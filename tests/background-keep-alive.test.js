import { describe, expect, jest, test } from '@jest/globals';
import {
    BACKGROUND_KEEP_ALIVE_STORAGE_KEY,
    createBackgroundKeepAlive,
    createQuietToneWav,
    isBackgroundKeepAliveDevice,
    readBackgroundKeepAliveEnabled,
    writeBackgroundKeepAliveEnabled,
} from '../public/scripts/background-keep-alive.js';

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        values,
    };
}

function createDocument() {
    const listeners = new Set();
    return {
        visibilityState: 'visible',
        addEventListener: (type, listener) => type === 'visibilitychange' && listeners.add(listener),
        removeEventListener: (type, listener) => type === 'visibilitychange' && listeners.delete(listener),
        setVisibility(state) {
            this.visibilityState = state;
            for (const listener of listeners) listener();
        },
        listenerCount: () => listeners.size,
    };
}

function createAudioStub(playImplementation = () => Promise.resolve()) {
    const audio = {
        src: '',
        loop: false,
        paused: true,
        play: jest.fn(() => {
            audio.paused = false;
            return playImplementation();
        }),
        pause: jest.fn(() => { audio.paused = true; }),
        removeAttribute: jest.fn((name) => { if (name === 'src') audio.src = ''; }),
        load: jest.fn(),
    };
    return audio;
}

function createMediaSession() {
    const handlers = {};
    return {
        metadata: null,
        playbackState: 'none',
        handlers,
        setActionHandler: (action, handler) => { handlers[action] = handler; },
    };
}

function setup({ enabled = true, audio = createAudioStub() } = {}) {
    const documentRef = createDocument();
    const storage = createStorage(enabled ? { [BACKGROUND_KEEP_ALIVE_STORAGE_KEY]: 'on' } : {});
    const mediaSession = createMediaSession();
    const statuses = [];
    const controller = createBackgroundKeepAlive({
        documentRef,
        navigatorRef: { mediaSession },
        storage,
        createAudio: () => audio,
        createObjectUrl: () => 'blob:quiet-tone',
        onStatus: status => statuses.push(status),
    });
    return { audio, controller, documentRef, mediaSession, statuses, storage };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('background keep-alive device detection', () => {
    test('offers the switch in Android browsers only', () => {
        expect(isBackgroundKeepAliveDevice({ userAgent: ANDROID_CHROME }, {})).toBe(true);
        expect(isBackgroundKeepAliveDevice({ userAgent: DESKTOP_CHROME, userAgentData: { platform: 'Android' } }, {})).toBe(true);
        expect(isBackgroundKeepAliveDevice({ userAgent: DESKTOP_CHROME }, {})).toBe(false);
        expect(isBackgroundKeepAliveDevice({ userAgent: IPHONE_SAFARI }, {})).toBe(false);
        expect(isBackgroundKeepAliveDevice(undefined, {})).toBe(false);
    });

    test('hides the switch inside the Android app, which keeps itself alive', () => {
        expect(isBackgroundKeepAliveDevice({ userAgent: ANDROID_CHROME }, { NeconyanAndroid: {} })).toBe(false);
        expect(isBackgroundKeepAliveDevice({ userAgent: ANDROID_CHROME }, { NeconyanExport: {} })).toBe(false);
    });
});

describe('background keep-alive storage', () => {
    test('stays off until this device opts in', () => {
        const storage = createStorage();
        expect(readBackgroundKeepAliveEnabled(storage)).toBe(false);
        writeBackgroundKeepAliveEnabled(storage, true);
        expect(storage.values.get(BACKGROUND_KEEP_ALIVE_STORAGE_KEY)).toBe('on');
        expect(readBackgroundKeepAliveEnabled(storage)).toBe(true);
        writeBackgroundKeepAliveEnabled(storage, false);
        expect(storage.values.has(BACKGROUND_KEEP_ALIVE_STORAGE_KEY)).toBe(false);
    });

    test('treats unavailable storage as off', () => {
        const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        expect(readBackgroundKeepAliveEnabled(throwing)).toBe(false);
        expect(writeBackgroundKeepAliveEnabled(throwing, true)).toBe(false);
        expect(readBackgroundKeepAliveEnabled(undefined)).toBe(false);
    });
});

describe('quiet tone', () => {
    test('is a valid six-second 8 kHz mono WAV well below full volume', () => {
        const buffer = createQuietToneWav();
        const view = new DataView(buffer);
        const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length));
        expect(text(0, 4)).toBe('RIFF');
        expect(text(8, 4)).toBe('WAVE');
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(8000);
        expect(view.getUint16(34, true)).toBe(16);
        expect(view.getUint32(40, true)).toBe(8000 * 6 * 2);
        expect(buffer.byteLength).toBe(44 + 8000 * 6 * 2);

        let peak = 0;
        for (let offset = 44; offset < buffer.byteLength; offset += 2) {
            peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
        }
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThanOrEqual(64);
        expect(view.getInt16(44, true)).toBe(0);
    });
});

describe('background keep-alive controller', () => {
    test('does nothing while switched off', async () => {
        const { audio, documentRef, controller } = setup({ enabled: false });
        documentRef.setVisibility('hidden');
        await flush();
        expect(audio.play).not.toHaveBeenCalled();
        expect(controller.isPlaying()).toBe(false);
    });

    test('plays only while the page is hidden and stops when it returns', async () => {
        const { audio, documentRef, controller, mediaSession, statuses } = setup();
        expect(audio.play).not.toHaveBeenCalled();

        documentRef.setVisibility('hidden');
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(audio.loop).toBe(true);
        expect(audio.src).toBe('blob:quiet-tone');
        expect(controller.isPlaying()).toBe(true);
        expect(mediaSession.playbackState).toBe('playing');
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: true, lastError: '' });

        documentRef.setVisibility('visible');
        expect(audio.pause).toHaveBeenCalled();
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        expect(controller.isPlaying()).toBe(false);
        expect(mediaSession.playbackState).toBe('none');
        expect(mediaSession.handlers.pause).toBeNull();
        expect(statuses.at(-1).playing).toBe(false);
    });

    test('pausing from the media notification stops it until the user comes back', async () => {
        const { audio, documentRef, controller, mediaSession } = setup();
        documentRef.setVisibility('hidden');
        await flush();
        mediaSession.handlers.pause();
        expect(controller.isPlaying()).toBe(false);

        documentRef.setVisibility('hidden');
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);

        documentRef.setVisibility('visible');
        documentRef.setVisibility('hidden');
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(2);
    });

    test('ignores a late play result after the user has already returned', async () => {
        let resolvePlay;
        const audio = createAudioStub(() => new Promise(resolve => { resolvePlay = resolve; }));
        const { documentRef, controller, mediaSession } = setup({ audio });
        documentRef.setVisibility('hidden');
        documentRef.setVisibility('visible');
        resolvePlay();
        await flush();
        expect(controller.isPlaying()).toBe(false);
        expect(mediaSession.playbackState).toBe('none');
    });

    test('reports when the browser blocks the sound', async () => {
        const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
        const audio = createAudioStub(() => Promise.reject(blocked));
        const { documentRef, controller, statuses } = setup({ audio });
        documentRef.setVisibility('hidden');
        await flush();
        expect(controller.isPlaying()).toBe(false);
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: false, lastError: 'blocked' });

        controller.setEnabled(true);
        expect(controller.getStatus().lastError).toBe('');
    });

    test('switching off while away stops the sound and forgets the choice', async () => {
        const { audio, documentRef, controller, storage } = setup();
        documentRef.setVisibility('hidden');
        await flush();
        controller.setEnabled(false);
        expect(audio.pause).toHaveBeenCalled();
        expect(controller.isPlaying()).toBe(false);
        expect(storage.values.has(BACKGROUND_KEEP_ALIVE_STORAGE_KEY)).toBe(false);
    });

    test('destroy removes the visibility listener', () => {
        const { documentRef, controller } = setup();
        expect(documentRef.listenerCount()).toBe(1);
        controller.destroy();
        expect(documentRef.listenerCount()).toBe(0);
    });
});

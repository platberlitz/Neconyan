/* global globalThis */
import fs from 'node:fs';

import { describe, expect, jest, test } from '@jest/globals';
import {
    BACKGROUND_KEEP_ALIVE_STORAGE_KEY,
    createBackgroundKeepAlive,
    createQuietToneWav,
    createReplyKeepAlive,
    isBackgroundKeepAliveDevice,
    readBackgroundKeepAliveEnabled,
    writeBackgroundKeepAliveEnabled,
} from '../public/scripts/background-keep-alive.js';
import { createNativeAppLifecycle, NATIVE_APP_LIFECYCLE_EVENT } from '../public/scripts/native-app-lifecycle.js';

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

// Like a browser, it reports real playback with a 'playing' event once play() succeeds.
// events: false leaves out the event API; announce: false leaves out the 'playing' event.
function createAudioStub(playImplementation = () => Promise.resolve(), { events = true, announce = true } = {}) {
    const listeners = new Map();
    const audio = {
        src: '',
        loop: false,
        paused: true,
        readyState: 4,
        play: jest.fn(() => {
            audio.paused = false;
            const result = playImplementation();
            if (events && announce) result.then(() => audio.emit('playing'), () => { audio.paused = true; });
            return result;
        }),
        pause: jest.fn(() => { audio.paused = true; }),
        removeAttribute: jest.fn((name) => { if (name === 'src') audio.src = ''; }),
        load: jest.fn(),
    };
    if (events) {
        Object.assign(audio, {
            addEventListener: (type, listener) => listeners.set(type, new Set([...(listeners.get(type) ?? []), listener])),
            removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
            emit: (type) => { for (const listener of [...(listeners.get(type) ?? [])]) listener({ type }); },
            listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
        });
    }
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

function setup({ enabled = true, audio = createAudioStub(), hidden = false, onActivity } = {}) {
    const documentRef = createDocument();
    if (hidden) documentRef.visibilityState = 'hidden';
    const storage = createStorage(enabled ? { [BACKGROUND_KEEP_ALIVE_STORAGE_KEY]: 'on' } : {});
    const mediaSession = createMediaSession();
    const statuses = [];
    const activity = [];
    const timers = new Map();
    const clock = { now: 1_000_000 };
    let nextTimer = 1;
    const controller = createBackgroundKeepAlive({
        documentRef,
        navigatorRef: { mediaSession },
        storage,
        createAudio: () => audio,
        createObjectUrl: () => 'blob:quiet-tone',
        onStatus: status => statuses.push(status),
        onActivity: onActivity ?? (state => activity.push(state)),
        setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearTimer: id => timers.delete(id),
        now: () => clock.now,
    });
    const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
    return { activity, audio, clock, controller, documentRef, mediaSession, runTimers, statuses, storage, timers };
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

describe('background keep-alive honesty', () => {
    async function awayAndPlaying(options) {
        const fixture = setup(options);
        fixture.documentRef.setVisibility('hidden');
        await flush();
        return fixture;
    }

    test('counts the sound as playing only once the element reports it', async () => {
        const audio = createAudioStub(() => Promise.resolve(), { announce: false });
        const { controller, statuses } = await awayAndPlaying({ audio });
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(controller.isPlaying()).toBe(false);
        expect(statuses).toEqual([]);

        audio.emit('playing');
        expect(controller.isPlaying()).toBe(true);
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: true, lastError: '' });
    });

    test('trusts a play() that succeeds when the element has no events to listen to', async () => {
        const { controller } = await awayAndPlaying({ audio: createAudioStub(() => Promise.resolve(), { events: false }) });
        expect(controller.isPlaying()).toBe(true);
    });

    test('stops listening to the element when it stops, and when it is destroyed', async () => {
        const { audio, controller, documentRef } = await awayAndPlaying();
        expect(audio.listenerCount()).toBeGreaterThan(0);
        documentRef.setVisibility('visible');
        expect(audio.listenerCount()).toBe(0);

        documentRef.setVisibility('hidden');
        await flush();
        expect(audio.listenerCount()).toBeGreaterThan(0);
        controller.destroy();
        expect(audio.listenerCount()).toBe(0);
    });

    test('a pause the page did not cause is an interruption: recorded, reported and not retried', async () => {
        const { activity, audio, clock, controller, mediaSession, runTimers, statuses, timers } = await awayAndPlaying();
        clock.now += 312_000;
        audio.paused = true;
        audio.emit('pause');

        expect(controller.isPlaying()).toBe(false);
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: false, lastError: 'interrupted' });
        expect(activity.at(-1)).toMatchObject({ enabled: true, state: 'interrupted', interruptions: 1, playedSeconds: 312, lastEvent: 'pause' });
        expect(mediaSession.playbackState).toBe('none');
        // Another app taking over audio sends a plain pause; playing again would cut off the user's music or call.
        expect(timers.size).toBe(0);
        runTimers();
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    test('a fault in the element gets one more try after about two seconds, and no second one', async () => {
        const { activity, audio, controller, runTimers, statuses, timers } = await awayAndPlaying();
        audio.emit('error');
        expect([...timers.values()].map(timer => timer.ms)).toEqual([2000]);
        expect(statuses.at(-1).lastError).toBe('interrupted');
        expect(audio.play).toHaveBeenCalledTimes(1);

        runTimers();
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(controller.isPlaying()).toBe(true);
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: true, lastError: '' });
        expect(activity.at(-1)).toMatchObject({ state: 'playing', interruptions: 1, lastEvent: 'error' });

        audio.emit('ended');
        expect(controller.isPlaying()).toBe(false);
        expect(timers.size).toBe(0);
        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(activity.at(-1)).toMatchObject({ state: 'interrupted', interruptions: 2, lastEvent: 'ended' });
    });

    test.each(['ended', 'stalled'])('%s is retried once', async (event) => {
        const { audio, runTimers, timers } = await awayAndPlaying();
        audio.paused = true;
        audio.emit(event);
        expect(timers.size).toBe(1);
        runTimers();
        expect(audio.play).toHaveBeenCalledTimes(2);
    });

    test('a source that reports stalled while it plays on is not an interruption', async () => {
        const { audio, controller, statuses } = await awayAndPlaying();
        audio.paused = false;
        audio.readyState = 4;
        audio.emit('stalled');
        expect(controller.isPlaying()).toBe(true);
        expect(statuses.at(-1).lastError).toBe('');
    });

    test('the element being emptied is recorded but not retried', async () => {
        const { activity, audio, controller, timers } = await awayAndPlaying();
        audio.emit('emptied');
        expect(controller.isPlaying()).toBe(false);
        expect(timers.size).toBe(0);
        expect(activity.at(-1)).toMatchObject({ state: 'interrupted', lastEvent: 'emptied' });
    });

    test('a retry on an element that never stopped is counted as playing without waiting for an event', async () => {
        const audio = createAudioStub(() => Promise.resolve(), { announce: false });
        const { controller, runTimers, statuses } = await awayAndPlaying({ audio });
        audio.emit('playing');
        audio.paused = false;
        audio.emit('error');
        expect(controller.isPlaying()).toBe(false);
        runTimers();
        await flush();
        expect(controller.isPlaying()).toBe(true);
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: true, lastError: '' });
    });

    test('returning to the page cancels a pending retry', async () => {
        const { audio, documentRef, runTimers, timers } = await awayAndPlaying();
        audio.emit('error');
        expect(timers.size).toBe(1);
        documentRef.setVisibility('visible');
        expect(timers.size).toBe(0);
        runTimers();
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    test('a retry that is refused leaves the interruption on record, and a refusal by the browser is reported as blocked', async () => {
        const first = await awayAndPlaying();
        first.audio.play.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('failed'), { name: 'AbortError' })));
        first.audio.emit('error');
        first.runTimers();
        await flush();
        expect(first.controller.getStatus()).toEqual({ enabled: true, playing: false, lastError: 'interrupted' });
        expect(first.audio.play).toHaveBeenCalledTimes(2);
        expect(first.timers.size).toBe(0);

        const second = await awayAndPlaying();
        second.audio.play.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
        second.audio.emit('error');
        second.runTimers();
        await flush();
        expect(second.controller.getStatus().lastError).toBe('blocked');
    });

    test('pausing from the media notification is a dismissal, not an interruption', async () => {
        const { activity, audio, controller, documentRef, mediaSession, statuses } = await awayAndPlaying();
        mediaSession.handlers.pause();
        audio.emit('pause');
        expect(controller.isPlaying()).toBe(false);
        expect(statuses.at(-1)).toEqual({ enabled: true, playing: false, lastError: '' });
        expect(activity.at(-1)).toMatchObject({ state: 'dismissed', interruptions: 0 });
        documentRef.setVisibility('visible');
        expect(activity.at(-1)).toMatchObject({ state: 'armed', interruptions: 0 });
    });

    test('stopping on return is normal, and events after it are ignored', async () => {
        const { activity, audio, controller, documentRef, statuses } = await awayAndPlaying();
        documentRef.setVisibility('visible');
        audio.emit('pause');
        audio.emit('emptied');
        expect(controller.getStatus()).toEqual({ enabled: true, playing: false, lastError: '' });
        expect(statuses.at(-1).lastError).toBe('');
        expect(activity.at(-1)).toMatchObject({ state: 'armed', interruptions: 0 });
        expect(activity.every(state => state.interruptions === 0)).toBe(true);
    });

    test('keeps the outcome of the time away until the next one succeeds', async () => {
        const { audio, controller, documentRef } = await awayAndPlaying();
        audio.emit('pause');
        documentRef.setVisibility('visible');
        expect(controller.getStatus()).toEqual({ enabled: true, playing: false, lastError: 'interrupted' });

        documentRef.setVisibility('hidden');
        await flush();
        expect(controller.getStatus()).toEqual({ enabled: true, playing: true, lastError: '' });
    });

    test('switching the setting clears an old interruption', async () => {
        const { audio, controller } = await awayAndPlaying();
        audio.emit('pause');
        controller.setEnabled(true);
        expect(controller.getStatus().lastError).toBe('');
    });

    test('a page that loads while hidden starts the sound once, if the setting is on', async () => {
        const { audio, controller } = setup({ hidden: true });
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(controller.isPlaying()).toBe(true);

        const off = setup({ enabled: false, hidden: true });
        await flush();
        expect(off.audio.play).not.toHaveBeenCalled();

        const visible = setup();
        await flush();
        expect(visible.audio.play).not.toHaveBeenCalled();
    });

    test('a page that loads hidden and is refused tells the user what to do', async () => {
        const audio = createAudioStub(() => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
        const { controller, documentRef } = setup({ audio, hidden: true });
        await flush();
        expect(controller.getStatus().lastError).toBe('blocked');
        documentRef.setVisibility('visible');
        expect(controller.getStatus().lastError).toBe('blocked');
    });

    test('reports every state change to the diagnostics, with fixed values only', async () => {
        const { activity, audio, clock, controller, documentRef } = setup();
        expect(activity).toEqual([{ enabled: true, state: 'armed', since: 1_000_000, interruptions: 0 }]);

        clock.now += 1000;
        documentRef.setVisibility('hidden');
        await flush();
        expect(activity.at(-1)).toEqual({ enabled: true, state: 'playing', since: 1_001_000, interruptions: 0 });

        clock.now += 60_000;
        audio.emit('pause');
        expect(activity.at(-1)).toEqual({ enabled: true, state: 'interrupted', since: 1_061_000, interruptions: 1, playedSeconds: 60, lastEvent: 'pause' });

        const count = activity.length;
        documentRef.setVisibility('visible');
        expect(activity).toHaveLength(count);

        controller.setEnabled(false);
        expect(activity.at(-1)).toMatchObject({ enabled: false, state: 'off' });
        for (const state of activity) expect(Object.keys(state).every(key => ['enabled', 'state', 'since', 'interruptions', 'playedSeconds', 'lastEvent'].includes(key))).toBe(true);
    });

    test('reports blocked, failed and unsupported', async () => {
        const blocked = setup({ audio: createAudioStub(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))) });
        blocked.documentRef.setVisibility('hidden');
        await flush();
        expect(blocked.activity.at(-1).state).toBe('blocked');

        const failed = setup({ audio: createAudioStub(() => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }))) });
        failed.documentRef.setVisibility('hidden');
        await flush();
        expect(failed.activity.at(-1).state).toBe('failed');

        const unsupported = setup({ audio: createAudioStub(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }))) });
        unsupported.documentRef.setVisibility('hidden');
        await flush();
        expect(unsupported.activity.at(-1).state).toBe('unsupported');
        expect(unsupported.controller.getStatus().lastError).toBe('failed');
    });

    test('an audio element that cannot be created is reported as unsupported', async () => {
        const documentRef = createDocument();
        const activity = [];
        const controller = createBackgroundKeepAlive({
            documentRef,
            storage: createStorage({ [BACKGROUND_KEEP_ALIVE_STORAGE_KEY]: 'on' }),
            createAudio: () => { throw new TypeError('Audio is not available'); },
            createObjectUrl: () => 'blob:quiet-tone',
            onActivity: state => activity.push(state),
        });
        documentRef.setVisibility('hidden');
        await flush();
        expect(controller.getStatus().lastError).toBe('failed');
        expect(activity.at(-1).state).toBe('unsupported');
    });

    test('a diagnostics callback that throws never stops the sound', async () => {
        const { controller } = await awayAndPlaying({ onActivity: () => { throw new Error('storage full'); } });
        expect(controller.isPlaying()).toBe(true);
    });

    test('reports to the crash diagnostics when no callback is given', async () => {
        const updateActivity = jest.fn();
        globalThis.NeconyanCrashDiagnostics = { updateActivity };
        try {
            const documentRef = createDocument();
            createBackgroundKeepAlive({ documentRef, storage: createStorage({ [BACKGROUND_KEEP_ALIVE_STORAGE_KEY]: 'on' }), createAudio: () => createAudioStub(), createObjectUrl: () => 'blob:quiet-tone' });
            expect(updateActivity).toHaveBeenCalledWith({ keepAlive: expect.objectContaining({ enabled: true, state: 'armed' }) });
        } finally {
            delete globalThis.NeconyanCrashDiagnostics;
        }
    });
});

describe('background keep-alive status text', () => {
    // The formatter lives in power-user.js, which cannot load under Jest, so its source is run with a stand-in for the translator.
    const source = fs.readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
    const start = source.indexOf('function formatBackgroundKeepAliveStatus(');
    const body = source.slice(start, source.indexOf('\n}\n', start) + 3);
    const format = new Function('t', `${body}\nreturn formatBackgroundKeepAliveStatus;`)((strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''));

    test('keeps the existing texts for the existing states', () => {
        expect(format({ enabled: true, playing: false, lastError: '' })).toBe('On. Starts when you switch to another app or tab.');
        expect(format({ enabled: true, playing: true, lastError: '' })).toBe('Keeping Neconyan open.');
        expect(format({ enabled: false, playing: false, lastError: '' })).toBe('Off. Android may reload Neconyan if you stay away for long.');
        expect(format({ enabled: true, playing: false, lastError: 'blocked' })).toBe('The browser blocked the sound. Tap anywhere in Neconyan once, then switch away again.');
        expect(format({ enabled: true, playing: false, lastError: 'failed' })).toBe('The sound could not start in this browser.');
    });

    test('says when the browser or another app stopped the sound while away', () => {
        expect(format({ enabled: true, playing: false, lastError: 'interrupted' }))
            .toBe('The browser or another app stopped the sound while you were away, so Android may reload Neconyan.');
    });

    test('the new text is in the English catalogue', () => {
        const catalogue = JSON.parse(fs.readFileSync(new URL('../public/locales/neconyan/en.json', import.meta.url), 'utf8'));
        const text = 'The browser or another app stopped the sound while you were away, so Android may reload Neconyan.';
        expect(catalogue[text]).toBe(text);
    });
});

describe('iPhone app reply keep-alive', () => {
    function setupReply(options = {}) {
        const documentRef = options.documentRef ?? createDocument();
        const audio = createAudioStub();
        const mediaSession = createMediaSession();
        const native = [];
        const timers = new Map();
        let nextTimer = 1;
        let listener = null;
        const controller = createReplyKeepAlive({
            subscribe: (fn) => { listener = fn; fn(false); return () => { listener = null; }; },
            notifyNative: busy => native.push(busy),
            documentRef,
            navigatorRef: { mediaSession },
            createAudio: () => audio,
            createObjectUrl: () => 'blob:quiet-tone',
            setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
            clearTimer: id => timers.delete(id),
            ...options,
        });
        const fire = (ms) => {
            for (const [id, timer] of [...timers]) {
                if (timer.ms === ms) { timers.delete(id); timer.fn(); }
            }
        };
        return { controller, documentRef, audio, mediaSession, native, timers, fire, activity: busy => listener(busy) };
    }

    test('stays silent while the page is open, even mid-reply', () => {
        const { controller, audio, native, activity } = setupReply();
        activity(true);
        expect(native).toEqual([true]);
        expect(audio.src).toBe('blob:quiet-tone');
        expect(audio.play).not.toHaveBeenCalled();
        expect(controller.isHolding()).toBe(true);
    });

    test('plays while hidden mid-reply and stops once the page is shown again', () => {
        const { controller, documentRef, audio, mediaSession, activity } = setupReply();
        activity(true);
        documentRef.setVisibility('hidden');
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(audio.loop).toBe(true);
        expect(mediaSession.playbackState).toBe('playing');
        documentRef.setVisibility('visible');
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(controller.isPlaying()).toBe(false);
        expect(controller.isHolding()).toBe(true);
    });

    test('starts at once when a reply begins on a hidden page', () => {
        const { documentRef, audio, activity } = setupReply();
        documentRef.setVisibility('hidden');
        expect(audio.play).not.toHaveBeenCalled();
        activity(true);
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    test('keeps going briefly after a reply so the Agents after it can start', () => {
        const { controller, documentRef, audio, native, timers, fire, activity } = setupReply();
        activity(true);
        documentRef.setVisibility('hidden');
        activity(false);
        expect(controller.isPlaying()).toBe(true);
        activity(true);
        expect([...timers.values()].map(timer => timer.ms)).toEqual([65 * 60_000]);
        activity(false);
        fire(15_000);
        expect(controller.isHolding()).toBe(false);
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(native).toEqual([true, false]);
    });

    test('lets go after an hour even if a reply never reports back', () => {
        const { controller, documentRef, native, fire, activity } = setupReply();
        activity(true);
        documentRef.setVisibility('hidden');
        fire(65 * 60_000);
        expect(controller.isHolding()).toBe(false);
        expect(controller.isPlaying()).toBe(false);
        expect(native).toEqual([true, false]);
    });

    test('the lock-screen pause stops it until the page is opened again', () => {
        const { controller, documentRef, audio, mediaSession, activity } = setupReply();
        activity(true);
        documentRef.setVisibility('hidden');
        mediaSession.handlers.pause();
        expect(controller.isPlaying()).toBe(false);
        documentRef.setVisibility('visible');
        documentRef.setVisibility('hidden');
        expect(audio.play).toHaveBeenCalledTimes(2);
    });

    test('a refused play leaves it ready to try again', async () => {
        const { controller, documentRef, audio, activity } = setupReply();
        audio.play.mockImplementationOnce(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
        activity(true);
        documentRef.setVisibility('hidden');
        await Promise.resolve();
        expect(controller.isPlaying()).toBe(false);
        documentRef.setVisibility('visible');
        documentRef.setVisibility('hidden');
        expect(controller.isPlaying()).toBe(true);
    });

    test('destroy lets go and stops listening', () => {
        const { controller, documentRef, native, activity } = setupReply();
        activity(true);
        controller.destroy();
        expect(native).toEqual([true, false]);
        expect(documentRef.listenerCount()).toBe(0);
    });

    function createSendLock(generating = '') {
        const observers = new Set();
        const body = { dataset: generating ? { generating } : {} };
        class FakeObserver {
            constructor(callback) { this.callback = callback; }
            observe(target, options) {
                this.target = target;
                this.options = options;
                observers.add(this);
            }
            disconnect() { observers.delete(this); }
        }
        const set = (value) => {
            if (value) body.dataset.generating = value;
            else delete body.dataset.generating;
            for (const observer of [...observers]) observer.callback([]);
        };
        return { body, FakeObserver, observers, set };
    }

    test('the Send lock keeps it going while Agents finish between their own requests', () => {
        const lock = createSendLock();
        const documentRef = Object.assign(createDocument(), { body: lock.body });
        const { controller, audio, native, timers, fire, activity } = setupReply({
            documentRef,
            watchSendLock: true,
            MutationObserverRef: lock.FakeObserver,
        });
        expect([...lock.observers][0].options).toEqual({ attributes: true, attributeFilter: ['data-generating'] });

        lock.set('true');
        activity(true);
        documentRef.setVisibility('hidden');
        activity(false);
        expect([...timers.values()].map(timer => timer.ms)).toEqual([65 * 60_000]);
        expect(controller.isPlaying()).toBe(true);

        lock.set('');
        expect([...timers.values()].map(timer => timer.ms).sort((a, b) => a - b)).toEqual([15_000, 65 * 60_000]);
        fire(15_000);
        expect(controller.isHolding()).toBe(false);
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(native).toEqual([true, false]);
    });

    test('a Send lock already held when the page loads holds at once, and destroy stops watching it', () => {
        const lock = createSendLock('true');
        const documentRef = Object.assign(createDocument(), { body: lock.body });
        const { controller, native } = setupReply({ documentRef, watchSendLock: true, MutationObserverRef: lock.FakeObserver });
        expect(controller.isHolding()).toBe(true);
        expect(native).toEqual([true]);
        controller.destroy();
        expect(lock.observers.size).toBe(0);
        expect(native).toEqual([true, false]);
    });

    test('without watchSendLock the Send lock is left alone', () => {
        const lock = createSendLock('true');
        const documentRef = Object.assign(createDocument(), { body: lock.body });
        const { controller } = setupReply({ documentRef, MutationObserverRef: lock.FakeObserver });
        expect(controller.isHolding()).toBe(false);
        expect(lock.observers.size).toBe(0);
    });

    test('the app leaving the screen counts as hidden even before the page hears about it', () => {
        const host = new EventTarget();
        const lifecycle = createNativeAppLifecycle({ host });
        const send = state => host.dispatchEvent(new CustomEvent(NATIVE_APP_LIFECYCLE_EVENT, { detail: { state } }));
        const { controller, audio, activity } = setupReply({ lifecycle });
        activity(true);
        send('paused');
        expect(controller.isPlaying()).toBe(false);
        send('stopped');
        expect(audio.play).toHaveBeenCalledTimes(1);
        expect(controller.isPlaying()).toBe(true);
        send('resumed');
        expect(controller.isPlaying()).toBe(false);
        controller.destroy();
        send('stopped');
        expect(audio.play).toHaveBeenCalledTimes(1);
        lifecycle.dispose();
    });
});

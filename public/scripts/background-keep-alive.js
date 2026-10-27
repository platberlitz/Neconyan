// Android browsers unload pages they consider idle once the tab has been in the background
// for a while. A page that is playing audio counts as a media player instead, and Chrome
// keeps media players loaded and shows them in the notification shade. This module plays a
// quiet sound only while Neconyan is hidden and only when the user has opted in on this device.

export const BACKGROUND_KEEP_ALIVE_STORAGE_KEY = 'neconyan:background-keep-alive:v1';

const SAMPLE_RATE = 8000;
// Chrome registers a media session only for sounds longer than five seconds.
const CLIP_SECONDS = 6;
// 20 Hz sits below what phone speakers reproduce and below human hearing at this level
// (about -55 dBFS), while staying above the level browsers treat as digital silence.
const TONE_HZ = 20;
const TONE_AMPLITUDE = 60;

export function isBackgroundKeepAliveDevice(navigatorRef = globalThis.navigator, host = globalThis) {
    if (!navigatorRef) return false;
    // The Android app keeps its own server and page alive with a foreground notification.
    if (host?.NeconyanAndroid || host?.NeconyanExport) return false;
    const userAgent = String(navigatorRef.userAgent || '');
    const platform = String(navigatorRef.platform || '');
    const userAgentDataPlatform = String(navigatorRef.userAgentData?.platform || '');
    return /Android/i.test(`${userAgent} ${platform} ${userAgentDataPlatform}`);
}

export function readBackgroundKeepAliveEnabled(storage) {
    try {
        return storage?.getItem(BACKGROUND_KEEP_ALIVE_STORAGE_KEY) === 'on';
    } catch {
        return false;
    }
}

export function writeBackgroundKeepAliveEnabled(storage, enabled) {
    try {
        if (enabled) storage?.setItem(BACKGROUND_KEEP_ALIVE_STORAGE_KEY, 'on');
        else storage?.removeItem(BACKGROUND_KEEP_ALIVE_STORAGE_KEY);
        return true;
    } catch {
        return false;
    }
}

/** A mono 16-bit WAV file holding a looping 20 Hz tone too quiet to hear. */
export function createQuietToneWav() {
    const samples = SAMPLE_RATE * CLIP_SECONDS;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
        for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples * 2, true);
    // Whole cycles only, so the loop point does not click.
    for (let index = 0; index < samples; index++) {
        view.setInt16(44 + index * 2, Math.round(Math.sin(2 * Math.PI * TONE_HZ * index / SAMPLE_RATE) * TONE_AMPLITUDE), true);
    }
    return buffer;
}

/**
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Navigator} [options.navigatorRef]
 * @param {Storage} [options.storage]
 * @param {() => HTMLAudioElement} [options.createAudio]
 * @param {(blob: Blob) => string} [options.createObjectUrl]
 * @param {(status: object) => void} [options.onStatus]
 */
export function createBackgroundKeepAlive({
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
    storage = globalThis.localStorage,
    createAudio = () => new globalThis.Audio(),
    createObjectUrl = blob => globalThis.URL.createObjectURL(blob),
    onStatus = () => {},
} = {}) {
    let enabled = readBackgroundKeepAliveEnabled(storage);
    let audio = null;
    let sourceUrl = '';
    let playing = false;
    let dismissed = false;
    let lastError = '';
    let attempts = 0;

    const report = () => onStatus({ enabled, playing, lastError });

    function setMediaSession(active) {
        const session = navigatorRef?.mediaSession;
        if (!session) return;
        try {
            if (active && typeof globalThis.MediaMetadata === 'function') {
                session.metadata = new globalThis.MediaMetadata({ title: 'Neconyan is staying open', artist: 'Stay open in the background' });
            } else if (!active) {
                session.metadata = null;
            }
            session.playbackState = active ? 'playing' : 'none';
            for (const action of ['pause', 'stop']) {
                session.setActionHandler?.(action, active ? () => { dismissed = true; stop(); } : null);
            }
        } catch {
            // Media Session support varies by browser; playback works without it.
        }
    }

    async function start() {
        if (!enabled || dismissed || playing || documentRef?.visibilityState !== 'hidden') return;
        try {
            if (!sourceUrl) sourceUrl = createObjectUrl(new Blob([createQuietToneWav()], { type: 'audio/wav' }));
            audio = audio || createAudio();
            audio.loop = true;
            audio.preload = 'auto';
            audio.src = sourceUrl;
            playing = true;
            const attempt = ++attempts;
            try {
                await audio.play();
            } catch (error) {
                if (attempt !== attempts || !playing) return;
                throw error;
            }
            if (attempt !== attempts || !playing) return;
            lastError = '';
            setMediaSession(true);
        } catch (error) {
            playing = false;
            lastError = error?.name === 'NotAllowedError' ? 'blocked' : 'failed';
        }
        report();
    }

    function stop() {
        const wasPlaying = playing;
        playing = false;
        attempts++;
        if (audio) {
            try { audio.pause(); } catch { /* Already stopped. */ }
            // Without a source the browser drops the media notification instead of showing it paused.
            audio.removeAttribute?.('src');
            try { audio.load?.(); } catch { /* Nothing to unload. */ }
        }
        setMediaSession(false);
        if (wasPlaying) report();
    }

    function handleVisibilityChange() {
        if (documentRef?.visibilityState === 'hidden') {
            void start();
        } else {
            // Returning to the page re-arms a keep-alive the user paused from the notification.
            dismissed = false;
            stop();
        }
    }

    documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);

    return {
        isEnabled: () => enabled,
        isPlaying: () => playing,
        getStatus: () => ({ enabled, playing, lastError }),
        setEnabled(next) {
            enabled = Boolean(next);
            writeBackgroundKeepAliveEnabled(storage, enabled);
            if (!enabled) stop();
            lastError = '';
            report();
        },
        destroy() {
            documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
            stop();
        },
    };
}

// Covers a gap between a reply finishing and the Agents that run after it starting their own requests.
const REPLY_GRACE_MS = 15_000;
// Longer than the server ever keeps a reply running, so a reply that never reports back cannot hold the phone awake.
const REPLY_HOLD_LIMIT_MS = 65 * 60_000;

/**
 * The iPhone app freezes a hidden page within seconds, which would stop a reply being written,
 * saved and handed to Agents until the app was opened again. A page that is playing sound keeps
 * running, so this plays the quiet tone while the page is hidden and a reply is still going.
 * @param {object} options
 * @param {(listener: (busy: boolean) => void) => (() => void)} options.subscribe
 * @param {(busy: boolean) => void} [options.notifyNative]
 * @param {Document} [options.documentRef]
 * @param {Navigator} [options.navigatorRef]
 * @param {() => HTMLAudioElement} [options.createAudio]
 * @param {(blob: Blob) => string} [options.createObjectUrl]
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 */
export function createReplyKeepAlive({
    subscribe,
    notifyNative = () => {},
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
    createAudio = () => new globalThis.Audio(),
    createObjectUrl = blob => globalThis.URL.createObjectURL(blob),
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
} = {}) {
    let holding = false;
    let playing = false;
    let dismissed = false;
    let audio = null;
    let graceTimer = null;
    let limitTimer = null;

    const hidden = () => documentRef?.visibilityState === 'hidden';
    const tell = busy => {
        try { notifyNative(busy); } catch { /* The app may be closing. */ }
    };

    function setMediaSession(active) {
        const session = navigatorRef?.mediaSession;
        if (!session) return;
        try {
            if (active && typeof globalThis.MediaMetadata === 'function') {
                session.metadata = new globalThis.MediaMetadata({ title: 'Neconyan is finishing a reply', artist: 'Neconyan' });
            } else if (!active) {
                session.metadata = null;
            }
            session.playbackState = active ? 'playing' : 'none';
            for (const action of ['pause', 'stop']) {
                session.setActionHandler?.(action, active ? () => { dismissed = true; stopAudio(); } : null);
            }
        } catch {
            // Playback works without the lock-screen controls.
        }
    }

    function prepareAudio() {
        if (audio) return audio;
        audio = createAudio();
        audio.loop = true;
        audio.preload = 'auto';
        // Loaded up front: the page has only a moment to start playing once it is hidden.
        audio.src = createObjectUrl(new Blob([createQuietToneWav()], { type: 'audio/wav' }));
        return audio;
    }

    function startAudio() {
        if (!holding || playing || dismissed || !hidden()) return;
        playing = true;
        try {
            const result = prepareAudio().play();
            setMediaSession(true);
            result?.catch?.(() => {
                playing = false;
                setMediaSession(false);
            });
        } catch {
            playing = false;
        }
    }

    function stopAudio() {
        if (!playing) return;
        playing = false;
        try { audio?.pause(); } catch { /* Already stopped. */ }
        setMediaSession(false);
    }

    function release() {
        clearTimer(graceTimer);
        clearTimer(limitTimer);
        graceTimer = limitTimer = null;
        if (!holding) return;
        holding = false;
        stopAudio();
        tell(false);
    }

    function handleActivity(busy) {
        if (busy) {
            clearTimer(graceTimer);
            graceTimer = null;
            if (!holding) {
                holding = true;
                limitTimer = setTimer(release, REPLY_HOLD_LIMIT_MS);
                prepareAudio();
                tell(true);
            }
            startAudio();
        } else if (holding && !graceTimer) {
            graceTimer = setTimer(release, REPLY_GRACE_MS);
        }
    }

    function handleVisibilityChange() {
        if (hidden()) {
            startAudio();
        } else {
            dismissed = false;
            stopAudio();
        }
    }

    documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
    const unsubscribe = subscribe(handleActivity);

    return {
        isHolding: () => holding,
        isPlaying: () => playing,
        destroy() {
            unsubscribe?.();
            documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
            release();
        },
    };
}

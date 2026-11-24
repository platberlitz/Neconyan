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
    // Android's foreground service keeps the server alive. Android can still suspend
    // the page when it is hidden; durable work continues on the server instead.
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

// A second try is only worth making when the sound element itself failed.
const INTERRUPTION_RETRY_MS = 2000;
const RETRY_EVENTS = ['error', 'stalled', 'ended'];

/**
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Navigator} [options.navigatorRef]
 * @param {Storage} [options.storage]
 * @param {() => HTMLAudioElement} [options.createAudio]
 * @param {(blob: Blob) => string} [options.createObjectUrl]
 * @param {(status: object) => void} [options.onStatus]
 * @param {(state: object) => void} [options.onActivity] Receives every state change for the crash diagnostics.
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 * @param {() => number} [options.now]
 */
export function createBackgroundKeepAlive({
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
    storage = globalThis.localStorage,
    createAudio = () => new globalThis.Audio(),
    createObjectUrl = blob => globalThis.URL.createObjectURL(blob),
    onStatus = () => {},
    onActivity = state => globalThis.NeconyanCrashDiagnostics?.updateActivity?.({ keepAlive: state }),
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
    now = () => Date.now(),
} = {}) {
    let enabled = readBackgroundKeepAliveEnabled(storage);
    let audio = null;
    let sourceUrl = '';
    let detachAudio = null;
    // Asked to play since the page was hidden, until it comes back.
    let active = false;
    // The audio element has reported real playback, and has not stopped since.
    let playing = false;
    let playingSince = 0;
    let dismissed = false;
    let unsupported = false;
    let lastError = '';
    let attempts = 0;
    let retried = false;
    let retryTimer = null;
    let interruptions = 0;
    let lastEvent = '';
    let playedSeconds = null;
    let publishedState = '';
    let publishedSince = now();
    let publishedText = '';

    const report = () => {
        onStatus({ enabled, playing, lastError });
        publish();
    };

    function currentState() {
        if (!enabled) return 'off';
        if (unsupported) return 'unsupported';
        if (playing) return 'playing';
        if (lastError === 'blocked' || lastError === 'failed' || lastError === 'interrupted') return lastError;
        return dismissed ? 'dismissed' : 'armed';
    }

    // Sends the state to the crash diagnostics, so a page that is later lost can say what the sound was doing.
    function publish() {
        const state = currentState();
        if (state !== publishedState) {
            publishedState = state;
            publishedSince = now();
        }
        const snapshot = { enabled, state, since: publishedSince, interruptions };
        if (playedSeconds !== null) snapshot.playedSeconds = playedSeconds;
        if (lastEvent) snapshot.lastEvent = lastEvent;
        const text = JSON.stringify(snapshot);
        if (text === publishedText) return;
        publishedText = text;
        try { onActivity(snapshot); } catch { /* Diagnostics are optional. */ }
    }

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

    function clearRetry() {
        if (retryTimer !== null) clearTimer(retryTimer);
        retryTimer = null;
    }

    function markPlaying() {
        if (!active || playing) return;
        playing = true;
        playingSince = now();
        lastError = '';
        clearRetry();
        setMediaSession(true);
        report();
    }

    // The sound stopped while the page was hidden and the page did not stop it. Pressing pause in the
    // media notification goes through the media session handler instead and is not counted here.
    function interrupt(event) {
        if (!active || !playing) return;
        playing = false;
        interruptions++;
        lastEvent = event;
        playedSeconds = Math.max(0, Math.round((now() - playingSince) / 1000));
        lastError = 'interrupted';
        setMediaSession(false);
        // A plain pause is not retried: it normally means another app took over audio (music or a call),
        // and playing again would cut that off. Only a fault in the element itself gets one more try.
        if (!retried && RETRY_EVENTS.includes(event)) scheduleRetry();
        report();
    }

    function scheduleRetry() {
        retried = true;
        const attempt = attempts;
        clearRetry();
        retryTimer = setTimer(() => {
            retryTimer = null;
            if (!active || playing || attempt !== attempts || documentRef?.visibilityState !== 'hidden') return;
            void play(true);
        }, INTERRUPTION_RETRY_MS);
    }

    function listen(element) {
        if (typeof element.addEventListener !== 'function') return null;
        const handlers = {
            playing: markPlaying,
            pause: () => interrupt('pause'),
            ended: () => interrupt('ended'),
            error: () => interrupt('error'),
            emptied: () => interrupt('emptied'),
            // A source that is already loaded can report 'stalled' while it plays on.
            stalled: () => { if (element.paused === false && element.readyState >= 3) return; interrupt('stalled'); },
        };
        for (const [type, handler] of Object.entries(handlers)) element.addEventListener(type, handler);
        return () => {
            for (const [type, handler] of Object.entries(handlers)) element.removeEventListener?.(type, handler);
        };
    }

    async function play(isRetry = false) {
        const attempt = ++attempts;
        try {
            await audio.play();
        } catch (error) {
            if (attempt !== attempts || !active) return;
            active = false;
            playing = false;
            detachAudio?.();
            detachAudio = null;
            unsupported = unsupported || error?.name === 'NotSupportedError';
            // A refused second try leaves the interruption as the thing to report, unless the browser now refuses sound outright.
            if (!isRetry || error?.name === 'NotAllowedError') lastError = error?.name === 'NotAllowedError' ? 'blocked' : 'failed';
            report();
            return;
        }
        if (attempt !== attempts || !active) return;
        // Browsers report real playback with a 'playing' event; an element without events is trusted once play() succeeds.
        // A second try on an element that never actually stopped starts nothing, so no event follows: read its own state.
        if (!detachAudio || (isRetry && audio.paused === false)) markPlaying();
    }

    async function start() {
        if (!enabled || dismissed || active || documentRef?.visibilityState !== 'hidden') return;
        try {
            if (!sourceUrl) sourceUrl = createObjectUrl(new Blob([createQuietToneWav()], { type: 'audio/wav' }));
            audio = audio || createAudio();
            audio.loop = true;
            audio.preload = 'auto';
            audio.src = sourceUrl;
            active = true;
            retried = false;
            lastEvent = '';
            playedSeconds = null;
            detachAudio?.();
            detachAudio = listen(audio);
        } catch {
            active = false;
            playing = false;
            unsupported = true;
            lastError = 'failed';
            report();
            return;
        }
        await play();
    }

    function stop() {
        const wasPlaying = playing;
        active = false;
        playing = false;
        retried = false;
        attempts++;
        clearRetry();
        detachAudio?.();
        detachAudio = null;
        if (audio) {
            try { audio.pause(); } catch { /* Already stopped. */ }
            // Without a source the browser drops the media notification instead of showing it paused.
            audio.removeAttribute?.('src');
            try { audio.load?.(); } catch { /* Nothing to unload. */ }
        }
        setMediaSession(false);
        if (wasPlaying) report();
        else publish();
    }

    function handleVisibilityChange() {
        if (documentRef?.visibilityState === 'hidden') {
            void start();
        } else {
            // Returning to the page re-arms a keep-alive the user paused from the notification.
            // An interruption stays on record until the next time away, so the status can still say so.
            dismissed = false;
            stop();
        }
    }

    documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
    publish();
    // A page that loads while already hidden never sees the change that would start the sound.
    if (documentRef?.visibilityState === 'hidden') void start();

    return {
        isEnabled: () => enabled,
        isPlaying: () => playing,
        getStatus: () => ({ enabled, playing, lastError }),
        setEnabled(next) {
            enabled = Boolean(next);
            writeBackgroundKeepAliveEnabled(storage, enabled);
            if (!enabled) stop();
            lastError = '';
            unsupported = false;
            lastEvent = '';
            playedSeconds = null;
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

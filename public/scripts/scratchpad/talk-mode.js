/**
 * Hands-free talk mode: listen, notice the pause at the end of a turn, transcribe, send, read the reply aloud, listen again.
 * Everything that touches the page, the microphone or the network is passed in, so the loop can be tested on its own.
 */

export const TALK_PAUSES = Object.freeze([
    Object.freeze({ id: 'short', ms: 1000 }),
    Object.freeze({ id: 'normal', ms: 1600 }),
    Object.freeze({ id: 'patient', ms: 2500 }),
]);

export const TALK_AUDIO = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
export const TALK_SPEECH_THRESHOLD = 0.02;
export const TALK_SPEECH_CONFIRM_MS = 180;
export const TALK_NO_SPEECH_MS = 20000;
export const TALK_MAX_EMPTY_TURNS = 3;
const LEVEL_INTERVAL_MS = 50;

export function talkPause(id) {
    return TALK_PAUSES.find(pause => pause.id === id) ?? TALK_PAUSES[1];
}

/** Root mean square of one block of samples, 0 for silence up to about 1 for a full-scale signal. */
export function rms(samples) {
    const count = samples?.length ?? 0;
    if (!count) return 0;
    let sum = 0;
    for (let index = 0; index < count; index++) sum += samples[index] * samples[index];
    return Math.sqrt(sum / count);
}

/**
 * Turns a stream of loudness readings into turn events. Speech counts only once the level has stayed above the
 * threshold for speechConfirmMs, so a cough or a click does not start a turn. After speech, silenceMs of quiet ends
 * the turn; with no speech at all, noSpeechTimeoutMs gives up. update() returns 'speech', 'end-of-turn',
 * 'no-speech-timeout' or null, and reports each of them once.
 */
export function createSilenceDetector({
    speechThreshold = TALK_SPEECH_THRESHOLD,
    speechConfirmMs = TALK_SPEECH_CONFIRM_MS,
    silenceMs = talkPause('normal').ms,
    noSpeechTimeoutMs = TALK_NO_SPEECH_MS,
} = {}) {
    let startedAt = null;
    let loudSince = null;
    let quietSince = null;
    let hasSpeech = false;
    let done = false;
    return {
        get hasSpeech() { return hasSpeech; },
        get done() { return done; },
        update(level, now) {
            if (done) return null;
            startedAt ??= now;
            const loud = Number(level) >= speechThreshold;
            if (!hasSpeech) {
                if (!loud) {
                    loudSince = null;
                    if (now - startedAt >= noSpeechTimeoutMs) {
                        done = true;
                        return 'no-speech-timeout';
                    }
                    return null;
                }
                loudSince ??= now;
                if (now - loudSince < speechConfirmMs) return null;
                hasSpeech = true;
                return 'speech';
            }
            if (loud) {
                quietSince = null;
                return null;
            }
            quietSince ??= now;
            if (now - quietSince < silenceMs) return null;
            done = true;
            return 'end-of-turn';
        },
        reset() {
            startedAt = loudSince = quietSince = null;
            hasSpeech = done = false;
        },
    };
}

/** Samples the microphone level through an analyser on the given audio context. stop() disconnects it again. */
export function monitorStream(stream, { audioContext, onLevel, intervalMs = LEVEL_INTERVAL_MS }) {
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        onLevel(rms(samples));
    }, intervalMs);
    let stopped = false;
    return {
        stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            try { source.disconnect(); } catch { /* already disconnected */ }
        },
    };
}

export function createAudioContext() {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return null;
    try {
        return new AudioContextClass();
    } catch (error) {
        console.warn('[Scratchpad] Talk mode could not open an audio context', error);
        return null;
    }
}

function quietly(promise) {
    try { promise?.catch?.(() => {}); } catch { /* nothing to wait for */ }
}

/**
 * The talk loop. deps:
 * - record({ audio, onLimit }) -> { stream, stop(): Promise<Blob>, cancel() }; stop and cancel let go of the microphone.
 * - toWav(blob), transcribe(wav, { signal }) -> text; an error with code 'empty' means nothing was heard.
 * - waitUntilReady({ signal }): resolves when the chat is free for a new turn.
 * - sendTurn(text, { signal }) -> [{ message, speaker }] worth reading aloud; throws when the turn could not be sent.
 * - canSpeak(), speak(replies, { signal }) -> 'finished' | 'stopped' | 'empty' | 'unavailable', stopSpeaking().
 * - createAudioContext(), monitor(stream, { audioContext, onLevel }) -> { stop() }.
 * - pauseMs(), now(), detector (extra createSilenceDetector options).
 * - onChange({ state, hearing, active }), onLevel(level), onNotice('tts-off'), onEnd(reason, error).
 * End reasons: 'ended', 'no-speech', 'error', or whatever end() was given.
 */
export function createTalkMode(deps) {
    const now = deps.now ?? (() => performance.now());
    let run = null;
    let state = 'idle';
    let hearing = false;

    const snapshot = () => ({ state, hearing, active: Boolean(run) });
    function set(next, nextHearing = false) {
        if (state === next && hearing === nextHearing) return;
        state = next;
        hearing = nextHearing;
        deps.onChange?.(snapshot());
    }

    function release(current) {
        current.turn?.('ended');
        current.turn = null;
        current.meter?.stop();
        current.meter = null;
        current.recorder?.cancel();
        current.recorder = null;
    }

    function end(reason = 'ended', error = null) {
        const current = run;
        if (!current) return false;
        run = null;
        current.abort.abort();
        release(current);
        if (current.speech) {
            current.speech.abort();
            current.speech = null;
            try { deps.stopSpeaking?.(); } catch (stopError) { console.warn('[Scratchpad] Could not stop reading aloud', stopError); }
        }
        try { quietly(current.audioContext?.close?.()); } catch { /* already closed */ }
        set('idle');
        deps.onEnd?.(reason, error);
        return true;
    }

    function notice(current, code) {
        if (current.noticed.has(code)) return;
        current.noticed.add(code);
        deps.onNotice?.(code);
    }

    async function listen(current) {
        set('listening');
        const recorder = await deps.record({ audio: TALK_AUDIO, onLimit: () => current.turn?.('limit') });
        if (run !== current) {
            recorder.cancel();
            return null;
        }
        current.recorder = recorder;
        const detector = createSilenceDetector({ ...deps.detector, silenceMs: deps.pauseMs?.() ?? talkPause('normal').ms });
        const reason = await new Promise(resolve => {
            current.turn = resolve;
            if (!current.audioContext) return;
            quietly(current.audioContext.resume?.());
            current.meter = deps.monitor(recorder.stream, {
                audioContext: current.audioContext,
                onLevel: level => {
                    if (run !== current) return;
                    deps.onLevel?.(level);
                    const event = detector.update(level, now());
                    if (event === 'speech') set('listening', true);
                    else if (event) resolve(event);
                },
            });
        });
        current.turn = null;
        current.meter?.stop();
        current.meter = null;
        if (run !== current) return null;
        // The recording is over: the microphone goes before anything is transcribed, sent or spoken.
        const blob = await recorder.stop();
        current.recorder = null;
        quietly(current.audioContext?.suspend?.());
        deps.onLevel?.(0);
        return run === current ? { reason, blob } : null;
    }

    async function transcribe(current, blob) {
        set('transcribing');
        try {
            const text = await deps.transcribe(await deps.toWav(blob), { signal: current.abort.signal });
            current.emptyTurns = 0;
            return String(text ?? '').trim() || null;
        } catch (error) {
            if (error?.code !== 'empty') throw error;
            current.emptyTurns += 1;
            return null;
        }
    }

    async function speak(current, replies) {
        if (!replies?.length) return;
        if (!deps.canSpeak()) return notice(current, 'tts-off');
        set('speaking');
        const speech = new AbortController();
        current.speech = speech;
        try {
            const outcome = await deps.speak(replies, { signal: speech.signal });
            if (outcome === 'unavailable' && run === current) notice(current, 'tts-off');
        } finally {
            if (current.speech === speech) current.speech = null;
        }
    }

    async function loop(current) {
        try {
            while (run === current) {
                set('thinking');
                await deps.waitUntilReady({ signal: current.abort.signal });
                if (run !== current) return;
                const heard = await listen(current);
                if (!heard) return;
                if (heard.reason === 'no-speech-timeout') return void end('no-speech');
                const text = await transcribe(current, heard.blob);
                if (run !== current) return;
                if (!text) {
                    if (current.emptyTurns >= TALK_MAX_EMPTY_TURNS) return void end('no-speech');
                    continue;
                }
                set('thinking');
                const replies = await deps.sendTurn(text, { signal: current.abort.signal });
                if (run !== current) return;
                await speak(current, replies);
            }
        } catch (error) {
            if (run === current) end('error', error);
        }
    }

    return {
        get state() { return state; },
        get hearing() { return hearing; },
        get active() { return Boolean(run); },
        snapshot,
        /** Call from the click that turns talk mode on, so the audio context is created inside the user's gesture. */
        start() {
            if (run) return false;
            const audioContext = deps.createAudioContext?.() ?? null;
            quietly(audioContext?.resume?.());
            run = { abort: new AbortController(), audioContext, recorder: null, meter: null, turn: null, speech: null, emptyTurns: 0, noticed: new Set() };
            void loop(run);
            return true;
        },
        /** Ends the current turn now instead of waiting for the pause. */
        sendNow() {
            if (!run?.turn || state !== 'listening') return false;
            run.turn('send-now');
            return true;
        },
        /** Stops the voice and goes straight back to listening. */
        interrupt() {
            if (!run?.speech) return false;
            run.speech.abort();
            run.speech = null;
            try { deps.stopSpeaking?.(); } catch (error) { console.warn('[Scratchpad] Could not stop reading aloud', error); }
            return true;
        },
        end,
    };
}

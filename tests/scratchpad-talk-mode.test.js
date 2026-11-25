import { describe, expect, jest, test } from '@jest/globals';
import { createSilenceDetector, createTalkMode, rms, TALK_AUDIO, TALK_MAX_EMPTY_TURNS, talkPause, TALK_PAUSES } from '../public/scripts/scratchpad/talk-mode.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

function feed(detector, level, fromMs, toMs, stepMs = 50) {
    const events = [];
    for (let now = fromMs; now <= toMs; now += stepMs) {
        const event = detector.update(level, now);
        if (event) events.push([event, now]);
    }
    return events;
}

/** A talk loop wired to fakes: a microphone whose level the test sets, a transcriber, a chat and a voice. */
function harness(overrides = {}) {
    const log = [];
    let clock = 0;
    const recorders = [];
    const meters = [];
    const voice = { resolve: null };
    const audioContext = {
        resume: jest.fn(async () => {}),
        suspend: jest.fn(async () => { log.push('audio.suspend'); }),
        close: jest.fn(async () => { log.push('audio.close'); }),
    };
    const deps = {
        now: () => clock,
        createAudioContext: jest.fn(() => audioContext),
        record: jest.fn(async ({ audio, onLimit }) => {
            const track = { stop: jest.fn(() => log.push('track.stop')) };
            const recorder = {
                audio, onLimit, track, released: false, stream: { getTracks: () => [track] },
                release() {
                    if (recorder.released) return;
                    recorder.released = true;
                    track.stop();
                },
                stop: jest.fn(async () => {
                    recorder.release();
                    return { size: 3, type: 'audio/webm' };
                }),
                cancel: jest.fn(() => recorder.release()),
            };
            recorders.push(recorder);
            log.push('record');
            return recorder;
        }),
        monitor: jest.fn((stream, { audioContext: context, onLevel }) => {
            const meter = { context, onLevel, stop: jest.fn(() => { meter.stopped = true; }), stopped: false };
            meters.push(meter);
            return meter;
        }),
        toWav: jest.fn(async () => 'wav'),
        transcribe: jest.fn(async () => {
            log.push('transcribe');
            return 'Hello there';
        }),
        waitUntilReady: jest.fn(async () => {}),
        sendTurn: jest.fn(async text => {
            log.push(`send:${text}`);
            return [{ message: { id: 'r1', text: 'Hi.' }, speaker: 'Miso' }];
        }),
        canSpeak: jest.fn(() => true),
        speak: jest.fn((replies, { signal }) => new Promise(resolve => {
            log.push(`speak:${replies.map(reply => reply.speaker).join(',')}`);
            voice.resolve = resolve;
            signal.addEventListener('abort', () => resolve('stopped'), { once: true });
        })),
        stopSpeaking: jest.fn(() => log.push('voice.stop')),
        pauseMs: () => 1600,
        onChange: jest.fn(),
        onLevel: jest.fn(),
        onNotice: jest.fn(),
        onEnd: jest.fn(),
        ...overrides,
    };
    const talk = createTalkMode(deps);
    const meter = () => meters.at(-1);
    return {
        talk, deps, log, recorders, meters, audioContext, voice,
        /** Plays one level into the newest microphone meter for a while, 50 ms at a time. */
        level(value, ms) {
            for (let elapsed = 0; elapsed < ms; elapsed += 50) {
                clock += 50;
                meter().onLevel(value);
            }
        },
        /** Speaks, then goes quiet for the whole pause. */
        async sayTurn() {
            this.level(0.2, 400);
            this.level(0, 1700);
            await flush();
        },
        states: () => deps.onChange.mock.calls.map(([snapshot]) => snapshot.state),
    };
}

describe('Scratchpad talk mode pause detection', () => {
    test('needs speech to last before it counts, so a click or a cough does not start a turn', () => {
        const detector = createSilenceDetector({ speechThreshold: 0.02, speechConfirmMs: 180, silenceMs: 1600, noSpeechTimeoutMs: 20000 });
        expect(feed(detector, 0.5, 0, 100)).toEqual([]);
        expect(feed(detector, 0, 150, 1000)).toEqual([]);
        expect(detector.hasSpeech).toBe(false);
        expect(feed(detector, 0.5, 1050, 1300)).toEqual([['speech', 1250]]);
        expect(detector.hasSpeech).toBe(true);
    });

    test('ends the turn after the chosen pause, and talking again restarts the wait', () => {
        const detector = createSilenceDetector({ silenceMs: 1000 });
        feed(detector, 0.3, 0, 300);
        expect(feed(detector, 0, 350, 1000)).toEqual([]);
        expect(feed(detector, 0.3, 1050, 1100)).toEqual([]);
        expect(feed(detector, 0.01, 1150, 2100)).toEqual([]);
        expect(feed(detector, 0.01, 2150, 2200)).toEqual([['end-of-turn', 2150]]);
        expect(detector.done).toBe(true);
        expect(feed(detector, 0, 2250, 9000)).toEqual([]);
    });

    test('gives up when nobody speaks, and starts fresh after a reset', () => {
        const detector = createSilenceDetector({ noSpeechTimeoutMs: 20000 });
        expect(feed(detector, 0.01, 0, 19950)).toEqual([]);
        expect(feed(detector, 0, 20000, 21000)).toEqual([['no-speech-timeout', 20000]]);
        detector.reset();
        expect(detector.done).toBe(false);
        expect(feed(detector, 0.4, 30000, 30200)).toEqual([['speech', 30200]]);
    });

    test('offers short, normal and patient pauses and measures loudness', () => {
        expect(TALK_PAUSES.map(pause => [pause.id, pause.ms])).toEqual([['short', 1000], ['normal', 1600], ['patient', 2500]]);
        expect(talkPause('patient').ms).toBe(2500);
        expect(talkPause('unknown').id).toBe('normal');
        expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
        expect(rms(new Float32Array(0))).toBe(0);
        expect(rms(null)).toBe(0);
    });
});

describe('Scratchpad talk mode loop', () => {
    test('listens, lets go of the microphone, transcribes, sends, speaks and listens again', async () => {
        const run = harness();
        expect(run.talk.start()).toBe(true);
        expect(run.deps.createAudioContext).toHaveBeenCalledTimes(1);
        expect(run.audioContext.resume).toHaveBeenCalled();
        await flush();
        expect(run.talk.state).toBe('listening');
        expect(run.deps.record).toHaveBeenCalledWith(expect.objectContaining({ audio: TALK_AUDIO }));
        expect(TALK_AUDIO).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
        expect(run.meters[0].context).toBe(run.audioContext);

        run.level(0.2, 400);
        expect(run.talk.hearing).toBe(true);
        expect(run.deps.onLevel).toHaveBeenCalledWith(0.2);
        run.level(0, 1700);
        await flush();
        expect(run.talk.state).toBe('speaking');
        expect(run.deps.sendTurn).toHaveBeenCalledWith('Hello there', expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(run.meters[0].stop).toHaveBeenCalled();
        // The microphone and the level monitor are off before anything is transcribed, sent or spoken.
        expect(run.log.slice(0, 6)).toEqual(['record', 'track.stop', 'audio.suspend', 'transcribe', 'send:Hello there', 'speak:Miso']);
        expect(run.recorders[0].track.stop).toHaveBeenCalledTimes(1);
        expect(run.deps.onLevel).toHaveBeenLastCalledWith(0);

        run.voice.resolve('finished');
        await flush();
        expect(run.talk.state).toBe('listening');
        expect(run.deps.record).toHaveBeenCalledTimes(2);
        expect(run.states()).toEqual(['thinking', 'listening', 'listening', 'transcribing', 'thinking', 'speaking', 'thinking', 'listening']);
        expect(run.deps.onChange.mock.calls[2][0]).toEqual({ state: 'listening', hearing: true, active: true });

        expect(run.talk.end()).toBe(true);
        expect(run.recorders[1].track.stop).toHaveBeenCalledTimes(1);
        expect(run.audioContext.close).toHaveBeenCalledTimes(1);
        expect(run.deps.onEnd).toHaveBeenCalledWith('ended', null);
        expect(run.talk.snapshot()).toEqual({ state: 'idle', hearing: false, active: false });
        expect(run.talk.end()).toBe(false);
    });

    test('waits for the chat to be free before each turn', async () => {
        let ready = null;
        const run = harness({ waitUntilReady: jest.fn(() => new Promise(resolve => { ready = resolve; })) });
        run.talk.start();
        await flush();
        expect(run.talk.state).toBe('thinking');
        expect(run.deps.record).not.toHaveBeenCalled();
        ready();
        await flush();
        expect(run.talk.state).toBe('listening');
        run.talk.end();
    });

    test('uses the pause chosen when each turn starts', async () => {
        let pause = 1000;
        const run = harness({ pauseMs: () => pause });
        run.talk.start();
        await flush();
        run.level(0.2, 400);
        run.level(0, 1050);
        await flush();
        expect(run.deps.transcribe).toHaveBeenCalledTimes(1);
        pause = 2500;
        run.voice.resolve('finished');
        await flush();
        run.level(0.2, 400);
        run.level(0, 2000);
        await flush();
        expect(run.deps.transcribe).toHaveBeenCalledTimes(1);
        run.level(0, 600);
        await flush();
        expect(run.deps.transcribe).toHaveBeenCalledTimes(2);
        run.talk.end();
    });

    test('Interrupt stops the voice and goes straight back to listening', async () => {
        const run = harness();
        run.talk.start();
        await flush();
        expect(run.talk.interrupt()).toBe(false);
        await run.sayTurn();
        expect(run.talk.state).toBe('speaking');
        expect(run.talk.interrupt()).toBe(true);
        expect(run.deps.stopSpeaking).toHaveBeenCalledTimes(1);
        await flush();
        expect(run.talk.state).toBe('listening');
        expect(run.deps.record).toHaveBeenCalledTimes(2);
        expect(run.talk.active).toBe(true);
        run.talk.end();
    });

    test('Send now ends the turn without waiting for the pause', async () => {
        const run = harness();
        run.talk.start();
        await flush();
        run.level(0.2, 400);
        expect(run.talk.sendNow()).toBe(true);
        await flush();
        expect(run.recorders[0].stop).toHaveBeenCalled();
        expect(run.deps.sendTurn).toHaveBeenCalledWith('Hello there', expect.any(Object));
        expect(run.talk.state).toBe('speaking');
        expect(run.talk.sendNow()).toBe(false);
        run.talk.end();
        expect(run.deps.stopSpeaking).toHaveBeenCalledTimes(1);
    });

    test('the recording time limit ends the turn as well', async () => {
        const run = harness();
        run.talk.start();
        await flush();
        run.level(0.2, 400);
        run.recorders[0].onLimit();
        await flush();
        expect(run.deps.sendTurn).toHaveBeenCalledTimes(1);
        run.talk.end();
    });

    test(`stops after ${TALK_MAX_EMPTY_TURNS} empty transcriptions in a row, with the microphone off`, async () => {
        const empty = Object.assign(new Error('nothing heard'), { code: 'empty' });
        const run = harness({ transcribe: jest.fn(async () => { throw empty; }) });
        run.talk.start();
        await flush();
        for (let turn = 1; turn <= TALK_MAX_EMPTY_TURNS; turn++) {
            expect(run.talk.state).toBe('listening');
            await run.sayTurn();
        }
        expect(run.deps.transcribe).toHaveBeenCalledTimes(TALK_MAX_EMPTY_TURNS);
        expect(run.deps.sendTurn).not.toHaveBeenCalled();
        expect(run.deps.onEnd).toHaveBeenCalledWith('no-speech', null);
        expect(run.talk.active).toBe(false);
        expect(run.recorders.every(recorder => recorder.track.stop.mock.calls.length === 1)).toBe(true);
    });

    test('a heard turn resets the empty count', async () => {
        const empty = Object.assign(new Error('nothing heard'), { code: 'empty' });
        const answers = [empty, empty, 'Real words', empty, empty];
        const run = harness({ transcribe: jest.fn(async () => {
            const next = answers.shift();
            if (next instanceof Error) throw next;
            return next;
        }) });
        run.talk.start();
        await flush();
        await run.sayTurn();
        await run.sayTurn();
        await run.sayTurn();
        run.voice.resolve('finished');
        await flush();
        await run.sayTurn();
        await run.sayTurn();
        expect(run.talk.active).toBe(true);
        expect(run.deps.sendTurn).toHaveBeenCalledWith('Real words', expect.any(Object));
        run.talk.end();
    });

    test('stops when nobody speaks for the whole wait', async () => {
        const run = harness();
        run.talk.start();
        await flush();
        run.level(0, 20100);
        await flush();
        expect(run.deps.onEnd).toHaveBeenCalledWith('no-speech', null);
        expect(run.deps.transcribe).not.toHaveBeenCalled();
        expect(run.recorders[0].track.stop).toHaveBeenCalledTimes(1);
        expect(run.audioContext.close).toHaveBeenCalled();
    });

    test.each([
        ['the microphone cannot open', { record: jest.fn(async () => { throw Object.assign(new Error('denied'), { code: 'microphone' }); }) }],
        ['transcription fails', { transcribe: jest.fn(async () => { throw Object.assign(new Error('service down'), { code: 'service' }); }) }],
        ['the turn cannot be sent', { sendTurn: jest.fn(async () => { throw new Error('send failed'); }) }],
        ['the voice fails', { speak: jest.fn(async () => { throw new Error('voice failed'); }) }],
    ])('ends and lets go of the microphone when %s', async (_name, overrides) => {
        const run = harness(overrides);
        run.talk.start();
        await flush();
        if (run.talk.active) await run.sayTurn();
        await flush();
        expect(run.deps.onEnd).toHaveBeenCalledWith('error', expect.any(Error));
        expect(run.talk.snapshot()).toEqual({ state: 'idle', hearing: false, active: false });
        expect(run.recorders.every(recorder => recorder.released)).toBe(true);
        expect(run.audioContext.close).toHaveBeenCalledTimes(1);
    });

    test.each(['listening', 'transcribing', 'thinking', 'speaking'])('ending while %s stops the microphone and the voice at once', async state => {
        let transcribed = null;
        let replied = null;
        const run = harness({
            transcribe: jest.fn(() => new Promise(resolve => { transcribed = resolve; })),
            sendTurn: jest.fn(() => new Promise(resolve => { replied = resolve; })),
        });
        run.talk.start();
        await flush();
        if (state !== 'listening') await run.sayTurn();
        if (state === 'thinking' || state === 'speaking') {
            transcribed('Hello');
            await flush();
        }
        if (state === 'speaking') {
            replied([{ message: { id: 'r', text: 'Hi.' }, speaker: 'Miso' }]);
            await flush();
        }
        expect(run.talk.state).toBe(state);
        // Closing Scratchpad, switching session or chat, hiding the tab and Escape all end talk this way.
        run.talk.end('context');
        expect(run.recorders.every(recorder => recorder.released)).toBe(true);
        expect(run.meters.every(meter => meter.stopped)).toBe(true);
        expect(run.deps.stopSpeaking).toHaveBeenCalledTimes(state === 'speaking' ? 1 : 0);
        expect(run.deps.onEnd).toHaveBeenCalledWith('context', null);
        transcribed?.('Late words');
        replied?.([{ message: { id: 'late', text: 'Late.' }, speaker: 'Miso' }]);
        await flush();
        expect(run.deps.sendTurn).toHaveBeenCalledTimes(state === 'listening' || state === 'transcribing' ? 0 : 1);
        expect(run.deps.speak).toHaveBeenCalledTimes(state === 'speaking' ? 1 : 0);
        expect(run.deps.record).toHaveBeenCalledTimes(1);
    });

    test('without text to speech it says so once and keeps listening, with replies left as text', async () => {
        const run = harness({ canSpeak: jest.fn(() => false) });
        run.talk.start();
        await flush();
        await run.sayTurn();
        expect(run.talk.state).toBe('listening');
        await run.sayTurn();
        expect(run.deps.sendTurn).toHaveBeenCalledTimes(2);
        expect(run.deps.speak).not.toHaveBeenCalled();
        expect(run.deps.onNotice).toHaveBeenCalledTimes(1);
        expect(run.deps.onNotice).toHaveBeenCalledWith('tts-off');
        run.talk.end();
    });

    test('text to speech declining mid-talk is reported once too', async () => {
        const run = harness({ speak: jest.fn(async () => 'unavailable') });
        run.talk.start();
        await flush();
        await run.sayTurn();
        await run.sayTurn();
        expect(run.deps.speak).toHaveBeenCalledTimes(2);
        expect(run.deps.onNotice).toHaveBeenCalledTimes(1);
        expect(run.talk.state).toBe('listening');
        run.talk.end();
    });

    test('a reply with only a change card goes back to listening without reading, saving or accepting anything', async () => {
        const run = harness({ sendTurn: jest.fn(async () => []) });
        run.talk.start();
        await flush();
        await run.sayTurn();
        expect(run.deps.speak).not.toHaveBeenCalled();
        expect(run.talk.state).toBe('listening');
        expect(Object.keys(run.deps)).not.toContain('saveChange');
        run.talk.end();
    });

    test('several replies are handed to the voice together, in order', async () => {
        const replies = [{ message: { id: 'a', text: 'One.' }, speaker: 'Miso' }, { message: { id: 'b', text: 'Two.' }, speaker: 'Taro' }];
        const run = harness({ sendTurn: jest.fn(async () => replies) });
        run.talk.start();
        await flush();
        await run.sayTurn();
        expect(run.deps.speak).toHaveBeenCalledWith(replies, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(run.log).toContain('speak:Miso,Taro');
        run.talk.end();
    });

    test('still runs without an audio context, ending turns with Send now', async () => {
        const run = harness({ createAudioContext: () => null });
        run.talk.start();
        await flush();
        expect(run.deps.monitor).not.toHaveBeenCalled();
        expect(run.talk.sendNow()).toBe(true);
        await flush();
        expect(run.deps.sendTurn).toHaveBeenCalledTimes(1);
        run.talk.end();
        expect(run.recorders.every(recorder => recorder.released)).toBe(true);
    });
});

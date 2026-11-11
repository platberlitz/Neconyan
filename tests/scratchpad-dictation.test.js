/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/script.js', () => ({
    getRequestHeaders: ({ omitContentType = false } = {}) => ({ 'X-CSRF-Token': 'token', ...(omitContentType ? {} : { 'Content-Type': 'application/json' }) }),
}));

const { canDictate, DICTATION_RATE, DICTATION_SERVICES, DictationError, dictationService, encodeWav, MAX_DICTATION_SECONDS, mixToMono, recordingToWav, startRecording, transcribeWav }
    = await import('../public/scripts/scratchpad/dictation.js');

const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const code = async promise => {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(DictationError);
        return error.code;
    }
    return 'resolved';
};
const saved = {};
const setGlobal = (name, value) => {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

afterEach(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
        delete saved[name];
    }
    jest.useRealTimers();
});

describe('Scratchpad dictation', () => {
    test('encodes mono samples as 16-bit WAV at the dictation rate', () => {
        const wav = encodeWav(new Float32Array([0, 1, -1, 2, Number.NaN]));
        const view = new DataView(wav.buffer);
        const text = (offset, length) => String.fromCharCode(...wav.subarray(offset, offset + length));
        expect(wav).toHaveLength(54);
        expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
        expect(view.getUint32(4, true)).toBe(46);
        expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)])
            .toEqual([1, 1, DICTATION_RATE, DICTATION_RATE * 2, 2, 16]);
        expect(view.getUint32(40, true)).toBe(10);
        expect([0, 1, 2, 3, 4].map(index => view.getInt16(44 + index * 2, true))).toEqual([0, 32767, -32768, 32767, 0]);
    });

    test('averages every channel into one', () => {
        const channels = [new Float32Array([1, 0, 0.5]), new Float32Array([0, 0, 0.5])];
        const mono = mixToMono({ numberOfChannels: 2, length: 3, getChannelData: index => channels[index] });
        expect([...mono]).toEqual([0.5, 0, 0.5]);
    });

    test('turns a recording into WAV by decoding it at the dictation rate', async () => {
        const made = [];
        setGlobal('OfflineAudioContext', class {
            constructor(...args) { made.push(args); }
            async decodeAudioData(buffer) {
                if (buffer.byteLength === 1) throw new Error('unreadable');
                const length = buffer.byteLength === 2 ? 0 : 4;
                return { numberOfChannels: 1, length, sampleRate: DICTATION_RATE, getChannelData: () => new Float32Array(length).fill(0.5) };
            }
        });
        const wav = await recordingToWav({ arrayBuffer: async () => new ArrayBuffer(8) });
        expect(made).toEqual([[1, 1, DICTATION_RATE]]);
        expect(wav).toHaveLength(52);
        expect(await code(recordingToWav({ arrayBuffer: async () => new ArrayBuffer(1) }))).toBe('audio');
        expect(await code(recordingToWav({ arrayBuffer: async () => new ArrayBuffer(2) }))).toBe('empty');
        setGlobal('OfflineAudioContext', undefined);
        expect(await code(recordingToWav({ arrayBuffer: async () => new ArrayBuffer(8) }))).toBe('unsupported');
    });

    test('sends WAV to this server as a data address and to key services as an upload', async () => {
        const wav = encodeWav(new Float32Array([0.25, -0.25]));
        const fetch = jest.fn(async () => answer({ text: '  Hello\n there.  ' }));
        expect(await transcribeWav(wav, 'local', { fetch })).toBe('Hello there.');
        let [path, request] = fetch.mock.calls[0];
        expect(path).toBe('/api/speech/recognize');
        expect(request.headers).toEqual({ 'X-CSRF-Token': 'token', 'Content-Type': 'application/json' });
        const body = JSON.parse(request.body);
        expect(Object.keys(body)).toEqual(['audio']);
        expect(Buffer.from(body.audio.replace('data:audio/wav;base64,', ''), 'base64')).toEqual(Buffer.from(wav));

        for (const service of DICTATION_SERVICES.filter(item => item.id !== 'local')) {
            await transcribeWav(wav, service.id, { fetch });
            [path, request] = fetch.mock.calls.at(-1);
            expect(path).toBe(service.path);
            expect(request.headers).toEqual({ 'X-CSRF-Token': 'token' });
            expect(request.body.get('model')).toBe(service.model);
            const file = request.body.get('avatar');
            expect([file.name, file.type, file.size]).toEqual(['audio.wav', 'audio/wav', wav.length]);
        }
        expect(DICTATION_SERVICES.map(service => service.id)).toEqual(['local', 'openai', 'groq', 'mistral']);
        expect(dictationService('nonsense').id).toBe('local');
    });

    test('names why a transcription failed', async () => {
        const wav = encodeWav(new Float32Array(2));
        expect(await code(transcribeWav(wav, 'groq', { fetch: async () => answer({}, 400) }))).toBe('key');
        expect(await code(transcribeWav(wav, 'local', { fetch: async () => answer({}, 400) }))).toBe('service');
        expect(await code(transcribeWav(wav, 'openai', { fetch: async () => answer({}, 500) }))).toBe('service');
        expect(await code(transcribeWav(wav, 'openai', { fetch: async () => { throw new Error('offline'); } }))).toBe('service');
        expect(await code(transcribeWav(wav, 'openai', { fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('html'); } }) }))).toBe('service');
        expect(await code(transcribeWav(wav, 'openai', { fetch: async () => answer({ text: ' \n ' }) }))).toBe('empty');
        expect(await code(transcribeWav(wav, 'openai', { fetch: async () => answer({}) }))).toBe('empty');
    });

    test('records, releases the microphone and stops at the time limit', async () => {
        expect(canDictate()).toBe(false);
        expect(await code(startRecording())).toBe('unsupported');

        const tracks = [{ stop: jest.fn() }];
        const getUserMedia = jest.fn(async () => ({ getTracks: () => tracks }));
        setGlobal('navigator', { mediaDevices: { getUserMedia } });
        const recorders = [];
        setGlobal('MediaRecorder', class {
            constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
            start() { this.state = 'recording'; }
            stop() {
                this.state = 'inactive';
                this.ondataavailable({ data: new Blob(['abc']) });
                this.ondataavailable({ data: new Blob([]) });
                this.onstop();
            }
        });
        expect(canDictate()).toBe(true);

        jest.useFakeTimers();
        const onLimit = jest.fn();
        const recording = await startRecording({ onLimit });
        expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(recorders[0].state).toBe('recording');
        jest.advanceTimersByTime(MAX_DICTATION_SECONDS * 1000 - 1);
        expect(onLimit).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(onLimit).toHaveBeenCalledTimes(1);
        const blob = await recording.stop();
        expect([blob.size, blob.type]).toEqual([3, 'audio/webm']);
        expect(tracks[0].stop).toHaveBeenCalledTimes(1);
        expect(await recording.stop()).toBe(blob);

        const cancelled = await startRecording({ onLimit });
        cancelled.cancel();
        expect(recorders[1].state).toBe('inactive');
        expect(tracks[0].stop).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(MAX_DICTATION_SECONDS * 1000);
        expect(onLimit).toHaveBeenCalledTimes(1);

        getUserMedia.mockRejectedValueOnce(new Error('denied'));
        expect(await code(startRecording())).toBe('microphone');
    });
});

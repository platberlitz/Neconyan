import { getRequestHeaders } from '../../script.js';

export const MAX_DICTATION_SECONDS = 120;
export const DICTATION_RATE = 16000;

/** Transcription routes the server already offers. Every one receives 16 kHz mono WAV. */
export const DICTATION_SERVICES = Object.freeze([
    Object.freeze({ id: 'local', path: '/api/speech/recognize' }),
    Object.freeze({ id: 'openai', path: '/api/openai/transcribe-audio', model: 'whisper-1' }),
    Object.freeze({ id: 'groq', path: '/api/openai/groq/transcribe-audio', model: 'whisper-large-v3-turbo' }),
    Object.freeze({ id: 'mistral', path: '/api/openai/mistral/transcribe-audio', model: 'voxtral-mini-latest' }),
]);

export class DictationError extends Error {
    /** code: 'unsupported' | 'microphone' | 'audio' | 'key' | 'service' | 'empty' */
    constructor(code, cause) {
        super(code);
        this.name = 'DictationError';
        this.code = code;
        this.cause = cause;
    }
}

export function dictationService(id) {
    return DICTATION_SERVICES.find(service => service.id === id) ?? DICTATION_SERVICES[0];
}

export function canDictate() {
    return typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function' && typeof globalThis.MediaRecorder === 'function';
}

/** 16-bit PCM WAV bytes for mono samples between -1 and 1. */
export function encodeWav(samples, rate = DICTATION_RATE) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
        view.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
    }
    return bytes;
}

/** Averages the channels of a decoded recording into one. */
export function mixToMono(buffer) {
    const channels = buffer.numberOfChannels;
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < channels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channels;
    }
    return mono;
}

/** Whatever format the browser recorded becomes WAV, since the server labels every upload as WAV. */
export async function recordingToWav(blob) {
    const Offline = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (typeof Offline !== 'function') throw new DictationError('unsupported');
    let decoded;
    try {
        // Decoding in a 16 kHz context resamples the recording to that rate.
        decoded = await new Offline(1, 1, DICTATION_RATE).decodeAudioData(await blob.arrayBuffer());
    } catch (error) {
        throw new DictationError('audio', error);
    }
    if (!decoded?.length) throw new DictationError('empty');
    return encodeWav(mixToMono(decoded), decoded.sampleRate || DICTATION_RATE);
}

function dataUri(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Sends WAV bytes to the chosen service and resolves to the text it heard. */
export async function transcribeWav(wav, serviceId, { fetch = globalThis.fetch, signal } = {}) {
    const service = dictationService(serviceId);
    let response;
    try {
        if (service.id === 'local') {
            response = await fetch(service.path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ audio: dataUri(wav) }), cache: 'no-store', signal });
        } else {
            const form = new FormData();
            form.append('avatar', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
            form.append('model', service.model);
            response = await fetch(service.path, { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form, cache: 'no-store', signal });
        }
    } catch (error) {
        throw new DictationError('service', error);
    }
    // The remote routes answer 400 only when the account has no key saved for that service.
    if (!response.ok) throw new DictationError(response.status === 400 && service.id !== 'local' ? 'key' : 'service');
    let text = '';
    try {
        text = String((await response.json())?.text ?? '');
    } catch (error) {
        throw new DictationError('service', error);
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) throw new DictationError('empty');
    return text;
}

/**
 * Starts recording from the microphone. `stop()` resolves to the recording, `cancel()` throws it away;
 * either way the microphone is released. `onLimit` runs once when the longest recording time is reached.
 */
export async function startRecording({ onLimit, maxSeconds = MAX_DICTATION_SECONDS } = {}) {
    if (!canDictate()) throw new DictationError('unsupported');
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
        throw new DictationError('microphone', error);
    }
    const release = () => { for (const track of stream.getTracks()) track.stop(); };
    let recorder;
    try {
        recorder = new MediaRecorder(stream);
    } catch (error) {
        release();
        throw new DictationError('unsupported', error);
    }
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    let ended = null;
    const end = () => ended ??= new Promise(resolve => {
        clearTimeout(timer);
        const done = () => { release(); resolve(new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || '' })); };
        if (recorder.state === 'inactive') return done();
        recorder.onstop = done;
        recorder.onerror = done;
        try { recorder.stop(); } catch { done(); }
    });
    const timer = setTimeout(() => onLimit?.(), maxSeconds * 1000);
    try {
        recorder.start();
    } catch (error) {
        clearTimeout(timer);
        release();
        throw new DictationError('unsupported', error);
    }
    return {
        stop: end,
        cancel: () => { void end(); },
    };
}

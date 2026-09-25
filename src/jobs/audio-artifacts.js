import crypto from 'node:crypto';
import path from 'node:path';
import { createRoleplayDirectory, readRoleplayFile } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';
import { getJob, jobKey } from './store.js';
import { readArtifact, writeArtifact } from './artifacts.js';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { status: 409, code: 'TTS_RESULT_RECOVERY' });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateWave(data) {
    if (data.length < 44) throw fail('The speech WAV header is incomplete.');
    const declared = data.readUInt32LE(4);
    if (declared !== 0xffffffff && declared + 8 !== data.length) throw fail('The speech WAV container is incomplete.');
    let format;
    const lengths = [];
    for (let offset = 12; offset < data.length;) {
        if (offset + 8 > data.length) throw fail('The speech WAV chunk header is incomplete.');
        const id = data.toString('ascii', offset, offset + 4);
        let length = data.readUInt32LE(offset + 4);
        const start = offset + 8;
        // Some complete HTTP speech responses retain an explicitly streaming data length.
        if (length === 0xffffffff && id === 'data') length = data.length - start;
        if (start + length > data.length) throw fail('The speech WAV chunk is incomplete.');
        if (id === 'fmt ') {
            if (format || length < 16) throw fail('The speech WAV sample format is invalid.');
            let encoding = data.readUInt16LE(start);
            const channels = data.readUInt16LE(start + 2);
            const rate = data.readUInt32LE(start + 4);
            const byteRate = data.readUInt32LE(start + 8);
            const alignment = data.readUInt16LE(start + 12);
            const bits = data.readUInt16LE(start + 14);
            if (encoding === 0xfffe) {
                if (length < 40 || data.readUInt16LE(start + 16) < 22 || data.readUInt16LE(start + 18) > bits
                    || data.subarray(start + 28, start + 40).toString('hex') !== '00001000800000aa00389b71') throw fail('The speech WAV extended format is invalid.');
                encoding = data.readUInt32LE(start + 24);
            }
            if (!([1, 3].includes(encoding)) || channels < 1 || channels > 8 || rate < 8000 || rate > 384000
                || !(encoding === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits)
                || alignment !== channels * bits / 8 || byteRate !== rate * alignment) throw fail('The speech WAV sample format is invalid.');
            format = { alignment };
        }
        if (id === 'data') lengths.push(length);
        offset = start + length + (length % 2);
        if (offset > data.length) throw fail('The speech WAV chunk padding is incomplete.');
    }
    if (!format || !lengths.some(length => length > 0) || lengths.some(length => length % format.alignment)) throw fail('The speech WAV samples are missing or incomplete.');
}

/** Validate the actual container rather than a provider's Content-Type header. */
export function audioFormat(bytes) {
    const data = Buffer.from(bytes);
    if (data.length < 4 || data.length > MAX_AUDIO_BYTES) throw fail('The speech result is empty or too large.');
    if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
        validateWave(data);
        return { mimeType: 'audio/wav', format: 'wav' };
    }
    if (data.toString('ascii', 0, 4) === 'OggS') return { mimeType: 'audio/ogg', format: 'ogg' };
    if (data.toString('ascii', 0, 4) === 'fLaC') return { mimeType: 'audio/flac', format: 'flac' };
    if (data.readUInt32BE(0) === 0x1a45dfa3) return { mimeType: 'audio/webm', format: 'webm' };
    if (data.length > 12 && data.toString('ascii', 4, 8) === 'ftyp') return { mimeType: 'audio/mp4', format: 'm4a' };
    if (data.toString('ascii', 0, 3) === 'ID3' || data[0] === 0xff && (data[1] & 0xe0) === 0xe0 && (data[1] & 0x06) !== 0) {
        return { mimeType: 'audio/mpeg', format: 'mp3' };
    }
    if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return { mimeType: 'audio/aac', format: 'aac' };
    throw fail('The speech provider did not return a supported audio container.');
}

export function pcmWave(samples, { sampleRate = 24000, channels = 1, float = false } = {}) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
        || !Number.isSafeInteger(channels) || channels < 1 || channels > 8) throw fail('The speech sample format is invalid.');
    let pcm;
    if (float) {
        const values = samples instanceof Float32Array ? samples : new Float32Array(samples);
        if (values.length * 2 + 44 > MAX_AUDIO_BYTES) throw fail('The speech result is too large.');
        pcm = Buffer.alloc(values.length * 2);
        for (let i = 0; i < values.length; i++) {
            if (!Number.isFinite(values[i])) throw fail('The speech samples are invalid.');
            const value = Math.max(-1, Math.min(1, values[i]));
            pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
        }
    } else pcm = Buffer.from(samples);
    if (!pcm.length || pcm.length % (2 * channels) || pcm.length + 44 > MAX_AUDIO_BYTES) throw fail('The speech samples are incomplete.');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

export function audioResult(bytes) {
    return { base64: Buffer.from(bytes).toString('base64'), ...audioFormat(bytes) };
}

function filePath(directories, id, name, create = false) {
    if (!getJob(directories, id)) throw fail('The speech job no longer exists.');
    const root = path.resolve(directories.root);
    const parent = path.join(root, 'jobs', 'artifacts', jobKey(id));
    if (create) createRoleplayDirectory(parent, root);
    return path.join(parent, `${jobKey(name)}.audio`);
}

/** Caller holds the account lock. A small durable receipt keeps large audio outside the JSON budget. */
export function writeAudioArtifact(directories, id, name, value) {
    const bytes = typeof value?.base64 === 'string' ? Buffer.from(value.base64, 'base64') : Buffer.alloc(0);
    const format = audioFormat(bytes);
    if (value.mimeType !== format.mimeType) throw fail('The speech format differs from its bytes.');
    const filename = filePath(directories, id, name, true);
    const existing = readRoleplayFile(filename, MAX_AUDIO_BYTES);
    if (existing && !existing.bytes.equals(bytes)) throw fail('The saved speech bytes differ from this result.');
    if (!existing) tryWriteFileSync(filename, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const confirmed = readRoleplayFile(filename, MAX_AUDIO_BYTES, { flush: true });
    if (!confirmed || !confirmed.bytes.equals(bytes)) throw fail('The speech file could not be confirmed.');
    const receipt = { audioArtifact: 1, byteLength: bytes.length, digest: digest(bytes), ...format };
    const previous = readArtifact(directories, id, name);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(receipt)) throw fail('The saved speech receipt differs.');
    if (previous === undefined) writeArtifact(directories, id, name, receipt);
    return { ...value, ...format };
}

export function readAudioArtifact(directories, id, name) {
    const receipt = readArtifact(directories, id, name);
    if (receipt === undefined) return undefined;
    if (receipt?.audioArtifact !== 1) {
        // Accepted narration from before binary receipts remains playable.
        if (receipt?.ok === false) return receipt;
        const bytes = typeof receipt?.base64 === 'string' ? Buffer.from(receipt.base64, 'base64') : Buffer.alloc(0);
        const format = audioFormat(bytes);
        if (format.mimeType !== receipt.mimeType) throw fail('The legacy speech receipt is invalid.');
        return { ...receipt, ...format };
    }
    if (!Number.isSafeInteger(receipt.byteLength) || receipt.byteLength < 1 || receipt.byteLength > MAX_AUDIO_BYTES
        || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw fail('The saved speech receipt is invalid.');
    const file = readRoleplayFile(filePath(directories, id, name), MAX_AUDIO_BYTES, { allowMissingParent: true });
    if (!file || file.bytes.length !== receipt.byteLength || digest(file.bytes) !== receipt.digest) throw fail('The saved speech file changed or is missing.');
    const result = audioResult(file.bytes);
    if (result.mimeType !== receipt.mimeType || result.format !== receipt.format) throw fail('The saved speech format changed.');
    return result;
}

export const audioArtifactStore = Object.freeze({ readResult: readAudioArtifact, writeResult: writeAudioArtifact });

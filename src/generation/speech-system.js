import { spawn } from 'node:child_process';
import { speechError } from './speech-config.js';
import { MAX_AUDIO_BYTES } from '../jobs/audio-artifacts.js';
import { speechNumber } from './speech-local-requests.js';

function commandOutput(command, args, text, signal, limit) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], signal, windowsHide: true });
        const chunks = [];
        let size = 0, settled = false;
        const end = (error, bytes) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            error ? reject(error) : resolve(bytes);
        };
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            end(speechError('The installed system voice did not finish.', 'TTS_PROVIDER', 504));
        }, 120000);
        child.on('error', () => end(signal?.aborted ? signal.reason : speechError('The selected system speech program is unavailable.', 'TTS_SYSTEM_UNAVAILABLE')));
        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                child.kill('SIGKILL');
                end(speechError('The system speech result is too large.'));
            } else chunks.push(chunk);
        });
        child.stdin.on('error', () => end(speechError('The system speech request could not be read.')));
        child.on('close', code => end(code === 0 ? null : speechError('The installed system voice did not finish.', 'TTS_PROVIDER', 502), Buffer.concat(chunks)));
        child.stdin.end(text);
    });
}

/** Only an exact installed voice is portable; browser-only voice identities are never substituted. */
export async function listSystemSpeechVoices(config, signal) {
    const bytes = await commandOutput(config.systemCommand, ['--voices'], '', signal, 2 * 1024 * 1024);
    return bytes.toString('utf8').split(/\r?\n/).slice(1).flatMap(line => {
        const fields = line.trim().split(/\s+/);
        return fields.length >= 5 && /^\d+$/.test(fields[0]) ? [{ id: fields[3], name: fields[3], lang: fields[1] }] : [];
    });
}

export async function synthesizeSystemSpeech(config, segment, signal) {
    const rate = speechNumber(config.settings, 'rate', 1, 0.1, 2);
    const pitch = speechNumber(config.settings, 'pitch', 1, 0, 2);
    const bytes = await commandOutput(config.systemCommand, ['--stdout', '--stdin', '-v', segment.voice.id,
        '-s', String(Math.round(175 * rate)), '-p', String(Math.round(50 * pitch))], segment.text, signal, MAX_AUDIO_BYTES);
    // Standard output has no seekable length when synthesis starts. Finish its WAV sizes after EOF.
    if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 36, 40) === 'data') {
        bytes.writeUInt32LE(bytes.length - 8, 4);
        bytes.writeUInt32LE(bytes.length - 44, 40);
    }
    return bytes;
}

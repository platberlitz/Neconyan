import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { speechJson } from './speech-voices.js';
import { speechError } from './speech-config.js';
import { speechNumber } from './speech-local-requests.js';
import { MAX_AUDIO_BYTES } from '../jobs/audio-artifacts.js';

const CLIENT = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VERSION = '143.0.3650.75';
const BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[char]);

function query(now) {
    const seconds = BigInt(Math.floor(now / 1000)) + 11644473600n;
    const ticks = (seconds - seconds % 300n) * 10000000n;
    const gec = createHash('sha256').update(`${ticks}${CLIENT}`).digest('hex').toUpperCase();
    return new URLSearchParams({ TrustedClientToken: CLIENT, 'Sec-MS-GEC': gec, 'Sec-MS-GEC-Version': `1-${VERSION}` });
}

export async function listEdgeSpeechVoices({ signal, fetchImpl = fetch, now = Date.now() } = {}) {
    const voices = await speechJson(`https://${BASE}/voices/list?${query(now)}`, { signal, fetchImpl,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!Array.isArray(voices)) throw speechError('The Edge speech voice list is invalid.');
    return voices.map(voice => ({ id: voice.ShortName, name: voice.ShortName, lang: voice.Locale }));
}

/** One recorded synthesis per socket; a disconnected or incomplete turn is never retried here. */
export async function synthesizeEdgeSpeech(config, segment, signal, { socketFactory = (url, options) => new WebSocket(url, options), now = Date.now() } = {}) {
    signal?.throwIfAborted();
    const text = xml(segment.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' '));
    if (Buffer.byteLength(text) > 4096) throw speechError('The Edge speech segment is too large.');
    const rate = Math.trunc(speechNumber(config.settings, 'rate', 0, -100, 100));
    const parameters = query(now);
    parameters.set('ConnectionId', segment.id.slice(0, 32));
    const date = new Date(now).toUTCString();
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${xml(segment.voice.id)}'><prosody pitch='+0Hz' rate='${rate < 0 ? '' : '+'}${rate}%' volume='+0%'>${text}</prosody></voice></speak>`;
    return new Promise((resolve, reject) => {
        const socket = socketFactory(`wss://${BASE}/edge/v1?${parameters}`, { handshakeTimeout: 15000, maxPayload: MAX_AUDIO_BYTES,
            followRedirects: false, headers: { 'User-Agent': USER_AGENT, Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
                'Cache-Control': 'no-cache', Pragma: 'no-cache', Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};` } });
        const chunks = [];
        let size = 0, settled = false;
        const end = (error, bytes) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            socket.close();
            error ? reject(error) : resolve(bytes);
        };
        const abort = () => { end(signal.reason); socket.terminate(); };
        const timeout = setTimeout(() => { end(speechError('Edge speech did not finish.', 'TTS_PROVIDER', 504)); socket.terminate(); }, 120000);
        signal?.addEventListener('abort', abort, { once: true });
        socket.on('open', () => {
            socket.send(`X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
                context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } },
            })}\r\n`);
            socket.send(`X-RequestId:${segment.id.slice(0, 32)}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n${ssml}`);
        });
        socket.on('message', (data, binary) => {
            if (settled) return;
            try {
                const bytes = Buffer.from(data);
                if (binary) {
                    if (bytes.length < 2) throw new Error();
                    const length = bytes.readUInt16BE(0);
                    if (length + 2 > bytes.length) throw new Error();
                    const headers = bytes.subarray(2, length + 2).toString('utf8');
                    const audio = bytes.subarray(length + 2);
                    if (!/(?:^|\r\n)Path:audio(?:\r\n|$)/i.test(headers) || audio.length && !/Content-Type:audio\/mpeg/i.test(headers)) throw new Error();
                    size += audio.length;
                    if (size > MAX_AUDIO_BYTES) throw new Error();
                    if (audio.length) chunks.push(audio);
                } else {
                    const header = bytes.toString('utf8').split('\r\n\r\n')[0];
                    const path = /(?:^|\r\n)Path:([^\r\n]+)/i.exec(header)?.[1];
                    if (path === 'turn.end') {
                        if (!size) throw new Error();
                        end(null, Buffer.concat(chunks));
                    } else if (!['turn.start', 'response', 'audio.metadata'].includes(path)) throw new Error();
                }
            } catch { end(speechError('Edge returned an incomplete or invalid speech turn.', 'TTS_RESULT_RECOVERY')); }
        });
        socket.on('error', () => end(speechError('The Edge speech connection failed.', 'TTS_PROVIDER', 502)));
        socket.on('close', () => { if (!settled) end(speechError('Edge speech closed before completing.', 'TTS_RESULT_RECOVERY')); });
    });
}

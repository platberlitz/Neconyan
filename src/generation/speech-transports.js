import { GEMINI_SAFETY, VERTEX_SAFETY } from '../constants.js';
import { audioResult, pcmWave, MAX_AUDIO_BYTES } from '../jobs/audio-artifacts.js';
import { speechError } from './speech-config.js';
import { isDefiniteProviderRefusal } from '../jobs/artifacts.js';
import { speechJson } from './speech-voices.js';
import { localSpeechRequest, speechNumber as n } from './speech-local-requests.js';
import { prepareGoogleRequestHeaders } from './caption-transports.js';
import { readResponseArrayBuffer, readResponseText, normalizeImageSource } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { pollinationsSpeechModel } from '../endpoints/speech-transports.js';

const endpointQueues = new Map();
const bearer = key => key ? { Authorization: `Bearer ${key}` } : {};
const request = (url, body, headers = {}, response = 'audio') => ({ url, method: 'POST', response,
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const escapeXml = text => String(text).replace(/[<>&"']/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[value]);

/** Serialise native callers sharing mutable local synthesis controls, without holding the account lock. */
export async function withSpeechEndpoint(endpoint, operation) {
    const previous = endpointQueues.get(endpoint) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    endpointQueues.set(endpoint, current);
    await previous.catch(() => {});
    try { return await operation(); } finally {
        release();
        if (endpointQueues.get(endpoint) === current) endpointQueues.delete(endpoint);
    }
}

function languageMiniMax(lang) {
    const map = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish',
        pt: 'Portuguese', it: 'Italian', ar: 'Arabic', ru: 'Russian', tr: 'Turkish', nl: 'Dutch', uk: 'Ukrainian',
        vi: 'Vietnamese', id: 'Indonesian', th: 'Thai', pl: 'Polish', ro: 'Romanian', el: 'Greek', cs: 'Czech', fi: 'Finnish', hi: 'Hindi' };
    return lang === 'zh-TW' || lang === 'yue' ? 'Chinese,Yue' : map[String(lang ?? '').split('-')[0]];
}

/** Complete private request, including read-only auth preparation; caller saves only its digest. */
export async function prepareSpeechTransport(config, segment, { signal, fetchImpl = fetch } = {}) {
    const { provider, settings: s, key } = config;
    const { text, voice, seed, instructions } = segment;
    let result = localSpeechRequest(config, segment);
    if (!result && ['OpenAI', 'OpenAI Compatible'].includes(provider)) {
        result = request(provider === 'OpenAI' ? 'https://api.openai.com/v1/audio/speech' : config.endpoint, {
            input: text, voice: voice.id, model: s.model || 'tts-1', speed: n(s, 'speed', 1, 0.25, 4),
            response_format: s.response_format || 'wav', ...(instructions ? { instructions } : {}),
        }, bearer(key));
        result.pcm = s.response_format === 'pcm';
    } else if (!result && provider === 'Pollinations') result = request('https://gen.pollinations.ai/v1/audio/speech', {
        model: pollinationsSpeechModel(s.model), input: text, voice: voice.id,
    }, bearer(key));
    else if (!result && provider === 'Chutes') {
        if (s.model && s.model !== 'kokoro') throw speechError('The saved Chutes speech model is unsupported.');
        result = request('https://chutes-kokoro.chutes.ai/speak', { text, voice: voice.id, speed: n(s, 'speed', 1, 0.1, 10) }, bearer(key));
    } else if (!result && provider === 'ElevenLabs') {
        const model = s.model || 'eleven_turbo_v2_5';
        const modern = ['eleven_v3', 'eleven_ttv_v3', 'eleven_multilingual_v2', 'eleven_multilingual_ttv_v2'].includes(model);
        result = request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.id)}`, {
            model_id: model, text, voice_settings: { stability: n(s, 'stability', 0.75, 0, 1), similarity_boost: n(s, 'similarity_boost', 0.75, 0, 1),
                speed: n(s, 'speed', 1, 0.1, 10), ...(modern ? { style: n(s, 'style_exaggeration', 0, 0, 1), use_speaker_boost: s.speaker_boost !== false } : {}) },
        }, { 'xi-api-key': key });
    } else if (!result && provider === 'Azure') result = { url: `${config.endpoint}/v1`, method: 'POST', response: 'audio',
        headers: { 'Content-Type': 'application/ssml+xml', 'Ocp-Apim-Subscription-Key': key, 'X-Microsoft-OutputFormat': 'webm-24khz-16bit-mono-opus' },
        body: `<speak version='1.0' xml:lang='${escapeXml(voice.id.split('-').slice(0, 2).join('-'))}'><voice name='${escapeXml(voice.id)}'>${escapeXml(text)}</voice></speak>` };
    else if (!result && provider === 'Novel') result = { url: `https://api.novelai.net/ai/generate-voice?${new URLSearchParams({
        text, voice: '-1', seed: voice.id, opus: 'false', version: 'v2' })}`, method: 'GET', headers: { ...bearer(key), Accept: 'audio/mpeg' }, response: 'audio' };
    else if (!result && provider === 'Google Translate') {
        if (text.length > 200) throw speechError('A Google Translate speech part is too long.');
        const params = new URLSearchParams({ rpcids: 'jQ1olc', 'source-path': '/', 'f.sid': '', bl: '', hl: 'en-US',
            'soc-app': '1', 'soc-platform': '1', 'soc-device': '1', _reqid: String(1000 + seed % 9000), rt: 'c' });
        result = { url: `https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?${params}`, method: 'POST', response: 'google-translate',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: `f.req=${encodeURIComponent(JSON.stringify([[['jQ1olc', JSON.stringify([text, voice.id, true]), null, '0']]]))}&` };
    } else if (!result && provider === 'Google Gemini TTS') result = request(config.google.url, {
        contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.id } } } },
        safetySettings: [...GEMINI_SAFETY, ...(config.google.api === 'vertexai' ? VERTEX_SAFETY : [])],
    }, { ...await prepareGoogleRequestHeaders(config.google, { signal, fetchImpl }), ...config.google.headers }, 'google-audio');
    else if (!result && provider === 'Electron Hub') {
        const model = s.model || 'tts-1';
        const body = { input: text, voice: voice.id, speed: n(s, 'speed', 1), temperature: n(s, 'temperature', 1), model, response_format: 'mp3' };
        for (const name of voice.model?.parameters ?? []) {
            if (!['input', 'voice', 'model', 'response_format', 'voiceMap', 'provider_endpoint', 'api_key'].includes(name)
                && s[name] !== undefined && ['string', 'number', 'boolean'].includes(typeof s[name])) body[name] = s[name];
        }
        if (model.includes('gpt-4o-mini-tts') && (instructions || s.instructions)) body.instructions = instructions || s.instructions;
        if (/dia/i.test(model)) Object.assign(body, { speaker_transcript: s.speaker_transcript || '', cfg_filter_top_k: n(s, 'cfg_filter_top_k', 25), cfg_scale: n(s, 'cfg_scale', 3) });
        if (/microsoft/i.test(model)) Object.assign(body, { speech_rate: n(s, 'speech_rate', 0), pitch_adjustment: n(s, 'pitch_adjustment', 0), emotional_style: s.emotional_style || '' });
        if ((voice.model?.parameters ?? []).includes('top_p')) body.top_p = n(s, 'top_p', 1, 0, 1);
        result = request('https://api.electronhub.ai/v1/audio/speech', body, bearer(key));
    } else if (!result && provider === 'MiniMax') {
        const lang = languageMiniMax(voice.lang);
        result = request(`${config.endpoint}/v1/t2a_v2?${new URLSearchParams({ GroupId: config.groupId })}`, {
            model: s.model || 'speech-02-hd', text, stream: false, voice_setting: { voice_id: voice.id,
                speed: n(s, 'speed', 1, 0.5, 2), vol: n(s, 'volume', 1, 0, 10), pitch: n(s, 'pitch', 0, -12, 12) },
            audio_setting: { sample_rate: n(s, 'audioSampleRate', 32000, 8000, 192000), bitrate: n(s, 'bitrate', 128000, 1000), format: s.format || 'mp3', channel: 1 },
            ...(lang ? { lang } : {}),
        }, { ...bearer(key), 'MM-API-Source': 'SillyTavern-TTS' }, 'minimax');
        result.pcm = s.format === 'pcm';
        result.sampleRate = n(s, 'audioSampleRate', 32000, 8000, 192000);
    } else if (!result && provider === 'Volcengine') result = request(config.endpoint, {
        req_params: { text: text.split('...').join(''), speaker: voice.id, audio_params: { format: 'mp3', speech_rate: n(s, 'speed', 0, -50, 100) },
            additions: JSON.stringify({ mute_cut_threshold: '400', mute_cut_remain_ms: '1', explicit_language: 'crosslingual',
                enable_language_detector: true, disable_markdown_filter: true, cache_config: { use_cache: true, text_type: 1 } }) },
    }, { 'X-Api-App-Id': config.appId, 'X-Api-Access-Key': config.accessKey, 'X-Api-Resource-Id': s.resource_id }, 'volc-audio');
    if (!result) {
        if (['SpeechT5', 'System', 'Edge'].includes(provider)) return { native: provider };
        throw speechError('This speech provider has no native request.');
    }
    result.headers = { ...result.headers, ...config.headers };
    if (result.body instanceof URLSearchParams) result.body = result.body.toString();
    if (Buffer.byteLength(result.body ?? '') > 2 * 1024 * 1024) throw speechError('The saved speech request is too large.');
    return result;
}

export async function previousElevenLabsAudio(config, segment, { signal, fetchImpl = fetch } = {}) {
    if (config.provider !== 'ElevenLabs') return null;
    const history = await speechJson('https://api.elevenlabs.io/v1/history', { signal, fetchImpl, headers: { 'xi-api-key': config.key } });
    const previous = history.history?.find(item => item.text === segment.text && item.voice_id === segment.voice.id);
    if (!previous) return null;
    if (typeof previous.history_item_id !== 'string' || !previous.history_item_id || previous.history_item_id.length > 256) throw speechError('The speech history identity is invalid.');
    return { url: `https://api.elevenlabs.io/v1/history/${encodeURIComponent(previous.history_item_id)}/audio` };
}

async function fetchAudioResponse(descriptor, { signal, fetchImpl }) {
    let response;
    try {
        response = await fetchImpl(descriptor.url, { method: descriptor.method ?? 'GET', headers: descriptor.headers ?? {},
            ...(descriptor.body === undefined ? {} : { body: descriptor.body }), redirect: 'error', signal });
    } catch {
        if (signal?.aborted) throw signal.reason;
        throw speechError('The speech request did not return a complete response.', 'TTS_PROVIDER', 502);
    }
    if (!response.ok) {
        response.body?.cancel?.().catch?.(() => {});
        throw Object.assign(speechError('The speech provider rejected the request.', 'TTS_PROVIDER', 502),
            { providerStatus: response.status, speechRefused: isDefiniteProviderRefusal(response.status) });
    }
    return response;
}

/** A received answer that is not audio is a definite failure, never an unknown outcome. */
function invalidAudio(message) {
    return Object.assign(speechError(message, 'TTS_INVALID_AUDIO', 502), { speechRefused: true });
}

function assertAudioContentType(response) {
    const type = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && !['application/octet-stream', 'binary/octet-stream'].includes(type) && !/^audio\/[a-z0-9.+-]+$/.test(type)) {
        response.body?.cancel?.().catch?.(() => {});
        throw invalidAudio(`The speech provider returned ${type} instead of audio.`);
    }
}

function receivedAudio(bytes) {
    try { return audioResult(bytes); } catch (error) { throw invalidAudio(error.message); }
}

function decodedAudio(value) {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4
        || !/^[a-z0-9+/]*={0,2}$/i.test(value)) throw speechError('The speech data is invalid.', 'TTS_RESULT_RECOVERY');
    return Buffer.from(value, 'base64');
}

export function speechOutputUrl(value, config) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw speechError('The returned speech address is missing or invalid.');
    let url;
    try { url = new URL(value, config.endpoint || 'https://api.elevenlabs.io'); } catch { throw speechError('The returned speech address is invalid.'); }
    const origin = config.endpoint ? new URL(config.endpoint).origin : 'https://api.elevenlabs.io';
    if (url.username || url.password || url.hash || config.key && url.href.includes(config.key)) throw speechError('The speech address contains private credentials.');
    if (config.provider === 'AllTalk' && url.origin !== origin) throw speechError('The speech output is outside the selected service.');
    if (url.origin !== origin && !normalizeImageSource(url.href, { allowHttp: false, allowRelative: false, blockPrivateHosts: true })) {
        throw speechError('The speech output address is not a public HTTPS resource.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw speechError('The speech output address is invalid.');
    return url.href;
}

/** Called only inside a recorded provider step. A returned URL is saved before downloading its audio. */
export async function sendSpeechTransport(config, descriptor, segment, { signal, fetchImpl = fetch, localSynthesis, systemSynthesis, edgeSynthesis } = {}) {
    if (descriptor.native === 'SpeechT5') {
        const run = localSynthesis ?? (async input => {
            const { runPipeline } = await import('../transformers.js');
            const bytes = Buffer.from(input.voice.data, 'base64');
            const speaker_embeddings = Float32Array.from({ length: 512 }, (_, index) => bytes.readFloatLE(index * 4));
            signal.throwIfAborted();
            return runPipeline('text-to-speech', 'Xenova/speecht5_tts', pipe => pipe(input.text, { speaker_embeddings }), { signal });
        });
        const result = await run(segment, signal);
        signal.throwIfAborted();
        return audioResult(pcmWave(result.audio, { sampleRate: result.sampling_rate, float: true }));
    }
    if (descriptor.native === 'System') {
        const { synthesizeSystemSpeech } = await import('./speech-system.js');
        return audioResult(await (systemSynthesis ?? synthesizeSystemSpeech)(config, segment, signal));
    }
    if (descriptor.native === 'Edge') {
        const { synthesizeEdgeSpeech } = await import('./speech-edge.js');
        return audioResult(await (edgeSynthesis ?? synthesizeEdgeSpeech)(config, segment, signal));
    }
    const run = async () => {
        if (descriptor.settingsRequest) {
            const changed = await fetchAudioResponse(descriptor.settingsRequest, { signal, fetchImpl });
            await readResponseText(changed, 64 * 1024, { signal });
        }
        const response = await fetchAudioResponse(descriptor, { signal, fetchImpl });
        if (descriptor.response === 'audio') {
            assertAudioContentType(response);
            let bytes = Buffer.from(await readResponseArrayBuffer(response, MAX_AUDIO_BYTES, { signal }));
            if (descriptor.pcm) bytes = pcmWave(bytes, { sampleRate: descriptor.sampleRate ?? 24000 });
            if (descriptor.wavStream && bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF'
                && bytes.toString('ascii', 36, 40) === 'data') {
                bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
            }
            return receivedAudio(bytes);
        }
        const text = await readResponseText(response, MAX_AUDIO_BYTES * 2 + 65536, { signal });
        if (descriptor.response === 'volc-audio') {
            let terminal = false, size = 0;
            const chunks = [];
            for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
                const item = JSON.parse(line);
                if (terminal || ![0, 20000000].includes(item.code)) throw speechError('The speech stream did not complete successfully.', 'TTS_RESULT_RECOVERY');
                if (item.data) { const bytes = decodedAudio(item.data); size += bytes.length; if (size > MAX_AUDIO_BYTES) throw speechError('The speech stream is too large.'); chunks.push(bytes); }
                terminal = item.code === 20000000;
            }
            if (!terminal) throw speechError('The speech stream ended without completion.', 'TTS_RESULT_RECOVERY');
            return audioResult(Buffer.concat(chunks));
        }
        if (descriptor.response === 'google-translate') {
            const frames = text.replace(/^\)\]\}'[^\n]*\n/, '').split('\n').filter(line => line.startsWith('[')).flatMap(line => JSON.parse(line));
            const spoken = frames.find(frame => frame?.[0] === 'wrb.fr' && frame[1] === 'jQ1olc');
            const value = spoken?.[2] && JSON.parse(spoken[2])?.[0];
            return audioResult(decodedAudio(value));
        }
        const data = JSON.parse(text);
        if (descriptor.response === 'google-audio') {
            const candidate = data.candidates?.[0];
            if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw speechError('The speech model did not finish successfully.', 'TTS_RESULT_RECOVERY');
            const parts = candidate?.content?.parts?.filter(part => part.inlineData);
            if (!parts?.length) throw speechError('The speech model returned no audio.', 'TTS_RESULT_RECOVERY');
            const mime = parts[0].inlineData.mimeType;
            if (parts.some(part => part.inlineData.mimeType !== mime)) throw speechError('The speech model returned incompatible audio parts.');
            let bytes = Buffer.concat(parts.map(part => decodedAudio(part.inlineData.data)));
            if (/^audio\/l16/i.test(mime)) bytes = pcmWave(bytes, { sampleRate: Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000) });
            return audioResult(bytes);
        }
        if (descriptor.response === 'minimax') {
            if (data.base_resp?.status_code && data.base_resp.status_code !== 0) throw speechError('The speech service rejected synthesis.', 'TTS_PROVIDER', 502);
            if (data.data?.audio) {
                const hex = String(data.data.audio).replace(/^0x/, '').replace(/\s/g, '');
                if (!hex.length || hex.length % 2 || !/^[\da-f]+$/i.test(hex)) throw speechError('The speech bytes are invalid.', 'TTS_RESULT_RECOVERY');
                let bytes = Buffer.from(hex, 'hex');
                if (descriptor.pcm) bytes = pcmWave(bytes, { sampleRate: descriptor.sampleRate });
                return audioResult(bytes);
            }
            return { url: speechOutputUrl(data.data?.url, config) };
        }
        return { url: speechOutputUrl(data.output_file_url, config) };
    };
    return descriptor.serial ? withSpeechEndpoint(descriptor.serial, run) : run();
}

export async function downloadSpeechOutput(config, output, { signal, fetchImpl = fetch } = {}) {
    const url = speechOutputUrl(output.url, config);
    const headers = config.provider === 'ElevenLabs' && new URL(url).origin === 'https://api.elevenlabs.io' ? { 'xi-api-key': config.key } : {};
    const response = await fetchAudioResponse({ url, headers }, { signal, fetchImpl });
    assertAudioContentType(response);
    return receivedAudio(Buffer.from(await readResponseArrayBuffer(response, MAX_AUDIO_BYTES, { signal })));
}

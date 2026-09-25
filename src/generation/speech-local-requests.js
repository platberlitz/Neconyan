import { speechError } from './speech-config.js';

export function speechNumber(settings, key, fallback, minimum = -Infinity, maximum = Infinity) {
    const value = Number(settings[key] ?? fallback);
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw speechError('A saved speech control is outside its supported range.');
    return value;
}

const n = speechNumber;
const json = (url, body) => ({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), response: 'audio' });
const form = (url, body, method = 'POST') => ({ url, method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])), response: 'audio' });
const query = (url, body, method = 'GET') => ({ url: `${url}?${new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))}`,
    method, headers: {}, response: 'audio' });

/** Local provider controls are prepared without a network call, before an uncertain synthesis step. */
export function localSpeechRequest(config, segment) {
    const { provider, settings: s, endpoint: base } = config;
    const { text, voice, seed, character, id } = segment;
    if (provider === 'Silero') return { ...json(`${base}/generate`, { text, speaker: voice.id, session: 'sillytavern' }), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } };
    if (provider === 'XTTSv2') {
        const values = { text, speaker_wav: voice.id, language: s.language ?? 'en' };
        const request = s.streaming ? query(`${base}/tts_stream/`, values) : json(`${base}/tts_to_audio/`, values);
        const controls = { temperature: n(s, 'temperature', 0.75), length_penalty: n(s, 'length_penalty', 1),
            repetition_penalty: n(s, 'repetition_penalty', 5), top_k: n(s, 'top_k', 50), top_p: n(s, 'top_p', 0.85),
            speed: n(s, 'speed', 1, 0.1, 10), enable_text_splitting: s.enable_text_splitting ?? true,
            stream_chunk_size: n(s, 'stream_chunk_size', 100, 1, 10000) };
        return { ...request, settingsRequest: json(`${base}/set_tts_settings`, controls), serial: base };
    }
    if (provider === 'VITS') {
        const split = voice.id.indexOf('&');
        const type = voice.id.slice(0, split), speaker = voice.id.slice(split + 1);
        if (split < 1 || !/^[a-z0-9-]+$/i.test(type) || !/^\d+$/.test(speaker)) throw speechError('The saved VITS voice identity is invalid.');
        const params = { text, id: speaker, lang: s.lang ?? 'auto', length: n(s, 'length', 1), noise: n(s, 'noise', 0.33),
            noisew: n(s, 'noisew', 0.4), segment_size: n(s, 'segment_size', 50, 1) };
        if (type === 'W2V2-VITS') params.emotion = n(s, 'dim_emotion', 0);
        if (type === 'BERT-VITS2') Object.assign(params, { sdp_ratio: n(s, 'sdp_ratio', 0.2), emotion: n(s, 'emotion', 0),
            text_prompt: s.text_prompt ?? '', style_text: s.style_text ?? '', style_weight: n(s, 'style_weight', 1) });
        return s.streaming ? query(`${base}/voice/${type.toLowerCase()}`, { ...params, streaming: true })
            : form(`${base}/voice/${type.toLowerCase()}`, { ...params, format: s.format ?? 'wav' });
    }
    if (provider === 'GSVI') return query(`${base}/tts`, { text, cha_name: voice.id, text_language: s.language ?? '多语种混合',
        batch_size: n(s, 'batch_size', 10, 1), speed: n(s, 'speed', 1, 0.1, 10), top_k: n(s, 'top_k', 6),
        top_p: n(s, 'top_p', 0.85), temperature: n(s, 'temperature', 0.75), stream: s.stream ?? false });
    if (provider === 'SBVits2') {
        const parts = /^(\d+)-(\d+)-(.+)$/.exec(voice.id);
        if (!parts) throw speechError('The saved SBVits2 voice identity is invalid.');
        return query(`${base}/voice`, { text: text.replace(/<br\s*\/?\s*>/gi, '\n'), model_id: parts[1], speaker_id: parts[2],
            sdp_ratio: n(s, 'sdp_ratio', 0.2), noise: n(s, 'noise', 0.6), noisew: n(s, 'noisew', 0.8), length: n(s, 'length', 1),
            language: s.language ?? 'JP', auto_split: s.auto_split ?? true, split_interval: n(s, 'split_interval', 0.5),
            ...(s.assist_text ? { assist_text: s.assist_text, assist_text_weight: n(s, 'assist_text_weight', 1) } : {}),
            style: parts[3], style_weight: n(s, 'style_weight', 1), ...(s.reference_audio_path ? { reference_audio_path: s.reference_audio_path } : {}) }, 'POST');
    }
    if (provider === 'GPT-SoVITS-V2 (Unofficial)') return json(`${base}/`, { text, prompt_text: voice.id.replace(/\[.*?\]/gu, ''),
        ref_audio_path: `./参考音频/${voice.id}.wav`, text_lang: s.text_lang ?? 'zh', prompt_lang: s.prompt_lang ?? 'zh',
        text_split_method: 'cut5', batch_size: 1, media_type: 'ogg', streaming_mode: 'true' });
    if (provider === 'GPT-SoVITS-Adapter') return json(`${base}/`, { text, card_name: character, use_st_adapter: true,
        target_voice: voice.id, text_lang: s.text_lang ?? 'zh', text_split_method: 'cut5', batch_size: 1,
        media_type: s.media_type ?? 'auto', streaming_mode: 'true' });
    if (provider === 'CosyVoice (Unofficial)') return json(`${base}/`, { text, speaker: voice.id, streaming: s.streaming ? 1 : 0 });
    if (provider === 'TTS WebUI') {
        const defaults = { desired_length: 80, max_length: 200, halve_first_chunk: true, exaggeration: 0.5, cfg_weight: 0.5,
            temperature: 0.8, device: 'auto', dtype: 'float32', cpu_offload: false, chunked: true, cache_voice: false,
            tokens_per_slice: 1000, remove_milliseconds: 45, remove_milliseconds_start: 25, chunk_overlap_method: 'zero', seed };
        const params = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, key === 'seed' ? seed : s[key] ?? value]));
        const request = json(base, { model: s.model || 'chatterbox', voice: voice.id, input: text, response_format: 'wav',
            speed: n(s, 'speed', 1, 0.1, 10), stream: s.streaming ?? true, params });
        return { ...request, wavStream: s.streaming !== false };
    }
    if (provider === 'Chatterbox') return json(`${base}/tts`, { text, voice_mode: voice.id.startsWith('ref_') ? 'clone' : 'predefined',
        ...(voice.id.startsWith('ref_') ? { reference_audio_filename: voice.id.slice(4) } : { predefined_voice_id: voice.id }),
        temperature: n(s, 'temperature', 0.8), exaggeration: n(s, 'exaggeration', 0.5), cfg_weight: n(s, 'cfg_weight', 0.5),
        seed, speed_factor: n(s, 'speed_factor', 1, 0.1, 10), language: s.language ?? 'en', split_text: s.split_text ?? true,
        chunk_size: n(s, 'chunk_size', 120, 1), output_format: s.output_format || 'wav' });
    if (provider === 'AllTalk') {
        if (s.at_generation_method === 'streaming_enabled') return query(`${base}/api/tts-generate-streaming`, {
            text, voice: voice.id, language: s.language ?? 'en', output_file: `nn-${id}.wav` });
        const params = { text_input: text, text_filtering: 'standard', character_voice_gen: voice.id,
            narrator_enabled: String(s.narrator_enabled ?? 'false'), narrator_voice_gen: s.narrator_voice_gen ?? 'Please set a voice',
            text_not_inside: s.at_narrator_text_not_inside ?? 'narrator', language: s.language ?? 'en', output_file_name: `nn-${id}`,
            output_file_timestamp: true, autoplay: false, autoplay_volume: 0.8 };
        if ((s.server_version || 'v2') === 'v2') for (const who of ['character', 'narrator']) {
            const key = `rvc_${who}_voice`;
            if (s[key] && s[key] !== 'Disabled') {
                params[`rvc${who}_voice_gen`] = s[key];
                params[`rvc${who}_pitch`] = n(s, `rvc_${who}_pitch`, 0);
            }
        }
        return { ...form(`${base}/api/tts-generate`, params), response: 'alltalk-url' };
    }
    return null;
}

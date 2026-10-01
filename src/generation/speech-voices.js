import { languages } from 'google-translate-api-x';
import { speechError } from './speech-config.js';
import { readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { POLLINATIONS_AUDIO_MODELS_URL, pollinationsModelVoices } from '../endpoints/speech-transports.js';

const OPENAI = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'marin', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'cedar'];
const GEMINI = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirhoe', 'Autonoe', 'Enceladus',
    'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam',
    'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
const CHUTES = [
    ['af', 'Female', 'en-US', 'alloy aoede bella heart jessica kore nicole nova river sarah sky'],
    ['am', 'Male', 'en-US', 'adam echo eric fenrir liam michael onyx puck santa'],
    ['bf', 'British Female', 'en-GB', 'alice emma isabella lily'], ['bm', 'British Male', 'en-GB', 'daniel fable george lewis'],
    ['ef', 'European Female', 'es-ES', 'dora'], ['em', 'European Male', 'es-ES', 'alex santa'],
    ['ff', 'French Female', 'fr-FR', 'siwis'], ['hf', 'Hindi Female', 'hi-IN', 'alpha beta'], ['hm', 'Hindi Male', 'hi-IN', 'omega psi'],
    ['if', 'Italian Female', 'it-IT', 'sara'], ['im', 'Italian Male', 'it-IT', 'nicola'],
    ['jf', 'Japanese Female', 'ja-JP', 'alpha gongitsune nezumi tebukuro'], ['jm', 'Japanese Male', 'ja-JP', 'kumo'],
    ['pf', 'Portuguese Female', 'pt-PT', 'dora'], ['pm', 'Portuguese Male', 'pt-PT', 'alex santa'],
    ['zf', 'Chinese Female', 'zh-CN', 'xiaobei xiaoni xiaoxiao xiaoyi'], ['zm', 'Chinese Male', 'zh-CN', 'yunjian yunxi yunxia yunyang'],
].flatMap(([prefix, label, lang, names]) => names.split(' ').map(name => ({ id: `${prefix}_${name}`,
    name: `${name[0].toUpperCase()}${name.slice(1)} (${label})${prefix === 'af' && name === 'heart' ? ' - Default' : ''}`, lang })));

export async function speechJson(url, { headers = {}, signal, fetchImpl = fetch, method = 'GET', body } = {}) {
    let response;
    try { response = await fetchImpl(url, { method, headers, signal, redirect: 'error', ...(body === undefined ? {} : { body }) }); } catch {
        if (signal?.aborted) throw signal.reason;
        throw speechError('The speech service could not be reached.', 'TTS_PROVIDER', 502);
    }
    if (!response.ok) throw speechError('The speech service rejected the request.', 'TTS_PROVIDER', 502);
    try { return JSON.parse(await readResponseText(response, 2 * 1024 * 1024, { signal })); } catch {
        if (signal?.aborted) throw signal.reason;
        throw speechError('The speech service returned an invalid response.', 'TTS_PROVIDER', 502);
    }
}

function selected(voices, entry) {
    if (!Array.isArray(voices) || voices.length > 10000) throw speechError('The speech voice list is invalid.');
    const matches = voices.filter(voice => voice?.id === entry || voice?.name === entry);
    if (!matches.length || new Set(matches.map(voice => voice.id)).size !== 1) throw speechError('The saved speech voice is missing or ambiguous.', 'TTS_VOICE_MISSING');
    const voice = matches[0];
    if (typeof voice.id !== 'string' || !voice.id || voice.id.length > 512 || /[\r\n\0]/.test(voice.id)) throw speechError('The speech voice identity is invalid.');
    return { id: voice.id, name: String(voice.name ?? voice.id), ...(voice.lang ? { lang: String(voice.lang) } : {}),
        ...(voice.data ? { data: voice.data } : {}), ...(voice.model ? { model: voice.model } : {}) };
}

/** Read-only voice discovery happens before synthesis and its selected result is saved by the caller. */
export async function resolveSpeechVoice(config, entry, { signal, fetchImpl = fetch, systemVoices, edgeVoices } = {}) {
    if (typeof entry !== 'string' || !entry || entry.length > 512) throw speechError('A saved speech voice is required.', 'TTS_VOICE_MISSING');
    const { provider, settings, endpoint, key } = config;
    const get = (url, headers = {}) => speechJson(url, { signal, fetchImpl, headers: { ...headers, ...config.headers } });
    const entries = value => Array.isArray(value) ? value.map(item => typeof item === 'string' ? { id: item, name: item }
        : { id: String(item.voice_id ?? item.id ?? item.value ?? ''), name: item.name ?? item.label, lang: item.lang, data: item.data }) : [];
    let voices;
    if (provider === 'OpenAI') voices = OPENAI.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
    else if (provider === 'OpenAI Compatible') voices = entries(settings.available_voices ?? ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    else if (provider === 'Google Gemini TTS') voices = entries(GEMINI);
    else if (provider === 'Chutes') voices = CHUTES;
    else if (provider === 'Google Translate') voices = Object.entries(languages).filter(([id]) => id !== 'auto').map(([id, name]) => ({ id, name }));
    else if (provider === 'Novel') voices = [{ id: entry, name: entry }];
    else if (provider === 'SpeechT5') {
        voices = entries(settings.speakers);
        const voice = selected(voices, entry);
        const data = Buffer.from(String(voice.data || '').replace(/^data:[^,]*,/, ''), 'base64');
        if (data.length !== 2048) throw speechError('The saved SpeechT5 speaker must contain 512 float samples.');
        for (let i = 0; i < data.length; i += 4) if (!Number.isFinite(data.readFloatLE(i))) throw speechError('The saved SpeechT5 speaker is invalid.');
        return { ...voice, data: data.toString('base64') };
    } else if (provider === 'MiniMax') {
        voices = entries([{ name: 'Unrestrained Young Man', voice_id: 'Chinese (Mandarin)_Unrestrained_Young_Man', lang: 'zh-CN' }, ...(settings.customVoices ?? [])]);
        if (entry === 'customVoice') {
            if (!settings.customVoiceId?.trim()) throw speechError('The selected custom MiniMax voice has no saved identity.');
            return { id: settings.customVoiceId.trim(), name: entry };
        }
    } else if (provider === 'Volcengine') voices = entries(['zh_female_xiaohe_uranus_bigtts', 'zh_female_vv_uranus_bigtts',
        'saturn_zh_female_keainvsheng_tob', 'saturn_zh_female_tiaopigongzhu_tob', 'saturn_zh_female_cancan_tob',
        'saturn_zh_male_shuanglangshaonian_tob', 'saturn_zh_male_tiancaitongzhuo_tob', 'zh_male_taocheng_uranus_bigtts', ...(settings.customVoices ?? [])]);
    else if (provider === 'ElevenLabs') {
        const data = await get('https://api.elevenlabs.io/v1/voices', { 'xi-api-key': key });
        voices = entries(data.voices);
    } else if (provider === 'Azure') voices = (await get(`${endpoint}/voices/list`, { 'Ocp-Apim-Subscription-Key': key }))
        .map(item => ({ id: item.ShortName, name: item.ShortName, lang: item.Locale }));
    else if (provider === 'Pollinations') {
        voices = entries(pollinationsModelVoices(await get(POLLINATIONS_AUDIO_MODELS_URL), settings.model));
    } else if (provider === 'Electron Hub') {
        const data = await get('https://api.electronhub.ai/v1/models', { Authorization: `Bearer ${key}` });
        const model = (data.data ?? data).find(item => item.id === (settings.model || 'tts-1'));
        if (!model) throw speechError('The saved speech model no longer exists.', 'TTS_MODEL_MISSING');
        voices = entries(model.voices).map(voice => ({ ...voice, model: { id: model.id,
            parameters: Array.isArray(model.parameters) ? model.parameters.filter(value => typeof value === 'string') : [] } }));
    } else if (provider === 'System') {
        const { listSystemSpeechVoices } = await import('./speech-system.js');
        voices = await (systemVoices ?? listSystemSpeechVoices)(config, signal);
    } else if (provider === 'Edge') {
        const { listEdgeSpeechVoices } = await import('./speech-edge.js');
        voices = await (edgeVoices ?? listEdgeSpeechVoices)({ signal, fetchImpl });
    } else if (provider === 'AllTalk') voices = entries((await get(`${endpoint}/api/voices`)).voices);
    else if (provider === 'Chatterbox') {
        const [predefined, reference] = await Promise.all([get(`${endpoint}/get_predefined_voices`), get(`${endpoint}/get_reference_files`)]);
        voices = [
            ...(predefined.voices ?? predefined).map(item => ({ id: item.voice_id || item.filename, name: item.display_name, lang: item.language })),
            ...(reference.files ?? reference).map(item => { const name = typeof item === 'string' ? item : item.filename; return { id: `ref_${name}`, name: `[Clone] ${name}` }; }),
        ];
    } else if (provider === 'GSVI') voices = entries(Object.keys(await get(`${endpoint}/character_list`)));
    else if (provider === 'VITS') {
        voices = Object.entries(await get(`${endpoint}/voice/speakers`)).flatMap(([type, items]) => items.map(item => ({
            id: `${type}&${item.id}`, name: `[${type}] ${item.name} (${item.lang})`, lang: Array.isArray(item.lang) ? item.lang.join(',') : item.lang })));
    } else if (provider === 'SBVits2') {
        voices = Object.entries(await get(`${endpoint}/models/info`)).flatMap(([model, info]) => Object.entries(info.spk2id ?? {}).flatMap(([name, id]) =>
            Object.keys(info.style2id ?? {}).map(style => ({ id: `${model}-${id}-${style}`, name: `${name} (${style})` }))));
    } else if (provider === 'TTS WebUI') voices = entries((await get(endpoint.replace(/\/speech\/?$/, `/voices/${encodeURIComponent(settings.model || 'chatterbox')}`))).voices);
    else if (['Silero', 'XTTSv2', 'CosyVoice (Unofficial)', 'GPT-SoVITS-Adapter', 'GPT-SoVITS-V2 (Unofficial)'].includes(provider)) {
        const data = await get(`${endpoint}/speakers`);
        voices = entries(data.speakers ?? data);
    } else throw speechError('This speech provider has no native voice selection.');
    return selected(voices, entry);
}

import fs from 'node:fs';
import path from 'node:path';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { getOverrideHeaders } from '../additional-headers.js';
import { getConfigValue } from '../util.js';
import { roleplayAccountBase, roleplayError, roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { resolveCaptionConfiguration } from './caption-transports.js';
import { parseTtsVoiceMap } from '../../public/scripts/extensions/tts/lib/text-prep.js';

export const SPEECH_PROVIDERS = Object.freeze(['AllTalk', 'Azure', 'Chatterbox', 'Chutes', 'CosyVoice (Unofficial)',
    'Edge', 'ElevenLabs', 'Electron Hub', 'Google Translate', 'Google Gemini TTS', 'GSVI', 'GPT-SoVITS-Adapter',
    'GPT-SoVITS-V2 (Unofficial)', 'Kokoro', 'MiniMax', 'Novel', 'OpenAI', 'OpenAI Compatible', 'Pollinations',
    'SBVits2', 'Silero', 'SpeechT5', 'System', 'TTS WebUI', 'VITS', 'XTTSv2', 'Volcengine']);
export const speechError = (message, code = 'TTS_INVALID', status = 409) => roleplayError(code, message, status);
export const MAX_SPEECH_TEXT = 256 * 1024;
const TEXT_OPTIONS = ['multi_voice_enabled', 'narrate_user', 'narrate_translated_only', 'skip_codeblocks', 'narrate_dialogues_only',
    'pass_asterisks', 'narrate_quoted_only', 'skip_tags', 'apply_regex', 'regex_pattern', 'playback_rate'];
const KEYS = { OpenAI: 'OPENAI', 'OpenAI Compatible': 'CUSTOM_OPENAI_TTS', ElevenLabs: 'ELEVENLABS', Pollinations: 'POLLINATIONS',
    Azure: 'AZURE_TTS', Novel: 'NOVEL', Chutes: 'CHUTES', 'Electron Hub': 'ELECTRONHUB', MiniMax: 'MINIMAX' };
const ENDPOINTS = { AllTalk: 'http://localhost:7851', Chatterbox: 'http://localhost:8004',
    'CosyVoice (Unofficial)': 'http://localhost:9880', GSVI: 'http://127.0.0.1:5000',
    'GPT-SoVITS-Adapter': 'http://localhost:9881', 'GPT-SoVITS-V2 (Unofficial)': 'http://localhost:9880',
    SBVits2: 'http://localhost:5000', Silero: 'http://localhost:8001/tts',
    'TTS WebUI': 'http://127.0.0.1:7778/v1/audio/speech', VITS: 'http://localhost:23456', XTTSv2: 'http://localhost:8020' };

export function speechAddress(value) {
    let url;
    try { url = new URL(value); } catch { throw speechError('The saved speech address is invalid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw speechError('The saved speech address is invalid.');
    }
    return url.href.replace(/\/$/, '');
}

export function readSpeechSettings(directories) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value;
    } catch { throw speechError('The saved speech settings are unreadable.', 'TTS_SOURCE_CHANGED'); }
}

/** Private connection material is used in memory; captured requests contain only its fingerprint. */
export function resolveSpeechConfiguration(directories, data) {
    const tts = data.extension_settings?.tts;
    if (!tts || typeof tts !== 'object' || Array.isArray(tts)) throw speechError('The saved speech settings are missing.');
    const provider = tts.currentProvider;
    if (!SPEECH_PROVIDERS.includes(provider)) throw speechError('The selected speech provider is unavailable.');
    const settings = tts[provider] ?? {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw speechError('The saved speech controls are invalid.');
    const keyName = KEYS[provider];
    const key = keyName ? readSecret(directories, SECRET_KEYS[keyName]) || '' : '';
    if (keyName && provider !== 'OpenAI Compatible' && !key) throw speechError('The selected speech provider has no saved key.', 'TTS_CREDENTIALS_MISSING');
    let endpoint = '';
    if (Object.hasOwn(ENDPOINTS, provider)) endpoint = speechAddress(settings.provider_endpoint || ENDPOINTS[provider]);
    if (provider === 'OpenAI Compatible') endpoint = speechAddress(settings.provider_endpoint);
    if (provider === 'MiniMax') endpoint = speechAddress(settings.apiHost || 'https://api.minimax.io');
    if (provider === 'Volcengine') endpoint = speechAddress(settings.provider_endpoint || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    if (provider === 'Azure') {
        if (!/^[a-z0-9-]+$/.test(settings.region || '')) throw speechError('The saved Azure speech region is invalid.');
        endpoint = `https://${settings.region}.tts.speech.microsoft.com/cognitiveservices`;
    }
    let google = null;
    if (provider === 'Google Gemini TTS') {
        const api = settings.apiType === 'vertexai' ? 'vertexai' : settings.apiType === 'makersuite' || !settings.apiType ? 'google' : null;
        if (!api) throw speechError('The saved Google speech API is invalid.');
        google = resolveCaptionConfiguration(directories, { ...data, extension_settings: { ...data.extension_settings,
            caption: { source: 'multimodal', multimodal_api: api, multimodal_model: settings.model || 'gemini-2.5-flash-preview-tts', allow_reverse_proxy: true } } });
    }
    const groupId = provider === 'MiniMax' ? readSecret(directories, SECRET_KEYS.MINIMAX_GROUP_ID) || '' : '';
    if (provider === 'MiniMax' && !groupId) throw speechError('The saved MiniMax group is missing.', 'TTS_CREDENTIALS_MISSING');
    const appId = provider === 'Volcengine' ? readSecret(directories, SECRET_KEYS.VOLCENGINE_APP_ID) || '' : '';
    const accessKey = provider === 'Volcengine' ? readSecret(directories, SECRET_KEYS.VOLCENGINE_ACCESS_KEY) || '' : '';
    if (provider === 'Volcengine' && (!appId || !accessKey || !settings.resource_id)) throw speechError('The saved speech account or resource is missing.', 'TTS_CREDENTIALS_MISSING');
    const headers = endpoint ? getOverrideHeaders(new URL(endpoint).host) : {};
    if (Object.entries(headers).some(([name, value]) => typeof value !== 'string' || /[\r\n]/.test(name + value))) throw speechError('The saved speech headers are invalid.');
    const systemCommand = provider === 'System' ? getConfigValue('extensions.speech.systemCommand', 'espeak-ng') : '';
    if (provider === 'System' && !['espeak-ng', 'espeak'].includes(systemCommand)) throw speechError('Select a supported installed system speech command.');
    return { provider, settings, key, endpoint, headers, google, groupId, appId, accessKey, systemCommand,
        rvc: data.extension_settings?.rvc?.enabled ? data.extension_settings.rvc : null };
}

/** Call during protected admission, with the same saved account settings as the parent request. */
export function captureSpeechPolicy(directories, data, { automatic = true } = {}) {
    const tts = data.extension_settings?.tts;
    if (!tts || tts.enabled !== true || automatic && tts.auto_generation === false
        || data.extension_settings?.disabledExtensions?.some(name => String(name).toLowerCase() === 'tts')) return null;
    const config = resolveSpeechConfiguration(directories, data);
    const map = parseTtsVoiceMap(config.settings.voiceMap);
    if (!map || Array.isArray(map) || Object.entries(map).some(([name, value]) => name.length > 512 || typeof value !== 'string' || value.length > 512)) {
        throw speechError('The saved speech voice map is invalid.');
    }
    const options = Object.fromEntries(TEXT_OPTIONS.filter(name => tts[name] !== undefined).map(name => [name, tts[name]]));
    if (typeof options.regex_pattern !== 'undefined' && (typeof options.regex_pattern !== 'string' || options.regex_pattern.length > 4096)) throw speechError('The saved speech text filter is invalid.');
    if (options.playback_rate !== undefined && (typeof options.playback_rate !== 'number' || !Number.isFinite(options.playback_rate)
        || options.playback_rate <= 0 || options.playback_rate > 16)) throw speechError('The saved speech playback speed is invalid.');
    return { version: 1, provider: config.provider, fingerprint: roleplayHash(config), options,
        voiceMap: { ...map }, allowName2Display: data.power_user?.allow_name2_display === true, automatic };
}

export function assertSpeechPolicy(directories, policy) {
    const data = readSpeechSettings(directories);
    const captured = captureSpeechPolicy(directories, data, { automatic: policy.automatic });
    if (!captured || roleplayHash(captured) !== roleplayHash(policy)) throw speechError('The accepted speech settings or credentials changed.', 'TTS_SOURCE_CHANGED');
    return resolveSpeechConfiguration(directories, data);
}

/** Bind automatic speech while a Conversation participant is still being prepared. */
export function captureBoundSpeechPolicy(directories, data) {
    if (!data.extension_settings?.tts?.enabled) return { speechPolicy: null };
    const base = roleplayAccountBase(directories);
    if (!base) throw speechError('The speech account has no protected identity.', 'TTS_SOURCE_CHANGED');
    return withRoleplayAccount(base, null, lease => {
        const speechPolicy = captureSpeechPolicy(directories, data);
        if (!speechPolicy) return { speechPolicy: null };
        assertSpeechPolicy(directories, speechPolicy);
        const { scope } = roleplayLease(lease);
        return { speechPolicy, speechAccount: { accountId: scope.accountId, dataEpoch: scope.dataEpoch } };
    });
}

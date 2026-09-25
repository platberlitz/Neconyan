import { createSign } from 'node:crypto';
import yaml from 'yaml';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { AIMLAPI_HEADERS, GEMINI_SAFETY, OPENROUTER_HEADERS, VERTEX_SAFETY, ZAI_ENDPOINT } from '../constants.js';
import { getOverrideHeaders } from '../additional-headers.js';
import { getConfigValue, trimV1 } from '../util.js';
import { roleplayError } from '../roleplay-store.js';
import { readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { MAX_CAPTION_BYTES } from './caption-records.js';

const OPENAI_URLS = Object.freeze({
    openai: 'https://api.openai.com/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
    xai: 'https://api.x.ai/v1/chat/completions',
    aimlapi: 'https://api.aimlapi.com/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    cohere: 'https://api.cohere.ai/v2/chat',
    moonshot: 'https://api.moonshot.ai/v1/chat/completions',
    nanogpt: 'https://nano-gpt.com/api/v1/chat/completions',
    chutes: 'https://llm.chutes.ai/v1/chat/completions',
    electronhub: 'https://api.electronhub.ai/v1/chat/completions',
    pollinations: 'https://gen.pollinations.ai/v1/chat/completions',
});
const LOCAL_APIS = new Set(['ollama', 'llamacpp', 'ooba', 'koboldcpp', 'vllm']);
const PROXY_APIS = new Set(['openai', 'anthropic', 'google', 'vertexai', 'mistral', 'xai', 'zai', 'moonshot']);
const KEY_NAMES = { anthropic: 'CLAUDE', google: 'MAKERSUITE', mistral: 'MISTRALAI' };
export { MAX_CAPTION_BYTES };
export const captionError = (message, code = 'ROLEPLAY_CAPTION_INVALID', status = 409) => roleplayError(code, message, status);

function address(value) {
    let url;
    try { url = new URL(value); } catch { throw captionError('The saved caption address is invalid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw captionError('The saved caption address is invalid.');
    }
    return url.href.replace(/\/$/, '');
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function yamlControl(value, exclude = false) {
    if (!value) return exclude ? [] : {};
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CAPTION_BYTES) {
        throw captionError('The saved custom caption controls are invalid.');
    }
    let parsed;
    try { parsed = yaml.parse(value, { maxAliasCount: 20 }); } catch {
        throw captionError('The saved custom caption controls are invalid.');
    }
    if (exclude) {
        const keys = Array.isArray(parsed) ? parsed : object(parsed) ? Object.keys(parsed) : typeof parsed === 'string' ? [parsed] : null;
        if (!keys || keys.some(key => typeof key !== 'string')) throw captionError('The saved caption exclusions are invalid.');
        return keys;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    if (entries.some(item => !object(item) || Object.keys(item).some(key => ['__proto__', 'prototype', 'constructor'].includes(key)))) {
        throw captionError('The saved custom caption controls are invalid.');
    }
    return Object.assign({}, ...entries);
}

/** Resolve private connection material under the account lock. Only its fingerprint is persisted. */
export function resolveCaptionConfiguration(directories, settings) {
    const caption = settings.extension_settings?.caption ?? {};
    const source = caption.source === 'openai' ? 'multimodal' : caption.source || (caption.local === false ? 'multimodal' : 'local');
    if (source === 'local') return { source, model: getConfigValue('extensions.models.captioning', 'Xenova/vit-gpt2-image-captioning') };
    if (source === 'horde') return { source, key: readSecret(directories, SECRET_KEYS.HORDE) || '0000000000' };
    if (source !== 'multimodal') throw captionError('The saved caption source is unsupported.');
    const api = caption.multimodal_api || 'openai';
    const chat = settings.oai_settings ?? {};
    const text = settings.textgenerationwebui_settings ?? {};
    const proxy = PROXY_APIS.has(api) && caption.allow_reverse_proxy && chat.reverse_proxy ? address(chat.reverse_proxy) : '';
    const keyName = api === 'vertexai' && chat.vertexai_auth_mode === 'full' ? 'VERTEXAI_SERVICE_ACCOUNT' : KEY_NAMES[api] || api.toUpperCase();
    const key = proxy ? String(chat.proxy_password || '') : readSecret(directories, SECRET_KEYS[keyName]) || '';
    let model = caption.multimodal_model || 'gpt-4-turbo';
    let url;
    if (LOCAL_APIS.has(api)) {
        const base = address(caption.alt_endpoint_enabled ? caption.alt_endpoint_url : text.server_urls?.[api]);
        url = api === 'ollama' ? `${trimV1(base)}/api/generate` : `${trimV1(base)}/v1/chat/completions`;
        if (model === 'ollama_current') model = text.ollama_model;
        if (model === 'ollama_custom') model = caption.ollama_custom_model;
        if (model === 'vllm_current') model = text.vllm_model;
    } else if (api === 'custom') {
        url = `${address(chat.custom_url)}/chat/completions`;
        if (model === 'custom_current') model = chat.custom_model || '';
        if (model === 'custom_custom') model = caption.custom_model || '';
    } else if (api === 'anthropic') url = `${proxy || 'https://api.anthropic.com/v1'}/messages`;
    else if (api === 'google') {
        const version = getConfigValue('gemini.apiVersion', 'v1beta');
        if (!/^v\d+(?:alpha|beta)?$/i.test(version)) throw captionError('The saved Google caption API version is invalid.');
        const base = proxy || 'https://generativelanguage.googleapis.com';
        url = `${/\/v\d+(?:alpha|beta)?$/i.test(base) ? base : `${base}/${version}`}/models/${encodeURIComponent(model)}:generateContent`;
    } else if (api === 'vertexai') {
        const region = chat.vertexai_region || 'us-central1';
        if (!/^[a-z0-9-]+$/.test(region)) throw captionError('The saved Vertex caption region is invalid.');
        const mode = proxy ? 'proxy' : chat.vertexai_auth_mode || 'express';
        if (!['proxy', 'express', 'full'].includes(mode)) throw captionError('The saved Vertex caption authentication mode is invalid.');
        let project = chat.vertexai_express_project_id || '';
        if (mode === 'full') {
            let account;
            try { account = JSON.parse(key); } catch { throw captionError('The saved Vertex caption credentials are invalid.'); }
            if (!account.project_id || !account.client_email || !account.private_key) throw captionError('The saved Vertex caption credentials are incomplete.');
            project = account.project_id;
        }
        const base = proxy ? (/\/v\d+(?:alpha|beta)?$/i.test(proxy) ? proxy : `${proxy}/v1`)
            : `https://${region === 'global' ? '' : `${region}-`}aiplatform.googleapis.com/v1`;
        url = `${base}${mode !== 'proxy' && project ? `/projects/${encodeURIComponent(project)}/locations/${region}` : ''}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    } else if (api === 'zai') url = `${proxy || (chat.zai_endpoint === ZAI_ENDPOINT.CODING
        ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4')}/chat/completions`;
    else if (api === 'workers_ai') {
        if (!chat.workers_ai_account_id) throw captionError('The saved Workers AI account is missing.');
        url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(chat.workers_ai_account_id)}/ai/v1/chat/completions`;
    } else if (Object.hasOwn(OPENAI_URLS, api)) url = proxy ? `${proxy}/chat/completions` : OPENAI_URLS[api];
    else throw captionError('The saved multimodal caption API is unsupported.');
    if (!key && !proxy && !LOCAL_APIS.has(api) && api !== 'custom') throw captionError('The configured caption key is unavailable.');
    if (typeof model !== 'string' || model.length > 256 || !model && api !== 'custom') throw captionError('The saved caption model is invalid.');
    const headers = { ...(api === 'openrouter' ? OPENROUTER_HEADERS : api === 'aimlapi' ? AIMLAPI_HEADERS : {}),
        ...(api === 'custom' ? yamlControl(chat.custom_include_headers) : {}), ...getOverrideHeaders(new URL(url).host) };
    if (Object.entries(headers).some(([name, value]) => typeof value !== 'string' || /[\r\n]/.test(name + value))) {
        throw captionError('The saved caption headers are invalid.');
    }
    return { source, api, model, url, key, headers, authMode: proxy ? 'proxy' : chat.vertexai_auth_mode || 'express',
        systemPrompt: getConfigValue('openai.captionSystemPrompt', ''),
        bodyParams: api === 'custom' ? yamlControl(chat.custom_include_body) : {},
        exclude: api === 'custom' ? yamlControl(chat.custom_exclude_body, true) : [] };
}

export async function readCaptionResponse(response, signal) {
    if (!response.ok) throw captionError('The caption provider rejected the request.', 'ROLEPLAY_CAPTION_PROVIDER', 502);
    try { return JSON.parse(await readResponseText(response, 1024 * 1024, { signal })); } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw captionError('The caption provider returned an invalid response.', 'ROLEPLAY_CAPTION_PROVIDER', 502);
    }
}

async function vertexToken(config, signal, fetchImpl) {
    const account = JSON.parse(config.key);
    const issued = Math.floor(Date.now() / 1000);
    const input = [Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
            aud: 'https://oauth2.googleapis.com/token', iat: issued, exp: issued + 3600 })).toString('base64url')].join('.');
    const signer = createSign('RSA-SHA256');
    signer.update(input);
    const jwt = `${input}.${signer.sign(account.private_key, 'base64url')}`;
    const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
    const result = await readCaptionResponse(response, signal);
    if (typeof result.access_token !== 'string' || !result.access_token) throw captionError('Caption authentication failed.');
    return result.access_token;
}

/** Shared saved Google/Vertex authentication for captions and speech; tokens are never persisted. */
export async function prepareGoogleRequestHeaders(config, { signal, fetchImpl = fetch } = {}) {
    if (config.api === 'google' || config.authMode === 'express') return { 'x-goog-api-key': config.key };
    return { Authorization: `Bearer ${config.authMode === 'full' ? await vertexToken(config, signal, fetchImpl) : config.key}` };
}

/** Prepare read-only authentication/image conversion before the paid request is marked uncertain. */
export async function prepareCaptionRequest(config, { image, prompt, seed, signal, fetchImpl = fetch }) {
    if (config.source !== 'multimodal') throw captionError('A multimodal caption connection is required.');
    let dataUrl = image;
    if (['ooba', 'koboldcpp'].includes(config.api)) {
        const { decodeServerImage, encodeServerImage } = await import('../media-codecs.js');
        const converted = await decodeServerImage(Buffer.from(image.split(',')[1], 'base64'));
        dataUrl = `data:image/jpeg;base64,${(await encodeServerImage(converted, 'jpeg', { quality: 90 })).toString('base64')}`;
    }
    const match = /^data:((?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm|quicktime|mpeg|ogg)));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw captionError('The bound caption image is invalid.');
    const [, mime, bytes] = match;
    const video = mime.startsWith('video/');
    if (video && !['google', 'vertexai', 'zai'].includes(config.api)) throw captionError('The selected caption connection does not support video.');
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (config.api === 'anthropic') {
        Object.assign(headers, { 'anthropic-version': '2023-06-01', 'x-api-key': config.key });
        body = { model: config.model, max_tokens: 4096, messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: bytes } }, { type: 'text', text: prompt },
        ] }] };
    } else if (['google', 'vertexai'].includes(config.api)) {
        Object.assign(headers, await prepareGoogleRequestHeaders(config, { signal, fetchImpl }));
        body = { contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: bytes } }] }],
            safetySettings: [...GEMINI_SAFETY, ...(config.api === 'vertexai' ? VERTEX_SAFETY : [])] };
    } else if (config.api === 'ollama') body = { model: config.model, prompt, images: [bytes], stream: false };
    else {
        headers.Authorization = `Bearer ${config.key}`;
        body = { model: config.model, messages: [{ role: 'user', content: [
            { type: 'text', text: prompt }, video ? { type: 'video_url', video_url: { url: dataUrl } } : { type: 'image_url', image_url: { url: dataUrl } },
        ] }], ...(config.api === 'zai' ? { max_tokens: 4096 } : {}), ...(config.api === 'ooba' ? { temperature: 0.1 } : {}),
        ...(config.api === 'pollinations' ? { seed } : {}), ...config.bodyParams };
        if (config.systemPrompt) body.messages.unshift({ role: config.api === 'groq' ? 'user' : 'system', content: config.systemPrompt });
        for (const key of config.exclude) delete body[key];
        if (config.api === 'ooba') {
            body.messages.pop();
            body.messages.push({ role: 'user', content: prompt }, { role: 'user', content: [], image_url: dataUrl });
        }
        if (body.stream === true) throw captionError('A bound caption needs a complete response, not a partial stream.');
    }
    Object.assign(headers, config.headers);
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > (video ? 35 : 4) * 1024 * 1024) throw captionError('The saved caption request is too large.');
    return { url: config.url, headers, body: json };
}

export function validateCaption(value) {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_CAPTION_BYTES) {
        throw captionError('The caption result is empty or too large.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
    }
    return value.trim();
}

export async function sendCaptionRequest(config, request, { signal, fetchImpl = fetch }) {
    const response = await fetchImpl(request.url, { method: 'POST', redirect: 'error', signal,
        headers: request.headers, body: request.body });
    const data = await readCaptionResponse(response, signal);
    const text = config.api === 'anthropic' ? data.content?.filter(part => part.type === 'text').map(part => part.text).join('\n')
        : ['google', 'vertexai'].includes(config.api) ? data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('\n')
            : config.api === 'ollama' ? data.response : data.choices?.[0]?.message?.content ?? data.message?.content?.[0]?.text;
    return validateCaption(text);
}

export async function captionLocalImage({ model }, image, signal) {
    const { getRawImage, runPipeline } = await import('../transformers.js');
    const raw = await getRawImage(image.split(',')[1]);
    if (!raw) throw captionError('The bound image could not be decoded.');
    const result = await runPipeline('image-to-text', model, caption => caption(raw), { signal });
    return validateCaption(result?.[0]?.generated_text);
}

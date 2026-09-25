import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import sanitize from 'sanitize-filename';

import { SETTINGS_FILE, MEDIA_EXTENSIONS } from '../constants.js';
import { clientRelativePath, fsyncDirectorySync, removeFileExtension } from '../util.js';
import { roleplayAccountBase, withRoleplayAccount } from '../roleplay-store.js';
import {
    extractProviderImageSource,
    buildGptImagePayload,
    getGptImageApiUrl,
    getNanobananaApiUrl,
    getNanobananaAuthHeaders,
} from '../../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import {
    getClosestSupportedImageSize,
    getFalEffectiveSteps,
    getFalEffectiveGuidance,
    getGlmImageResolution,
} from '../../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import {
    normalizeImageSource,
    readResponseArrayBuffer,
    readResponseText,
} from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { createHostedProviderDeadline } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { isTrustedProviderOutputUrl } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { buildCustomBackendRequest, executeCustomBackend, normalizeCustomBackendConfig } from '../../public/scripts/extensions/quick-image-gen/lib/custom-backend.js';
import { getGeminiCandidateFailure } from '../../public/scripts/extensions/quick-image-gen/lib/generated-image.js';
import { MAX_PROVIDER_RESPONSE_BYTES } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { buildQueuedImageRequest } from './quick-image-gen-queued.js';
import { nanobananaEndpoint } from './quick-image-gen-nanobanana.js';
import { buildNovelAIRequest, decodeNovelAIOutput, resolveNovelAIProxyImage } from './quick-image-gen-novelai.js';
import { assertProxyImageConfigured, generateProxyImage } from './quick-image-gen-proxy.js';
import { assertComfyImageConfigured, comfyImageBaseUrl } from './quick-image-gen-comfy.js';
import { a1111BaseUrl, buildA1111ImageRequest } from './quick-image-gen-a1111.js';

/**
 * Server-side callers for the bundled Quick Image Gen provider settings.
 * The account's saved `extension_settings['quick-image-gen']` block decides the
 * provider; no other image backend is substituted. Providers without a server
 * implementation are refused with a recoverable error that names them.
 */

export const QUICK_IMAGE_GEN_EXTENSION_ID = 'quick-image-gen';

const ROUTEWAY_MODEL_SIZES = {
    'flux-1-schnell': ['1024x1024', '1792x1024', '1024x1792', '1024x768', '768x1024', '1080x1350'],
    'qwen-image-2.0': ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'],
    'qwen-image-2.0-pro': ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'],
    'seedream-v5.0-lite': ['2048x2048', '2560x1440', '1440x2560', '3072x2048', '2048x3072', '4096x2304', '2304x4096'],
    'flux-2-dev': ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'],
    sdxl: ['512x512', '768x768', '1024x1024', '1408x1408', '576x1024', '1024x576', '768x1024', '1024x768'],
};

const NAVY_MODEL_SIZES = {
    'gpt-image-2': ['1024x1024', '1536x1024', '1024x1536'],
    'gpt-image-1.5': ['1024x1024', '1536x1024', '1024x1536'],
};

const trustedErrors = new WeakSet();
function fail(message, { status = 502, code = 'QIG_PROVIDER_ERROR', recoverable = true } = {}) {
    const error = Object.assign(new Error(message), { status, code, recoverable });
    trustedErrors.add(error);
    return error;
}

function requireKey(value, label) {
    const key = String(value || '').trim();
    if (!key) throw fail(`${label} is not configured in Quick Image Gen.`, { code: 'QIG_MISSING_KEY' });
    return key;
}

function numberOr(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

export function resolveQuickImageGenSeed(seed) {
    const value = seed == null || seed === '' ? -1 : Number(seed);
    if (Number.isFinite(value) && value >= 0) return Math.min(Math.floor(value), 0xffffffff);
    return Math.floor(Math.random() * 0x7fffffff);
}

async function readJson(response) {
    const text = await readResponseText(response);
    try {
        return JSON.parse(text);
    } catch {
        throw fail('The image provider returned an unreadable response.');
    }
}

async function describeError(response, label) {
    return `${label} request failed with HTTP ${response.status}.`;
}

function finishImage(bytes, source) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const format = detectImageFormat(buffer);
    if (!format) throw fail('returned a response that is not a supported image.', { code: 'QIG_BAD_IMAGE' });
    void source;
    return { base64: buffer.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext };
}

async function materializeImage(source, fetchImpl, signal, provider, requestUrl = '', authHeaders = {}) {
    if (typeof source === 'string' && /^data:/i.test(source)) {
        const match = source.match(/^data:([^;,]+);base64,(.+)$/is);
        if (!match) throw fail('returned malformed inline image data.', { code: 'QIG_BAD_IMAGE' });
        return finishImage(Buffer.from(match[2], 'base64'));
    }
    if (source && typeof source === 'object' && typeof source.url === 'string') {
        return materializeImage(source.url, fetchImpl, signal, provider, requestUrl, authHeaders);
    }
    if (typeof source === 'string' && /^https?:/i.test(source)) {
        let sameConfiguredProxyOrigin = false;
        try {
            sameConfiguredProxyOrigin = provider === 'proxy' && !!requestUrl
                && new URL(source).origin === new URL(requestUrl).origin;
        } catch { /* An invalid output URL cannot be used. */ }
        const normalized = normalizeImageSource(source, { allowHttp: sameConfiguredProxyOrigin,
            allowRelative: false, blockPrivateHosts: !sameConfiguredProxyOrigin });
        if (!normalized || !isTrustedProviderOutputUrl(provider === 'proxy' ? 'custom' : provider,
            normalized, requestUrl, { allowRequestSubdomains: provider === 'proxy' })) {
            throw fail('a provider returned an untrusted image URL.', { code: 'QIG_UNSAFE_IMAGE_URL' });
        }
        const exactProviderOrigin = requestUrl && new URL(normalized).origin === new URL(requestUrl).origin;
        let response;
        try {
            response = await fetchImpl(normalized, { signal, redirect: 'error',
                ...(exactProviderOrigin ? { headers: authHeaders } : {}) });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw fail('the image provider output could not be downloaded.', { code: 'QIG_PROVIDER_ERROR' });
        }
        if (!response.ok) throw fail(await describeError(response, 'image download'));
        return finishImage(Buffer.from(await readResponseArrayBuffer(response)));
    }
    throw fail('returned no usable image.', { code: 'QIG_BAD_IMAGE' });
}

/** Replicate API output may need its key; allowlisted CDN output never receives it. */
export function materializeQueuedImage(source, fetchImpl, signal, provider, apiKey) {
    return materializeImage(source, fetchImpl, signal, provider,
        'https://api.replicate.com/v1/predictions', { Authorization: `Bearer ${apiKey}` });
}

function customConfig(settings) {
    return {
        mode: settings.customApiMode, url: settings.customApiUrl,
        method: settings.customApiMethod, requestType: settings.customApiRequestType,
        authType: settings.customApiAuthType, authName: settings.customApiAuthName, apiKey: settings.customApiKey,
        requestTemplate: settings.customApiRequestTemplate, responsePath: settings.customApiResponsePath,
        responseType: settings.customApiResponseType, timeoutMs: Number(settings.customApiTimeout) * 1000,
        jobIdPath: settings.customApiJobIdPath, pollUrl: settings.customApiPollUrl,
        pollMethod: settings.customApiPollMethod, statusPath: settings.customApiStatusPath,
        successValues: settings.customApiSuccessValues, failureValues: settings.customApiFailureValues,
        pollIntervalMs: settings.customApiPollInterval,
    };
}

function customInput(settings, prompt, negative) {
    return { prompt, negative, model: settings.customApiModel ?? '', width: settings.width ?? 1024,
        height: settings.height ?? 1024, steps: settings.steps ?? 25, cfgScale: settings.cfgScale ?? 7,
        sampler: settings.sampler ?? '', seed: resolveQuickImageGenSeed(settings.seed),
        referenceImages: settings.__qigCustomReferences ?? settings.customApiRefImages ?? [] };
}

export function createCustomImageRequest(settings, prompt, negative) {
    const config = normalizeCustomBackendConfig(customConfig(settings));
    // The shared adapter accepts template text and parses it when building a request.
    return { config: { ...config, requestTemplate: JSON.stringify(config.requestTemplate) }, input: customInput(settings, prompt, negative) };
}

export function assertQuickImageGenRequestConfigured(settings, prompt, negative = '') {
    const provider = assertQuickImageGenConfigured(settings);
    if (provider === 'custom') {
        buildCustomBackendRequest(customConfig(settings), customInput(settings, prompt, negative));
    } else if (provider === 'replicate' || provider === 'civitai') {
        buildQueuedImageRequest(provider, { ...settings, seed: resolveQuickImageGenSeed(settings.seed) }, prompt, negative);
    } else if (provider === 'nanobanana') {
        nanobananaEndpoint(settings);
    } else if (provider === 'novelai') {
        buildNovelAIRequest({ ...settings, seed: resolveQuickImageGenSeed(settings.seed) }, prompt, negative);
    } else if (provider === 'local' && settings.localType === 'comfyui') {
        assertComfyImageConfigured(settings, prompt, negative, resolveQuickImageGenSeed(settings.seed));
    } else if (provider === 'local') {
        buildA1111ImageRequest(settings, { prompt, negative, seed: resolveQuickImageGenSeed(settings.seed) });
    } else if (provider === 'proxy') {
        assertProxyImageConfigured(settings, prompt, negative, resolveQuickImageGenSeed(settings.proxySeed));
    }
    return provider;
}

async function openAiCompatible(provider, { label, url, apiKey, model, prompt, negative, size, body, responseFormat, fetchImpl, signal }) {
    const payload = { model, prompt, size, n: 1, ...body };
    if (responseFormat) payload.response_format = responseFormat;
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal,
    });
    if (!response.ok) throw fail(await describeError(response, label));
    void provider;
    const source = extractProviderImageSource(await readJson(response));
    if (!source) throw fail(`${label} returned no image.`, { code: 'QIG_BAD_IMAGE' });
    return source;
}

const PROVIDER_GENERATORS = {
    async novelai(s, prompt, negative, { fetchImpl, signal }) {
        const { url, body, proxy } = buildNovelAIRequest({ ...s, seed: resolveQuickImageGenSeed(s.seed) }, prompt, negative);
        const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Accept: '*/*',
                Authorization: `Bearer ${requireKey(s.naiProxyKey || s.naiKey, 'NovelAI API key')}` },
            body: JSON.stringify(body) });
        if (!response.ok) throw fail(await describeError(response, 'NovelAI'));
        if (proxy) {
            const source = extractProviderImageSource(await readJson(response));
            if (!source) throw fail('NovelAI proxy returned no image.', { code: 'QIG_BAD_IMAGE' });
            return resolveNovelAIProxyImage(source, url);
        }
        return finishImage(decodeNovelAIOutput(await readResponseArrayBuffer(response)));
    },

    async gptimage(s, prompt, negative, { fetchImpl, signal }) {
        const apiKey = requireKey(s.gptImageProxyKey || s.gptImageKey, 'GPT Image API key');
        const model = String(s.gptImageModel || 'gpt-image-2').trim();
        const width = numberOr(s.width, 1024);
        const height = numberOr(s.height, 1024);
        const size = width === height ? '1024x1024' : width > height ? '1536x1024' : '1024x1536';
        const payload = buildGptImagePayload({
            model,
            prompt,
            negative,
            size,
            quality: ['auto', 'low', 'medium', 'high'].includes(String(s.gptImageQuality)) ? s.gptImageQuality : 'auto',
            outputFormat: ['png', 'jpeg', 'webp'].includes(String(s.gptImageFormat)) ? s.gptImageFormat : 'png',
            background: ['auto', 'transparent', 'opaque'].includes(String(s.gptImageBackground)) ? s.gptImageBackground : 'auto',
            moderation: ['auto', 'low'].includes(String(s.gptImageModeration)) ? s.gptImageModeration : 'auto',
        });
        const response = await fetchImpl(getGptImageApiUrl(s.gptImageProxyUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(payload),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'GPT Image'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('GPT Image returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async routeway(s, prompt, negative, { fetchImpl, signal }) {
        const model = String(s.routewayModel || 'flux-1-schnell').trim();
        const steps = Math.max(1, Math.trunc(numberOr(s.steps, 25)));
        const guidance = numberOr(s.cfgScale, 7);
        return openAiCompatible('routeway', {
            label: 'Routeway', url: 'https://api.routeway.ai/v1/images/generations',
            apiKey: requireKey(s.routewayKey, 'Routeway API key'), model, prompt, negative,
            size: getClosestSupportedImageSize(s, ROUTEWAY_MODEL_SIZES[model]),
            body: { negative_prompt: negative, steps, guidance, seed: resolveQuickImageGenSeed(s.seed) },
            responseFormat: 'b64_json', fetchImpl, signal,
        });
    },

    async navy(s, prompt, negative, { fetchImpl, signal }) {
        const model = String(s.navyModel || 'flux').trim();
        return openAiCompatible('navy', {
            label: 'Navy.ai', url: 'https://api.navy/v1/images/generations',
            apiKey: requireKey(s.navyKey, 'Navy.ai API key'), model, prompt, negative,
            size: getClosestSupportedImageSize(s, NAVY_MODEL_SIZES[model]),
            body: {}, fetchImpl, signal,
        });
    },

    async together(s, prompt, negative, { fetchImpl, signal }) {
        const response = await fetchImpl('https://api.together.xyz/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireKey(s.togetherKey, 'Together AI API key')}` },
            body: JSON.stringify({
                model: s.togetherModel || 'stabilityai/stable-diffusion-xl-base-1.0',
                prompt, negative_prompt: negative,
                width: numberOr(s.width, 1024), height: numberOr(s.height, 1024),
                steps: Math.min(Math.trunc(numberOr(s.steps, 25)), 50), guidance_scale: numberOr(s.cfgScale, 7),
                seed: resolveQuickImageGenSeed(s.seed), n: 1,
            }),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'Together AI'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('Together AI returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async zai(s, prompt, negative, { fetchImpl, signal }) {
        const model = String(s.zaiModel || 'cogview-4-250304').trim();
        const width = numberOr(s.width, 1024);
        const height = numberOr(s.height, 1024);
        const size = model === 'glm-image' ? getGlmImageResolution(width, height) : `${width}x${height}`;
        const response = await fetchImpl('https://api.z.ai/api/paas/v4/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireKey(s.zaiKey, 'Z.AI API key')}` },
            body: JSON.stringify({ model, prompt, quality: s.zaiQuality || 'hd', size }),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'Z.AI'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('Z.AI returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async fal(s, prompt, negative, { fetchImpl, signal }) {
        const model = String(s.falModel || 'fal-ai/flux/schnell').trim();
        const response = await fetchImpl(`https://fal.run/${model}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Key ${requireKey(s.falKey, 'Fal.ai API key')}` },
            body: JSON.stringify({
                prompt, negative_prompt: negative || '',
                image_size: { width: numberOr(s.width, 1024), height: numberOr(s.height, 1024) },
                num_inference_steps: getFalEffectiveSteps(model, s.steps),
                guidance_scale: getFalEffectiveGuidance(model, s.cfgScale),
                seed: resolveQuickImageGenSeed(s.seed), num_images: 1, enable_safety_checker: false,
            }),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'Fal.ai'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('Fal.ai returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async arliai(s, prompt, negative, { fetchImpl, signal }) {
        const response = await fetchImpl('https://api.arliai.com/v1/txt2img', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireKey(s.arliKey, 'ArliAI API key')}` },
            body: JSON.stringify({
                sd_model_checkpoint: s.arliModel, prompt, negative_prompt: negative,
                width: numberOr(s.width, 1024), height: numberOr(s.height, 1024),
                steps: Math.trunc(numberOr(s.steps, 25)), cfg_scale: numberOr(s.cfgScale, 7),
                sampler_name: s.sampler, seed: resolveQuickImageGenSeed(s.seed),
            }),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'ArliAI'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('ArliAI returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async stability(s, prompt, negative, { fetchImpl, signal }) {
        const response = await fetchImpl('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireKey(s.stabilityKey, 'Stability AI API key')}` },
            body: JSON.stringify({
                text_prompts: [{ text: prompt, weight: 1 }, { text: negative || '', weight: -1 }],
                cfg_scale: numberOr(s.cfgScale, 7),
                steps: Math.min(Math.max(Math.trunc(numberOr(s.steps, 25)), 10), 50),
                width: numberOr(s.width, 1024), height: numberOr(s.height, 1024),
                seed: resolveQuickImageGenSeed(s.seed), samples: 1,
            }),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'Stability'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('Stability returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async pollinations(s, prompt, negative, { fetchImpl, signal }) {
        const model = String(s.pollinationsModel || '').trim();
        const key = String(s.pollinationsKey || '').trim();
        if (key) {
            const response = await fetchImpl('https://gen.pollinations.ai/v1/images/generations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: model || 'flux', prompt,
                    negative_prompt: negative || undefined,
                    size: `${numberOr(s.width, 1024)}x${numberOr(s.height, 1024)}`,
                    seed: resolveQuickImageGenSeed(s.seed), n: 1, response_format: 'b64_json',
                }),
                signal,
            });
            if (!response.ok) throw fail(await describeError(response, 'Pollinations'));
            const source = extractProviderImageSource(await readJson(response));
            if (!source) throw fail('Pollinations returned no image.', { code: 'QIG_BAD_IMAGE' });
            return source;
        }
        const params = new URLSearchParams({
            width: String(numberOr(s.width, 1024)), height: String(numberOr(s.height, 1024)),
            seed: String(resolveQuickImageGenSeed(s.seed)), nologo: 'true',
        });
        if (negative) params.set('negative', negative);
        if (model && model !== 'flux') params.set('model', model);
        const response = await fetchImpl(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`, { signal });
        if (!response.ok) throw fail(await describeError(response, 'Pollinations'));
        return finishImage(Buffer.from(await readResponseArrayBuffer(response)));
    },

    async chutes(s, prompt, negative, { fetchImpl, signal }) {
        const response = await fetchImpl('https://image.chutes.ai/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireKey(s.chutesKey, 'Chutes API key')}` },
            body: JSON.stringify({
                model: s.chutesModel || 'stabilityai/stable-diffusion-xl-base-1.0',
                prompt, negative_prompt: negative,
                width: numberOr(s.width, 1024), height: numberOr(s.height, 1024),
                num_inference_steps: numberOr(s.steps, 25), guidance_scale: numberOr(s.cfgScale, 7),
                seed: resolveQuickImageGenSeed(s.seed),
            }),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'Chutes'));
        const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
        if (mime.startsWith('image/') || mime === 'application/octet-stream') {
            return finishImage(Buffer.from(await readResponseArrayBuffer(response)));
        }
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('Chutes returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async nanogpt(s, _prompt, _negative, { fetchImpl, signal }) {
        const body = s.__qigNanoGptPayload;
        if (!body || typeof body !== 'object') {
            throw fail('The NanoGPT request has no saved model and reference input.', { status: 409, code: 'QIG_INPUT_MISSING' });
        }
        const response = await fetchImpl('https://nano-gpt.com/api/v1/images', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireKey(s.nanogptKey, 'NanoGPT API key')}` },
            body: JSON.stringify(body), signal, redirect: 'error',
        });
        if (!response.ok) throw fail(await describeError(response, 'NanoGPT'));
        const source = extractProviderImageSource(await readJson(response));
        if (!source) throw fail('NanoGPT returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async nanobanana(s, _prompt, _negative, { fetchImpl, signal }) {
        const payload = s.__qigNanobananaPayload;
        if (!payload || typeof payload !== 'object') {
            throw fail('The Nanobanana request has no saved references and model input.', { status: 409, code: 'QIG_INPUT_MISSING' });
        }
        const key = requireKey(s.nanobananaProxyKey || s.nanobananaKey, 'Nanobanana API key');
        const url = nanobananaEndpoint(s);
        const response = await fetchImpl(url, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getNanobananaAuthHeaders(url, key) },
            body: JSON.stringify(payload), signal, redirect: 'error' });
        if (!response.ok) throw fail(`Nanobanana request failed with HTTP ${response.status}.`);
        const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
        if (mime.startsWith('image/') || mime === 'application/octet-stream') {
            return finishImage(Buffer.from(await readResponseArrayBuffer(response)));
        }
        let data;
        try { data = JSON.parse(await readResponseText(response, MAX_PROVIDER_RESPONSE_BYTES)); } catch {
            throw fail('Nanobanana returned an unreadable response.');
        }
        if (data.promptFeedback?.blockReason) throw fail('Gemini refused this image prompt.');
        let source = extractProviderImageSource(data, { defaultMime: 'image/png', includeGeminiCandidates: false });
        let failure;
        for (const candidate of data.candidates || []) {
            const reason = getGeminiCandidateFailure(candidate);
            if (reason) { failure = 'Nanobanana did not complete the requested image.'; continue; }
            source ||= extractProviderImageSource({ candidates: [candidate] });
        }
        if (!source) throw fail(failure || 'Nanobanana returned no image.', { code: 'QIG_BAD_IMAGE' });
        return source;
    },

    async local(s, prompt, negative, { fetchImpl, signal }) {
        if (s.localType === 'comfyui') throw fail('ComfyUI needs a saved image job for safe submission and polling.',
            { status: 409, code: 'QIG_INPUT_MISSING' });
        if (!s.__qigA1111Request && (s.localRefImage || s.a1111ControlNet || s.a1111SubseedStrength > 0)) {
            throw fail('A1111 references and variation controls require a saved image job.', { status: 409, code: 'QIG_INPUT_MISSING' });
        }
        const request = s.__qigA1111Request || buildA1111ImageRequest(s, { prompt, negative, seed: resolveQuickImageGenSeed(s.seed) });
        const response = await fetchImpl(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: request.body,
            signal, redirect: 'error',
        });
        if (!response.ok) throw fail(await describeError(response, 'A1111'));
        const data = await readJson(response);
        const encoded = Array.isArray(data?.images) ? data.images[0] : '';
        if (typeof encoded !== 'string' || !encoded) throw fail('A1111 returned no image.', { code: 'QIG_BAD_IMAGE' });
        return finishImage(Buffer.from(encoded, 'base64'));
    },

    async custom(s, prompt, negative, { fetchImpl, signal }) {
        if (s.customApiMode === 'async') throw fail('Asynchronous Custom API images require a saved job.', { code: 'QIG_INPUT_MISSING', status: 409 });
        const result = await executeCustomBackend(customConfig(s), customInput(s, prompt, negative), { signal, fetchImpl });
        return finishImage(result.buffer);
    },

    async proxy(s, prompt, negative, { fetchImpl, signal }) {
        const result = await generateProxyImage({ settings: s, input: { prompt, negative },
            prepared: s.__qigProxyRequest, fetchImpl, signal });
        return Buffer.isBuffer(result) ? finishImage(result) : result;
    },
};

export function readQuickImageGenSettings(directories) {
    try {
        const raw = fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8');
        const block = JSON.parse(raw)?.extension_settings?.[QUICK_IMAGE_GEN_EXTENSION_ID];
        return block && typeof block === 'object' ? block : {};
    } catch {
        return {};
    }
}

/** Reject a configuration known to be unable to send a request before recording provider uncertainty. */
export function assertQuickImageGenConfigured(settings) {
    const provider = String(settings?.provider || '').trim();
    if (!Object.hasOwn(PROVIDER_GENERATORS, provider) && !['replicate', 'civitai'].includes(provider)) {
        throw fail(provider
            ? `Quick Image Gen provider '${provider}' has no server-side implementation yet.`
            : 'No Quick Image Gen provider is configured for this account.',
        { status: 409, code: 'QIG_PROVIDER_UNSUPPORTED' });
    }
    switch (provider) {
        case 'gptimage': requireKey(settings.gptImageProxyKey || settings.gptImageKey, 'GPT Image API key'); break;
        case 'routeway': requireKey(settings.routewayKey, 'Routeway API key'); break;
        case 'navy': requireKey(settings.navyKey, 'Navy.ai API key'); break;
        case 'together': requireKey(settings.togetherKey, 'Together AI API key'); break;
        case 'zai': requireKey(settings.zaiKey, 'Z.AI API key'); break;
        case 'fal': requireKey(settings.falKey, 'Fal.ai API key'); break;
        case 'arliai': requireKey(settings.arliKey, 'ArliAI API key'); break;
        case 'stability': requireKey(settings.stabilityKey, 'Stability AI API key'); break;
        case 'chutes': requireKey(settings.chutesKey, 'Chutes API key'); break;
        case 'nanogpt': requireKey(settings.nanogptKey, 'NanoGPT API key'); break;
        case 'nanobanana': requireKey(settings.nanobananaProxyKey || settings.nanobananaKey, 'Nanobanana API key'); break;
        case 'novelai': requireKey(settings.naiProxyKey || settings.naiKey, 'NovelAI API key'); break;
        case 'replicate': requireKey(settings.replicateKey, 'Replicate API key'); break;
        case 'civitai': requireKey(settings.civitaiKey, 'CivitAI API key'); break;
        case 'local':
            if (settings.localType === 'comfyui') comfyImageBaseUrl(settings);
            else a1111BaseUrl(settings);
            break;
        case 'custom': normalizeCustomBackendConfig(customConfig(settings)); break;
        case 'proxy': assertProxyImageConfigured(settings, '', '', resolveQuickImageGenSeed(settings.proxySeed)); break;
        default: break;
    }
    return provider;
}

/**
 * Generate one image with the account's configured Quick Image Gen provider.
 * Returns { base64, format }; never substitutes a different provider.
 */
export async function generateQuickImageGenImage({ directories, prompt, negative = '', signal, fetch: fetchImpl = globalThis.fetch, settings } = {}) {
    if (!directories?.root) throw fail('No account directories were provided for image generation.', { status: 500, recoverable: false });
    if (!String(prompt || '').trim()) throw fail('An image prompt is required.', { status: 400, recoverable: false });
    const resolvedSettings = settings && typeof settings === 'object' ? settings : readQuickImageGenSettings(directories);
    const provider = assertQuickImageGenRequestConfigured(resolvedSettings, prompt, negative);
    const generator = PROVIDER_GENERATORS[provider];
    if (!generator) throw fail('This queued image provider requires a saved job for safe submission and polling.',
        { status: 409, code: 'QIG_INPUT_MISSING' });
    const deadline = createHostedProviderDeadline(signal, provider === 'local' ? 600 : resolvedSettings.hostedTimeout, provider);
    const safeFetch = (url, init = {}) => fetchImpl(url, { ...init, redirect: 'error' });
    try {
        const source = await generator(resolvedSettings, prompt, negative, { fetchImpl: safeFetch, signal: deadline.signal });
        if (source && typeof source === 'object' && typeof source.base64 === 'string') return source;
        let requestUrl = '';
        let key = '';
        if (provider === 'gptimage') {
            requestUrl = getGptImageApiUrl(resolvedSettings.gptImageProxyUrl);
            key = resolvedSettings.gptImageProxyKey || resolvedSettings.gptImageKey;
        } else if (provider === 'proxy') {
            requestUrl = resolvedSettings.__qigProxyRequest?.request?.url || '';
            key = resolvedSettings.proxyKey;
        } else if (provider === 'nanobanana') {
            requestUrl = getNanobananaApiUrl(resolvedSettings.nanobananaProxyUrl,
                resolvedSettings.nanobananaModel || 'gemini-3-pro-image');
            key = resolvedSettings.nanobananaProxyKey || resolvedSettings.nanobananaKey;
        } else if (provider === 'novelai') {
            requestUrl = buildNovelAIRequest({ ...resolvedSettings,
                seed: resolveQuickImageGenSeed(resolvedSettings.seed) }, prompt, negative).url;
            key = resolvedSettings.naiProxyKey || resolvedSettings.naiKey;
        }
        const headers = provider === 'nanobanana' ? getNanobananaAuthHeaders(requestUrl, key)
            : key ? { Authorization: `Bearer ${key}` } : {};
        return await materializeImage(source, safeFetch, deadline.signal, provider, requestUrl, headers);
    } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (deadline.didTimeOut()) throw fail(`Quick Image Gen provider '${provider}' timed out after ${deadline.seconds} seconds.`, { code: 'QIG_PROVIDER_TIMEOUT' });
        if (trustedErrors.has(error)) throw error;
        if (error?.name === 'AbortError') throw Object.assign(new Error('The image request was cancelled.'), { name: 'AbortError' });
        throw fail(`Quick Image Gen provider '${provider}' failed.`, {
            status: error?.status || 502, code: /^QIG_[A-Z_]+$/.test(error?.code) ? error.code : 'QIG_PROVIDER_ERROR',
        });
    } finally {
        deadline.dispose();
    }
}

function unsafeImagePath() {
    return fail('The saved image directory is not an account directory.', { status: 409, code: 'QIG_UNSAFE_IMAGE_PATH' });
}

function ensureAccountImageDirectory(root, directory) {
    const accountRoot = path.resolve(root);
    const relative = path.relative(accountRoot, path.resolve(directory));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw unsafeImagePath();
    const account = fs.lstatSync(accountRoot);
    if (!account.isDirectory() || account.isSymbolicLink()) throw unsafeImagePath();
    let current = accountRoot;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        let info;
        try {
            info = fs.lstatSync(current);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            try {
                fs.mkdirSync(current, { mode: 0o700 });
                fsyncDirectorySync(path.dirname(current));
            } catch (created) {
                if (created.code !== 'EEXIST') throw created;
            }
            info = fs.lstatSync(current);
        }
        if (!info.isDirectory() || info.isSymbolicLink()) throw unsafeImagePath();
    }
}

function matchesSavedImage(target, bytes) {
    let fd;
    try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const current = fs.fstatSync(fd);
        if (!current.isFile() || current.nlink !== 1 || current.size !== bytes.length || !bytes.equals(fs.readFileSync(fd))) {
            throw fail('A saved image path already contains different data; the original was left untouched.', { status: 409, code: 'QIG_IMAGE_CONFLICT' });
        }
    } catch (error) {
        if (error.code === 'QIG_IMAGE_CONFLICT') throw error;
        if (['ELOOP', 'ENOENT'].includes(error.code)) {
            throw fail('A saved image path changed or points to another file.', { status: 409, code: 'QIG_IMAGE_CONFLICT' });
        }
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** Save a generated image into the account's userImages tree and return its client-relative path. */
export async function saveQuickImageToUserImages(directories, { base64, format = 'png', chName = '', filename = '', owner, account, assertSourceLocked } = {}) {
    const base = roleplayAccountBase(directories);
    if (!base || base.owner !== owner) throw unsafeImagePath();
    return withRoleplayAccount(base, account, lease => {
        assertSourceLocked?.(lease);
        const extension = MEDIA_EXTENSIONS.includes(format) ? format : 'png';
        const name = filename
            ? `${removeFileExtension(filename)}.${extension}`
            : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
        let target = path.join(directories.userImages, sanitize(name));
        if (chName) target = path.join(directories.userImages, sanitize(chName), sanitize(name));
        const directory = path.dirname(target);
        ensureAccountImageDirectory(directories.root, directory);
        const bytes = Buffer.from(base64, 'base64');
        const temporary = path.join(directory, `.qig-${randomUUID()}.tmp`);
        let fd;
        let failure;
        try {
            fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
                | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            ensureAccountImageDirectory(directories.root, directory);
            try {
                // Hard-link creates the final name only after the complete temporary image is durable.
                fs.linkSync(temporary, target);
                fsyncDirectorySync(directory);
            } catch (error) {
                if (error.code !== 'EEXIST' || !filename) throw error;
                matchesSavedImage(target, bytes);
            }
        } catch (error) {
            failure = error;
        } finally {
            try {
                if (fd !== undefined) fs.closeSync(fd);
                fs.unlinkSync(temporary);
                fsyncDirectorySync(directory);
            } catch (error) {
                if (error.code !== 'ENOENT' && !failure) failure = error;
            }
        }
        if (failure) throw failure;
        return clientRelativePath(directories.root, target);
    });
}

export const testExports = { PROVIDER_GENERATORS, resolveSeed: resolveQuickImageGenSeed };

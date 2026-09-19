import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import sanitize from 'sanitize-filename';

import { SETTINGS_FILE, MEDIA_EXTENSIONS } from '../constants.js';
import { clientRelativePath, ensureDirectory, removeFileExtension } from '../util.js';
import {
    extractProviderImageSource,
    buildGptImagePayload,
    getGptImageApiUrl,
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

const A1111_SAMPLER_DISPLAY_NAMES = {
    euler_a: 'Euler a', euler: 'Euler',
    'dpm++_2m': 'DPM++ 2M', 'dpm++_sde': 'DPM++ SDE', 'dpm++_2m_sde': 'DPM++ 2M SDE',
    'dpm++_3m_sde': 'DPM++ 3M SDE', 'dpm++_2s_ancestral': 'DPM++ 2S a',
    dpm_2: 'DPM2', dpm_2_ancestral: 'DPM2 a', dpm_fast: 'DPM fast', dpm_adaptive: 'DPM adaptive',
    ddim: 'DDIM', ddpm: 'DDPM', lms: 'LMS', heun: 'Heun', heunpp2: 'Heun++ 2', plms: 'PLMS',
    uni_pc: 'UniPC', uni_pc_bh2: 'UniPC BH2',
    lcm: 'LCM', deis: 'DEIS', restart: 'Restart',
    er_sde: 'ER SDE',
};

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

function fail(message, { status = 502, code = 'QIG_PROVIDER_ERROR', recoverable = true } = {}) {
    return Object.assign(new Error(message), { status, code, recoverable });
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

function resolveSeed(seed) {
    const value = Number(seed);
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
    // ponytail: mirrors QIG's random seed behaviour without its signed-seed modes.
    return Math.floor(Math.random() * 4294967296);
}

async function readJson(response) {
    const text = await readResponseText(response);
    try {
        return JSON.parse(text);
    } catch {
        throw fail(`returned an unreadable response: ${text.replace(/\s+/g, ' ').slice(0, 200) || 'empty'}`);
    }
}

async function describeError(response, label) {
    let detail = '';
    try {
        detail = (await readResponseText(response)).replace(/\s+/g, ' ').slice(0, 200);
    } catch {
        detail = '';
    }
    return `${label} request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

function finishImage(bytes, source) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const format = detectImageFormat(buffer);
    if (!format) throw fail('returned a response that is not a supported image.', { code: 'QIG_BAD_IMAGE' });
    void source;
    return { base64: buffer.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext };
}

async function materializeImage(source, fetchImpl, signal) {
    if (typeof source === 'string' && /^data:/i.test(source)) {
        const match = source.match(/^data:([^;,]+);base64,(.+)$/is);
        if (!match) throw fail('returned malformed inline image data.', { code: 'QIG_BAD_IMAGE' });
        return finishImage(Buffer.from(match[2], 'base64'));
    }
    if (source && typeof source === 'object' && typeof source.url === 'string') {
        return materializeImage(source.url, fetchImpl, signal);
    }
    if (typeof source === 'string' && /^https?:/i.test(source)) {
        const normalized = normalizeImageSource(source, { allowHttp: false, allowRelative: false, blockPrivateHosts: true });
        if (!normalized) throw fail('a provider returned an untrusted image URL.', { code: 'QIG_UNSAFE_IMAGE_URL' });
        const response = await fetchImpl(normalized, { signal, redirect: 'error' });
        if (!response.ok) throw fail(await describeError(response, 'image download'));
        return finishImage(Buffer.from(await readResponseArrayBuffer(response)));
    }
    throw fail('returned no usable image.', { code: 'QIG_BAD_IMAGE' });
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
            body: { negative_prompt: negative, steps, guidance, seed: resolveSeed(s.seed) },
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
                seed: resolveSeed(s.seed), n: 1,
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
                seed: resolveSeed(s.seed), num_images: 1, enable_safety_checker: false,
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
                sampler_name: s.sampler, seed: resolveSeed(s.seed),
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
                seed: resolveSeed(s.seed), samples: 1,
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
                    seed: resolveSeed(s.seed), n: 1, response_format: 'b64_json',
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
            seed: String(resolveSeed(s.seed)), nologo: 'true',
        });
        if (negative) params.set('negative', negative);
        if (model && model !== 'flux') params.set('model', model);
        const response = await fetchImpl(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`, { signal });
        if (!response.ok) throw fail(await describeError(response, 'Pollinations'));
        return finishImage(Buffer.from(await readResponseArrayBuffer(response)));
    },

    async local(s, prompt, negative, { fetchImpl, signal }) {
        if (s.localType === 'comfyui') throw fail('ComfyUI has no server-side implementation yet.', { status: 409, code: 'QIG_PROVIDER_UNSUPPORTED' });
        const baseUrl = String(s.localUrl || '').trim().replace(/\/+$/, '');
        if (!baseUrl) throw fail('A1111 URL is not configured in Quick Image Gen.', { code: 'QIG_MISSING_URL' });
        const payload = {
            prompt, negative_prompt: negative,
            width: numberOr(s.width, 1024), height: numberOr(s.height, 1024),
            steps: Math.min(Math.max(Math.trunc(numberOr(s.steps, 25)), 1), 150), cfg_scale: numberOr(s.cfgScale, 7),
            sampler_name: A1111_SAMPLER_DISPLAY_NAMES[s.sampler] || s.sampler,
            scheduler: s.a1111Scheduler || 'Automatic',
            seed: resolveSeed(s.seed),
        };
        if (s.a1111Model) {
            payload.override_settings = { sd_model_checkpoint: s.a1111Model };
            payload.override_settings_restore_afterwards = true;
        }
        const response = await fetchImpl(`${baseUrl}/sdapi/v1/txt2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        });
        if (!response.ok) throw fail(await describeError(response, 'A1111'));
        const data = await readJson(response);
        const encoded = Array.isArray(data?.images) ? data.images[0] : '';
        if (typeof encoded !== 'string' || !encoded) throw fail('A1111 returned no image.', { code: 'QIG_BAD_IMAGE' });
        return finishImage(Buffer.from(encoded, 'base64'));
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

/**
 * Generate one image with the account's configured Quick Image Gen provider.
 * Returns { base64, format }; never substitutes a different provider.
 */
export async function generateQuickImageGenImage({ directories, prompt, negative = '', signal, fetch: fetchImpl = globalThis.fetch, settings } = {}) {
    if (!directories?.root) throw fail('No account directories were provided for image generation.', { status: 500, recoverable: false });
    if (!String(prompt || '').trim()) throw fail('An image prompt is required.', { status: 400, recoverable: false });
    const resolvedSettings = settings && typeof settings === 'object' ? settings : readQuickImageGenSettings(directories);
    const provider = String(resolvedSettings.provider || '').trim();
    if (!Object.hasOwn(PROVIDER_GENERATORS, provider)) {
        throw fail(provider
            ? `Quick Image Gen provider '${provider}' has no server-side implementation yet.`
            : 'No Quick Image Gen provider is configured for this account.',
        { status: 409, code: 'QIG_PROVIDER_UNSUPPORTED' });
    }
    const generator = PROVIDER_GENERATORS[provider];
    const deadline = createHostedProviderDeadline(signal, resolvedSettings.hostedTimeout, provider);
    try {
        const source = await generator(resolvedSettings, prompt, negative, { fetchImpl, signal: deadline.signal });
        if (source && typeof source === 'object' && typeof source.base64 === 'string') return source;
        return await materializeImage(source, fetchImpl, deadline.signal);
    } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (deadline.didTimeOut()) throw fail(`Quick Image Gen provider '${provider}' timed out after ${deadline.seconds} seconds.`, { code: 'QIG_PROVIDER_TIMEOUT' });
        if (error?.name === 'AbortError') throw error;
        if (error?.status) throw error;
        throw fail(`Quick Image Gen provider '${provider}' failed: ${error?.message || error}`, { code: 'QIG_PROVIDER_ERROR' });
    } finally {
        deadline.dispose();
    }
}

/** Save a generated image into the account's userImages tree and return its client-relative path. */
export async function saveQuickImageToUserImages(directories, { base64, format = 'png', chName = '', filename = '' } = {}) {
    const extension = MEDIA_EXTENSIONS.includes(format) ? format : 'png';
    const name = filename
        ? `${removeFileExtension(filename)}.${extension}`
        : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
    let target = path.join(directories.userImages, sanitize(name));
    if (chName) target = path.join(directories.userImages, sanitize(chName), sanitize(name));
    ensureDirectory(path.dirname(target));
    await fs.promises.writeFile(target, Buffer.from(base64, 'base64'));
    return clientRelativePath(directories.root, target);
}

export const testExports = { PROVIDER_GENERATORS, resolveSeed };

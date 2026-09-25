import { inflateRawSync } from 'node:zlib';

import { getClosestSupportedImageSize } from '../../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';
import { isNovelAICompatibleProxyUrl, isOpenAIChatCompletionsEndpoint } from '../../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import { buildNovelAIProxyRequestUrl, findEmbeddedPngRange } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { assertSafeConfigurableEndpoint } from '../../public/scripts/extensions/quick-image-gen/lib/network-runtime.js';
import { MAX_IMAGE_BYTES } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';

const sizes = ['512x768', '768x512', '640x640', '832x1216', '1216x832', '1024x1024',
    '1024x1536', '1536x1024', '1472x1472', '1088x1920', '1920x1088'];
const samplers = {
    euler_a: 'k_euler_ancestral', euler: 'k_euler', 'dpm++_2m': 'k_dpmpp_2m',
    'dpm++_sde': 'k_dpmpp_sde', 'dpm++_2m_sde': 'k_dpmpp_2m', 'dpm++_3m_sde': 'k_dpmpp_2m',
    'dpm++_2s_ancestral': 'k_dpmpp_2s_ancestral', dpm_2: 'k_dpm_2', dpm_2_ancestral: 'k_dpm_2_ancestral',
    dpm_fast: 'k_dpm_fast', dpm_adaptive: 'k_dpm_adaptive', ddim: 'ddim', ddpm: 'k_euler',
    lms: 'k_lms', heun: 'k_heun', heunpp2: 'k_heun', plms: 'k_euler', uni_pc: 'k_euler',
    uni_pc_bh2: 'k_euler', lcm: 'k_euler', deis: 'k_euler', restart: 'k_euler',
};

function dimension(value) {
    const numeric = Number.parseInt(value, 10);
    return Math.round(Math.max(256, Math.min(2048, Number.isFinite(numeric) ? numeric : 512)) / 64) * 64;
}

/** Build the native, generate-proxy or chat-proxy request before a paid outcome is marked unknown. */
export function buildNovelAIRequest(settings, prompt, negative) {
    const model = String(settings.naiModel || 'nai-diffusion-4-5-curated').trim();
    if (!model || !Number.isSafeInteger(settings.seed) || settings.seed < 0) throw new Error('NovelAI has invalid saved model or seed.');
    const width = dimension(settings.width);
    const height = dimension(settings.height);
    const newer = model.includes('diffusion-3') || model.includes('diffusion-4');
    const sampler = settings.sampler === 'ddim' && newer ? 'ddim_v3' : samplers[settings.sampler] || 'k_euler_ancestral';
    const proxy = String(settings.naiProxyUrl || '').trim();
    if (proxy && isNovelAICompatibleProxyUrl(proxy)) {
        const url = isOpenAIChatCompletionsEndpoint(proxy) ? proxy : buildNovelAIProxyRequestUrl(proxy, 'chat');
        assertSafeConfigurableEndpoint(url, 'NovelAI proxy URL');
        const [chosenWidth, chosenHeight] = getClosestSupportedImageSize({ width, height }, sizes).split('x');
        const alias = { k_euler_ancestral: 'Euler Ancestral', k_euler: 'Euler', k_dpmpp_2m: 'DPM++ 2M',
            k_dpmpp_sde: 'DPM++ SDE', k_dpmpp_2m_sde: 'DPM++ 2M SDE', ddim: 'DDIM', ddim_v3: 'DDIM' };
        return { proxy: true, url, body: { model, messages: [{ role: 'user', content: prompt }],
            size: `${chosenWidth}:${chosenHeight}`, negative_prompt: negative,
            sampler: alias[sampler] || 'Euler Ancestral', steps: settings.steps,
            scale: settings.cfgScale, seed: settings.seed, return_base64: true, stream: false } };
    }
    const apiUrl = proxy ? buildNovelAIProxyRequestUrl(proxy, 'generate') : 'https://image.novelai.net/ai/generate-image';
    assertSafeConfigurableEndpoint(apiUrl, 'NovelAI generation URL');
    const parameters = { width, height, steps: settings.steps, scale: settings.cfgScale, sampler,
        seed: settings.seed, n_samples: 1, ucPreset: 0, qualityToggle: false, negative_prompt: negative,
        params_version: 3, legacy: false, controlnet_strength: 1, dynamic_thresholding: false,
        cfg_rescale: 0, noise_schedule: 'native' };
    if (model.includes('-4')) Object.assign(parameters, {
        v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
        v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false },
        characterPrompts: [], skip_cfg_above_sigma: null,
    });
    if (proxy) parameters.return_base64 = true;
    return { proxy: !!proxy, url: apiUrl, body: { input: prompt, model, action: 'generate', parameters } };
}

export function resolveNovelAIProxyImage(source, requestUrl) {
    if (typeof source !== 'string' || !source) throw new Error('NovelAI proxy returned no image.');
    if (/^(?:data:|https?:\/\/)/i.test(source)) return source;
    const base = String(requestUrl).replace(/\/(?:generate|chat\/completions)\/?(?:[?#].*)?$/i, '').replace(/\/$/, '');
    try { return new URL(source, `${base}/`).href; } catch {
        throw new Error('NovelAI proxy returned an invalid image location.');
    }
}

/** A bounded, filename-agnostic PNG reader. No archive path ever reaches the filesystem. */
export function decodeNovelAIOutput(value) {
    const bytes = Buffer.from(value);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('NovelAI image response exceeds its size limit.');
    if (bytes.length >= 2 && bytes.readUInt16LE(0) === 0x4b50) {
        let end = -1;
        for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
            if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
        }
        if (end < 0) throw new Error('NovelAI ZIP response has no central directory.');
        let offset = bytes.readUInt32LE(end + 16);
        const count = Math.min(bytes.readUInt16LE(end + 10), 1024);
        for (let index = 0; index < count; index++) {
            if (offset > bytes.length - 46 || bytes.readUInt32LE(offset) !== 0x02014b50) break;
            const flags = bytes.readUInt16LE(offset + 8);
            const method = bytes.readUInt16LE(offset + 10);
            const compressedSize = bytes.readUInt32LE(offset + 20);
            const uncompressedSize = bytes.readUInt32LE(offset + 24);
            const nameLength = bytes.readUInt16LE(offset + 28);
            const extraLength = bytes.readUInt16LE(offset + 30);
            const commentLength = bytes.readUInt16LE(offset + 32);
            const next = offset + 46 + nameLength + extraLength + commentLength;
            if (next > bytes.length) break;
            const filename = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
            if (filename.toLowerCase().endsWith('.png')) {
                if (flags & 1 || uncompressedSize > MAX_IMAGE_BYTES || compressedSize > MAX_IMAGE_BYTES) {
                    throw new Error('NovelAI ZIP PNG is encrypted or too large.');
                }
                const localOffset = bytes.readUInt32LE(offset + 42);
                if (localOffset > bytes.length - 30 || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
                    throw new Error('NovelAI ZIP PNG has an invalid local header.');
                }
                const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
                if (dataOffset > bytes.length || compressedSize > bytes.length - dataOffset) {
                    throw new Error('NovelAI ZIP PNG is truncated.');
                }
                const payload = bytes.subarray(dataOffset, dataOffset + compressedSize);
                const png = method === 0 ? payload : method === 8
                    ? inflateRawSync(payload, { maxOutputLength: MAX_IMAGE_BYTES }) : null;
                if (!png || png.length !== uncompressedSize || !findEmbeddedPngRange(png)) {
                    throw new Error('NovelAI ZIP PNG is invalid.');
                }
                return png;
            }
            offset = next;
        }
        throw new Error('NovelAI ZIP response has no PNG image.');
    }
    const range = findEmbeddedPngRange(bytes);
    if (!range) throw new Error('NovelAI response has no PNG image.');
    return bytes.subarray(range.start, range.end);
}

import path from 'node:path';
import { bindChatInputSettings, supportsChatImages } from '../../public/scripts/chat-input-capabilities.js';
import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { fetchChatProfileModels } from '../generation/service.js';
import { readRoleplayFile } from '../roleplay-store.js';
import { decodeServerImage, encodeServerImage } from '../media-codecs.js';
import { Jimp } from '../jimp.js';
import { imageChangeHash, imagePart, SCRATCHPAD_IMAGE_URL } from './image-state.js';

const CATALOGUED = new Set(['openrouter', 'mistralai', 'aimlapi', 'chutes', 'electronhub', 'pollinations', 'moonshot', 'nanogpt', 'workers_ai']);
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_IMAGES = 4;
export const MAX_GENERATED_HISTORY_BYTES = 1024 * 1024;

/** Only a completed server receipt matching the selected reply version can supply pixels. */
export function generatedImageReceipts(message) {
    if (message.role !== 'assistant' || message.state !== 'done') return [];
    return Object.entries(message.images ?? {}).flatMap(([index, image]) => {
        const part = imagePart(message.text, Number(index));
        return image.state === 'done' && SCRATCHPAD_IMAGE_URL.test(image.url) && /^[a-f0-9]{64}$/.test(image.imageHash)
            && part && imageChangeHash(part.change) === image.changeHash ? [{ ...image, index: Number(index) }] : [];
    });
}

async function imageInput(directories, receipt) {
    try {
        const file = readRoleplayFile(path.join(directories.root, receipt.url.replace(/^\//, '')), 20 * 1024 * 1024, { allowMissingParent: true });
        if (!file || file.rawHash !== receipt.imageHash) return null;
        let bytes = file.bytes;
        let mime = detectImageFormat(bytes)?.mime;
        if (!mime) return null;
        const bitmap = await decodeServerImage(bytes);
        if (Math.ceil(bytes.length / 3) * 4 > MAX_IMAGE_BYTES) {
            const preview = Jimp.fromBitmap(bitmap);
            for (const size of [1024, 768, 512]) {
                preview.scaleToFit({ w: size, h: size });
                bytes = await encodeServerImage(preview.bitmap, 'jpeg', { quality: 80 });
                if (Math.ceil(bytes.length / 3) * 4 + 64 <= MAX_IMAGE_BYTES) break;
            }
            mime = 'image/jpeg';
        }
        const url = `data:${mime};base64,${bytes.toString('base64')}`;
        return Buffer.byteLength(url) <= MAX_IMAGE_BYTES ? url : null;
    } catch {
        // Missing, changed or unreadable pictures must not prevent a text follow-up.
        return null;
    }
}

/** Resolve vision for this speaker, then attach recent results within the saved-request budget. */
export async function prepareGeneratedImageHistory({ context, material, history, maxBytes = MAX_GENERATED_HISTORY_BYTES,
    fetchModels = fetchChatProfileModels, cache = new Map() }) {
    if (material.backend && material.backend !== 'chat' || !history.some(message => message.generatedImages?.length) || maxBytes <= 0) return history;
    const settings = bindChatInputSettings(mergeChatPresetSettings(material.active, material.preset), material.source, material.profile?.model);
    if (!settings.media_inlining) return history;
    let models = [];
    try {
        if (CATALOGUED.has(material.source)) models = await fetchModels({ context, material });
        if (!supportsChatImages(settings, { model_list: models })) return history;
    } catch {
        return history;
    }
    const result = history.map(message => ({ ...message }));
    let remaining = Math.min(maxBytes, MAX_GENERATED_HISTORY_BYTES);
    let count = 0;
    for (const message of result.toReversed()) {
        const content = [];
        for (const image of (message.generatedImages ?? []).toReversed()) {
            const label = `Generated image from ${message.assistantName || message.assistant || 'the assistant'}, proposal ${image.index + 1} in the preceding Scratchpad reply.`;
            let url = null;
            if (count < MAX_IMAGES && remaining > 1024) {
                const key = `${image.url}:${image.imageHash}`;
                if (!cache.has(key)) cache.set(key, imageInput(context.directories, image));
                url = await cache.get(key);
            }
            let parts = url ? [{ type: 'text', text: label }, { type: 'image_url', image_url: { url, detail: ['low', 'high'].includes(settings.inline_image_quality) ? settings.inline_image_quality : 'auto' } }] : [];
            if (!parts.length || Buffer.byteLength(JSON.stringify(parts)) + 64 > remaining) {
                parts = [{ type: 'text', text: `${label} Picture not attached (unavailable or history limit); do not infer its appearance from the prompt.` }];
            } else count++;
            const size = Buffer.byteLength(JSON.stringify(parts)) + 64;
            if (size > remaining) continue;
            remaining -= size;
            content.unshift(...parts);
        }
        if (content.length) message.generatedImageContent = content;
    }
    return result;
}

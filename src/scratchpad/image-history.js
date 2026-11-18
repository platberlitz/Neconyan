import path from 'node:path';
import { bindChatInputSettings, supportsChatImages } from '../../public/scripts/chat-input-capabilities.js';
import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { fetchChatProfileModels } from '../generation/service.js';
import { readRoleplayFile } from '../roleplay-store.js';
import { decodeServerImage, encodeServerImage } from '../media-codecs.js';
import { Jimp } from '../jimp.js';
export { generatedImageReceipts } from './image-state.js';

const CATALOGUED = new Set(['openrouter', 'mistralai', 'aimlapi', 'chutes', 'electronhub', 'pollinations', 'moonshot', 'nanogpt', 'workers_ai']);
// These sources route to models Neconyan cannot look up, so their pictures are offered and a refusal falls back to text.
const UNLISTED = new Set(['custom', 'cometapi']);
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_IMAGES = 4;
const MAX_TEXT_ONLY_MODELS = 256;
export const MAX_GENERATED_HISTORY_BYTES = 1024 * 1024;
const textOnlyModels = new Set();

function speakerSettings(material) {
    return bindChatInputSettings(mergeChatPresetSettings(material.active, material.preset), material.source, material.profile?.model);
}

function modelKey(material) {
    const settings = speakerSettings(material);
    const source = settings.chat_completion_source;
    // Saved profiles carry their own Custom address; the active connection keeps it in its settings.
    const url = source === 'custom' ? material.profile?.['api-url'] || settings.custom_url || '' : '';
    return JSON.stringify([source, url, settings.reverse_proxy ?? '', settings[`${source}_model`] ?? '']);
}

/** Remember for this server run that a model refused pictures, so later replies skip the failed attempt. */
export function rememberTextOnlyModel(material) {
    const key = modelKey(material);
    textOnlyModels.delete(key);
    textOnlyModels.add(key);
    if (textOnlyModels.size > MAX_TEXT_ONLY_MODELS) textOnlyModels.delete(textOnlyModels.values().next().value);
}

export function forgetTextOnlyModels() {
    textOnlyModels.clear();
}

function refusalText(error) {
    if (![400, 404, 415, 422].includes(Number(error?.providerStatus))) return '';
    const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? '');
    const text = `${error.message ?? ''} ${body}`.slice(0, 8000);
    return /\bimages?\b|image_url|vision|multi-?modal|modalit/i.test(text) ? text : '';
}

/** A definite provider refusal that names pictures, as opposed to an auth, quota or prompt failure. */
export function isImageRefusal(error) {
    return Boolean(refusalText(error));
}

/** Only wording about missing support marks the model text-only; a picture the provider could not read does not. */
export function isUnsupportedImageRefusal(error) {
    return /not (?:be )?supported|unsupported|not support|does not accept|doesn't support|only supported|not available|not allowed|expected `?text|unknown variant|invalid content type/i.test(refusalText(error));
}

/** Record where pictures sit in the prepared messages, with the text that replaces them if the model refuses pictures. */
export function generatedImageFallback(messages, history) {
    const text = new Map(history.filter(message => message.generatedImageText).map(message => [message.generatedImageContent, message.generatedImageText]));
    return messages.flatMap((message, index) => text.has(message.content) ? [{ index, content: text.get(message.content) }] : []);
}

export function withoutGeneratedImages(messages, fallback) {
    const result = [...messages];
    for (const { index, content } of fallback) {
        if (!Array.isArray(result[index]?.content) || !result[index].content.some(part => part.type === 'image_url')) throw new Error('The saved picture position is missing.');
        result[index] = { ...result[index], content };
    }
    return result;
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
    const settings = speakerSettings(material);
    if (textOnlyModels.has(modelKey(material))) return history;
    if (!UNLISTED.has(material.source)) {
        try {
            const models = CATALOGUED.has(material.source) ? await fetchModels({ context, material }) : [];
            // Scratchpad supplies its own saved pictures, independently of regular-chat media inlining.
            if (!supportsChatImages({ ...settings, media_inlining: true }, { model_list: models })) return history;
        } catch {
            return history;
        }
    }
    const result = history.map(message => ({ ...message }));
    let remaining = Math.min(maxBytes, MAX_GENERATED_HISTORY_BYTES);
    let count = 0;
    for (const message of result.toReversed()) {
        const content = [];
        const text = [];
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
            text.unshift(parts.length > 1 ? { type: 'text', text: `${label} Picture not attached because this model refused pictures; do not infer its appearance from the prompt.` } : parts[0]);
        }
        if (content.length) message.generatedImageContent = content;
        if (content.length > text.length) message.generatedImageText = text;
    }
    return result;
}

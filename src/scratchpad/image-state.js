import { roleplayHash } from '../roleplay-store.js';
import { splitReply } from '../../public/scripts/scratchpad/proposals.js';

export const SCRATCHPAD_IMAGE_URL = /^\/?user\/images\/Scratchpad\/scratchpad-[a-z0-9-]+\.(?:png|jpe?g|webp|gif)$/;
export const imageChangeHash = change => roleplayHash(change);
export const imagePart = (text, index) => splitReply(text).find(part => part.type === 'change' && part.index === Number(index) && part.change?.type === 'image');
export const hasPendingImages = message => Object.values(message.images ?? {}).some(image => image.state === 'pending');

/** Receipts and target permissions are accepted only from the server's own saved bucket. */
export function normaliseStoredImages(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const images = {};
    for (const [index, input] of Object.entries(value).slice(0, 24)) {
        if (!/^\d{1,2}$/.test(index) || String(Number(index)) !== index || Number(index) > 23 || !input || typeof input !== 'object'
            || !['pending', 'done', 'failed', 'cancelled'].includes(input.state) || !/^[a-f0-9]{64}$/.test(input.changeHash)
            || !['image', 'avatar'].includes(input.target)) continue;
        const image = { state: input.state, target: input.target, changeHash: input.changeHash };
        if (typeof input.providerReached === 'boolean') image.providerReached = input.providerReached;
        for (const [key, max] of Object.entries({ id: 64, jobId: 128, avatar: 256, characterName: 200, prompt: 10000, negative: 10000, error: 1000, previousAvatarRevision: 64 })) {
            if (typeof input[key] === 'string') image[key] = input[key].slice(0, max);
        }
        if (typeof input.imageHash === 'string' && /^[a-f0-9]{64}$/.test(input.imageHash)) image.imageHash = input.imageHash;
        for (const key of ['url', 'previousAvatarUrl']) if (typeof input[key] === 'string' && SCRATCHPAD_IMAGE_URL.test(input[key])) image[key] = input[key];
        for (const key of ['width', 'height']) if (Number.isSafeInteger(input[key]) && input[key] > 0 && input[key] <= 32768) image[key] = input[key];
        if (image.state === 'done' && !image.url) { image.state = 'failed'; image.error = 'The saved image address is unavailable.'; }
        images[index] = image;
    }
    return images;
}

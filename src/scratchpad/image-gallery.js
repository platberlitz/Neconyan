import path from 'node:path';
import { inspectRoleplayFileStat, roleplayLease } from '../roleplay-store.js';
import { replySwipes } from '../../public/scripts/scratchpad/swipes.js';
import { generatedImageReceipts, normaliseStoredImages } from './image-state.js';
import { savedSessionListsLocked } from './search.js';

/** Gallery references saved pictures directly; listing never reads or copies their bytes. */
export function scratchpadGalleryLocked(lease) {
    const root = roleplayLease(lease).scope.directories.root;
    const images = new Map();
    for (const list of savedSessionListsLocked(lease)) {
        for (const session of list.sessions) {
            if (!session || session.temporary === true || !Array.isArray(session.messages)) continue;
            for (const current of session.messages) {
                if (!current || typeof current !== 'object') continue;
                for (const message of replySwipes(current)) {
                    if (!message || typeof message.text !== 'string' || !message.images) continue;
                    const receipts = generatedImageReceipts({ ...message, images: normaliseStoredImages(message.images) });
                    for (const image of receipts) {
                        const url = `/${image.url.replace(/^\//, '')}`;
                        if (images.has(url)) continue;
                        let stat;
                        try {
                            stat = inspectRoleplayFileStat(path.join(root, url.slice(1)), 20 * 1024 * 1024, { allowMissingParent: true });
                        } catch { continue; }
                        if (!stat || stat.size === 0n) continue;
                        images.set(url, {
                            id: `scratchpad:${url}`, url, prompt: image.prompt || '', negative: image.negative || '',
                            date: Number(stat.mtimeMs), metadataSettings: { width: image.width, height: image.height },
                        });
                    }
                }
            }
        }
    }
    return [...images.values()].sort((a, b) => b.date - a.date || a.url.localeCompare(b.url));
}

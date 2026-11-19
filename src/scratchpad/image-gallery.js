import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { inspectRoleplayFileStat, roleplayLease } from '../roleplay-store.js';
import { replySwipes } from '../../public/scripts/scratchpad/swipes.js';
import { generatedImageReceipts, normaliseStoredImages, SCRATCHPAD_IMAGE_URL } from './image-state.js';
import { savedSessionListsLocked } from './search.js';
import { ScratchpadError } from './store.js';

const PREFIX = 'scratchpad:';
const FILE_LIMIT = 4 * 1024 * 1024;

function exclusionFile(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'scratchpad', 'gallery-exclusions.json');
}

function validId(id) {
    return typeof id === 'string' && id.length <= 256 && id.startsWith(`${PREFIX}/`) && SCRATCHPAD_IMAGE_URL.test(id.slice(PREFIX.length));
}

function readExclusions(lease) {
    const file = readAuthoringFileLocked(lease, exclusionFile(lease), FILE_LIMIT);
    if (!file) return new Set();
    const ids = JSON.parse(file.bytes.toString('utf8'));
    if (!Array.isArray(ids) || !ids.every(validId)) throw new Error('Invalid saved Gallery exclusions');
    return new Set(ids);
}

/** Only the Gallery entry is removed; the receipt and image used in the reply are untouched. */
export function removeScratchpadGalleryImagesLocked(lease, ids) {
    if (!Array.isArray(ids) || !ids.length || !ids.every(validId)) {
        throw new ScratchpadError('SCRATCHPAD_GALLERY_INVALID', 'Choose saved Scratchpad pictures from Gallery.');
    }
    const requested = new Set(ids);
    const excluded = readExclusions(lease);
    const found = collectGalleryImages(lease, excluded, requested);
    const removed = [...requested].filter(id => excluded.has(id) || found.has(id));
    if (found.size) {
        for (const id of found.keys()) excluded.add(id);
        writeAuthoringFileLocked(lease, exclusionFile(lease), JSON.stringify([...excluded]), { limit: FILE_LIMIT });
    }
    return removed;
}

/** Gallery references saved pictures directly; listing never reads or copies their bytes. */
export function scratchpadGalleryLocked(lease) {
    return [...collectGalleryImages(lease, readExclusions(lease)).values()].sort((a, b) => b.date - a.date || a.url.localeCompare(b.url));
}

function collectGalleryImages(lease, excluded, requested = null) {
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
                        const id = `${PREFIX}${url}`;
                        if (excluded.has(id) || images.has(id) || (requested && !requested.has(id))) continue;
                        let stat;
                        try {
                            stat = inspectRoleplayFileStat(path.join(root, url.slice(1)), 20 * 1024 * 1024, { allowMissingParent: true });
                        } catch { continue; }
                        if (!stat || stat.size === 0n) continue;
                        images.set(id, {
                            id, url, prompt: image.prompt || '', negative: image.negative || '',
                            date: Number(stat.mtimeMs), metadataSettings: { width: image.width, height: image.height },
                        });
                    }
                }
            }
        }
    }
    return images;
}

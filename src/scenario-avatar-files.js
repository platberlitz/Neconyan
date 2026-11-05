import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { clientRelativePath, ensureDirectory, isPathUnderParent } from './util.js';
import { readRoleplayFile } from './roleplay-store.js';
import {
    isScenarioAvatarPath,
    normalizeScenarioAvatar,
    parseScenarioAvatarDataUrl,
    SCENARIO_AVATAR_FOLDER,
} from '../public/scripts/persona-appendix-avatar.js';

export const MAX_SCENARIO_AVATAR_FILE_BYTES = 20 * 1024 * 1024;

const USER_IMAGES_PREFIX = '/user/images/';

export function scenarioAvatarFilePath(directories, value) {
    if (!isScenarioAvatarPath(value)) {
        return '';
    }
    const filename = path.resolve(directories.userImages, ...value.slice(USER_IMAGES_PREFIX.length).split('/'));
    return isPathUnderParent(directories.userImages, filename) ? filename : '';
}

export function scenarioAvatarMimeType(extension) {
    switch (String(extension).toLowerCase()) {
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'webp':
            return 'image/webp';
        case 'gif':
            return 'image/gif';
        default:
            return '';
    }
}

/** Read either a saved user image or an embedded legacy portrait without changing its bytes. */
export function readScenarioAvatarFile(directories, value, limit = MAX_SCENARIO_AVATAR_FILE_BYTES) {
    const normalized = normalizeScenarioAvatar(value);
    if (!normalized) {
        return null;
    }
    const embedded = parseScenarioAvatarDataUrl(normalized);
    if (embedded) {
        const bytes = Buffer.from(embedded.base64, 'base64');
        if (!bytes.length || bytes.length > limit) {
            throw new Error('The Scenario Note picture is empty or too large.');
        }
        return { value: normalized, bytes, extension: embedded.extension, rawHash: createHash('sha256').update(bytes).digest('hex') };
    }
    const filename = scenarioAvatarFilePath(directories, normalized);
    if (!filename) {
        return null;
    }
    const file = readRoleplayFile(filename, limit, { allowMissingParent: true });
    if (!file) {
        return null;
    }
    return { value: normalized, bytes: file.bytes, extension: path.extname(filename).slice(1).toLowerCase(), rawHash: file.rawHash, filename };
}

/** Replace saved picture paths with the full embedded image before a persona card is written. */
export function embedScenarioAvatarPaths(descriptor, directories) {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || !Array.isArray(descriptor.appendices)) {
        return descriptor;
    }
    return {
        ...descriptor,
        appendices: descriptor.appendices.map(note => {
            if (!note || typeof note !== 'object' || Array.isArray(note) || !isScenarioAvatarPath(note.avatar)) {
                return note;
            }
            const file = readScenarioAvatarFile(directories, note.avatar);
            const mime = file && scenarioAvatarMimeType(file.extension);
            if (!file || !mime) {
                throw new Error('The Scenario Note picture could not be read.');
            }
            return { ...note, avatar: `data:${mime};base64,${file.bytes.toString('base64')}` };
        }),
    };
}

/** Save embedded portraits as original files and point imported notes at them. */
export function storeScenarioAvatarFiles(card, directories, created = []) {
    if (!card?.data || !Array.isArray(card.data.appendices)) {
        return card;
    }
    const appendices = card.data.appendices.map(note => {
        if (!note.avatar) {
            return note;
        }
        // A full-persona backup can keep an existing saved picture path; a card embed is written out.
        if (isScenarioAvatarPath(note.avatar)) {
            return note;
        }
        const embedded = parseScenarioAvatarDataUrl(note.avatar);
        if (!embedded) {
            throw new Error('Invalid Scenario Note avatar.');
        }
        const bytes = Buffer.from(embedded.base64, 'base64');
        if (!bytes.length || bytes.length > MAX_SCENARIO_AVATAR_FILE_BYTES) {
            throw new Error('The Scenario Note picture is empty or too large.');
        }
        const directory = path.join(directories.userImages, SCENARIO_AVATAR_FOLDER);
        ensureDirectory(directory);
        const filename = path.join(directory, `${randomUUID()}.${embedded.extension}`);
        writeFileAtomicSync(filename, bytes);
        created.push(filename);
        return { ...note, avatar: clientRelativePath(directories.root, filename) };
    });
    return { ...card, data: { ...card.data, appendices } };
}

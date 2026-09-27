import fs from 'node:fs';
import path from 'node:path';
import { readRoleplayFile, roleplayHash } from '../roleplay-store.js';
import { authoringEvidence } from '../authoring-store.js';
import { read as readCard } from '../character-card-parser.js';
import { CHAT_BACKUPS_PREFIX } from '../endpoints/chats.js';
import { getSettingsBackupFilePrefix } from '../endpoints/settings.js';
import { operationError } from './store.js';

export const MAINTENANCE_FILE_LIMIT = 128 * 1024 * 1024;
const RESERVED_UPLOADS = new Set(['_sbca_organization.json', 'hopper-store.json', 'hopper-server-storage.json']);
const CATEGORIES = ['images', 'files', 'chats', 'groupChats', 'avatarThumbnails', 'backgroundThumbnails', 'personaThumbnails', 'chatBackups', 'settingsBackups'];

function relative(root, file) {
    const value = path.relative(root, file);
    if (!value || value === '..' || value.startsWith('../') || path.isAbsolute(value)) throw operationError('The maintenance source is outside this account.');
    return value;
}

/** One guarded snapshot, shared by report generation and the final reviewed-delete check. */
export function captureMaintenanceFiles(base) {
    const root = path.resolve(base.directories.root);
    const files = [];
    const directories = [];
    const skip = new Set(['jobs', 'vectors', 'secrets.json']);
    const walk = (folder, depth) => {
        if (depth > 32 || files.length + directories.length > 100000) throw operationError('The maintenance inventory exceeds its saved-work limit.', 413);
        readRoleplayFile(path.join(folder, '.maintenance-path-check'), 1, { allowMissingParent: true });
        if (!fs.existsSync(folder)) return;
        directories.push(path.relative(root, folder));
        for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!depth && skip.has(entry.name)) continue;
            const filename = path.join(folder, entry.name);
            if (entry.isSymbolicLink()) throw operationError('Maintenance found a linked source. Resolve it before scanning.');
            if (entry.isDirectory()) walk(filename, depth + 1);
            else if (entry.isFile()) {
                const file = readRoleplayFile(filename, MAINTENANCE_FILE_LIMIT);
                if (!file) throw operationError('A maintenance source disappeared during the scan. Try a new scan.');
                files.push({ relative: relative(root, filename), evidence: authoringEvidence(file), size: file.bytes.length,
                    mtime: fs.statSync(filename).mtimeMs });
            } else throw operationError('Maintenance found a source that is not a regular file.');
        }
    };
    walk(root, 0);
    return { files, directories };
}

function json(bytes, filename) {
    try {
        const text = bytes.toString('utf8');
        if (path.basename(filename) === 'hopper-store.json' && /^[A-Za-z0-9+/=\s]+$/.test(text)) return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
        return JSON.parse(text);
    } catch {
        throw operationError(`Maintenance could not read ${path.basename(filename)}. No files were marked safe to delete.`);
    }
}

function references(value, found, depth = 0) {
    if (depth > 100) throw operationError('A maintenance reference document is too deeply nested.', 413);
    if (typeof value === 'string') {
        const candidates = [value, ...value.matchAll(/\/?user\/(?:images|files)\/[^\s"'<>\])}]+/g)].map(item => typeof item === 'string' ? item : item[0]);
        for (let candidate of candidates) {
            try {
                if (/^https?:\/\//i.test(candidate)) candidate = new URL(candidate).pathname;
                candidate = decodeURIComponent(candidate.split(/[?#]/)[0]).replace(/^\/+/, '');
            } catch { continue; }
            if (candidate.startsWith('user/images/') || candidate.startsWith('user/files/')) found.add(path.normalize(candidate));
        }
    } else if (Array.isArray(value)) {
        for (const child of value) references(child, found, depth + 1);
    } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) references(child, found, depth + 1);
    }
}

export function captureMaintenancePlan(base) {
    const root = path.resolve(base.directories.root);
    const inventory = captureMaintenanceFiles(base);
    const roots = Object.fromEntries(Object.entries(base.directories).filter(([key, value]) => key !== 'root' && typeof value === 'string'
        && path.resolve(value).startsWith(root + path.sep)).map(([key, value]) => [key, path.relative(root, value)]));
    const found = new Set();
    const groupChats = new Set();
    const source = value => !(roots.backups && value.startsWith(roots.backups + '/')) && (value === 'settings.json' || value.startsWith('hopper/') && value.endsWith('.json') || value.endsWith('.jsonl')
        || value.endsWith('.json') && ![roots.files, roots.backups].some(folder => folder && value.startsWith(folder + '/'))
        || value.startsWith((roots.characters || 'characters') + '/') && value.toLowerCase().endsWith('.png')
        || value.startsWith((roots.files || 'user/files') + '/') && RESERVED_UPLOADS.has(path.basename(value)));
    const readSources = new Set();
    for (const item of inventory.files.filter(item => source(item.relative))) {
        readSources.add(item.relative);
        const filename = path.join(root, item.relative);
        const file = readRoleplayFile(filename, MAINTENANCE_FILE_LIMIT);
        if (!file || roleplayHash(authoringEvidence(file)) !== roleplayHash(item.evidence)) throw operationError('A maintenance source changed during capture.');
        let documents;
        if (item.relative.toLowerCase().endsWith('.png')) {
            try { documents = [JSON.parse(readCard(file.bytes))]; } catch { throw operationError('A character card could not be read. Maintenance stopped before reporting unused files.'); }
        } else if (item.relative.endsWith('.jsonl')) {
            documents = file.bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => json(Buffer.from(line), filename));
        } else documents = [json(file.bytes, filename)];
        for (const document of documents) references(document, found);
        if (path.dirname(item.relative) === roots.groups && item.relative.endsWith('.json')) {
            const group = documents[0];
            if (!group || typeof group !== 'object' || Array.isArray(group) || group.chats !== undefined && !Array.isArray(group.chats)) throw operationError('A group definition is incomplete. Maintenance stopped.');
            for (const chat of [...(group.chats || []), group.chat_id].filter(value => value !== undefined && value !== null)) groupChats.add(String(chat));
        }
    }
    // Snapshot blobs can themselves own media. Follow their saved references before classifying uploads.
    for (const name of found) {
        if (readSources.has(name) || !name.endsWith('.json')) continue;
        const item = inventory.files.find(file => file.relative === name);
        if (!item) continue;
        const file = readRoleplayFile(path.join(root, name), MAINTENANCE_FILE_LIMIT);
        if (!file || roleplayHash(authoringEvidence(file)) !== roleplayHash(item.evidence)) throw operationError('A saved reference changed during maintenance capture.');
        readSources.add(name);
        references(json(file.bytes, name), found);
    }
    const after = captureMaintenanceFiles(base);
    if (roleplayHash(after) !== roleplayHash(inventory)) throw operationError('The account files changed during maintenance capture. Start a new scan.');
    return { ...inventory, roots, references: [...found], groupChats: [...groupChats], owner: base.owner };
}

export function maintenanceReport(plan) {
    const report = Object.fromEntries(CATEGORIES.map(category => [category, []]));
    const existing = new Set(plan.files.map(item => item.relative));
    const references = new Set(plan.references);
    const groups = new Set(plan.groupChats);
    const within = (file, key) => plan.roots[key] && file.startsWith(plan.roots[key] + '/');
    for (const file of plan.files) {
        const value = file.relative;
        const name = path.basename(value);
        let category;
        if (within(value, 'userImages') && !references.has(value)) category = 'images';
        else if (within(value, 'files') && !RESERVED_UPLOADS.has(name) && !references.has(value)) category = 'files';
        else if (within(value, 'chats') && value.endsWith('.jsonl') && path.dirname(value) !== plan.roots.chats
            && !existing.has(path.join(plan.roots.characters, path.basename(path.dirname(value)) + '.png'))) category = 'chats';
        else if (within(value, 'groupChats') && value.endsWith('.jsonl') && !groups.has(name.slice(0, -6))) category = 'groupChats';
        else if (within(value, 'thumbnailsAvatar') && !existing.has(path.join(plan.roots.characters, name))) category = 'avatarThumbnails';
        else if ((within(value, 'thumbnailsBg') || within(value, 'thumbnailsBgMobile')) && !existing.has(path.join(plan.roots.backgrounds, name))) category = 'backgroundThumbnails';
        else if (within(value, 'thumbnailsPersona') && !existing.has(path.join(plan.roots.avatars, name))) category = 'personaThumbnails';
        else if (within(value, 'backups') && name.startsWith(CHAT_BACKUPS_PREFIX)) category = 'chatBackups';
        else if (within(value, 'backups') && name.startsWith(getSettingsBackupFilePrefix(plan.owner))) category = 'settingsBackups';
        if (category) report[category].push({ name, hash: roleplayHash(value), parent: path.basename(path.dirname(value)), size: file.size, mtime: file.mtime });
    }
    return { report, count: Object.values(report).reduce((total, values) => total + values.length, 0) };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import { createRoleplayDirectory, inspectRoleplayFile, readRoleplayFile, roleplayHash } from './roleplay-store.js';
import { readRepairJson, writeRepairJson, writeRepairBytes, repairFailure } from './roleplay-image-repair-store.js';
import { uiText } from '../public/scripts/ui-text.js';

const FOLDER = 'neconyan-repaired';
const MARKER = '.neconyan-managed-images.json';
const LIMIT = 1024 * 1024;
export function managedImageDirectory(directories) { return path.join(directories.userImages ?? path.join(directories.root, 'user/images'), FOLDER); }
function authorityPath(directories) { return path.join(directories.root, MARKER); }
function canonical(filename) { const resolved = path.resolve(filename); return process.platform === 'win32' ? resolved.split(path.sep).map(part => part.replace(/[. ]+$/, '').toLowerCase()).join(path.sep) : resolved; }
function contained(directories, filename) {
    const root = canonical(managedImageDirectory(directories)), target = canonical(filename);
    return target === root || target.startsWith(root + path.sep);
}
function namespaceRecord(value, creating = false) {
    if (!value || value.version !== 1 || value.kind !== 'immutable-prompt-images'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id ?? '')
        || Object.keys(value).sort().join(',') !== (creating ? 'creating,id,kind,version' : 'id,kind,version')
        || creating && value.creating !== true) throw repairFailure('The saved image namespace needs recovery.');
    return { version: 1, kind: value.kind, id: value.id };
}
function inspectCreatingNamespace(directories, saved) {
    const expected = namespaceRecord(saved.value, true), folder = managedImageDirectory(directories);
    readRoleplayFile(path.join(folder, '.path-check'), 1, { allowMissingParent: true });
    if (fs.existsSync(folder)) {
        const entries = fs.readdirSync(folder);
        if (entries.some(name => name !== MARKER)) throw repairFailure('Unexpected files occupy the unfinished image namespace. They were retained.');
        const marker = readRepairJson(path.join(folder, MARKER), 4096, true);
        if (marker && roleplayHash(marker.value) !== roleplayHash(expected)) throw repairFailure('The unfinished image ownership record changed.');
    }
    return expected;
}
function authority(directories) {
    const saved = readRepairJson(authorityPath(directories), 4096, true);
    if (!saved) return null;
    const expected = namespaceRecord(saved.value);
    const marker = readRepairJson(path.join(managedImageDirectory(directories), MARKER), 4096);
    if (roleplayHash(marker.value) !== roleplayHash(expected)) throw repairFailure('The image folder ownership record changed.');
    return expected;
}
/** Called again immediately before every generic publish/unlink, including delayed jobs. */
export function isManagedImagePath(directories, filename) {
    if (canonical(filename) === canonical(authorityPath(directories))) return true;
    if (!contained(directories, filename)) return false;
    return Boolean(authority(directories));
}
export function assertMutableImagePath(directories, filename) {
    if (isManagedImagePath(directories, filename)) throw repairFailure('This saved prompt copy is shared and retained. Detach it from the chat instead.');
}
export function ensureManagedImageNamespace(directories, { checkpoint = () => {} } = {}) {
    let saved = readRepairJson(authorityPath(directories), 4096, true);
    if (saved && saved.value.creating !== true) { authority(directories); return; }
    const folder = managedImageDirectory(directories);
    if (!saved) {
        readRoleplayFile(path.join(folder, '.path-check'), 1, { allowMissingParent: true });
        if (fs.existsSync(folder)) throw repairFailure('The repair image folder already belongs to other files. Use Show only or choose another replacement until its ownership is reviewed.');
        const value = { version: 1, kind: 'immutable-prompt-images', id: crypto.randomUUID(), creating: true };
        const file = writeRepairJson(authorityPath(directories), value, 4096);
        saved = { value, file };
        checkpoint('namespace-intent');
    }
    const marker = inspectCreatingNamespace(directories, saved);
    createRoleplayDirectory(folder, directories.root);
    checkpoint('namespace-directory');
    const markerFile = readRepairJson(path.join(folder, MARKER), 4096, true);
    if (!markerFile) writeRepairJson(path.join(folder, MARKER), marker, 4096);
    checkpoint('namespace-marker');
    inspectCreatingNamespace(directories, saved);
    writeRepairJson(authorityPath(directories), marker, 4096, saved.file);
    checkpoint('namespace-ready');
    authority(directories);
}
export function accountImagePath(directories, url) {
    if (typeof url !== 'string' || !url.startsWith('/user/images/')) throw repairFailure('Choose a saved image from this account.');
    let parts;
    try { parts = url.slice('/user/images/'.length).split('/').map(decodeURIComponent); } catch { throw repairFailure('The image location is invalid.'); }
    if (!parts.length || parts.length > 2 || parts.some(part => !part || ['.', '..'].includes(part) || /[\\/\0?#:]/.test(part))) throw repairFailure('The image location is invalid.');
    return path.join(directories.userImages ?? path.join(directories.root, 'user/images'), ...parts);
}
/** Check canonical base64 length before allocation. No URL fetch is performed. */
export function decodeCompatibleImage(data) {
    if (typeof data !== 'string' || data.length > 4 * Math.ceil(LIMIT / 3) + 64) throw repairFailure('This image needs a reviewed smaller copy (maximum 1 MiB).');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
    if (!match || !match[2] || match[2].length % 4 !== 0) throw repairFailure('Use one PNG, JPEG or WebP image with canonical base64 data.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > LIMIT || bytes.toString('base64') !== match[2]) throw repairFailure('The image data is malformed or exceeds 1 MiB.');
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { throw repairFailure('The image could not be read. Choose a replacement.'); }
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[dimensions.type];
    if (mime !== match[1] || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
        || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 2048 || dimensions.height > 2048) throw repairFailure('Use a PNG, JPEG or WebP still image no larger than 2048 pixels per side.');
    // Recognise container chunks, rather than searching compressed pixels for a coincidental string.
    if (dimensions.type === 'png') {
        let offset = 8, ended = false;
        while (offset + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
            if (offset + 12 + length > bytes.length || type === 'acTL') throw repairFailure('Animated or incomplete images need an explicit still-image replacement.');
            offset += 12 + length;
            if (type === 'IEND') { ended = offset === bytes.length; break; }
        }
        if (!ended) throw repairFailure('The PNG image is incomplete.');
    } else if (dimensions.type === 'webp') {
        if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw repairFailure('The WebP image is incomplete.');
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
            if (type === 'ANIM' || type === 'ANMF' || offset + 8 + length > bytes.length) throw repairFailure('Animated or incomplete images need a still-image replacement.');
            offset += 8 + length + length % 2;
        }
        if (offset !== bytes.length) throw repairFailure('The WebP image is incomplete.');
    } else if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw repairFailure('The JPEG image is incomplete.');
    return { bytes, extension: dimensions.type === 'jpg' ? 'jpg' : dimensions.type, width: dimensions.width, height: dimensions.height,
        rawHash: crypto.createHash('sha256').update(bytes).digest('hex') };
}
export function managedImageUrl(image) { return `/user/images/${FOLDER}/${image.rawHash}.${image.extension}`; }
export function publishManagedImage(directories, image) {
    ensureManagedImageNamespace(directories);
    const url = managedImageUrl(image), filename = accountImagePath(directories, url);
    const recordPath = filename + '.record.json';
    const expected = { version: 1, rawHash: image.rawHash, size: image.bytes.length, extension: image.extension };
    const record = readRepairJson(recordPath, 4096, true);
    if (record && roleplayHash(record.value) !== roleplayHash(expected)) throw repairFailure('The immutable image record changed.');
    if (!record) writeRepairJson(recordPath, expected, 4096);
    const current = readRoleplayFile(filename, LIMIT);
    if (current && current.rawHash !== image.rawHash) throw repairFailure('A different file occupies the saved prompt-copy location.');
    if (!current) writeRepairBytes(filename, image.bytes, LIMIT);
    verifyManagedImage(directories, url);
    return url;
}
export function verifyManagedImage(directories, url) {
    const filename = accountImagePath(directories, url);
    if (!contained(directories, filename) || !authority(directories)) throw repairFailure('This prompt copy is not a verified managed image.');
    const record = readRepairJson(filename + '.record.json', 4096).value;
    const file = inspectRoleplayFile(filename, LIMIT);
    if (record.version !== 1 || !file || record.rawHash !== file.rawHash || record.size !== file.size
        || path.basename(filename) !== `${record.rawHash}.${record.extension}`) throw repairFailure(uiText('An image\'s compatible copy is missing or changed. Prepare a new one in Review chat images.'));
    return file;
}

/** Read-only import preflight. A destination may reuse verified bytes, never replace them. */
export function checkManagedImageDestination(directories, image = null) {
    const root = readRepairJson(authorityPath(directories), 4096, true);
    if (root?.value.creating === true) { inspectCreatingNamespace(directories, root); return; }
    const owned = authority(directories), folder = managedImageDirectory(directories);
    readRoleplayFile(path.join(folder, '.path-check'), 1, { allowMissingParent: true });
    if (!owned && fs.existsSync(folder)) throw repairFailure('The repair image folder already belongs to other files.');
    if (!owned || !image) return;
    const filename = accountImagePath(directories, managedImageUrl(image));
    const record = readRepairJson(filename + '.record.json', 4096, true);
    const expected = { version: 1, rawHash: image.rawHash, size: image.bytes.length, extension: image.extension };
    if (record && roleplayHash(record.value) !== roleplayHash(expected)) throw repairFailure('The destination immutable image record differs.');
    const current = readRoleplayFile(filename, LIMIT);
    if (current && current.rawHash !== image.rawHash) throw repairFailure('Different bytes occupy the destination prompt-copy location.');
}

/** Validate only selected automatic reads; callers retain frozen accepted request bytes. */
export function verifyPromptImageCopy(directories, descriptor) {
    if (!descriptor || Object.keys(descriptor).some(key => !['imageUrl', 'originalUrl', 'originalHash'].includes(key))
        || typeof descriptor.imageUrl !== 'string' || descriptor.imageUrl.length > 4096
        || descriptor.originalUrl !== null && (typeof descriptor.originalUrl !== 'string' || descriptor.originalUrl.length > 4096)) {
        throw repairFailure(uiText('An image\'s compatible copy record is damaged. Prepare a new copy in Review chat images.'));
    }
    verifyManagedImage(directories, descriptor.imageUrl);
    if (descriptor.originalUrl === null) return null;
    const evidence = inspectRoleplayFile(accountImagePath(directories, descriptor.originalUrl), 64 * 1024 * 1024);
    if (!evidence || evidence.rawHash !== descriptor.originalHash) {
        throw repairFailure(uiText('An image\'s original file changed or is missing, so its compatible copy is not used. Review it in Review chat images.'));
    }
    return { rawHash: evidence.rawHash, physical: evidence.physical };
}

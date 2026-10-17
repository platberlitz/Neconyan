import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import { createRoleplayDirectory, inspectRoleplayFile, readRoleplayFile, roleplayHash } from './roleplay-store.js';
import { readRepairJson, writeRepairJson, writeRepairBytes, repairFailure, integrityFailure } from './roleplay-image-repair-store.js';
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
        || creating && value.creating !== true) throw integrityFailure('The saved image namespace needs recovery.');
    return { version: 1, kind: value.kind, id: value.id };
}
function inspectCreatingNamespace(directories, saved) {
    const expected = namespaceRecord(saved.value, true), folder = managedImageDirectory(directories);
    readRoleplayFile(path.join(folder, '.path-check'), 1, { allowMissingParent: true });
    if (fs.existsSync(folder)) {
        const entries = fs.readdirSync(folder);
        if (entries.some(name => name !== MARKER)) throw integrityFailure('Unexpected files occupy the unfinished image namespace. They were retained.');
        const marker = readRepairJson(path.join(folder, MARKER), 4096, true);
        if (marker && roleplayHash(marker.value) !== roleplayHash(expected)) throw integrityFailure('The unfinished image ownership record changed.');
    }
    return expected;
}
function authority(directories) {
    const saved = readRepairJson(authorityPath(directories), 4096, true);
    if (!saved) return null;
    const expected = namespaceRecord(saved.value);
    const marker = readRepairJson(path.join(managedImageDirectory(directories), MARKER), 4096);
    if (roleplayHash(marker.value) !== roleplayHash(expected)) throw integrityFailure('The image folder ownership record changed.');
    return expected;
}
/** Called again immediately before every generic publish/unlink, including delayed jobs. */
export function isManagedImagePath(directories, filename) {
    if (canonical(filename) === canonical(authorityPath(directories))) return true;
    if (!contained(directories, filename)) return false;
    return Boolean(authority(directories));
}
export function assertMutableImagePath(directories, filename) {
    if (isManagedImagePath(directories, filename)) throw repairFailure(uiText('This compatible copy may be used by other chats, so it is kept. Remove it from the message instead.'));
}
export function ensureManagedImageNamespace(directories, { checkpoint = () => {} } = {}) {
    let saved = readRepairJson(authorityPath(directories), 4096, true);
    if (saved && saved.value.creating !== true) { authority(directories); return; }
    const folder = managedImageDirectory(directories);
    if (!saved) {
        readRoleplayFile(path.join(folder, '.path-check'), 1, { allowMissingParent: true });
        if (fs.existsSync(folder)) throw repairFailure(uiText('Compatible copies cannot be saved, because the folder user/images/neconyan-repaired already holds other files. Choose Show only for now, and ask whoever runs this server to move those files.'));
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
    if (typeof url !== 'string' || !url.startsWith('/user/images/')) throw repairFailure(uiText('Choose an image saved in your account.'));
    let parts;
    try { parts = url.slice('/user/images/'.length).split('/').map(decodeURIComponent); } catch { throw repairFailure(uiText('This image\'s address is not valid.')); }
    if (!parts.length || parts.length > 2 || parts.some(part => !part || ['.', '..'].includes(part) || /[\\/\0?#:]/.test(part))) throw repairFailure(uiText('This image\'s address is not valid.'));
    return path.join(directories.userImages ?? path.join(directories.root, 'user/images'), ...parts);
}
/** Check canonical base64 length before allocation. No URL fetch is performed. */
export function decodeCompatibleImage(data) {
    if (typeof data !== 'string' || data.length > 4 * Math.ceil(LIMIT / 3) + 64) throw repairFailure(uiText('This image is larger than 1 MiB. Use Prepare a converted copy for it.'));
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
    if (!match || !match[2] || match[2].length % 4 !== 0) throw repairFailure(uiText('Only PNG, JPEG or WebP images can be saved as compatible copies. Use Prepare a converted copy.'));
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > LIMIT || bytes.toString('base64') !== match[2]) throw repairFailure(uiText('This image is damaged or larger than 1 MiB. Use Prepare a converted copy.'));
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { throw repairFailure(uiText('This image could not be read. Choose an image file instead.')); }
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[dimensions.type];
    if (mime !== match[1] || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
        || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 2048 || dimensions.height > 2048) throw repairFailure(uiText('Compatible copies must be PNG, JPEG or WebP still images of at most 2048 pixels per side. Use Prepare a converted copy.'));
    // Recognise container chunks, rather than searching compressed pixels for a coincidental string.
    if (dimensions.type === 'png') {
        let offset = 8, ended = false;
        while (offset + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
            if (offset + 12 + length > bytes.length || type === 'acTL') throw repairFailure(uiText('Animated or incomplete images cannot be copied as they are. Choose a still image file instead.'));
            offset += 12 + length;
            if (type === 'IEND') { ended = offset === bytes.length; break; }
        }
        if (!ended) throw repairFailure(uiText('This PNG image is incomplete. Choose another image.'));
    } else if (dimensions.type === 'webp') {
        if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw repairFailure(uiText('This WebP image is incomplete. Choose another image.'));
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
            if (type === 'ANIM' || type === 'ANMF' || offset + 8 + length > bytes.length) throw repairFailure(uiText('Animated or incomplete images cannot be copied as they are. Choose a still image file instead.'));
            offset += 8 + length + length % 2;
        }
        if (offset !== bytes.length) throw repairFailure(uiText('This WebP image is incomplete. Choose another image.'));
    } else if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw repairFailure(uiText('This JPEG image is incomplete. Choose another image.'));
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
    if (record && roleplayHash(record.value) !== roleplayHash(expected)) throw integrityFailure('The immutable image record changed.');
    if (!record) writeRepairJson(recordPath, expected, 4096);
    const current = readRoleplayFile(filename, LIMIT);
    if (current && current.rawHash !== image.rawHash) throw integrityFailure('A different file occupies the saved prompt-copy location.');
    if (!current) writeRepairBytes(filename, image.bytes, LIMIT);
    verifyManagedImage(directories, url);
    return url;
}
export function verifyManagedImage(directories, url) {
    const filename = accountImagePath(directories, url);
    if (!contained(directories, filename) || !authority(directories)) throw integrityFailure('This prompt copy is not a verified managed image.');
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
    if (!owned && fs.existsSync(folder)) throw repairFailure(uiText('Compatible copies cannot be imported, because the folder user/images/neconyan-repaired already holds other files. Ask whoever runs this server to move them.'));
    if (!owned || !image) return;
    const filename = accountImagePath(directories, managedImageUrl(image));
    const record = readRepairJson(filename + '.record.json', 4096, true);
    const expected = { version: 1, rawHash: image.rawHash, size: image.bytes.length, extension: image.extension };
    if (record && roleplayHash(record.value) !== roleplayHash(expected)) throw integrityFailure('The destination immutable image record differs.');
    const current = readRoleplayFile(filename, LIMIT);
    if (current && current.rawHash !== image.rawHash) throw integrityFailure('Different bytes occupy the destination prompt-copy location.');
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

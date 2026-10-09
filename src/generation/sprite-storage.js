import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import { assertUntrackedRoleplayFiles, createRoleplayDirectory, readRoleplayFile,
    roleplayAccountBase, roleplayAccountStamp, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';
import { assertNativeMediaTargetIdle } from './media-jobs.js';
import { expressionLabelFromFilename } from '../../public/scripts/extensions/expressions/expression-labels.js';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function invalid(message) { throw roleplayError('SPRITE_INVALID', message, 409); }

function folderPath(directories, name) {
    const parts = typeof name === 'string' ? name.split('/') : [];
    if (!parts.length || parts.length > 2 || parts.some(part => !part || part !== sanitize(part)
        || part === '.' || part === '..' || part.includes('\\'))) invalid('The sprite folder name is invalid.');
    return path.join(directories.characters, ...parts);
}

function spriteFilename(name) {
    if (typeof name !== 'string' || !name || name !== sanitize(name) || path.basename(name) !== name
        || !String(mime.lookup(name)).startsWith('image/')) invalid('The sprite filename is invalid.');
    return name;
}

function syncDirectory(filename) {
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function withSprites(directories, name, create, operation, { mutate = false, account } = {}) {
    const base = roleplayAccountBase(directories);
    if (!base) invalid('This account needs its protected media store.');
    const folder = folderPath(directories, name);
    return withRoleplayAccount(base, account ?? roleplayAccountStamp(base), lease => {
        if (mutate) assertNativeMediaTargetIdle(lease, { kind: 'sprites', id: name });
        // The protected reader also checks every physical parent when this probe is absent.
        readRoleplayFile(path.join(folder, '.sprite-path-check'), 1, { allowMissingParent: true });
        if (create) createRoleplayDirectory(folder, directories.root);
        else if (!fs.existsSync(folder)) return operation(lease, folder, []);
        const files = fs.readdirSync(folder).filter(file => String(mime.lookup(file)).startsWith('image/'));
        const paths = files.map(file => path.join(folder, spriteFilename(file)));
        assertUntrackedRoleplayFiles(lease, paths);
        for (const filename of paths) readRoleplayFile(filename, MAX_IMAGE_BYTES);
        return operation(lease, folder, files);
    });
}

/** Synchronous cooperating HTTP/import writers share the native sprite account lock. */
export function saveSpriteFiles(directories, name, sprites, { overwrite = true, beforePublish, account } = {}) {
    if (!Array.isArray(sprites) || !sprites.length || sprites.length > 256) invalid('The sprite files are invalid.');
    const names = new Set();
    for (const item of sprites) {
        spriteFilename(item?.filename);
        const stem = path.parse(item.filename).name;
        if (names.has(stem) || !Buffer.isBuffer(item.bytes) || !item.bytes.length || item.bytes.length > MAX_IMAGE_BYTES) {
            invalid('The sprite file data or selection is invalid.');
        }
        names.add(stem);
    }
    return withSprites(directories, name, true, (lease, folder, files) => {
        let count = 0;
        for (const { filename, bytes } of sprites) {
            const old = files.filter(file => path.parse(file).name === path.parse(filename).name);
            if (!overwrite && old.length) continue;
            const target = path.join(folder, filename);
            assertUntrackedRoleplayFiles(lease, [target]);
            const previous = readRoleplayFile(target, MAX_IMAGE_BYTES);
            const validate = () => {
                const current = readRoleplayFile(target, MAX_IMAGE_BYTES);
                if (roleplayHash(current ? { rawHash: current.rawHash, physical: current.physical } : null)
                    !== roleplayHash(previous ? { rawHash: previous.rawHash, physical: previous.physical } : null)) invalid('The sprite changed before publication.');
            };
            beforePublish?.();
            tryWriteFileSync(target, bytes, { mode: 0o600 }, previous ? {
                replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(previous.physical.dev), ino: BigInt(previous.physical.ino) },
                validateBeforeReplace: validate,
            } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
            const stored = readRoleplayFile(target, MAX_IMAGE_BYTES, { flush: true });
            if (!stored?.bytes.equals(bytes)) invalid('The replacement sprite could not be confirmed.');
            // The prior format is retained until the replacement is completely and durably written.
            for (const file of old) {
                if (file !== filename) fs.unlinkSync(path.join(folder, file));
            }
            syncDirectory(folder);
            count++;
        }
        return count;
    }, { mutate: true, account });
}

export function deleteSpriteFiles(directories, name, spriteName) {
    if (typeof spriteName !== 'string' || !spriteName || spriteName !== sanitize(spriteName)) invalid('The sprite name is invalid.');
    return withSprites(directories, name, false, (_lease, folder, files) => {
        const matches = files.filter(file => path.parse(file).name === spriteName);
        for (const file of matches) fs.unlinkSync(path.join(folder, file));
        if (matches.length) syncDirectory(folder);
        return matches.length;
    }, { mutate: true });
}

export function listSpriteFiles(directories, name) {
    return withSprites(directories, name, false, (_lease, folder, files) => {
        const settings = readRoleplayFile(path.join(directories.root, 'settings.json'), 8 * 1024 * 1024);
        const labels = settings ? JSON.parse(settings.bytes.toString('utf8')).extension_settings?.expressions?.custom ?? [] : [];
        return files.map(file => {
            const mtime = fs.statSync(path.join(folder, file)).mtimeMs;
            return { label: expressionLabelFromFilename(file, labels),
                path: `/characters/${name.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(file)}?t=${mtime}` };
        });
    });
}

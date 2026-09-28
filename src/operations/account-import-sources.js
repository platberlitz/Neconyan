import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { SECRETS_FILE } from '../endpoints/secrets.js';
import { ENTITY_DATE_ADDED_FILE } from '../entity-date-added.js';
import { ENTITY_LAST_CHAT_FILE } from '../entity-last-chat.js';
import { FILE_WRITE_RECOVERY_SUFFIX } from '../util.js';
import { inspectRoleplayFile, roleplayHash, roleplayStoreDirectory } from '../roleplay-store.js';
import { operationError } from './store.js';
import { BINARY_FILE_LIMIT } from './binary-files.js';

const ROOT_FILES = [SETTINGS_FILE, SECRETS_FILE, ENTITY_DATE_ADDED_FILE, ENTITY_LAST_CHAT_FILE];
const ROOT_DIRECTORIES = [...new Set(Object.values(USER_DIRECTORY_TEMPLATE).filter(Boolean).map(value => value.split('/')[0]))];
const MARKERS = [SETTINGS_FILE, 'characters', 'chats', 'group chats', 'groups', 'OpenAI Settings', 'themes', 'extensions'];
const within = (candidate, parent) => candidate === parent || candidate.startsWith(parent + path.sep);
const evidence = file => ({ rawHash: file.rawHash, physical: file.physical });

export function importRelativePath(value) {
    if (typeof value !== 'string' || !value || value.length > 1000 || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return null;
    const parts = value.replace(/\/$/, '').split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return null;
    if (!(parts.length === 1 && ROOT_FILES.includes(parts[0])) && !ROOT_DIRECTORIES.includes(parts[0])) return null;
    if (parts.at(-1).endsWith(FILE_WRITE_RECOVERY_SUFFIX) || parts.at(-1).endsWith('.sillybunny-write-recovery') || (parts[0] === USER_DIRECTORY_TEMPLATE.extensions && parts.includes('.git'))) return null;
    return parts.join('/');
}

function directory(filename) {
    inspectRoleplayFile(path.join(filename, '.application-import-path-check'), 1, { allowMissingParent: true });
    const stat = fs.lstatSync(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw operationError('The selected import source is not an ordinary folder.', 400);
}

/** Resolve the same app/data/user-folder forms without following linked directories. */
export function resolveAccountImportRoot(input) {
    if (typeof input !== 'string' || !input.trim()) throw operationError('A SillyTavern folder path is required.', 400);
    const root = path.resolve(input.trim());
    directory(root);
    const likely = candidate => MARKERS.some(marker => fs.existsSync(path.join(candidate, marker)));
    if (likely(root)) return root;
    const data = path.basename(root) === 'data' ? root : path.join(root, 'data');
    directory(data);
    const candidates = fs.readdirSync(data, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => path.join(data, entry.name)).filter(likely);
    if (candidates.length === 1) return candidates[0];
    const preferred = candidates.find(candidate => path.basename(candidate) === 'default-user');
    if (preferred) return preferred;
    throw operationError(candidates.length ? 'Multiple user folders were found. Select the exact user folder.' : 'No importable user folder was found.', 400);
}

export function captureFolderImport(base, sourcePath, { extensionsOnly = false } = {}) {
    const sourceRoot = resolveAccountImportRoot(sourcePath);
    const targetRoot = path.resolve(base.directories.root);
    if (within(sourceRoot, targetRoot) || within(sourceRoot, roleplayStoreDirectory(base))) throw operationError('The import source belongs to this account or its protected records.', 400);
    const files = [];
    const directories = [];
    let total = 0;
    const visit = (filename, relative, depth = 0) => {
        if (depth > 32 || files.length + directories.length >= 100000) throw operationError('The import exceeds its file or folder capacity.', 413);
        if (within(filename, targetRoot) || within(filename, roleplayStoreDirectory(base))) throw operationError('The import source contains this account or its protected records.', 400);
        const normalized = importRelativePath(relative);
        if (!normalized) return;
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw operationError('Linked or special files cannot be imported.', 400);
        if (stat.isDirectory()) {
            directory(filename); directories.push(normalized);
            for (const entry of fs.readdirSync(filename).sort()) visit(path.join(filename, entry), `${normalized}/${entry}`, depth + 1);
        } else {
            const file = inspectRoleplayFile(filename, BINARY_FILE_LIMIT);
            total += file.size;
            if (total > BINARY_FILE_LIMIT) throw operationError('The import exceeds its total file capacity.', 413);
            files.push({ relative: normalized, filename, size: file.size, evidence: evidence(file) });
        }
    };
    const selected = extensionsOnly ? [USER_DIRECTORY_TEMPLATE.extensions] : [...ROOT_FILES, ...ROOT_DIRECTORIES];
    for (const relative of selected) if (fs.existsSync(path.join(sourceRoot, relative))) visit(path.join(sourceRoot, relative), relative);
    if (!files.length) throw operationError('No importable files were found in that folder.', 400);
    return { sourceRoot, files, directories, total };
}

function openZip(source) {
    const fd = fs.openSync(source.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd, { bigint: true });
    const physical = { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
    if (roleplayHash(physical) !== roleplayHash(source.evidence.physical)) {
        fs.closeSync(fd); throw operationError('The retained ZIP changed before it was opened.');
    }
    return new Promise((resolve, reject) => yauzl.fromFd(fd, { lazyEntries: true, strictFileNames: true, autoClose: false }, (error, zip) => {
        if (error) { fs.closeSync(fd); reject(error); } else resolve(zip);
    }));
}

/** Read the central directory once, rejecting duplicate destinations and oversized expansion before writes. */
export async function captureZipImport(source) {
    const actual = inspectRoleplayFile(source.filename, BINARY_FILE_LIMIT);
    if (!actual || roleplayHash(evidence(actual)) !== roleplayHash(source.evidence)) throw operationError('The retained ZIP changed before inspection.');
    const zip = await openZip(source);
    const entries = [];
    try {
        await new Promise((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.on('entry', entry => {
                try {
                    if (entries.length >= 100000) throw operationError('The ZIP exceeds its entry capacity.', 413);
                    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > BINARY_FILE_LIMIT) throw operationError('A ZIP entry exceeds its file capacity.', 413);
                    entries.push({ name: entry.fileName, size: entry.uncompressedSize, attributes: entry.externalFileAttributes,
                        crc32: entry.crc32, compressedSize: entry.compressedSize, offset: entry.relativeOffsetOfLocalHeader });
                    zip.readEntry();
                } catch (error) { reject(error); }
            });
            zip.readEntry();
        });
    } finally { zip.close(); }
    const scores = new Map();
    for (const entry of entries) {
        if (entry.name.startsWith('__MACOSX/')) continue;
        const parts = entry.name.replace(/\/$/, '').split('/');
        for (let index = 0; index < parts.length; index++) if (importRelativePath(parts.slice(index).join('/'))) {
            const base = parts.slice(0, index).join('/');
            scores.set(base, (scores.get(base) ?? 0) + 1);
        }
    }
    const preferred = value => value === 'default-user' || value.endsWith('/default-user');
    const selected = [...scores].sort((a, b) => b[1] - a[1] || Number(preferred(b[0])) - Number(preferred(a[0])) || b[0].length - a[0].length)[0]?.[0];
    if (selected === undefined) throw operationError('The ZIP does not contain importable user data.', 400);
    const files = [];
    const directories = [];
    const seen = new Set();
    let total = 0;
    for (const entry of entries) {
        if (selected && !entry.name.startsWith(selected + '/')) continue;
        const relative = importRelativePath(selected ? entry.name.slice(selected.length + 1) : entry.name);
        if (!relative) continue;
        const type = (entry.attributes >>> 16) & 0xf000;
        if (type && type !== 0x8000 && type !== 0x4000) throw operationError('Linked or special ZIP entries cannot be imported.', 400);
        if (entry.name.endsWith('/')) { directories.push(relative); continue; }
        if (seen.has(relative)) throw operationError('The ZIP contains duplicate file destinations.', 400);
        seen.add(relative); total += entry.size;
        if (total > BINARY_FILE_LIMIT) throw operationError('The ZIP exceeds its total expanded capacity.', 413);
        files.push({ relative, size: entry.size, zip: entry });
    }
    if (!files.length) throw operationError('The ZIP contains no importable files.', 400);
    if (directories.some(relative => seen.has(relative))) throw operationError('A ZIP file also occupies a destination folder.', 400);
    for (const file of files) {
        const parts = file.relative.split('/');
        while (parts.length > 1) { parts.pop(); if (seen.has(parts.join('/'))) throw operationError('A ZIP file also occupies a destination folder.', 400); }
    }
    return { source, sourceRoot: selected, files, directories: [...new Set(directories)], total };
}

/** Stream only the exact captured entry from the immutable, account-owned ZIP. */
export async function openCapturedZipEntry(source, captured) {
    const actual = inspectRoleplayFile(source.filename, BINARY_FILE_LIMIT);
    if (!actual || roleplayHash(evidence(actual)) !== roleplayHash(source.evidence)) throw operationError('The retained ZIP changed.');
    const zip = await openZip(source);
    return new Promise((resolve, reject) => {
        let found = false;
        const fail = error => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', () => { if (!found) fail(operationError('The captured ZIP entry is missing.')); });
        zip.on('entry', entry => {
            if (entry.fileName !== captured.name) { zip.readEntry(); return; }
            found = true;
            if (entry.uncompressedSize !== captured.size || entry.crc32 !== captured.crc32 || entry.compressedSize !== captured.compressedSize
                || entry.relativeOffsetOfLocalHeader !== captured.offset) { fail(operationError('The captured ZIP entry changed.')); return; }
            zip.openReadStream(entry, (error, stream) => {
                if (error) { fail(error); return; }
                stream.once('close', () => zip.close());
                stream.once('error', () => zip.close());
                resolve(stream);
            });
        });
        zip.readEntry();
    });
}

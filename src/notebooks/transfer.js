import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { zipSync } from 'fflate';

import { deleteAuthoringFileLocked, readAuthoringFileLocked, writeAuthoringFileLocked, withAuthoringBatchLocked, flushAuthoringPathLocked } from '../authoring-store.js';
import { roleplayAccountStamp, withRoleplayAccount } from '../roleplay-store.js';
import { prepareInWorker, yieldNotebookWork } from './preparation.js';
import {
    MAX_DEPTH, NotebookError, foldKey, normaliseRelativePath, parentFolder, sha256, uniquePath,
} from './paths.js';
import { splitFrontmatter } from './markdown.js';
import { importedPolicies } from './permissions.js';
import {
    MAX_NOTE_BYTES, MAX_NOTES_PER_NOTEBOOK, accountRootOf, createNotebookRecordLocked, emptyPolicies,
    loadNotebookLocked, notebookContentRoot, notebookSummary, ownerOf, readManifestLocked, readPoliciesLocked, writePoliciesLocked,
    recordHistoryLocked, listTrashLocked, runOperationLocked, updateManifestLocked, updateNoteLocked, readJsonLocked, writeJsonLocked,
} from './store.js';
import { MAX_ATTACHMENT_BYTES, attachmentType, validateAttachment } from './attachments.js';

export const MAX_IMPORT_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 5000;
export const MAX_IMPORT_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 200;
export const STAGE_TTL_MS = 30 * 60 * 1000;
export const MAX_STAGES_PER_OWNER = 3;
export const IMPORT_BATCH_SIZE = 8;
const STAGE_CHUNK_BYTES = 8 * 1024 * 1024;

const APPLICATION_FOLDERS = new Set(['.obsidian', '.trash', '__macosx', '.git', '.github', '.vscode', '.idea', '.neconyan']);
const ARCHIVE_EXTENSIONS = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|zst|jar|apk)$/i;

/* ---------- ZIP reading ---------- */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function archiveError(message, code = 'IMPORT_ARCHIVE_INVALID', status = 400) {
    return new NotebookError(code, message, status);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes) {
    try {
        return utf8.decode(bytes);
    } catch {
        throw archiveError('The archive contains a file name that is not valid text.');
    }
}

/**
 * Reads the central directory of a ZIP archive without inflating anything.
 * Rejects encrypted, ZIP64, symlink and unusual compression entries before
 * any content is expanded.
 */
export function readZipDirectory(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length > MAX_IMPORT_ARCHIVE_BYTES) throw archiveError('The archive is larger than 128 MiB.', 'IMPORT_TOO_LARGE', 413);
    if (buffer.length < 22) throw archiveError('That file is not a ZIP archive.');
    let eocd = -1;
    const floor = Math.max(0, buffer.length - 65557);
    for (let i = buffer.length - 22; i >= floor; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw archiveError('That file is not a ZIP archive.');
    const disk = buffer.readUInt16LE(eocd + 4);
    const total = buffer.readUInt16LE(eocd + 10);
    const size = buffer.readUInt32LE(eocd + 12);
    const offset = buffer.readUInt32LE(eocd + 16);
    if (disk !== 0) throw archiveError('Multi-part archives are not supported.');
    if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw archiveError('ZIP64 archives are not supported.');
    if (total > MAX_IMPORT_ENTRIES) throw archiveError(`The archive has more than ${MAX_IMPORT_ENTRIES} entries.`, 'IMPORT_TOO_MANY_ENTRIES', 413);
    if (offset + size > eocd) throw archiveError('The archive directory is damaged.');
    const entries = [];
    let cursor = offset;
    const seen = new Set();
    for (let index = 0; index < total; index++) {
        if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw archiveError('The archive directory is damaged.');
        const madeBy = buffer.readUInt16LE(cursor + 4);
        const flags = buffer.readUInt16LE(cursor + 8);
        const method = buffer.readUInt16LE(cursor + 10);
        const crc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const externalAttributes = buffer.readUInt32LE(cursor + 38);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
        cursor += 46 + nameLength + extraLength + commentLength;
        if (flags & 0x1) throw archiveError('Encrypted archives are not supported.');
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw archiveError('ZIP64 archives are not supported.');
        }
        const unixMode = (madeBy >>> 8) === 3 ? externalAttributes >>> 16 : 0;
        const fileType = unixMode & 0o170000;
        if (fileType === 0o120000) throw archiveError(`The archive contains a symbolic link (${name}).`, 'IMPORT_UNSAFE_ENTRY');
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) throw archiveError(`The archive contains a special file (${name}).`, 'IMPORT_UNSAFE_ENTRY');
        if (seen.has(name)) throw archiveError(`The archive lists ${name} twice.`, 'IMPORT_UNSAFE_ENTRY');
        seen.add(name);
        const directory = name.endsWith('/') || fileType === 0o040000;
        if (!directory && method !== 0 && method !== 8) throw archiveError(`The archive uses an unsupported compression method (${name}).`);
        entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset, directory });
    }
    return entries;
}

export function inflateZipEntry(buffer, entry) {
    const header = entry.localOffset;
    if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== 0x04034b50) throw archiveError(`The archive entry ${entry.name} is damaged.`);
    const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
    const end = start + entry.compressedSize;
    if (end > buffer.length) throw archiveError(`The archive entry ${entry.name} is truncated.`);
    const slice = buffer.subarray(start, end);
    let bytes;
    if (entry.method === 0) {
        bytes = Buffer.from(slice);
    } else {
        try {
            bytes = zlib.inflateRawSync(slice, { maxOutputLength: entry.uncompressedSize + 1 });
        } catch {
            throw archiveError(`The archive entry ${entry.name} could not be expanded.`);
        }
    }
    if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc) {
        throw archiveError(`The archive entry ${entry.name} failed its integrity check.`);
    }
    return bytes;
}

/**
 * Normalises an archive path. Whole-archive rejection for escapes; a
 * string reason for entries that are simply left out.
 */
function archivePath(name) {
    if (name.includes('\0') || name.includes('\\')) throw archiveError(`The archive contains an unsafe path (${name}).`, 'IMPORT_UNSAFE_ENTRY');
    if (/^[A-Za-z]:/.test(name) || name.startsWith('/') || name.startsWith('//')) throw archiveError(`The archive contains an absolute path (${name}).`, 'IMPORT_UNSAFE_ENTRY');
    const parts = name.replace(/\/+$/, '').split('/');
    if (parts.some(part => part === '..')) throw archiveError(`The archive contains a path that escapes its folder (${name}).`, 'IMPORT_UNSAFE_ENTRY');
    const clean = parts.filter(part => part && part !== '.');
    if (clean.length > MAX_DEPTH + 1) throw archiveError(`The archive nests folders too deeply (${name}).`, 'IMPORT_UNSAFE_ENTRY');
    return clean;
}

/* ---------- staging ---------- */

function stageRoot(lease, stageId) {
    if (!/^st_[a-f0-9]{32}$/.test(String(stageId))) throw new NotebookError('IMPORT_STAGE_EXPIRED', 'That import could not be found. Choose the file again.', 404);
    return path.join(accountRootOf(lease), 'notebook-control', '_imports', stageId);
}

function stageSummary(stage) {
    return {
        stageId: stage.stageId,
        name: stage.name,
        source: stage.source,
        target: stage.target ?? null,
        createdAt: new Date(stage.createdAt).toISOString(),
        expiresAt: new Date(stage.createdAt + STAGE_TTL_MS).toISOString(),
        notes: stage.notes.map(note => ({
            path: note.path, size: note.size ?? note.bytes.length, identityHint: note.hint, duplicateHint: note.duplicateHint ?? false,
            match: note.match ?? null,
        })),
        attachments: stage.attachments.map(item => ({ path: item.path, size: item.size ?? item.bytes.length })),
        excluded: stage.excluded,
        renamed: stage.renamed,
        totals: {
            notes: stage.notes.length,
            attachments: stage.attachments.length,
            excluded: stage.excluded.length,
            bytes: [...stage.notes, ...stage.attachments].reduce((sum, item) => sum + (item.size ?? item.bytes.length), 0),
        },
        hash: stage.hash,
        recovery: stage.recovery ?? null,
    };
}

function defaultNameFor(filename) {
    const base = path.basename(String(filename ?? ''), path.extname(String(filename ?? ''))).normalize('NFC').trim();
    return base.slice(0, 120) || 'Imported notebook';
}

/**
 * Pure preparation, run in a worker before taking any account lock.
 */
export function prepareImport({ filename, bytes }) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    const excluded = [];
    const renamed = [];
    const candidates = [];
    if (/\.md$/i.test(String(filename ?? ''))) {
        if (buffer.length > MAX_NOTE_BYTES) throw archiveError('Notes can be up to 4 MiB.', 'IMPORT_TOO_LARGE', 413);
        candidates.push({ parts: [String(filename).split(/[\\/]/).pop()], bytes: buffer });
    } else {
        const entries = readZipDirectory(buffer);
        let declared = 0;
        for (const entry of entries) {
            if (entry.directory) continue;
            declared += entry.uncompressedSize;
            if (declared > MAX_IMPORT_TOTAL_BYTES) throw archiveError('The archive expands to more than 256 MiB.', 'IMPORT_TOO_LARGE', 413);
            if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) {
                throw archiveError(`The archive entry ${entry.name} is compressed suspiciously well.`, 'IMPORT_UNSAFE_ENTRY');
            }
        }
        for (const entry of entries) {
            const parts = archivePath(entry.name);
            if (entry.directory || !parts.length) continue;
            const lowered = parts.map(part => part.toLowerCase());
            const appFolder = lowered.slice(0, -1).find(part => APPLICATION_FOLDERS.has(part));
            if (appFolder) {
                excluded.push({ path: parts.join('/'), reason: 'application-folder' });
                continue;
            }
            if (parts.some(part => part.startsWith('.'))) {
                excluded.push({ path: parts.join('/'), reason: 'hidden' });
                continue;
            }
            const name = parts.at(-1);
            if (ARCHIVE_EXTENSIONS.test(name)) {
                excluded.push({ path: parts.join('/'), reason: 'nested-archive' });
                continue;
            }
            const isNote = /\.md$/i.test(name);
            if (!isNote && !attachmentType(name)) {
                excluded.push({ path: parts.join('/'), reason: 'unsupported-type' });
                continue;
            }
            const limit = isNote ? MAX_NOTE_BYTES : MAX_ATTACHMENT_BYTES;
            if (entry.uncompressedSize > limit) {
                excluded.push({ path: parts.join('/'), reason: 'too-large' });
                continue;
            }
            candidates.push({ parts, bytes: inflateZipEntry(buffer, entry) });
        }
    }

    const tops = new Set(candidates.map(candidate => candidate.parts.length > 1 ? candidate.parts[0] : null));
    const stripTop = candidates.length > 0 && tops.size === 1 && !tops.has(null) ? [...tops][0] : null;
    const taken = new Set();
    const notes = [];
    const attachments = [];
    for (const candidate of candidates) {
        const parts = stripTop ? candidate.parts.slice(1) : candidate.parts;
        let relative;
        try {
            relative = normaliseRelativePath(parts.join('/'), { label: 'imported path' });
        } catch {
            excluded.push({ path: candidate.parts.join('/'), reason: 'unsafe-name' });
            continue;
        }
        const isNote = /\.md$/i.test(relative);
        if (isNote) {
            try {
                utf8.decode(candidate.bytes);
            } catch {
                excluded.push({ path: relative, reason: 'not-utf8' });
                continue;
            }
            if (candidate.bytes.includes(0)) {
                excluded.push({ path: relative, reason: 'binary' });
                continue;
            }
        } else {
            try {
                validateAttachment(relative, candidate.bytes);
            } catch (error) {
                excluded.push({ path: relative, reason: error.code === 'ATTACHMENT_TYPE_MISMATCH' ? 'type-mismatch' : 'unsupported-type' });
                continue;
            }
        }
        if (taken.has(foldKey(relative))) {
            const ext = path.extname(relative);
            const stem = path.basename(relative, ext);
            const next = uniquePath(parentFolder(relative), stem, ext, taken);
            renamed.push({ from: relative, to: next, reason: 'name-collision' });
            relative = next;
        }
        taken.add(foldKey(relative));
        if (isNote) {
            if (notes.length >= MAX_NOTES_PER_NOTEBOOK) {
                excluded.push({ path: relative, reason: 'too-many-notes' });
                continue;
            }
            const text = candidate.bytes.toString('utf8');
            const { data } = splitFrontmatter(text);
            const hint = data && typeof data === 'object' && typeof data.neconyan_id === 'string' && /^n_[a-f0-9]{16}$/.test(data.neconyan_id)
                ? data.neconyan_id : null;
            notes.push({ path: relative, bytes: candidate.bytes, hash: sha256(candidate.bytes), hint });
        } else {
            attachments.push({ path: relative, bytes: candidate.bytes, hash: sha256(candidate.bytes) });
        }
    }
    const hintCounts = new Map();
    for (const note of notes) if (note.hint) hintCounts.set(note.hint, (hintCounts.get(note.hint) ?? 0) + 1);
    for (const note of notes) if (note.hint && hintCounts.get(note.hint) > 1) note.duplicateHint = true;
    if (!notes.length && !attachments.length) throw archiveError('Nothing in that file can be imported as notes.', 'IMPORT_EMPTY');
    const stageId = `st_${crypto.randomUUID().replace(/-/g, '')}`;
    const hash = sha256(JSON.stringify([...notes, ...attachments].map(item => [item.path, item.hash]).sort()));
    const stage = {
        stageId,
        createdAt: Date.now(),
        source: /\.md$/i.test(String(filename ?? '')) ? 'markdown' : 'zip',
        name: stripTop || defaultNameFor(filename),
        notes,
        attachments,
        excluded,
        renamed,
        hash,
    };
    const at = new Date(stage.createdAt).toISOString();
    for (const note of notes) note.preparedHistory = { id: `h_${sha256(`${stageId}:${note.path}`).slice(0, 16)}`, at };
    return stage;
}

function takeStage(lease, stageId) {
    const stage = readJsonLocked(lease, path.join(stageRoot(lease, stageId), 'stage.json'), null);
    if (!stage || stage.cancelled || !stage.ready || (!stage.committing && stage.createdAt + STAGE_TTL_MS < Date.now())) {
        throw new NotebookError('IMPORT_STAGE_EXPIRED', 'That import has expired. Choose the file again.', 404);
    }
    return stage;
}

export function readStage(lease, stageId) {
    return stageSummary(takeStage(lease, stageId));
}

export function listStagesLocked(lease) {
    const parent = path.join(accountRootOf(lease), 'notebook-control', '_imports');
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).filter(id => /^st_[a-f0-9]{32}$/.test(id))
        .map(id => readJsonLocked(lease, path.join(stageRoot(lease, id), 'stage.json'), null))
        .filter(stage => stage?.ready && !stage.completed && !stage.cancelled && (stage.committing || stage.createdAt + STAGE_TTL_MS >= Date.now()))
        .map(stageSummary);
}

function deleteStageLocked(lease, stageId) {
    const root = stageRoot(lease, stageId);
    const stage = readJsonLocked(lease, path.join(root, 'stage.json'), null);
    if (!stage) return false;
    if (stage.committing && !stage.completed) throw new NotebookError('IMPORT_IN_PROGRESS', 'This import has started. Resume it before removing its preview.', 409);
    for (const chunk of stage.chunks ?? []) deleteAuthoringFileLocked(lease, path.join(root, chunk.name));
    deleteAuthoringFileLocked(lease, path.join(root, 'commit.json'));
    deleteAuthoringFileLocked(lease, path.join(root, 'commit-progress.json'));
    deleteAuthoringFileLocked(lease, path.join(root, 'stage.json'));
    return true;
}

export function cancelStage(lease, stageId) {
    return runOperationLocked(lease, { operationId: `cancel:${stageId}`, kind: 'import-cancel', args: { stageId } }, () => ({ cancelled: deleteStageLocked(lease, stageId) })).cancelled;
}

/** Preview bytes are private account control data, not adopted notes. */
export async function stageImport(base, input, { stamp = roleplayAccountStamp(base), onBatch } = {}) {
    const prepared = await prepareInWorker('import', input);
    const chunks = [];
    let parts = [];
    let size = 0;
    const flush = () => { if (parts.length) { const bytes = Buffer.concat(parts); chunks.push({ name: `chunk-${chunks.length}.bin`, bytes, hash: sha256(bytes) }); parts = []; size = 0; } };
    const stage = { ...prepared, schema: 1, ready: false, notes: [], attachments: [] };
    for (const [kind, items] of [['notes', prepared.notes], ['attachments', prepared.attachments]]) {
        for (const item of items) {
            const bytes = Buffer.from(item.bytes);
            if (size + bytes.length > STAGE_CHUNK_BYTES) flush();
            const metadata = { ...item };
            delete metadata.bytes;
            stage[kind].push({ ...metadata, size: bytes.length, chunk: chunks.length, offset: size });
            parts.push(bytes);
            size += bytes.length;
        }
    }
    flush();
    stage.chunks = chunks.map(({ name, hash, bytes }) => ({ name, hash, size: bytes.length }));
    withRoleplayAccount(base, stamp, lease => runOperationLocked(lease, { operationId: `stage:${stage.stageId}`, kind: 'import-stage', args: { hash: stage.hash } }, () => {
        const parent = path.dirname(stageRoot(lease, stage.stageId));
        const owned = fs.existsSync(parent) ? fs.readdirSync(parent).filter(id => /^st_[a-f0-9]{32}$/.test(id)).map(id => readJsonLocked(lease, path.join(stageRoot(lease, id), 'stage.json'), null)).filter(Boolean) : [];
        const removable = owned.filter(item => !item.committing || item.completed).sort((a, b) => a.createdAt - b.createdAt);
        while (owned.length >= MAX_STAGES_PER_OWNER && removable.length) { const item = removable.shift(); deleteStageLocked(lease, item.stageId); owned.splice(owned.indexOf(item), 1); }
        if (owned.length >= MAX_STAGES_PER_OWNER) throw new NotebookError('IMPORT_STAGE_LIMIT', 'Resume the unfinished imports before choosing another file.', 409);
        writeJsonLocked(lease, path.join(stageRoot(lease, stage.stageId), 'stage.json'), stage);
        return { status: 'success' };
    }));
    for (const chunk of chunks) {
        const started = performance.now();
        withRoleplayAccount(base, stamp, lease => runOperationLocked(lease, { operationId: `stage:${stage.stageId}:${chunk.name}`, kind: 'import-stage-chunk', args: { hash: chunk.hash } }, () => {
            writeAuthoringFileLocked(lease, path.join(stageRoot(lease, stage.stageId), chunk.name), chunk.bytes, { expected: null, limit: MAX_ATTACHMENT_BYTES });
            return { status: 'success' };
        }));
        onBatch?.({ count: 1, lockMs: performance.now() - started });
        await yieldNotebookWork();
    }
    return withRoleplayAccount(base, stamp, lease => runOperationLocked(lease, { operationId: `ready:${stage.stageId}`, kind: 'import-stage-ready', args: { hash: stage.hash } }, () => {
        stage.ready = true;
        writeJsonLocked(lease, path.join(stageRoot(lease, stage.stageId), 'stage.json'), stage);
        return stageSummary(stage);
    }));
}

function stageBytes(lease, stage, item, cache) {
    const chunk = stage.chunks[item.chunk];
    if (!chunk || !/^chunk-\d+\.bin$/.test(chunk.name)) throw new NotebookError('IMPORT_STAGE_DAMAGED', 'The import preview is damaged. Choose the file again.', 409);
    if (!cache.has(item.chunk)) {
        const file = readAuthoringFileLocked(lease, path.join(stageRoot(lease, stage.stageId), chunk.name), MAX_ATTACHMENT_BYTES);
        if (!file || file.rawHash !== chunk.hash) throw new NotebookError('IMPORT_STAGE_DAMAGED', 'The import preview changed. Choose the file again.', 409);
        cache.set(item.chunk, file.bytes);
    }
    const bytes = cache.get(item.chunk).subarray(item.offset, item.offset + item.size);
    if (bytes.length !== item.size || sha256(bytes) !== item.hash) throw new NotebookError('IMPORT_STAGE_DAMAGED', 'The import preview is damaged. Choose the file again.', 409);
    return bytes;
}

/**
 * Compares a staged import with an existing notebook so the owner can
 * choose which changed notes to update. Matching is by path only.
 */
export function compareStageLocked(lease, { stageId, notebookId }) {
    const stage = takeStage(lease, stageId);
    if (stage.committing) throw new NotebookError('IMPORT_IN_PROGRESS', 'This import has started. Resume it with the same choices.', 409);
    const state = loadNotebookLocked(lease, notebookId, { force: true });
    const byPath = new Map(state.entries.map(entry => [foldKey(entry.path), entry]));
    for (const note of stage.notes) {
        const existing = byPath.get(foldKey(note.path));
        note.match = existing
            ? { noteId: existing.id, revision: existing.hash, state: existing.hash === note.hash ? 'same' : 'changed' }
            : { state: 'new' };
    }
    stage.target = notebookId;
    // Comparing again must persist this target even if it was compared before.
    runOperationLocked(lease, { operationId: `compare:${stageId}:${crypto.randomUUID()}`, kind: 'import-compare', args: { notebookId } }, () => {
        writeJsonLocked(lease, path.join(stageRoot(lease, stageId), 'stage.json'), stage);
        return { status: 'success' };
    });
    return stageSummary(stage);
}

function writeNewFile(lease, absolute, bytes) {
    const current = readAuthoringFileLocked(lease, absolute, MAX_ATTACHMENT_BYTES + 1);
    if (current) {
        if (current.rawHash === sha256(bytes)) return false;
        throw new NotebookError('IMPORT_PATH_TAKEN', 'A file already exists where the import wanted to write.', 409);
    }
    writeAuthoringFileLocked(lease, absolute, bytes, { expected: null, limit: MAX_ATTACHMENT_BYTES + 1 });
    return true;
}

/**
 * Commits a staged import as a new, independent notebook. Imported
 * notebooks start with assistant access, context use and publication off
 * until the owner admits them.
 */
export function commitImportLocked(lease, { operationId, stageId, name, actor = { kind: 'user' } }) {
    const owner = ownerOf(lease);
    return commitTransferBatchLocked(lease, { operationId, stageId, name, actor, kind: 'import-commit', notebookId: `nb_${sha256(`import:${owner}:${operationId}`).slice(0, 16)}` });
}

/**
 * Applies selected changed notes from a compared stage to an existing
 * notebook, each with the revision seen during comparison, and creates
 * the selected new notes. Conflicts are reported, never overwritten.
 */
export function commitStageUpdateLocked(lease, { operationId, stageId, notebookId, paths, actor = { kind: 'user' } }) {
    return commitTransferBatchLocked(lease, { operationId, stageId, notebookId, paths, actor, kind: 'import-update' });
}

function commitTransferBatchLocked(lease, { operationId, stageId, notebookId, name, paths, actor, kind, fault }) {
    const selected = new Set((Array.isArray(paths) ? paths : []).map(value => foldKey(String(value))));
    const args = kind === 'import-commit' ? { stageId, name: name ?? null } : { stageId, notebookId, paths: [...selected].sort() };
    return runOperationLocked(lease, { operationId, kind, args }, ({ plan, setPlan }) => {
        const stage = takeStage(lease, stageId);
        const journalFile = path.join(stageRoot(lease, stageId), 'commit.json');
        const progressFile = path.join(stageRoot(lease, stageId), 'commit-progress.json');
        let journal = readJsonLocked(lease, journalFile, null);
        if (stage.committing && stage.committing !== operationId) throw new NotebookError('IMPORT_IN_PROGRESS', 'This preview is already being imported. Resume the original change.', 409);
        if (!plan) {
            if (kind === 'import-update' && stage.target !== notebookId) throw new NotebookError('IMPORT_STAGE_MISMATCH', 'Compare the import with this notebook first.', 409);
            const existing = kind === 'import-update' ? readManifestLocked(lease, notebookId) : null;
            const used = new Set([...Object.keys(existing?.notes ?? {}), ...(existing ? listTrashLocked(lease, notebookId).map(item => item.noteId) : [])]);
            const reassigned = [];
            const items = [];
            for (const note of stage.notes) {
                if (kind === 'import-update' && (!selected.has(foldKey(note.path)) || !note.match || note.match.state === 'same')) continue;
                let noteId = note.match?.state === 'changed' && kind === 'import-update' ? note.match.noteId : null;
                if (!noteId) {
                    noteId = note.hint && !note.duplicateHint && !used.has(note.hint) ? note.hint : `n_${sha256(`import-note:${operationId}:${note.path}`).slice(0, 16)}`;
                    if (note.hint && noteId !== note.hint) reassigned.push({ path: note.path, identityHint: note.hint, reason: note.duplicateHint ? 'duplicate' : 'in-use' });
                }
                used.add(noteId);
                items.push({ ...note, noteId, type: kind === 'import-update' && note.match.state === 'changed' ? 'update' : 'note' });
            }
            for (const item of stage.attachments) if (kind === 'import-commit' || selected.has(foldKey(item.path))) items.push({ ...item, type: 'attachment' });
            journal = { schema: 1, kind, args, operationId, notebookId, stageId, at: new Date().toISOString(), cursor: 0, items, reassigned, results: [] };
            // Stable identities and decisions are durable BEFORE content or notebook creation.
            writeJsonLocked(lease, journalFile, journal);
            writeJsonLocked(lease, progressFile, { cursor: 0, results: [] });
            stage.committing = operationId;
            stage.recovery = { operationId, notebookId, kind, ...args };
            writeJsonLocked(lease, path.join(stageRoot(lease, stageId), 'stage.json'), stage);
            plan = { type: 'import', notebookId, stageId, journal: path.relative(accountRootOf(lease), journalFile) };
            setPlan(plan);
            fault?.('planned', { notebookId });
        }
        if (!journal || journal.operationId !== operationId) throw new NotebookError('IMPORT_STAGE_DAMAGED', 'The import recovery record is missing.', 409);
        const progress = readJsonLocked(lease, progressFile, { cursor: journal.cursor ?? 0, results: journal.results ?? [] });
        journal.cursor = progress.cursor;
        journal.results = progress.results;
        if (kind === 'import-commit') {
            try { readManifestLocked(lease, notebookId); } catch (error) {
                if (error.code !== 'NOTEBOOK_NOT_FOUND') throw error;
                createNotebookRecordLocked(lease, { id: notebookId, name: name || stage.name, origin: 'import', policies: importedPolicies(emptyPolicies()), folders: [] });
            }
        }
        let end = Math.min(journal.items.length, journal.cursor + IMPORT_BATCH_SIZE);
        // An existing-note save checks the whole index; keep it in its own short lease.
        const nextUpdate = journal.items.findIndex((item, index) => index >= journal.cursor && index < end && item.type === 'update');
        if (nextUpdate >= 0) end = nextUpdate === journal.cursor ? journal.cursor + 1 : nextUpdate;
        const cache = new Map();
        // Do not defer the independent revision-checked save's operation journal flushes.
        for (let index = journal.cursor; index < end; index++) {
            const item = journal.items[index];
            if (item.type !== 'update') continue;
            const bytes = stageBytes(lease, stage, item, cache);
            try {
                const result = updateNoteLocked(lease, { operationId: `${operationId}:u:${sha256(item.path).slice(0, 12)}`, notebookId, noteId: item.noteId, expectedRevision: item.match.revision, changes: [{ type: 'replace_all', markdown: bytes.toString('utf8') }], actor, origin: 'import', reason: 'import-update' });
                journal.results.push({ path: item.path, status: result.status, noteId: item.noteId, revision: result.revision });
            } catch (error) {
                if (!error.code || error.status >= 500) throw error;
                journal.results.push({ path: item.path, status: error.status === 409 ? 'conflict' : 'failure', code: error.code });
            }
        }
        // A new imported note must not inherit an existing notebook's AI access.
        // Flush the deny policy before any content can become visible after a crash.
        if (kind === 'import-update' && journal.items.slice(journal.cursor, end).some(item => item.type === 'note')) {
            const manifest = readManifestLocked(lease, notebookId);
            const policies = readPoliciesLocked(lease, notebookId);
            let changed = false;
            for (const item of journal.items.slice(journal.cursor, end)) {
                if (item.type !== 'note' || manifest.notes[item.noteId] || policies.notes[item.noteId]) continue;
                policies.notes[item.noteId] = { assistant: 'none' };
                changed = true;
            }
            if (changed) writePoliciesLocked(lease, notebookId, policies);
        }
        withAuthoringBatchLocked(lease, () => {
            const manifest = readManifestLocked(lease, notebookId);
            const taken = new Map(Object.entries(manifest.notes).map(([id, note]) => [foldKey(note.path), id]));
            for (let index = journal.cursor; index < end; index++) {
                const item = journal.items[index];
                if (item.type === 'update') continue;
                const bytes = stageBytes(lease, stage, item, cache);
                try {
                    if (item.type === 'note' && taken.has(foldKey(item.path)) && taken.get(foldKey(item.path)) !== item.noteId) throw new NotebookError('IMPORT_PATH_TAKEN', 'A note now exists at this path.', 409);
                    const current = manifest.notes[item.noteId];
                    const absolute = path.join(notebookContentRoot(accountRootOf(lease), notebookId), ...item.path.split('/'));
                    const created = (!current || item.type === 'attachment') && writeNewFile(lease, absolute, bytes);
                    if (!created) flushAuthoringPathLocked(lease, absolute);
                    fault?.('content', { notebookId, index });
                    if (item.type === 'note') {
                        recordHistoryLocked(lease, notebookId, item.noteId, { bytes, previous: null, actor, origin: 'import', reason: 'import', operationId, prepared: item.preparedHistory });
                        manifest.notes[item.noteId] ??= { path: item.path, hash: item.hash, createdAt: journal.at, updatedAt: journal.at, favourite: false, imported: true };
                        taken.set(foldKey(item.path), item.noteId);
                        fault?.('history', { notebookId, index });
                    }
                    journal.results.push({ path: item.path, status: 'created', noteId: item.noteId, revision: item.hash });
                } catch (error) {
                    if (kind === 'import-commit' || !error.code || error.status >= 500) throw error;
                    journal.results.push({ path: item.path, status: error.status === 409 ? 'conflict' : 'failure', code: error.code });
                }
            }
            // Changed-note saves already changed the manifest. Merge only new identities, never old revisions.
            updateManifestLocked(lease, notebookId, latest => {
                for (const item of journal.items.slice(journal.cursor, end)) if (item.type === 'note' && manifest.notes[item.noteId]) latest.notes[item.noteId] ??= manifest.notes[item.noteId];
                if (kind === 'import-commit') latest.importReport = { at: journal.at, source: stage.source, excluded: stage.excluded.length, renamed: stage.renamed.length, reassigned: journal.reassigned.length };
            });
            fault?.('manifest', { notebookId, cursor: journal.cursor });
        });
        // Progress cannot become durable until the preceding content/history/manifest batch is durable.
        journal.cursor = end;
        writeJsonLocked(lease, progressFile, { cursor: journal.cursor, results: journal.results });
        fault?.('progress', { notebookId, cursor: journal.cursor });
        if (end < journal.items.length) return { status: 'pending', pending: true, operationId, notebookId, processed: end, total: journal.items.length };
        stage.completed = true;
        writeJsonLocked(lease, path.join(stageRoot(lease, stageId), 'stage.json'), stage);
        return kind === 'import-update'
            ? { status: 'success', committed: true, operationId, notebookId, results: journal.results }
            : { status: 'success', committed: true, operationId, notebook: notebookSummary(lease, readManifestLocked(lease, notebookId)), imported: { notes: stage.notes.length, attachments: stage.attachments.length }, excluded: stage.excluded, renamed: stage.renamed, reassigned: journal.reassigned, permissions: 'inactive' };
    });
}

async function commitTransfer(base, input, kind, { stamp = roleplayAccountStamp(base), onBatch, fault } = {}) {
    let result;
    do {
        const started = performance.now();
        result = withRoleplayAccount(base, stamp, lease => commitTransferBatchLocked(lease, { ...input, kind, notebookId: kind === 'import-commit' ? `nb_${sha256(`import:${ownerOf(lease)}:${input.operationId}`).slice(0, 16)}` : input.notebookId, fault }));
        onBatch?.({ lockMs: performance.now() - started, result });
        await yieldNotebookWork();
    } while (result.pending);
    return result;
}

export const commitImport = (base, input, options) => commitTransfer(base, input, 'import-commit', options);
export const commitStageUpdate = (base, input, options) => commitTransfer(base, input, 'import-update', options);

/* ---------- export ---------- */

/**
 * Collects the notebook's portable content: Markdown notes and supported
 * attachments only. Control data, permissions, history and provenance are
 * never part of a portable export.
 */
export function collectExportLocked(lease, { notebookId }) {
    const state = loadNotebookLocked(lease, notebookId, { force: true });
    const root = notebookContentRoot(accountRootOf(lease), notebookId);
    const files = [];
    let total = 0;
    const add = (relative, limit) => {
        const file = readAuthoringFileLocked(lease, path.join(root, ...relative.split('/')), limit);
        if (!file) return;
        total += file.bytes.length;
        if (total > MAX_EXPORT_BYTES) throw new NotebookError('EXPORT_TOO_LARGE', 'This notebook is too large to export in one archive.', 413);
        files.push({ path: relative, bytes: file.bytes });
    };
    for (const entry of state.entries) add(entry.path, MAX_NOTE_BYTES);
    for (const item of state.attachments) if (attachmentType(item.path)) add(item.path, MAX_ATTACHMENT_BYTES);
    return { name: state.manifest.name, files, folders: state.folders };
}

export function exportFilename(name) {
    const stem = String(name ?? 'Notebook').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').trim().slice(0, 100) || 'Notebook';
    return `${stem}.zip`;
}

export function buildExportZip({ name, files, folders = [] }) {
    const top = exportFilename(name).replace(/\.zip$/, '');
    const tree = {};
    for (const folder of folders) tree[`${top}/${folder}/`] = new Uint8Array(0);
    for (const file of files) tree[`${top}/${file.path}`] = [new Uint8Array(file.bytes), { level: /\.(png|jpe?g|gif|webp|avif|mp3|mp4|webm|ogg|m4a|pdf)$/i.test(file.path) ? 0 : 6 }];
    return Buffer.from(zipSync(tree, { level: 6 }));
}

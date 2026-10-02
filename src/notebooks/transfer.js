import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

import { zipSync } from 'fflate';

import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import {
    MAX_DEPTH, NotebookError, foldKey, normaliseRelativePath, parentFolder, sha256, uniquePath,
} from './paths.js';
import { splitFrontmatter } from './markdown.js';
import { importedPolicies } from './permissions.js';
import {
    MAX_NOTE_BYTES, MAX_NOTES_PER_NOTEBOOK, accountRootOf, createNotebookRecordLocked, emptyPolicies,
    loadNotebookLocked, notebookContentRoot, notebookSummary, ownerOf, readManifestLocked,
    recordHistoryLocked, runOperationLocked, updateManifestLocked, updateNoteLocked,
} from './store.js';
import { MAX_ATTACHMENT_BYTES, attachmentType, validateAttachment } from './attachments.js';

export const MAX_IMPORT_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 5000;
export const MAX_IMPORT_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 200;
export const STAGE_TTL_MS = 30 * 60 * 1000;
export const MAX_STAGES_PER_OWNER = 3;

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

const stages = new Map();

function pruneStages() {
    const cutoff = Date.now() - STAGE_TTL_MS;
    for (const [key, stage] of stages) if (stage.createdAt < cutoff) stages.delete(key);
}

function stageKey(owner, stageId) {
    return `${owner}\0${stageId}`;
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
            path: note.path, size: note.bytes.length, identityHint: note.hint, duplicateHint: note.duplicateHint ?? false,
            match: note.match ?? null,
        })),
        attachments: stage.attachments.map(item => ({ path: item.path, size: item.bytes.length })),
        excluded: stage.excluded,
        renamed: stage.renamed,
        totals: {
            notes: stage.notes.length,
            attachments: stage.attachments.length,
            excluded: stage.excluded.length,
            bytes: stage.notes.reduce((sum, note) => sum + note.bytes.length, 0) + stage.attachments.reduce((sum, item) => sum + item.bytes.length, 0),
        },
        hash: stage.hash,
    };
}

function defaultNameFor(filename) {
    const base = path.basename(String(filename ?? ''), path.extname(String(filename ?? ''))).normalize('NFC').trim();
    return base.slice(0, 120) || 'Imported notebook';
}

/**
 * Validates a ZIP archive (or a single Markdown file) and holds the result
 * in memory until it is committed or expires. Nothing touches the account
 * folder here; this runs outside the account lock.
 */
export function stageImport(owner, { filename, bytes }) {
    pruneStages();
    if (typeof owner !== 'string' || !owner) throw archiveError('No account is selected.', 'IMPORT_ACCOUNT', 409);
    const owned = [...stages.values()].filter(stage => stage.owner === owner);
    if (owned.length >= MAX_STAGES_PER_OWNER) {
        const oldest = owned.sort((a, b) => a.createdAt - b.createdAt)[0];
        stages.delete(stageKey(owner, oldest.stageId));
    }
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
        owner,
        createdAt: Date.now(),
        source: /\.md$/i.test(String(filename ?? '')) ? 'markdown' : 'zip',
        name: stripTop || defaultNameFor(filename),
        notes,
        attachments,
        excluded,
        renamed,
        hash,
    };
    stages.set(stageKey(owner, stageId), stage);
    return stageSummary(stage);
}

function takeStage(owner, stageId) {
    pruneStages();
    const stage = stages.get(stageKey(owner, String(stageId ?? '')));
    if (!stage) throw new NotebookError('IMPORT_STAGE_EXPIRED', 'That import has expired. Choose the file again.', 404);
    return stage;
}

export function readStage(owner, stageId) {
    return stageSummary(takeStage(owner, stageId));
}

export function cancelStage(owner, stageId) {
    return stages.delete(stageKey(owner, String(stageId ?? '')));
}

/**
 * Compares a staged import with an existing notebook so the owner can
 * choose which changed notes to update. Matching is by path only.
 */
export function compareStageLocked(lease, { stageId, notebookId }) {
    const stage = takeStage(ownerOf(lease), stageId);
    const state = loadNotebookLocked(lease, notebookId, { force: true });
    const byPath = new Map(state.entries.map(entry => [foldKey(entry.path), entry]));
    for (const note of stage.notes) {
        const existing = byPath.get(foldKey(note.path));
        note.match = existing
            ? { noteId: existing.id, revision: existing.hash, state: existing.hash === note.hash ? 'same' : 'changed' }
            : { state: 'new' };
    }
    stage.target = notebookId;
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
    return runOperationLocked(lease, { operationId, kind: 'import-commit', args: { stageId, name: name ?? null } }, () => {
        const stage = takeStage(owner, stageId);
        const id = `nb_${sha256(`import:${owner}:${operationId}`).slice(0, 16)}`;
        const root = accountRootOf(lease);
        let manifest;
        try {
            manifest = readManifestLocked(lease, id);
        } catch (error) {
            if (error.code !== 'NOTEBOOK_NOT_FOUND') throw error;
            manifest = createNotebookRecordLocked(lease, {
                id, name: name || stage.name, origin: 'import', policies: importedPolicies(emptyPolicies()), folders: [],
            });
        }
        const content = notebookContentRoot(root, id);
        const identities = new Map();
        const usedIds = new Set(Object.keys(manifest.notes));
        const reassigned = [];
        for (const note of stage.notes) {
            let noteId = note.hint && !note.duplicateHint && !usedIds.has(note.hint) ? note.hint : null;
            if (!noteId) {
                noteId = `n_${sha256(`import-note:${operationId}:${note.path}`).slice(0, 16)}`;
                if (note.hint) reassigned.push({ path: note.path, identityHint: note.hint, reason: note.duplicateHint ? 'duplicate' : 'in-use' });
            }
            usedIds.add(noteId);
            identities.set(note.path, noteId);
        }
        for (const item of [...stage.notes, ...stage.attachments]) {
            writeNewFile(lease, path.join(content, ...item.path.split('/')), item.bytes);
        }
        const at = new Date().toISOString();
        updateManifestLocked(lease, id, current => {
            for (const note of stage.notes) {
                const noteId = identities.get(note.path);
                current.notes[noteId] ??= { path: note.path, hash: note.hash, createdAt: at, updatedAt: at, favourite: false, imported: true };
            }
            current.importReport = {
                at, source: stage.source, excluded: stage.excluded.length, renamed: stage.renamed.length, reassigned: reassigned.length,
            };
        });
        for (const note of stage.notes) {
            recordHistoryLocked(lease, id, identities.get(note.path), {
                bytes: note.bytes, previous: null, actor, origin: 'import', reason: 'import', operationId,
            });
        }
        stages.delete(stageKey(owner, stageId));
        return {
            status: 'success',
            committed: true,
            operationId,
            notebook: notebookSummary(lease, readManifestLocked(lease, id)),
            imported: { notes: stage.notes.length, attachments: stage.attachments.length },
            excluded: stage.excluded,
            renamed: stage.renamed,
            reassigned,
            permissions: 'inactive',
        };
    });
}

/**
 * Applies selected changed notes from a compared stage to an existing
 * notebook, each with the revision seen during comparison, and creates
 * the selected new notes. Conflicts are reported, never overwritten.
 */
export function commitStageUpdateLocked(lease, { operationId, stageId, notebookId, paths, actor = { kind: 'user' } }) {
    const owner = ownerOf(lease);
    const selected = new Set((Array.isArray(paths) ? paths : []).map(value => foldKey(String(value))));
    return runOperationLocked(lease, { operationId, kind: 'import-update', args: { stageId, notebookId, paths: [...selected].sort() } }, () => {
        const stage = takeStage(owner, stageId);
        if (stage.target !== notebookId) throw new NotebookError('IMPORT_STAGE_MISMATCH', 'Compare the import with this notebook first.', 409);
        const results = [];
        const root = accountRootOf(lease);
        for (const note of stage.notes) {
            if (!selected.has(foldKey(note.path)) || !note.match || note.match.state === 'same') continue;
            const suffix = sha256(note.path).slice(0, 12);
            try {
                if (note.match.state === 'changed') {
                    const result = updateNoteLocked(lease, {
                        operationId: `${operationId}:u:${suffix}`,
                        notebookId,
                        noteId: note.match.noteId,
                        expectedRevision: note.match.revision,
                        changes: [{ type: 'replace_all', markdown: note.bytes.toString('utf8') }],
                        actor,
                        origin: 'import',
                        reason: 'import-update',
                    });
                    results.push({ path: note.path, status: result.status, noteId: note.match.noteId, revision: result.revision });
                } else {
                    writeNewFile(lease, path.join(notebookContentRoot(root, notebookId), ...note.path.split('/')), note.bytes);
                    results.push({ path: note.path, status: 'created' });
                }
            } catch (error) {
                results.push({ path: note.path, status: error.code === 'NOTE_CONFLICT' ? 'conflict' : 'failure', code: error.code ?? 'FAILURE' });
            }
        }
        for (const item of stage.attachments) {
            if (!selected.has(foldKey(item.path))) continue;
            try {
                const created = writeNewFile(lease, path.join(notebookContentRoot(root, notebookId), ...item.path.split('/')), item.bytes);
                results.push({ path: item.path, status: created ? 'created' : 'no_change' });
            } catch (error) {
                results.push({ path: item.path, status: 'conflict', code: error.code ?? 'FAILURE' });
            }
        }
        updateManifestLocked(lease, notebookId, () => null);
        loadNotebookLocked(lease, notebookId, { force: true });
        stages.delete(stageKey(owner, stageId));
        return { status: 'success', committed: true, operationId, notebookId, results };
    });
}

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

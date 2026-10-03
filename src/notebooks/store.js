import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    readAuthoringFileLocked,
    writeAuthoringFileLocked,
    deleteAuthoringFileLocked,
    authoringEvidence,
    withAuthoringBatchLocked,
    flushAuthoringPathLocked,
} from '../authoring-store.js';
import { createRoleplayDirectory, roleplayLease, roleplayAccountStamp, withRoleplayAccount } from '../roleplay-store.js';
import { prepareInWorker, yieldNotebookWork } from './preparation.js';
import {
    NOTEBOOK_ID,
    NOTE_ID,
    NotebookError,
    newNotebookId,
    sha256,
    foldKey,
    normaliseRelativePath,
    normaliseFolder,
    titleToFileStem,
    joinPath,
    parentFolder,
    baseName,
    stemOf,
    uniquePath,
    requireNotebookId,
    requireNoteId,
} from './paths.js';
import {
    splitFrontmatter,
    updateFrontmatter,
    headingsOf,
    resolveSection,
    sectionBody,
    extractLinks,
    parseWikiTarget,
} from './markdown.js';
import { buildEntry, summariseEntry, resolveLink } from './note-index.js';

export const MANIFEST_SCHEMA = 1;
export const MAX_NOTE_BYTES = 4 * 1024 * 1024;
export const MAX_NOTES_PER_NOTEBOOK = 20000;
export const MAX_NOTEBOOKS = 200;
export const MAX_HISTORY = 100;
export const AUTOSAVE_COALESCE_MS = 10 * 60 * 1000;
export const MAX_OPERATIONS = 2000;
export const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTACHMENT_FOLDER = 'attachments';
const SCAN_TTL_MS = 1500;
const JSON_LIMIT = 16 * 1024 * 1024;

const scanCache = new Map();

function now() {
    return new Date().toISOString();
}

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

export function ownerOf(lease) {
    return path.basename(rootOf(lease));
}

export function notebookContentRoot(root, notebookId) {
    return path.join(root, 'notebooks', notebookId);
}

export function notebookControlRoot(root, notebookId) {
    return path.join(root, 'notebook-control', notebookId);
}

function controlFile(root, notebookId, ...parts) {
    return path.join(notebookControlRoot(root, notebookId), ...parts);
}

function readText(lease, filename, limit = JSON_LIMIT) {
    const file = readAuthoringFileLocked(lease, filename, limit);
    return file ? { text: file.bytes.toString('utf8'), bytes: file.bytes, hash: file.rawHash, evidence: file } : null;
}

export function readJsonLocked(lease, filename, fallback) {
    const file = readText(lease, filename);
    if (!file) return typeof fallback === 'function' ? fallback() : fallback;
    try {
        return JSON.parse(file.text);
    } catch {
        throw new NotebookError('NOTEBOOK_CONTROL_DAMAGED', 'A notebook control file could not be read.', 500);
    }
}

export function writeJsonLocked(lease, filename, value) {
    writeAuthoringFileLocked(lease, filename, `${JSON.stringify(value, null, 2)}\n`, { limit: JSON_LIMIT });
}

function ensureDirectory(lease, absolute) {
    const root = rootOf(lease);
    if (!fs.existsSync(absolute)) {
        createRoleplayDirectory(absolute, root);
    }
}

function emptyManifest(id, name, origin = 'local') {
    const at = now();
    return {
        schema: MANIFEST_SCHEMA,
        id,
        name,
        createdAt: at,
        updatedAt: at,
        origin,
        structureRevision: sha256(`${id}:${at}`),
        notes: {},
        associations: {},
    };
}

export function emptyPolicies() {
    return {
        schema: 1,
        revision: sha256('policies:initial'),
        assistant: 'none',
        assistantPublish: false,
        requestedEdits: null,
        admitted: true,
        notes: {},
    };
}

function migrateManifest(manifest, notebookId) {
    if (!manifest || typeof manifest !== 'object') return null;
    if (manifest.id !== notebookId) {
        throw new NotebookError('NOTEBOOK_CONTROL_DAMAGED', 'The notebook manifest does not match its folder.', 500);
    }
    if (!Number.isInteger(manifest.schema) || manifest.schema > MANIFEST_SCHEMA) {
        throw new NotebookError('NOTEBOOK_SCHEMA_UNSUPPORTED', 'This notebook was saved by a newer version of Neconyan.', 409);
    }
    manifest.notes = manifest.notes && typeof manifest.notes === 'object' ? manifest.notes : {};
    manifest.associations = manifest.associations && typeof manifest.associations === 'object' ? manifest.associations : {};
    manifest.structureRevision ||= sha256(JSON.stringify(Object.keys(manifest.notes).sort()));
    return manifest;
}

export function readManifestLocked(lease, notebookId) {
    requireNotebookId(notebookId);
    const root = rootOf(lease);
    const manifest = readJsonLocked(lease, controlFile(root, notebookId, 'manifest.json'), null);
    if (!manifest) throw new NotebookError('NOTEBOOK_NOT_FOUND', 'That notebook could not be found.', 404);
    return migrateManifest(manifest, notebookId);
}

function writeManifest(lease, manifest) {
    manifest.updatedAt = now();
    writeJsonLocked(lease, controlFile(rootOf(lease), manifest.id, 'manifest.json'), manifest);
}

function bumpStructure(manifest) {
    manifest.structureRevision = sha256(`${manifest.structureRevision}:${crypto.randomUUID()}`);
}

export function readPoliciesLocked(lease, notebookId) {
    const policies = readJsonLocked(lease, controlFile(rootOf(lease), notebookId, 'policies.json'), emptyPolicies);
    policies.notes ||= {};
    return policies;
}

export function writePoliciesLocked(lease, notebookId, policies) {
    policies.revision = sha256(JSON.stringify({ ...policies, revision: undefined, nonce: crypto.randomUUID() }));
    writeJsonLocked(lease, controlFile(rootOf(lease), notebookId, 'policies.json'), policies);
    return policies.revision;
}

function protectExternalImportsLocked(lease, notebookId, manifest, identities) {
    if (manifest.externalImportsDeny !== true || !identities.length) return;
    const policies = readPoliciesLocked(lease, notebookId);
    for (const id of identities) policies.notes[id] = { ...(policies.notes[id] ?? {}), assistant: 'none', context: { mode: 'off' } };
    // Finish this durable write before any new identity enters the manifest.
    writePoliciesLocked(lease, notebookId, policies);
}

/* ---------- operation journal ---------- */

function operationsFile(lease) {
    return path.join(rootOf(lease), 'notebook-control', '_operations.json');
}

function readOperations(lease) {
    const value = readJsonLocked(lease, operationsFile(lease), () => ({ schema: 1, entries: {} }));
    value.entries ||= {};
    return value;
}

function writeOperations(lease, journal) {
    const entries = Object.entries(journal.entries);
    const cutoff = Date.now() - OPERATION_RETENTION_MS;
    const kept = entries
        .filter(([, entry]) => entry.state === 'pending' || Date.parse(entry.at) >= cutoff)
        .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    const pending = kept.filter(([, entry]) => entry.state === 'pending');
    const completed = kept.filter(([, entry]) => entry.state !== 'pending').slice(0, Math.max(0, MAX_OPERATIONS - pending.length));
    journal.entries = Object.fromEntries([...pending, ...completed]);
    ensureDirectory(lease, path.dirname(operationsFile(lease)));
    writeJsonLocked(lease, operationsFile(lease), journal);
}

export function validOperationId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9:_.-]{8,160}$/.test(value)) {
        throw new NotebookError('OPERATION_ID_INVALID', 'Every change needs a valid operation ID.', 400);
    }
    return value;
}

export function argumentsHash(kind, args) {
    return sha256(JSON.stringify([kind, args ?? null]));
}

export function readOperationLocked(lease, operationId) {
    return readOperations(lease).entries[operationId] ?? null;
}

export function pendingOperationsLocked(lease) {
    return Object.entries(readOperations(lease).entries).filter(([, entry]) => entry.state === 'pending')
        .map(([operationId, entry]) => ({ operationId, ...entry }));
}

/**
 * Runs a mutation once per operation ID. Replays return the stored result;
 * reusing an ID with different arguments fails.
 */
export function runOperationLocked(lease, { operationId, kind, args }, execute) {
    validOperationId(operationId);
    const hash = argumentsHash(kind, args);
    const journal = readOperations(lease);
    const existing = journal.entries[operationId];
    if (existing) {
        if (existing.argsHash !== hash || existing.kind !== kind) {
            throw new NotebookError('OPERATION_REUSED', 'That operation ID was already used for a different change.', 409);
        }
        if (existing.state === 'done') return { ...existing.result, replayed: true };
    }
    if (!existing) {
        journal.entries[operationId] = { kind, argsHash: hash, state: 'pending', at: now(), plan: null };
        writeOperations(lease, journal);
    }
    const setPlan = plan => {
        const current = readOperations(lease);
        current.entries[operationId] = { ...current.entries[operationId], plan };
        writeOperations(lease, current);
    };
    const result = execute({ setPlan, plan: existing?.plan ?? null });
    if (result?.pending === true) return result;
    const finished = readOperations(lease);
    finished.entries[operationId] = { kind, argsHash: hash, state: 'done', at: now(), result };
    writeOperations(lease, finished);
    return result;
}

function deterministicNoteId(operationId, salt = '') {
    return `n_${sha256(`note:${operationId}:${salt}`).slice(0, 16)}`;
}

/* ---------- history ---------- */

function historyFile(root, notebookId, noteId) {
    return controlFile(root, notebookId, 'history', `${noteId}.json`);
}

function blobFile(root, notebookId, noteId, hash) {
    return controlFile(root, notebookId, 'history', noteId, `${hash}.md`);
}

export function readHistoryLocked(lease, notebookId, noteId) {
    const value = readJsonLocked(lease, historyFile(rootOf(lease), notebookId, noteId), () => ({ schema: 1, entries: [] }));
    value.entries ||= [];
    return value;
}

function writeBlob(lease, notebookId, noteId, bytes) {
    const hash = sha256(bytes);
    const file = blobFile(rootOf(lease), notebookId, noteId, hash);
    if (!fs.existsSync(file)) writeAuthoringFileLocked(lease, file, bytes, { limit: MAX_NOTE_BYTES + 1024 });
    return hash;
}

export function readBlobLocked(lease, notebookId, noteId, hash) {
    if (!/^[a-f0-9]{64}$/.test(String(hash))) throw new NotebookError('HISTORY_NOT_FOUND', 'That revision could not be found.', 404);
    const file = readText(lease, blobFile(rootOf(lease), notebookId, noteId, hash), MAX_NOTE_BYTES + 1024);
    if (!file) throw new NotebookError('HISTORY_NOT_FOUND', 'That revision could not be found.', 404);
    return file.text;
}

function referencedBlobs(lease, notebookId, noteId, history) {
    const keep = new Set(history.entries.map(entry => entry.revision));
    const trash = readTrash(lease, notebookId);
    for (const entry of trash.entries) if (entry.noteId === noteId) keep.add(entry.hash);
    const bindings = readJsonLocked(lease, controlFile(rootOf(lease), notebookId, 'lore-bindings.json'), () => ({ bindings: {} }));
    const records = Array.isArray(bindings.bindings) ? bindings.bindings : Object.values(bindings.bindings ?? {});
    for (const binding of records) {
        const revision = binding?.published?.noteRevision ?? binding?.publishedNoteRevision;
        if (binding?.noteId === noteId && revision) keep.add(revision);
    }
    return keep;
}

function pruneBlobs(lease, notebookId, noteId, history) {
    const directory = path.dirname(blobFile(rootOf(lease), notebookId, noteId, 'x'));
    if (!fs.existsSync(directory)) return;
    const keep = referencedBlobs(lease, notebookId, noteId, history);
    for (const name of fs.readdirSync(directory)) {
        const match = /^([a-f0-9]{64})\.md$/.exec(name);
        if (match && !keep.has(match[1])) deleteAuthoringFileLocked(lease, path.join(directory, name));
    }
}

/**
 * Records a revision. Consecutive user autosaves from one actor within ten
 * minutes collapse into one entry; every other kind of change keeps the
 * previous state as its own entry.
 */
export function recordHistoryLocked(lease, notebookId, noteId, { bytes, previous, actor, origin, reason, operationId, prepared }) {
    const history = readHistoryLocked(lease, notebookId, noteId);
    const hash = sha256(bytes);
    const prior = operationId && history.entries.find(entry => entry.revision === hash && entry.operationId === operationId);
    if (prior) {
        flushAuthoringPathLocked(lease, blobFile(rootOf(lease), notebookId, noteId, hash));
        flushAuthoringPathLocked(lease, historyFile(rootOf(lease), notebookId, noteId));
        return prior;
    }
    const revision = writeBlob(lease, notebookId, noteId, bytes);
    const last = history.entries.at(-1);
    const at = prepared?.at ?? now();
    const actorKey = JSON.stringify(actor ?? null);
    if (
        last && reason === 'autosave' && last.reason === 'autosave' && last.origin === origin
        && JSON.stringify(last.actor ?? null) === actorKey
        && Date.now() - Date.parse(last.startedAt ?? last.at) < AUTOSAVE_COALESCE_MS
        && history.entries.length > 1
    ) {
        last.revision = revision;
        last.at = at;
        last.operationId = operationId;
        last.saves = (last.saves ?? 1) + 1;
    } else {
        history.entries.push({
            id: prepared?.id ?? `h_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
            at,
            startedAt: at,
            revision,
            previous: previous ?? null,
            actor: actor ?? { kind: 'user' },
            origin: origin ?? 'user',
            reason: reason ?? 'edit',
            operationId: operationId ?? null,
        });
    }
    let pruned = false;
    while (history.entries.length > MAX_HISTORY) {
        history.entries.splice(1, 1);
        pruned = true;
    }
    writeJsonLocked(lease, historyFile(rootOf(lease), notebookId, noteId), history);
    if (pruned || (last && last.revision === revision)) pruneBlobs(lease, notebookId, noteId, history);
    return history.entries.at(-1);
}

function ensureRevisionKept(lease, notebookId, noteId, bytes, meta) {
    const history = readHistoryLocked(lease, notebookId, noteId);
    const hash = sha256(bytes);
    if (history.entries.at(-1)?.revision === hash) return history.entries.at(-1);
    return recordHistoryLocked(lease, notebookId, noteId, { bytes, previous: history.entries.at(-1)?.revision ?? null, ...meta });
}

/* ---------- trash ---------- */

function readTrash(lease, notebookId) {
    const value = readJsonLocked(lease, controlFile(rootOf(lease), notebookId, 'trash.json'), () => ({ schema: 1, entries: [] }));
    value.entries ||= [];
    return value;
}

function writeTrash(lease, notebookId, trash) {
    writeJsonLocked(lease, controlFile(rootOf(lease), notebookId, 'trash.json'), trash);
}

/* ---------- notebooks ---------- */

export function listNotebookIdsLocked(lease) {
    const directory = path.join(rootOf(lease), 'notebook-control');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && NOTEBOOK_ID.test(entry.name))
        .map(entry => entry.name)
        .filter(id => fs.existsSync(controlFile(rootOf(lease), id, 'manifest.json')));
}

function cleanName(value, label = 'name') {
    if (typeof value !== 'string') throw new NotebookError('NOTEBOOK_NAME_INVALID', `A ${label} is required.`, 400);
    const name = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!name || Buffer.byteLength(name) > 160) throw new NotebookError('NOTEBOOK_NAME_INVALID', `Choose a ${label} up to 160 bytes long.`, 400);
    return name;
}

export function createNotebookRecordLocked(lease, { id = newNotebookId(), name, origin = 'local', policies = emptyPolicies(), folders = ['Inbox'] }) {
    const root = rootOf(lease);
    if (listNotebookIdsLocked(lease).length >= MAX_NOTEBOOKS) {
        throw new NotebookError('NOTEBOOK_LIMIT', 'This account already has the maximum number of notebooks.', 409);
    }
    const manifest = emptyManifest(id, cleanName(name, 'notebook name'), origin);
    ensureDirectory(lease, notebookContentRoot(root, id));
    for (const folder of folders) ensureDirectory(lease, path.join(notebookContentRoot(root, id), normaliseFolder(folder)));
    writeJsonLocked(lease, controlFile(root, id, 'policies.json'), policies);
    writeJsonLocked(lease, controlFile(root, id, 'manifest.json'), manifest);
    return manifest;
}

export function createNotebookLocked(lease, { operationId, name, actor }) {
    return runOperationLocked(lease, { operationId, kind: 'create-notebook', args: { name } }, () => {
        const id = `nb_${sha256(`notebook:${ownerOf(lease)}:${operationId}`).slice(0, 16)}`;
        const manifest = fs.existsSync(controlFile(rootOf(lease), id, 'manifest.json'))
            ? readManifestLocked(lease, id)
            : createNotebookRecordLocked(lease, { id, name });
        return { status: 'success', committed: true, notebook: notebookSummary(lease, manifest), actor: actor?.kind ?? 'user' };
    });
}

export function ensureDefaultNotebookLocked(lease) {
    const ids = listNotebookIdsLocked(lease);
    if (ids.length) return null;
    return createNotebookRecordLocked(lease, { name: 'Notebook' });
}

export function accountRootOf(lease) {
    return rootOf(lease);
}

/**
 * Applies a structural manifest change (attachments, imports) and bumps
 * the structure revision so cached scans are refreshed.
 */
export function updateManifestLocked(lease, notebookId, mutate) {
    const manifest = readManifestLocked(lease, notebookId);
    const result = mutate(manifest);
    bumpStructure(manifest);
    writeManifest(lease, manifest);
    invalidateNotebookCache(lease, notebookId);
    return result;
}

export function notebookSummary(lease, manifest) {
    return {
        id: manifest.id,
        name: manifest.name,
        origin: manifest.origin,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        structureRevision: manifest.structureRevision,
        noteCount: Object.keys(manifest.notes).length,
    };
}

export function listNotebooksLocked(lease) {
    return listNotebookIdsLocked(lease)
        .map(id => notebookSummary(lease, readManifestLocked(lease, id)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function renameNotebookLocked(lease, { operationId, notebookId, name }) {
    return runOperationLocked(lease, { operationId, kind: 'rename-notebook', args: { notebookId, name } }, () => {
        const manifest = readManifestLocked(lease, notebookId);
        manifest.name = cleanName(name, 'notebook name');
        bumpStructure(manifest);
        writeManifest(lease, manifest);
        return { status: 'success', committed: true, notebook: notebookSummary(lease, manifest) };
    });
}

/* ---------- scanning and reconciliation ---------- */

export function walkContent(contentRoot) {
    const files = [];
    const attachments = [];
    const folders = [];
    const skipped = [];
    const visit = (absolute, relative, depth) => {
        if (depth > 16) {
            skipped.push({ path: relative, reason: 'too-deep' });
            return;
        }
        let entries;
        try {
            entries = fs.readdirSync(absolute, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const name = entry.name;
            const rel = relative ? `${relative}/${name}` : name;
            if (name.startsWith('.')) {
                if (!name.startsWith('.author-')) skipped.push({ path: rel, reason: 'hidden' });
                continue;
            }
            const full = path.join(absolute, name);
            let stat;
            try {
                stat = fs.lstatSync(full);
            } catch {
                continue;
            }
            if (stat.isSymbolicLink()) {
                skipped.push({ path: rel, reason: 'symlink' });
            } else if (stat.isDirectory()) {
                folders.push(rel);
                visit(full, rel, depth + 1);
            } else if (stat.isFile()) {
                const record = { path: rel, full, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, nlink: stat.nlink };
                if (/\.md$/i.test(name)) files.push(record);
                else attachments.push(record);
            }
        }
    };
    visit(contentRoot, '', 0);
    return { files, attachments, folders, skipped };
}

const preparations = new Map();
export const RECONCILE_BATCH_SIZE = 8;

function reservedImportIdentities(lease, notebookId) {
    const reserved = new Map();
    for (const [operationId, entry] of Object.entries(readOperations(lease).entries)) {
        if (entry.state !== 'pending' || entry.plan?.type !== 'import' || entry.plan.notebookId !== notebookId || !/^st_[a-f0-9]{32}$/.test(entry.plan.stageId)) continue;
        const journal = readJsonLocked(lease, path.join(rootOf(lease), 'notebook-control', '_imports', entry.plan.stageId, 'commit.json'), null);
        for (const item of journal?.items ?? []) if (item.type === 'note' && NOTE_ID.test(item.noteId)) reserved.set(foldKey(item.path), { ...item, operationId });
    }
    return reserved;
}

/** Prepare parsing/history metadata without a lease; publish bounded, replayable batches. */
export async function prepareNotebook(base, notebookId, { stamp = roleplayAccountStamp(base), onBatch, fault, force = false } = {}) {
    requireNotebookId(notebookId);
    const key = `${base.directories.root}\0${notebookId}\0${JSON.stringify(stamp)}`;
    if (preparations.has(key)) return preparations.get(key);
    const job = (async () => {
        const ready = withRoleplayAccount(base, stamp, lease => {
            const manifest = readManifestLocked(lease, notebookId);
            const cached = scanCache.get(cacheKey(lease, notebookId));
            const fresh = cached?.structureRevision === manifest.structureRevision && Date.now() - cached.scannedAt < SCAN_TTL_MS;
            if (fresh && !force) return { manifest, cached: { ...cached, manifest } };
            const walk = walkContent(notebookContentRoot(base.directories.root, notebookId));
            const unsettled = walk.files.filter(file => {
                const prior = cached?.files.get(file.path);
                return !prior || prior.size !== file.size || prior.mtimeMs !== file.mtimeMs || prior.ino !== file.ino;
            }).length;
            const paths = new Set(walk.files.map(file => foldKey(file.path)));
            const missing = Object.values(manifest.notes).filter(note => !paths.has(foldKey(note.path))).length;
            if (unsettled + missing <= RECONCILE_BATCH_SIZE * 4) {
                return { manifest, cached: loadNotebookLocked(lease, notebookId, { force }) };
            }
            return { manifest, reserved: reservedImportIdentities(lease, notebookId), trash: readTrash(lease, notebookId).entries,
                cached: !force && fresh ? { ...cached, manifest } : null };
        });
        if (ready.cached) return ready.cached;
        const initial = ready.manifest;
        const snapshot = await prepareInWorker('scan', { contentRoot: notebookContentRoot(base.directories.root, notebookId) });
        const known = new Map(Object.values(initial.notes).map(note => [foldKey(note.path), note]));
        const changedFiles = snapshot.files.filter(file => known.get(foldKey(file.path))?.hash !== file.hash);
        const pendingOperation = withRoleplayAccount(base, stamp, lease => Object.entries(readOperations(lease).entries)
            .find(([, entry]) => entry.state === 'pending' && entry.plan?.type === 'reconcile'
                && entry.plan.notebookId === notebookId && entry.plan.hash === snapshot.hash)?.[0]);
        // A crash resumes its original plan; a later identical snapshot is a new operation.
        const operationId = pendingOperation ?? `reconcile:${notebookId}:${snapshot.hash.slice(0, 24)}:${sha256(initial.structureRevision).slice(0, 12)}`;
        const planHash = sha256(operationId);
        const planFile = path.join(notebookControlRoot(base.directories.root, notebookId), 'reconciliation', `${planHash}.json`);
        const progressFile = path.join(path.dirname(planFile), `${planHash}.progress.json`);
        const at = now();
        // Build the identity/history plan outside the account lock, once, not per batch.
        const used = new Set([...Object.keys(initial.notes), ...(ready.trash ?? []).map(item => item.noteId)]);
        const initialPaths = new Map(Object.entries(initial.notes).map(([id, note]) => [foldKey(note.path), id]));
        const present = new Set(snapshot.files.map(file => foldKey(file.path)));
        const missing = Object.entries(initial.notes).filter(([, note]) => !present.has(foldKey(note.path)));
        const movedIds = new Set();
        const proposed = { schema: 1, operationId, notebookId, files: changedFiles.map(file => {
            const imported = ready.reserved?.get(foldKey(file.path));
            let id = initialPaths.get(foldKey(file.path));
            if (!id && imported?.hash === file.hash) id = imported.noteId;
            if (!id) {
                const moved = missing.find(([noteId, note]) => note.hash === file.hash && !movedIds.has(noteId));
                if (moved) { id = moved[0]; movedIds.add(id); }
            }
            if (!id) {
                const hint = file.parsed.properties.neconyan_id;
                id = typeof hint === 'string' && NOTE_ID.test(hint) && !used.has(hint) ? hint : `n_${sha256(`${operationId}:${file.path}`).slice(0, 16)}`;
            }
            used.add(id);
            return { id, path: file.path, hash: file.hash, history: { id: `h_${sha256(`${operationId}:${file.path}`).slice(0, 16)}`, at },
                imported: imported?.hash === file.hash ? { operationId: imported.operationId, preparedHistory: imported.preparedHistory } : null };
        }) };
        let recovery = proposed;
        const pending = Boolean(pendingOperation);
        if (changedFiles.length || pending) {
            const planned = withRoleplayAccount(base, stamp, lease => runOperationLocked(lease, { operationId, kind: 'reconcile-notebook', args: { notebookId, hash: snapshot.hash } }, ({ plan, setPlan }) => {
                if (!plan) {
                    writeJsonLocked(lease, planFile, proposed);
                    writeJsonLocked(lease, progressFile, { cursor: 0 });
                    setPlan({ type: 'reconcile', notebookId, hash: snapshot.hash });
                    fault?.('planned', { operationId });
                }
                return { pending: true, recovery: readJsonLocked(lease, planFile, null) };
            }));
            if (!planned.replayed) recovery = planned.recovery;
            if (!recovery || recovery.operationId !== operationId) throw new NotebookError('NOTEBOOK_CONTROL_DAMAGED', 'The indexing recovery record is damaged.', 500);
        }
        const byPath = new Map(snapshot.files.map(file => [file.path, file]));
        let cursor = 0;
        while (cursor < recovery.files.length) {
            const started = performance.now();
            const result = withRoleplayAccount(base, stamp, lease => runOperationLocked(lease, {
                operationId, kind: 'reconcile-notebook', args: { notebookId, hash: snapshot.hash },
            }, () => {
                const progress = readJsonLocked(lease, progressFile, { cursor: 0 });
                cursor = progress.cursor;
                const end = Math.min(cursor + RECONCILE_BATCH_SIZE, recovery.files.length);
                const batch = recovery.files.slice(cursor, end);
                const manifest = readManifestLocked(lease, notebookId);
                const paths = new Map(Object.entries(manifest.notes).map(([id, note]) => [foldKey(note.path), id]));
                let count = Object.keys(manifest.notes).length;
                protectExternalImportsLocked(lease, notebookId, manifest, batch.filter(item => !manifest.notes[item.id]).map(item => item.id));
                withAuthoringBatchLocked(lease, () => {
                    let changed = false;
                    for (let index = 0; index < batch.length; index++) {
                        const item = batch[index];
                        const file = byPath.get(item.path);
                        if (!file || file.hash !== item.hash) continue;
                        const source = readAuthoringFileLocked(lease, file.full, MAX_NOTE_BYTES);
                        if (JSON.stringify(authoringEvidence(source)) !== JSON.stringify(file.evidence)) continue;
                        const id = item.id;
                        if (paths.has(foldKey(file.path)) && paths.get(foldKey(file.path)) !== id) continue;
                        const prior = manifest.notes[id];
                        if (!prior && count >= MAX_NOTES_PER_NOTEBOOK) continue;
                        const imported = item.imported;
                        recordHistoryLocked(lease, notebookId, id, { bytes: Buffer.from(file.bytes), previous: prior?.hash ?? null, actor: imported ? { kind: 'user' } : { kind: 'external' }, origin: imported ? 'import' : 'external', reason: imported ? 'import' : prior ? 'external-change' : 'external-create', operationId: imported?.operationId ?? operationId, prepared: imported?.preparedHistory ?? item.history });
                        if (prior?.hash !== file.hash) {
                            fault?.('history', { operationId, index });
                        }
                        if (!prior) count++;
                        manifest.notes[id] = { ...(prior ?? { createdAt: at, favourite: false, adopted: true }), path: file.path, hash: file.hash, updatedAt: at };
                        changed = true;
                    }
                    if (changed) { bumpStructure(manifest); writeManifest(lease, manifest); invalidateNotebookCache(lease, notebookId); }
                    fault?.('manifest', { operationId });
                });
                cursor = end;
                writeJsonLocked(lease, progressFile, { cursor });
                fault?.('progress', { operationId, cursor });
                return { status: cursor < recovery.files.length ? 'pending' : 'success', pending: cursor < recovery.files.length, notebookId };
            }));
            if (result.replayed) cursor = recovery.files.length;
            onBatch?.({ count: Math.min(RECONCILE_BATCH_SIZE, recovery.files.length), lockMs: performance.now() - started });
            await yieldNotebookWork();
        }
        return withRoleplayAccount(base, stamp, lease => {
            const manifest = readManifestLocked(lease, notebookId);
            const files = new Map(snapshot.files.map(file => [file.path, { ...file, bytes: Buffer.from(file.bytes) }]));
            scanCache.set(cacheKey(lease, notebookId), { files, scannedAt: 0, structureRevision: manifest.structureRevision });
            return loadNotebookLocked(lease, notebookId, { force: true });
        });
    })();
    preparations.set(key, job);
    try { return await job; } finally { preparations.delete(key); }
}

function cacheKey(lease, notebookId) {
    return `${rootOf(lease)}\0${notebookId}`;
}

export function invalidateNotebookCache(lease, notebookId) {
    const invalidate = key => { const cached = scanCache.get(key); if (cached) { cached.scannedAt = 0; cached.structureRevision = null; } };
    if (notebookId) invalidate(cacheKey(lease, notebookId));
    else for (const key of scanCache.keys()) if (key.startsWith(`${rootOf(lease)}\0`)) invalidate(key);
}

/** A verified external byte change may retain its old size and modification time. */
export function invalidateNotebookFiles(lease, notebookId, paths) {
    const cached = scanCache.get(cacheKey(lease, notebookId));
    for (const relative of paths) cached?.files.delete(normaliseRelativePath(relative));
    invalidateNotebookCache(lease, notebookId);
}

function readNoteFile(lease, absolute) {
    const file = readAuthoringFileLocked(lease, absolute, MAX_NOTE_BYTES);
    if (!file) return null;
    return { text: file.bytes.toString('utf8'), bytes: file.bytes, hash: file.rawHash, evidence: file };
}

function identityHint(text) {
    const { data } = splitFrontmatter(text);
    const value = data && typeof data === 'object' ? data.neconyan_id : null;
    return typeof value === 'string' && NOTE_ID.test(value) ? value : null;
}

function applyPendingOperations(lease, manifest, byPath) {
    const journal = readOperations(lease);
    let changed = false;
    let journalChanged = false;
    for (const [operationId, entry] of Object.entries(journal.entries)) {
        const plan = entry.plan;
        if (entry.state !== 'pending' || !plan || plan.notebookId !== manifest.id) continue;
        if (plan.type === 'write') {
            const current = byPath.get(foldKey(plan.path));
            if (current && current.hash === plan.after) {
                manifest.notes[plan.noteId] = {
                    ...(manifest.notes[plan.noteId] ?? { createdAt: now(), favourite: false }),
                    path: plan.path,
                    hash: plan.after,
                    updatedAt: now(),
                };
                if (plan.fromPath && foldKey(plan.fromPath) !== foldKey(plan.path) && byPath.has(foldKey(plan.fromPath)) && byPath.get(foldKey(plan.fromPath)).hash === plan.after) {
                    /* a crashed move left both copies; the journal says the new one is current */
                }
                ensureRevisionKept(lease, manifest.id, plan.noteId, current.bytes, {
                    actor: plan.actor, origin: plan.origin, reason: plan.reason, operationId,
                });
                changed = true;
                entry.state = 'done';
                entry.result = plan.result ?? { status: 'success', committed: true, recovered: true, noteId: plan.noteId, revision: plan.after };
                journalChanged = true;
            } else {
                delete journal.entries[operationId];
                journalChanged = true;
            }
        }
    }
    if (journalChanged) {
        writeOperations(lease, journal);
    }
    return changed;
}

/**
 * Brings the manifest in line with the content folder. Files changed by
 * another program become new history entries; files that disappeared go
 * to Trash; unknown files are adopted with a fresh identity unless their
 * neconyan_id hint is unused in this notebook.
 */
export function loadNotebookLocked(lease, notebookId, { force = false } = {}) {
    const manifest = readManifestLocked(lease, notebookId);
    const root = rootOf(lease);
    const contentRoot = notebookContentRoot(root, notebookId);
    const key = cacheKey(lease, notebookId);
    const cached = scanCache.get(key);
    if (!force && cached && cached.structureRevision === manifest.structureRevision && Date.now() - cached.scannedAt < SCAN_TTL_MS) {
        return { ...cached, manifest };
    }
    ensureDirectory(lease, contentRoot);
    const walk = walkContent(contentRoot);
    const previous = cached?.files ?? new Map();
    const unsettled = walk.files.filter(record => { const prior = previous.get(record.path); return !prior || prior.size !== record.size || prior.mtimeMs !== record.mtimeMs || prior.ino !== record.ino; });
    if (unsettled.length > RECONCILE_BATCH_SIZE * 4) {
        const { scope } = roleplayLease(lease);
        const stamp = { accountId: scope.accountId, dataEpoch: scope.dataEpoch };
        setImmediate(() => void prepareNotebook(scope, notebookId, { stamp, force: true }).catch(error => console.warn('[notebooks] background preparation failed', error.code ?? error.name)));
        throw new NotebookError('NOTEBOOK_RECONCILING', 'These notes are being indexed in the background. Try again shortly.', 503, { notebookId });
    }
    const files = new Map();
    const unreadable = [];
    for (const record of walk.files) {
        const prior = previous.get(record.path);
        if (prior && prior.size === record.size && prior.mtimeMs === record.mtimeMs && prior.ino === record.ino) {
            files.set(record.path, prior);
            continue;
        }
        try {
            normaliseRelativePath(record.path);
            const file = readNoteFile(lease, record.full);
            if (!file) continue;
            files.set(record.path, { ...record, text: file.text, bytes: file.bytes, hash: file.hash });
        } catch {
            unreadable.push({ path: record.path, reason: record.nlink > 1 ? 'hardlink' : 'unreadable' });
        }
    }
    const byPath = new Map([...files.values()].map(file => [foldKey(file.path), file]));
    let changed = applyPendingOperations(lease, manifest, byPath);

    const claimed = new Set();
    const missing = [];
    for (const [id, note] of Object.entries(manifest.notes)) {
        const file = byPath.get(foldKey(note.path));
        if (!file || claimed.has(file.path)) {
            missing.push([id, note]);
            continue;
        }
        claimed.add(file.path);
        if (file.path !== note.path) {
            note.path = file.path;
            changed = true;
        }
        if (file.hash !== note.hash) {
            ensureRevisionKept(lease, notebookId, id, file.bytes, { actor: { kind: 'external' }, origin: 'external', reason: 'external-change' });
            note.hash = file.hash;
            note.updatedAt = now();
            changed = true;
        }
    }
    const unknown = [...files.values()].filter(file => !claimed.has(file.path));
    let noteCount = Object.keys(manifest.notes).length;
    const trashedIds = unknown.length ? new Set(readTrash(lease, notebookId).entries.map(entry => entry.noteId)) : new Set();
    const reserved = unknown.length ? reservedImportIdentities(lease, notebookId) : new Map();
    for (const file of unknown) {
        const moved = missing.findIndex(([, note]) => note.hash === file.hash);
        if (moved >= 0) {
            const [[, note]] = missing.splice(moved, 1);
            note.path = file.path;
            note.updatedAt = now();
            claimed.add(file.path);
            changed = true;
            continue;
        }
        if (noteCount >= MAX_NOTES_PER_NOTEBOOK) {
            unreadable.push({ path: file.path, reason: 'too-many-notes' });
            continue;
        }
        const hint = identityHint(file.text);
        const hintFree = hint && !manifest.notes[hint] && !missing.some(([id]) => id === hint)
            && !trashedIds.has(hint);
        const imported = reserved.get(foldKey(file.path));
        const retained = imported?.hash === file.hash ? imported : null;
        const id = retained?.noteId ?? (hintFree ? hint : `n_${sha256(`${notebookId}:${file.path}:${file.hash}:${crypto.randomUUID()}`).slice(0, 16)}`);
        protectExternalImportsLocked(lease, notebookId, manifest, [id]);
        manifest.notes[id] = { path: file.path, hash: file.hash, createdAt: now(), updatedAt: now(), favourite: false, adopted: true };
        noteCount++;
        ensureRevisionKept(lease, notebookId, id, file.bytes, { actor: retained ? { kind: 'user' } : { kind: 'external' }, origin: retained ? 'import' : 'external', reason: retained ? 'import' : 'external-create', operationId: retained?.operationId, prepared: retained?.preparedHistory });
        claimed.add(file.path);
        changed = true;
    }
    if (missing.length) {
        const trash = readTrash(lease, notebookId);
        for (const [id, note] of missing) {
            const history = readHistoryLocked(lease, notebookId, id);
            const known = history.entries.some(entry => entry.revision === note.hash);
            trash.entries.push({
                id: `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
                noteId: id,
                path: note.path,
                title: stemOf(note.path),
                hash: known ? note.hash : history.entries.at(-1)?.revision ?? null,
                deletedAt: now(),
                actor: { kind: 'external' },
                origin: 'external',
                favourite: Boolean(note.favourite),
            });
            delete manifest.notes[id];
        }
        writeTrash(lease, notebookId, trash);
        changed = true;
    }
    if (changed) {
        bumpStructure(manifest);
        writeManifest(lease, manifest);
    }
    const entries = Object.entries(manifest.notes).map(([id, note]) => {
        const file = byPath.get(foldKey(note.path));
        const prior = cached?.byId?.get(id);
        const parsed = prior?.hash === file.hash && prior?.path === note.path ? prior : file.parsed;
        return { ...(parsed ?? buildEntry(id, note.path, file.text, file.hash)), id, createdAt: note.createdAt, updatedAt: note.updatedAt, favourite: Boolean(note.favourite) };
    });
    const state = {
        notebookId,
        structureRevision: manifest.structureRevision,
        scannedAt: Date.now(),
        files,
        entries,
        byId: new Map(entries.map(entry => [entry.id, entry])),
        folders: walk.folders.filter(folder => !folder.split('/').some(part => part.startsWith('.'))).sort(),
        attachments: walk.attachments.map(item => ({ path: item.path, size: item.size, mtimeMs: item.mtimeMs })),
        skipped: [...walk.skipped, ...unreadable],
    };
    scanCache.set(key, state);
    return { ...state, manifest };
}

export function requireNoteLocked(state, noteId) {
    requireNoteId(noteId);
    const entry = state.byId.get(noteId);
    if (!entry) throw new NotebookError('NOTE_NOT_FOUND', 'That note could not be found.', 404);
    return entry;
}

export function noteSummary(entry) {
    return summariseEntry(entry, { createdAt: entry.createdAt, updatedAt: entry.updatedAt, favourite: entry.favourite });
}

export function noteDetail(entry, { includeText = true } = {}) {
    return {
        ...noteSummary(entry),
        text: includeText ? entry.text : undefined,
        properties: entry.properties,
        complexProperties: entry.complexProperties,
        propertiesError: entry.propertiesError,
        headings: entry.headings,
    };
}

/* ---------- writing notes ---------- */

function takenPaths(state, except) {
    const taken = new Set();
    for (const entry of state.entries) if (entry.id !== except) taken.add(foldKey(entry.path));
    for (const file of state.files.values()) if (!state.byId.get(except) || file.path !== state.byId.get(except).path) taken.add(foldKey(file.path));
    for (const folder of state.folders) taken.add(foldKey(folder));
    return taken;
}

function encodeText(text) {
    if (typeof text !== 'string') throw new NotebookError('NOTE_TEXT_INVALID', 'Note text must be text.', 400);
    if (text.includes('\u0000')) throw new NotebookError('NOTE_TEXT_INVALID', 'Note text cannot contain NUL characters.', 400);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_NOTE_BYTES) throw new NotebookError('NOTE_TOO_LARGE', 'That note is larger than 4 MiB.', 413);
    return bytes;
}

/**
 * The single write path for note content. The caller has already checked
 * permission; this re-checks the revision inside the account lock.
 */
function commitNoteLocked(lease, state, {
    noteId, path: relative, fromPath = null, bytes, expectedRevision, actor, origin, reason, operationId, setPlan, create = false, result,
}) {
    const root = rootOf(lease);
    const contentRoot = notebookContentRoot(root, state.notebookId);
    const manifest = state.manifest;
    const current = manifest.notes[noteId];
    if (!create) {
        if (!current) throw new NotebookError('NOTE_NOT_FOUND', 'That note could not be found.', 404);
        if (expectedRevision !== undefined && expectedRevision !== current.hash) {
            throw new NotebookError('NOTE_CONFLICT', 'This note changed somewhere else since you opened it.', 409, { currentRevision: current.hash });
        }
    }
    const before = current?.hash ?? null;
    const after = sha256(bytes);
    if (!create && after === before && (!fromPath || fromPath === relative)) {
        return { status: 'no_change', committed: false, noteId, revision: before };
    }
    if (before) {
        const prior = state.files.get(current.path);
        if (prior) ensureRevisionKept(lease, state.notebookId, noteId, prior.bytes, { actor: { kind: 'system' }, origin: 'system', reason: 'checkpoint' });
    }
    setPlan?.({ type: 'write', notebookId: state.notebookId, noteId, path: relative, fromPath, before, after, actor, origin, reason, result });
    const target = path.join(contentRoot, relative);
    const expected = create ? null : undefined;
    if (create && fs.existsSync(target)) throw new NotebookError('NOTEBOOK_PATH_TAKEN', 'A file already exists at that location.', 409);
    if (fromPath && fromPath !== relative) {
        if (fs.existsSync(target) && foldKey(fromPath) !== foldKey(relative)) {
            throw new NotebookError('NOTEBOOK_PATH_TAKEN', 'A file already exists at that location.', 409);
        }
        createRoleplayDirectory(path.dirname(target), root);
        fs.renameSync(path.join(contentRoot, fromPath), target);
        if (after !== before) writeAuthoringFileLocked(lease, target, bytes, { limit: MAX_NOTE_BYTES });
    } else {
        writeAuthoringFileLocked(lease, target, bytes, { expected, limit: MAX_NOTE_BYTES });
    }
    const entry = recordHistoryLocked(lease, state.notebookId, noteId, { bytes, previous: before, actor, origin, reason, operationId });
    manifest.notes[noteId] = {
        ...(current ?? { createdAt: now(), favourite: false }),
        path: relative,
        hash: after,
        updatedAt: now(),
    };
    delete manifest.notes[noteId].adopted;
    bumpStructure(manifest);
    writeManifest(lease, manifest);
    invalidateNotebookCache(lease, state.notebookId);
    return { status: 'success', committed: true, noteId, revision: after, previousRevision: before, historyId: entry.id, path: relative };
}

export function createNoteLocked(lease, { operationId, notebookId, folder = 'Inbox', title = '', text = '', actor = { kind: 'user' }, origin = 'user', reason = 'create', template = null, source = null }) {
    const args = { notebookId, folder, title, text, template, source };
    return runOperationLocked(lease, { operationId, kind: 'create-note', args }, ({ setPlan }) => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const cleanFolder = normaliseFolder(folder);
        if (cleanFolder) normaliseRelativePath(cleanFolder);
        const stem = titleToFileStem(typeof title === 'string' && title.trim() ? title : firstLineTitle(text));
        const relative = uniquePath(cleanFolder, stem, '.md', takenPaths(state));
        const noteId = deterministicNoteId(operationId);
        if (state.manifest.notes[noteId]) {
            return { status: 'success', committed: true, noteId, revision: state.manifest.notes[noteId].hash, path: state.manifest.notes[noteId].path };
        }
        const bytes = encodeText(text);
        const result = commitNoteLocked(lease, state, {
            noteId, path: relative, bytes, actor, origin, reason, operationId, setPlan, create: true,
        });
        if (source) recordProvenanceLocked(lease, notebookId, noteId, { ...source, at: now(), operationId });
        return { ...result, title: stemOf(relative), notebookId };
    });
}

function firstLineTitle(text) {
    const body = splitFrontmatter(String(text ?? '')).body ?? '';
    const line = body.split('\n').map(item => item.replace(/^#+\s*/, '').trim()).find(Boolean);
    return (line ?? 'Untitled').slice(0, 80);
}

export function sectionHash(text) {
    return sha256(Buffer.from(text, 'utf8'));
}

function detectNewline(text) {
    return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

function matchNewlines(original, inserted) {
    return detectNewline(original) === '\r\n' && !inserted.includes('\r') ? inserted.replace(/\n/g, '\r\n') : inserted;
}

function findSection(text, change) {
    const selector = change.selector ?? (change.sectionId ? { kind: 'id', id: change.sectionId } : null);
    if (!selector) throw new NotebookError('NOTE_SELECTOR_INVALID', 'Choose a section to change.', 400);
    const resolved = resolveSection(text, selector);
    if (resolved.status === 'missing') throw new NotebookError('NOTE_SELECTOR_MISSING', 'That section no longer exists. Read the note again.', 409);
    if (resolved.status === 'ambiguous') throw new NotebookError('NOTE_SELECTOR_AMBIGUOUS', 'More than one section matches. Read the note again.', 409);
    return resolved.heading;
}

/**
 * Applies a list of edits to note text. Each edit checks its own evidence
 * so a stale or ambiguous edit fails instead of touching the wrong place.
 */
export function applyNoteChanges(text, changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 32) {
        throw new NotebookError('NOTE_CHANGES_INVALID', 'Send between one and 32 changes.', 400);
    }
    let result = text;
    const regions = [];
    for (const change of changes) {
        const type = change?.type;
        if (type === 'replace_all') {
            result = String(change.markdown ?? '');
            regions.push('Whole note');
        } else if (type === 'append') {
            const addition = matchNewlines(result, String(change.markdown ?? ''));
            if (!addition) throw new NotebookError('NOTE_CHANGES_INVALID', 'There is nothing to append.', 400);
            if (change.selector || change.sectionId) {
                const heading = findSection(result, change);
                let end = heading.end;
                while (end > heading.bodyStart && /\s/.test(result[end - 1])) end -= 1;
                const nl = detectNewline(result);
                const insert = `${end > heading.lineEnd ? nl + nl : nl}${addition.replace(/\s+$/, '')}`;
                result = `${result.slice(0, end)}${insert}${result.slice(end)}`;
                if (!/\n$/.test(result)) result += nl;
                regions.push(heading.text);
            } else {
                const nl = detectNewline(result);
                const trimmed = result.replace(/(\r?\n)+$/, '');
                result = trimmed ? `${trimmed}${nl}${nl}${addition.replace(/(\r?\n)+$/, '')}${nl}` : `${addition.replace(/(\r?\n)+$/, '')}${nl}`;
                regions.push('End of note');
            }
        } else if (type === 'replace_section') {
            const heading = findSection(result, change);
            const current = sectionBody(result, heading);
            if (change.expectedTextHash && change.expectedTextHash !== sectionHash(current)) {
                throw new NotebookError('NOTE_SELECTION_STALE', 'That section changed since it was read.', 409);
            }
            if (!change.expectedTextHash) throw new NotebookError('NOTE_SELECTION_STALE', 'Read the section before replacing it.', 409);
            const nl = detectNewline(result);
            const replacement = matchNewlines(result, String(change.markdown ?? '')).replace(/^(\r?\n)+|(\r?\n)+$/g, '');
            const lineBreak = result.slice(heading.lineEnd, heading.bodyStart) || nl;
            let tail = heading.end;
            const trailing = /(\r?\n)+$/.exec(result.slice(heading.bodyStart, heading.end));
            const keepTrailing = trailing ? trailing[0] : '';
            tail = heading.end - keepTrailing.length;
            const leadMatch = /^(\r?\n)*/.exec(result.slice(heading.bodyStart, tail))[0];
            result = `${result.slice(0, heading.lineEnd)}${lineBreak}${leadMatch}${replacement}${keepTrailing || (heading.end < result.length ? nl + nl : nl)}${result.slice(heading.end)}`;
            regions.push(heading.text);
        } else if (type === 'replace_selection') {
            const find = String(change.find ?? '');
            if (!find) throw new NotebookError('NOTE_SELECTION_INVALID', 'Choose the text to replace.', 400);
            let start = -1;
            if (Number.isInteger(change.start)) {
                if (result.slice(change.start, change.start + find.length) !== find) {
                    throw new NotebookError('NOTE_SELECTION_STALE', 'The selected text changed. Select it again.', 409);
                }
                start = change.start;
            } else {
                start = result.indexOf(find);
                if (start < 0) throw new NotebookError('NOTE_SELECTION_STALE', 'The selected text is no longer in the note.', 409);
                if (result.indexOf(find, start + 1) >= 0) {
                    throw new NotebookError('NOTE_SELECTION_AMBIGUOUS', 'The selected text appears more than once. Select a longer passage.', 409);
                }
            }
            const replacement = matchNewlines(result, String(change.replace ?? ''));
            result = `${result.slice(0, start)}${replacement}${result.slice(start + find.length)}`;
            const heading = headingsOf(result).filter(item => item.start <= start).at(-1);
            regions.push(heading ? heading.text : 'Selection');
        } else if (type === 'properties') {
            try {
                result = updateFrontmatter(result, change.set ?? {});
            } catch (error) {
                throw new NotebookError('NOTE_PROPERTIES_INVALID', error.message || 'Those properties could not be saved.', 400);
            }
            regions.push('Properties');
        } else {
            throw new NotebookError('NOTE_CHANGES_INVALID', 'That change type is not supported.', 400);
        }
    }
    return { text: result, regions: [...new Set(regions)] };
}

export function updateNoteLocked(lease, { operationId, notebookId, noteId, expectedRevision, changes, actor = { kind: 'user' }, origin = 'user', reason = 'edit' }) {
    const args = { notebookId, noteId, expectedRevision, changes };
    return runOperationLocked(lease, { operationId, kind: 'update-note', args }, ({ setPlan }) => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const entry = requireNoteLocked(state, noteId);
        if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== entry.hash) {
            throw new NotebookError('NOTE_CONFLICT', 'This note changed somewhere else since you opened it.', 409, { currentRevision: entry.hash });
        }
        const { text, regions } = applyNoteChanges(entry.text, changes);
        const bytes = encodeText(text);
        const committed = commitNoteLocked(lease, state, {
            noteId, path: entry.path, bytes, expectedRevision: entry.hash, actor, origin, reason, operationId, setPlan,
        });
        return { ...committed, changedRegions: regions, title: entry.title, notebookId };
    });
}

export function readNoteLocked(lease, { notebookId, noteId }) {
    const state = loadNotebookLocked(lease, notebookId);
    return { state, entry: requireNoteLocked(state, noteId) };
}

/* ---------- rename, move and link rewriting ---------- */

function encodeMarkdownPath(relative) {
    return relative.split('/').map(part => encodeURIComponent(part).replace(/%2F/g, '/')).join('/');
}

function relativeHref(fromPath, toPath) {
    const from = parentFolder(fromPath);
    const rel = path.posix.relative(from || '.', toPath);
    return encodeMarkdownPath(rel || baseName(toPath));
}

function rewriteLinkText(link, { entries, fromNotePath, newPath }) {
    if (link.kind === 'markdown') {
        const href = relativeHref(fromNotePath, newPath) + (link.fragment ? `#${encodeURIComponent(link.fragment)}` : '');
        return link.raw.replace(/\]\(([^)]*)\)$/, () => `](${href})`);
    }
    const inner = /^!?\[\[([\s\S]*)\]\]$/.exec(link.raw)?.[1];
    if (inner === undefined) return link.raw;
    const parsed = parseWikiTarget(inner);
    const newStem = stemOf(newPath);
    const pathQualified = parsed.target.includes('/');
    const sameStem = entries.filter(entry => foldKey(entry.stem) === foldKey(newStem));
    const target = !pathQualified && sameStem.length <= 1 ? newStem : newPath.replace(/\.md$/i, '');
    const label = parsed.label ? `|${parsed.label}` : '';
    const fragment = parsed.fragment ? `#${parsed.fragment}` : '';
    return `${link.embed ? '!' : ''}[[${target}${fragment}${label}]]`;
}

function linkRewritesFor(state, noteId, newPath) {
    const plans = [];
    const futureEntries = state.entries.map(entry => entry.id === noteId ? { ...entry, path: newPath, stem: stemOf(newPath) } : entry);
    for (const entry of state.entries) {
        const edits = [];
        for (const link of entry.links) {
            if (link.external) continue;
            const resolved = resolveLink(state.entries, link, entry.path);
            if (resolved.status !== 'resolved' || resolved.entry.id !== noteId) continue;
            const fromNotePath = entry.id === noteId ? newPath : entry.path;
            const replacement = rewriteLinkText(link, { entries: futureEntries, fromNotePath, newPath });
            if (replacement !== link.raw) edits.push({ start: link.start, end: link.end, raw: link.raw, replacement });
        }
        if (edits.length) plans.push({ entry, edits });
    }
    return plans;
}

function applyEdits(text, edits) {
    let result = text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        if (result.slice(edit.start, edit.end) !== edit.raw) continue;
        result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
    }
    return result;
}

export function moveNoteLocked(lease, { operationId, notebookId, noteId, title, folder, expectedRevision, updateLinks = true, actor = { kind: 'user' }, origin = 'user' }) {
    const args = { notebookId, noteId, title, folder, expectedRevision, updateLinks };
    return runOperationLocked(lease, { operationId, kind: 'move-note', args }, ({ setPlan }) => {
        let state = loadNotebookLocked(lease, notebookId, { force: true });
        const entry = requireNoteLocked(state, noteId);
        if (expectedRevision && expectedRevision !== entry.hash) {
            throw new NotebookError('NOTE_CONFLICT', 'This note changed somewhere else since you opened it.', 409, { currentRevision: entry.hash });
        }
        const targetFolder = folder === undefined ? entry.folder : normaliseFolder(folder);
        if (targetFolder) normaliseRelativePath(targetFolder);
        const stem = title === undefined ? entry.stem : titleToFileStem(title);
        const desired = joinPath(targetFolder, `${stem}.md`);
        if (desired === entry.path) return { status: 'no_change', committed: false, noteId, path: entry.path, revision: entry.hash };
        const taken = takenPaths(state, noteId);
        const newPath = taken.has(foldKey(desired)) ? uniquePath(targetFolder, stem, '.md', taken) : desired;
        const rewrites = updateLinks ? linkRewritesFor(state, noteId, newPath) : [];
        const own = rewrites.find(plan => plan.entry.id === noteId);
        const ownBytes = own ? encodeText(applyEdits(entry.text, own.edits)) : entry.bytes ?? Buffer.from(entry.text, 'utf8');
        const moved = commitNoteLocked(lease, state, {
            noteId, path: newPath, fromPath: entry.path, bytes: ownBytes, expectedRevision: entry.hash, actor, origin, reason: 'move', operationId, setPlan,
        });
        const updated = [];
        const unresolved = [];
        for (const plan of rewrites) {
            if (plan.entry.id === noteId) continue;
            state = loadNotebookLocked(lease, notebookId, { force: true });
            const current = state.byId.get(plan.entry.id);
            if (!current || current.hash !== plan.entry.hash) {
                unresolved.push({ noteId: plan.entry.id, title: plan.entry.title });
                continue;
            }
            const bytes = encodeText(applyEdits(current.text, plan.edits));
            commitNoteLocked(lease, state, {
                noteId: current.id, path: current.path, bytes, expectedRevision: current.hash, actor, origin, reason: 'link-update', operationId,
            });
            updated.push({ noteId: current.id, title: current.title, links: plan.edits.length });
        }
        return { ...moved, status: 'success', committed: true, notebookId, path: newPath, updatedLinks: updated, unresolved };
    });
}

/* ---------- folders ---------- */

export function createFolderLocked(lease, { operationId, notebookId, folder }) {
    return runOperationLocked(lease, { operationId, kind: 'create-folder', args: { notebookId, folder } }, () => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const clean = normaliseRelativePath(normaliseFolder(folder), { label: 'folder' });
        const clash = [...state.files.values()].some(file => foldKey(file.path) === foldKey(clean))
            || state.folders.some(item => foldKey(item) === foldKey(clean) && item !== clean);
        if (clash) throw new NotebookError('NOTEBOOK_PATH_TAKEN', 'Something with that name already exists.', 409);
        ensureDirectory(lease, path.join(notebookContentRoot(rootOf(lease), notebookId), clean));
        state.manifest && bumpStructure(state.manifest);
        writeManifest(lease, state.manifest);
        invalidateNotebookCache(lease, notebookId);
        return { status: 'success', committed: true, folder: clean };
    });
}

export function moveFolderLocked(lease, { operationId, notebookId, folder, to, actor = { kind: 'user' } }) {
    return runOperationLocked(lease, { operationId, kind: 'move-folder', args: { notebookId, folder, to } }, () => {
        let state = loadNotebookLocked(lease, notebookId, { force: true });
        const from = normaliseRelativePath(normaliseFolder(folder), { label: 'folder' });
        const target = normaliseRelativePath(normaliseFolder(to), { label: 'folder' });
        if (!state.folders.includes(from)) throw new NotebookError('FOLDER_NOT_FOUND', 'That folder could not be found.', 404);
        if (foldKey(target) === foldKey(from)) return { status: 'no_change', committed: false, folder: from };
        if (target.startsWith(`${from}/`)) throw new NotebookError('NOTEBOOK_PATH_INVALID', 'A folder cannot move inside itself.', 400);
        const taken = new Set([...state.folders, ...[...state.files.values()].map(file => file.path)].map(foldKey));
        if (taken.has(foldKey(target))) throw new NotebookError('NOTEBOOK_PATH_TAKEN', 'Something with that name already exists.', 409);
        const affected = state.entries.filter(entry => entry.path.startsWith(`${from}/`));
        const futurePaths = new Map(affected.map(entry => [entry.id, `${target}${entry.path.slice(from.length)}`]));
        const futureEntries = state.entries.map(entry => futurePaths.has(entry.id) ? { ...entry, path: futurePaths.get(entry.id), folder: parentFolder(futurePaths.get(entry.id)) } : entry);
        const rewrites = new Map();
        for (const entry of state.entries) {
            for (const link of entry.links) {
                if (link.external) continue;
                const resolved = resolveLink(state.entries, link, entry.path);
                if (resolved.status !== 'resolved' || !futurePaths.has(resolved.entry.id)) continue;
                const fromNotePath = futurePaths.get(entry.id) ?? entry.path;
                const needs = link.kind === 'markdown' || link.target.includes('/') || futurePaths.has(entry.id);
                if (!needs) continue;
                const check = resolveLink(futureEntries, link, fromNotePath);
                if (link.kind === 'wiki' && check.status === 'resolved' && check.entry.id === resolved.entry.id) continue;
                const replacement = rewriteLinkText(link, { entries: futureEntries, fromNotePath, newPath: futurePaths.get(resolved.entry.id) });
                if (replacement === link.raw) continue;
                const list = rewrites.get(entry.id) ?? [];
                list.push({ start: link.start, end: link.end, raw: link.raw, replacement });
                rewrites.set(entry.id, list);
            }
        }
        const contentRoot = notebookContentRoot(rootOf(lease), notebookId);
        createRoleplayDirectory(path.dirname(path.join(contentRoot, target)), rootOf(lease));
        fs.renameSync(path.join(contentRoot, from), path.join(contentRoot, target));
        for (const [id, newPath] of futurePaths) state.manifest.notes[id].path = newPath;
        bumpStructure(state.manifest);
        writeManifest(lease, state.manifest);
        invalidateNotebookCache(lease, notebookId);
        const updated = [];
        for (const [id, edits] of rewrites) {
            state = loadNotebookLocked(lease, notebookId, { force: true });
            const current = state.byId.get(id);
            if (!current) continue;
            const bytes = encodeText(applyEdits(current.text, edits));
            commitNoteLocked(lease, state, {
                noteId: id, path: current.path, bytes, expectedRevision: current.hash, actor, origin: actor.kind === 'user' ? 'user' : actor.kind, reason: 'link-update', operationId,
            });
            updated.push({ noteId: id, title: current.title, links: edits.length });
        }
        return { status: 'success', committed: true, folder: target, movedNotes: affected.length, updatedLinks: updated };
    });
}

export function deleteFolderLocked(lease, { operationId, notebookId, folder }) {
    return runOperationLocked(lease, { operationId, kind: 'delete-folder', args: { notebookId, folder } }, () => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const clean = normaliseRelativePath(normaliseFolder(folder), { label: 'folder' });
        const absolute = path.join(notebookContentRoot(rootOf(lease), notebookId), clean);
        if (!state.folders.includes(clean)) throw new NotebookError('FOLDER_NOT_FOUND', 'That folder could not be found.', 404);
        const remaining = fs.readdirSync(absolute).filter(name => !name.startsWith('.author-'));
        if (remaining.length) throw new NotebookError('FOLDER_NOT_EMPTY', 'Move or delete the notes in this folder first.', 409);
        fs.rmdirSync(absolute);
        bumpStructure(state.manifest);
        writeManifest(lease, state.manifest);
        invalidateNotebookCache(lease, notebookId);
        return { status: 'success', committed: true, folder: clean };
    });
}

/* ---------- favourites, associations, provenance ---------- */

export function setFavouriteLocked(lease, { operationId, notebookId, noteId, favourite }) {
    return runOperationLocked(lease, { operationId, kind: 'favourite', args: { notebookId, noteId, favourite: Boolean(favourite) } }, () => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        requireNoteLocked(state, noteId);
        state.manifest.notes[noteId].favourite = Boolean(favourite);
        bumpStructure(state.manifest);
        writeManifest(lease, state.manifest);
        invalidateNotebookCache(lease, notebookId);
        return { status: 'success', committed: true, noteId, favourite: Boolean(favourite) };
    });
}

const ASSOCIATION_KINDS = new Set(['lorebook', 'lore-entry', 'character', 'chat']);

export function setAssociationsLocked(lease, { operationId, notebookId, noteId, associations }) {
    return runOperationLocked(lease, { operationId, kind: 'associations', args: { notebookId, noteId, associations } }, () => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        requireNoteLocked(state, noteId);
        if (!Array.isArray(associations) || associations.length > 64) {
            throw new NotebookError('ASSOCIATION_INVALID', 'Send up to 64 associations.', 400);
        }
        const clean = associations.map(item => {
            if (!ASSOCIATION_KINDS.has(item?.kind) || typeof item.id !== 'string' || !item.id || item.id.length > 512) {
                throw new NotebookError('ASSOCIATION_INVALID', 'That association is not valid.', 400);
            }
            return {
                kind: item.kind,
                id: item.id,
                label: typeof item.label === 'string' ? item.label.slice(0, 200) : item.id.slice(0, 200),
                ...(item.kind === 'lore-entry' ? { uid: Number.isInteger(item.uid) ? item.uid : Number(item.uid) } : {}),
            };
        });
        if (clean.length) state.manifest.associations[noteId] = clean;
        else delete state.manifest.associations[noteId];
        bumpStructure(state.manifest);
        writeManifest(lease, state.manifest);
        invalidateNotebookCache(lease, notebookId);
        return { status: 'success', committed: true, noteId, associations: clean };
    });
}

function provenanceFile(lease, notebookId) {
    return controlFile(rootOf(lease), notebookId, 'provenance.json');
}

export function recordProvenanceLocked(lease, notebookId, noteId, record) {
    const value = readJsonLocked(lease, provenanceFile(lease, notebookId), () => ({ schema: 1, notes: {} }));
    value.notes ||= {};
    const list = value.notes[noteId] ?? [];
    list.push(record);
    value.notes[noteId] = list.slice(-50);
    writeJsonLocked(lease, provenanceFile(lease, notebookId), value);
}

export function readProvenanceLocked(lease, notebookId, noteId) {
    const value = readJsonLocked(lease, provenanceFile(lease, notebookId), () => ({ schema: 1, notes: {} }));
    return value.notes?.[noteId] ?? [];
}

/* ---------- trash and history restore ---------- */

export function trashNoteLocked(lease, { operationId, notebookId, noteId, actor = { kind: 'user' } }) {
    return runOperationLocked(lease, { operationId, kind: 'trash-note', args: { notebookId, noteId } }, () => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const entry = requireNoteLocked(state, noteId);
        const file = state.files.get(entry.path);
        ensureRevisionKept(lease, notebookId, noteId, file.bytes, { actor, origin: actor.kind, reason: 'before-trash', operationId });
        const trash = readTrash(lease, notebookId);
        const trashId = `t_${sha256(`trash:${operationId}`).slice(0, 16)}`;
        trash.entries.push({
            id: trashId, noteId, path: entry.path, title: entry.title, hash: entry.hash, deletedAt: now(), actor, origin: actor.kind,
            favourite: entry.favourite,
        });
        writeTrash(lease, notebookId, trash);
        deleteAuthoringFileLocked(lease, path.join(notebookContentRoot(rootOf(lease), notebookId), entry.path));
        delete state.manifest.notes[noteId];
        bumpStructure(state.manifest);
        writeManifest(lease, state.manifest);
        invalidateNotebookCache(lease, notebookId);
        return { status: 'success', committed: true, noteId, trashId };
    });
}

export function listTrashLocked(lease, notebookId) {
    readManifestLocked(lease, notebookId);
    return readTrash(lease, notebookId).entries.map(({ id, noteId, path: notePath, title, deletedAt, origin }) => ({ id, noteId, path: notePath, title, deletedAt, origin }));
}

export function restoreTrashLocked(lease, { operationId, notebookId, trashId, actor = { kind: 'user' } }) {
    return runOperationLocked(lease, { operationId, kind: 'restore-trash', args: { notebookId, trashId } }, ({ setPlan }) => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const trash = readTrash(lease, notebookId);
        const item = trash.entries.find(entry => entry.id === trashId);
        if (!item) throw new NotebookError('TRASH_NOT_FOUND', 'That item is no longer in Trash.', 404);
        if (!item.hash) throw new NotebookError('TRASH_UNRECOVERABLE', 'No saved copy of that note exists.', 409);
        const text = readBlobLocked(lease, notebookId, item.noteId, item.hash);
        const folder = parentFolder(item.path);
        const taken = takenPaths(state);
        const relative = taken.has(foldKey(item.path)) ? uniquePath(folder, stemOf(item.path), '.md', taken) : item.path;
        const noteId = state.manifest.notes[item.noteId] ? deterministicNoteId(operationId, 'restore') : item.noteId;
        const result = commitNoteLocked(lease, state, {
            noteId, path: relative, bytes: Buffer.from(text, 'utf8'), actor, origin: actor.kind, reason: 'restore', operationId, setPlan, create: true,
        });
        const after = readTrash(lease, notebookId);
        after.entries = after.entries.filter(entry => entry.id !== trashId);
        writeTrash(lease, notebookId, after);
        if (item.favourite) {
            const manifest = readManifestLocked(lease, notebookId);
            manifest.notes[noteId].favourite = true;
            writeManifest(lease, manifest);
        }
        invalidateNotebookCache(lease, notebookId);
        return { ...result, restoredAs: noteId, sameIdentity: noteId === item.noteId };
    });
}

export function deleteTrashLocked(lease, { operationId, notebookId, trashId }) {
    return runOperationLocked(lease, { operationId, kind: 'delete-trash', args: { notebookId, trashId } }, () => {
        const trash = readTrash(lease, notebookId);
        const item = trash.entries.find(entry => entry.id === trashId);
        if (!item) throw new NotebookError('TRASH_NOT_FOUND', 'That item is no longer in Trash.', 404);
        trash.entries = trash.entries.filter(entry => entry.id !== trashId);
        writeTrash(lease, notebookId, trash);
        const manifest = readManifestLocked(lease, notebookId);
        const stillUsed = manifest.notes[item.noteId] || trash.entries.some(entry => entry.noteId === item.noteId);
        if (!stillUsed) {
            const root = rootOf(lease);
            const historyDir = path.dirname(blobFile(root, notebookId, item.noteId, 'x'));
            const bindings = readJsonLocked(lease, controlFile(root, notebookId, 'lore-bindings.json'), () => ({ bindings: [] }));
            const bound = (bindings.bindings ?? []).some(binding => binding.noteId === item.noteId);
            if (!bound) {
                fs.rmSync(historyDir, { recursive: true, force: true });
                deleteAuthoringFileLocked(lease, historyFile(root, notebookId, item.noteId));
            }
        }
        return { status: 'success', committed: true, trashId, permanentlyDeleted: true };
    });
}

export function listHistoryLocked(lease, { notebookId, noteId }) {
    readManifestLocked(lease, notebookId);
    requireNoteId(noteId);
    return readHistoryLocked(lease, notebookId, noteId).entries
        .map(({ id, at, revision, previous, actor, origin, reason, saves }) => ({ id, at, revision, previous, actor: { kind: actor?.kind ?? 'user' }, origin, reason, saves: saves ?? 1 }))
        .reverse();
}

/**
 * Restoring an earlier revision is a new change against the current one.
 * When the caller's view is stale the restore goes into a separate copy.
 */
export function restoreRevisionLocked(lease, { operationId, notebookId, noteId, historyId, expectedRevision, asCopy = false, actor = { kind: 'user' } }) {
    const args = { notebookId, noteId, historyId, expectedRevision, asCopy };
    return runOperationLocked(lease, { operationId, kind: 'restore-revision', args }, ({ setPlan }) => {
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const entry = requireNoteLocked(state, noteId);
        const history = readHistoryLocked(lease, notebookId, noteId);
        const item = history.entries.find(candidate => candidate.id === historyId);
        if (!item) throw new NotebookError('HISTORY_NOT_FOUND', 'That revision could not be found.', 404);
        const text = readBlobLocked(lease, notebookId, noteId, item.revision);
        if (asCopy) {
            const relative = uniquePath(entry.folder, `${entry.stem} (restored)`, '.md', takenPaths(state));
            const copyId = deterministicNoteId(operationId, 'copy');
            const result = commitNoteLocked(lease, state, {
                noteId: copyId, path: relative, bytes: Buffer.from(text, 'utf8'), actor, origin: actor.kind, reason: 'restore-copy', operationId, setPlan, create: true,
            });
            return { ...result, copyOf: noteId };
        }
        if (expectedRevision && expectedRevision !== entry.hash) {
            throw new NotebookError('NOTE_CONFLICT', 'This note changed since you opened its history. Restore it as a copy instead.', 409, { currentRevision: entry.hash });
        }
        return commitNoteLocked(lease, state, {
            noteId, path: entry.path, bytes: Buffer.from(text, 'utf8'), expectedRevision: entry.hash, actor, origin: actor.kind, reason: 'restore', operationId, setPlan,
        });
    });
}

export { foldKey, sha256, headingsOf, extractLinks };

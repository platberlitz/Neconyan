import path from 'node:path';
import { authoringEvidence, deleteAuthoringFileLocked, publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked } from '../authoring-store.js';
import { CANVAS_LIMITS, changeCanvasDocument, parseCanvasDocument, serializeCanvasDocument, validateCanvasDocument } from '../../public/scripts/notebooks/canvas-format.js';
import { accountRootOf, loadNotebookLocked, notebookContentRoot, notebookControlRoot, pendingOperationsLocked, readHistoryLocked,
    readJsonLocked, readManifestLocked, readOperationLocked, recordHistoryLocked, runOperationLocked, updateManifestLocked, writeJsonLocked } from './store.js';
import { NotebookError, foldKey, normaliseFolder, normaliseRelativePath, requireNotebookId, sha256, titleToFileStem, uniquePath } from './paths.js';

export const MAX_CANVASES = 200;
const at = () => new Date().toISOString();

export function requireCanvasId(value) {
    if (typeof value !== 'string' || !/^cv_[a-f\d]{16}$/.test(value)) throw new NotebookError('CANVAS_NOT_FOUND', 'That canvas could not be found.', 404);
    return value;
}

function metadataFile(lease, notebookId) {
    return path.join(notebookControlRoot(accountRootOf(lease), requireNotebookId(notebookId)), 'canvases.json');
}

function readMetadata(lease, notebookId) {
    readManifestLocked(lease, notebookId);
    const metadata = readJsonLocked(lease, metadataFile(lease, notebookId), () => ({ schema: 1, revision: 0, records: {} }));
    if (metadata.schema !== 1 || !metadata.records || typeof metadata.records !== 'object' || Array.isArray(metadata.records)) {
        throw new NotebookError('CANVAS_CONTROL_DAMAGED', 'The canvas list could not be read.', 500);
    }
    return metadata;
}

function writeMetadata(lease, notebookId, metadata) {
    metadata.revision = (Number.isSafeInteger(metadata.revision) ? metadata.revision : 0) + 1;
    writeJsonLocked(lease, metadataFile(lease, notebookId), metadata);
}

function contentFile(lease, notebookId, relative) {
    const checked = normaliseRelativePath(relative);
    if (!/\.canvas$/i.test(checked)) throw new NotebookError('CANVAS_PATH_INVALID', 'Choose a .canvas file inside this notebook.', 400);
    return path.join(notebookContentRoot(accountRootOf(lease), requireNotebookId(notebookId)), checked);
}

function summary(id, record) {
    return { id, path: record.path, title: path.posix.basename(record.path).replace(/\.canvas$/i, ''), revision: record.hash ?? null,
        createdAt: record.createdAt, updatedAt: record.updatedAt, deleted: Boolean(record.deleted) };
}

function journalFile(lease, notebookId, operationId) {
    return path.join(notebookControlRoot(accountRootOf(lease), notebookId), 'canvas-operations', `${sha256(operationId)}.json`);
}

function historyBytes(lease, notebookId, canvasId, revision) {
    requireCanvasId(canvasId);
    if (typeof revision !== 'string' || !/^[a-f\d]{64}$/.test(revision)) throw new NotebookError('CANVAS_HISTORY_NOT_FOUND', 'That canvas version could not be found.', 404);
    const filename = path.join(notebookControlRoot(accountRootOf(lease), notebookId), 'history', canvasId, `${revision}.md`);
    const file = readAuthoringFileLocked(lease, filename, CANVAS_LIMITS.bytes);
    if (!file || file.rawHash !== revision) throw new NotebookError('CANVAS_HISTORY_NOT_FOUND', 'That canvas version could not be found.', 404);
    return file.bytes;
}

function recordVersion(lease, notebookId, canvasId, bytes, { previous = null, actor = 'external', origin = 'external', reason = 'external-change', operationId, prepared } = {}) {
    return recordHistoryLocked(lease, notebookId, canvasId, { bytes, previous, actor, origin, reason, operationId, prepared });
}

function checkedJournal(lease, notebookId, operationId, kind, journal, plan = null) {
    const damaged = () => { throw new NotebookError('CANVAS_RECOVERY_DAMAGED', 'The saved canvas change could not be checked.', 409); };
    if (!journal || journal.schema !== 1 || journal.operationId !== operationId || journal.kind !== kind
        || !['canvas-create', 'canvas-update', 'canvas-observe'].includes(kind) || journal.args?.notebookId !== notebookId
        || !/^cv_[a-f\d]{16}$/.test(journal.canvasId ?? '') || typeof journal.record?.path !== 'string'
        || typeof journal.bytes !== 'string' || journal.bytes.length > Math.ceil(CANVAS_LIMITS.bytes / 3) * 4) damaged();
    const filename = contentFile(lease, notebookId, journal.record.path);
    const bytes = Buffer.from(journal.bytes, 'base64');
    if (bytes.toString('base64') !== journal.bytes || bytes.length > CANVAS_LIMITS.bytes || sha256(bytes) !== journal.revision) damaged();
    if (plan && (plan.type !== 'canvas-write' || plan.notebookId !== notebookId || plan.canvasId !== journal.canvasId
        || plan.path !== journal.record.path || plan.revision !== journal.revision)) damaged();
    if (journal.staged) {
        const relative = path.relative(accountRootOf(lease), filename);
        const temporary = journal.staged.temporary;
        if (journal.staged.relative !== relative || journal.staged.limit !== CANVAS_LIMITS.bytes
            || journal.staged.after?.rawHash !== journal.revision || (temporary !== null && temporary !== undefined
                && (path.dirname(temporary) !== path.dirname(relative) || !/^\.author-[0-9a-f-]+\.tmp$/i.test(path.basename(temporary))))) damaged();
    }
    return bytes;
}

function compactJournal(lease, notebookId, operationId) {
    const operation = readOperationLocked(lease, operationId);
    if (operation?.state !== 'done') return;
    const filename = journalFile(lease, notebookId, operationId);
    const journal = readJsonLocked(lease, filename, null);
    if (!journal || journal.completed) return;
    checkedJournal(lease, notebookId, operationId, operation.kind, journal, operation.plan);
    if (journal.staged?.temporary) {
        const temporary = path.join(accountRootOf(lease), journal.staged.temporary);
        try { deleteAuthoringFileLocked(lease, temporary, { expected: journal.staged.after, limit: CANVAS_LIMITS.bytes }); } catch (error) {
            if (error.status !== 409) throw error;
        }
    }
    writeJsonLocked(lease, filename, { schema: 1, completed: true, operationId, kind: journal.kind, canvasId: journal.canvasId,
        path: journal.record.path, revision: journal.revision, previous: journal.previous, result: operation.result });
}

function finishJournal(lease, notebookId, operationId, journal, { fault } = {}) {
    const filename = contentFile(lease, notebookId, journal.record.path);
    const bytes = checkedJournal(lease, notebookId, operationId, journal.kind, journal);
    if (journal.publish && !journal.published) {
        if (!journal.staged) {
            journal.staged = stageAuthoringFileLocked(lease, filename, bytes, { expected: journal.before, limit: CANVAS_LIMITS.bytes });
            writeJsonLocked(lease, journalFile(lease, notebookId, operationId), journal);
        }
        fault?.('staged', { canvasId: journal.canvasId });
        publishAuthoringFileLocked(lease, journal.staged);
        fault?.('renamed', { canvasId: journal.canvasId });
        journal.published = true;
        writeJsonLocked(lease, journalFile(lease, notebookId, operationId), journal);
        fault?.('published', { canvasId: journal.canvasId });
    }
    recordVersion(lease, notebookId, journal.canvasId, bytes, { previous: journal.previous, actor: journal.actor, origin: journal.origin,
        reason: journal.reason, operationId, prepared: journal.prepared });
    fault?.('history', { canvasId: journal.canvasId });
    const current = readAuthoringFileLocked(lease, filename, CANVAS_LIMITS.bytes);
    const metadata = readMetadata(lease, notebookId);
    const record = { ...metadata.records[journal.canvasId], ...journal.record, hash: journal.revision, deleted: !current };
    if (current && current.rawHash !== journal.revision) {
        // An external writer is not allowed to be overwritten during recovery.
        recordVersion(lease, notebookId, journal.canvasId, current.bytes, { previous: journal.revision,
            operationId: `canvas-external:${journal.canvasId}:${current.rawHash}`, reason: 'external-change' });
        record.hash = current.rawHash;
        record.updatedAt = at();
    }
    metadata.records[journal.canvasId] = record;
    writeMetadata(lease, notebookId, metadata);
    if (journal.publish) updateManifestLocked(lease, notebookId, () => {});
    fault?.('metadata', { canvasId: journal.canvasId });
    return { status: current?.rawHash === journal.revision ? 'success' : 'conflict', code: current?.rawHash === journal.revision ? undefined : 'CANVAS_CONFLICT',
        canvasId: journal.canvasId, path: record.path, revision: record.hash, savedRevision: journal.revision };
}

function runJournal(lease, notebookId, operationId, kind, args, makeJournal, options = {}) {
    const result = runOperationLocked(lease, { operationId, kind, args }, ({ setPlan, plan }) => {
        const filename = journalFile(lease, notebookId, operationId);
        let journal = readJsonLocked(lease, filename, null);
        if (!journal) {
            journal = makeJournal();
            if (journal.noChange) return journal.result;
            journal = { schema: 1, operationId, kind, args, ...journal };
            writeJsonLocked(lease, filename, journal);
        }
        checkedJournal(lease, notebookId, operationId, kind, journal, plan);
        setPlan({ type: 'canvas-write', notebookId, canvasId: journal.canvasId, path: journal.record.path, revision: journal.revision });
        options.fault?.('planned', { canvasId: journal.canvasId });
        return finishJournal(lease, notebookId, operationId, journal, options);
    });
    compactJournal(lease, notebookId, operationId);
    return result;
}

export function recoverCanvasOperationsLocked(lease, notebookId) {
    requireNotebookId(notebookId);
    const warnings = [];
    for (const pending of pendingOperationsLocked(lease)) {
        if (pending.plan?.type !== 'canvas-write' || pending.plan.notebookId !== notebookId) continue;
        const journal = readJsonLocked(lease, journalFile(lease, notebookId, pending.operationId), null);
        checkedJournal(lease, notebookId, pending.operationId, pending.kind, journal, pending.plan);
        try {
            runJournal(lease, notebookId, pending.operationId, pending.kind, journal.args, () => journal);
        } catch (error) {
            if (error.status !== 409) throw error;
            warnings.push({ operationId: pending.operationId, canvasId: journal.canvasId, path: journal.record.path, code: 'CANVAS_RECOVERY_CONFLICT',
                message: 'A canvas changed outside Neconyan while it was being saved. Its recovery copy is kept.' });
        }
    }
    return warnings;
}

export function canvasRecoveryReadLocked(lease, { notebookId, recoveryOperationId }) {
    requireNotebookId(notebookId);
    readManifestLocked(lease, notebookId);
    const operation = readOperationLocked(lease, recoveryOperationId);
    if (operation?.state !== 'pending' || operation.plan?.type !== 'canvas-write' || operation.plan.notebookId !== notebookId) {
        throw new NotebookError('CANVAS_RECOVERY_NOT_FOUND', 'That canvas recovery copy could not be found.', 404);
    }
    const journal = readJsonLocked(lease, journalFile(lease, notebookId, recoveryOperationId), null);
    const bytes = checkedJournal(lease, notebookId, recoveryOperationId, operation.kind, journal, operation.plan);
    const text = bytes.toString('utf8');
    return { status: 'success', recovery: { operationId: recoveryOperationId, canvasId: journal.canvasId, path: journal.record.path,
        revision: journal.revision, text, document: parseCanvasDocument(text) } };
}

export function decideCanvasRecoveryLocked(lease, { notebookId, operationId, recoveryOperationId, action, title, actor }) {
    if (!['save_copy', 'discard'].includes(action)) throw new NotebookError('CANVAS_RECOVERY_ACTION', 'Choose save a copy or discard this recovery copy.', 400);
    const args = { notebookId, recoveryOperationId, action, title: title ?? null };
    return runOperationLocked(lease, { operationId, kind: 'canvas-recovery-decision', args }, () => {
        const recovered = canvasRecoveryReadLocked(lease, { notebookId, recoveryOperationId }).recovery;
        const original = readOperationLocked(lease, recoveryOperationId);
        const journal = readJsonLocked(lease, journalFile(lease, notebookId, recoveryOperationId), null);
        const copy = action === 'save_copy' ? createCanvasLocked(lease, { notebookId,
            operationId: `canvas-recovery-copy:${sha256(operationId).slice(0, 32)}`, title: title ?? `${path.posix.basename(recovered.path, '.canvas')} (recovery)`,
            folder: path.posix.dirname(recovered.path) === '.' ? '' : path.posix.dirname(recovered.path), document: recovered.document, actor }) : null;
        runOperationLocked(lease, { operationId: recoveryOperationId, kind: original.kind, args: journal.args }, () => ({ status: 'cancelled',
            canvasId: recovered.canvasId, reason: action === 'save_copy' ? 'owner_saved_recovery_copy' : 'owner_discarded_recovery_copy', copyCanvasId: copy?.canvasId }));
        compactJournal(lease, notebookId, recoveryOperationId);
        return { status: 'success', canvasId: copy?.canvasId ?? recovered.canvasId, savedCopy: Boolean(copy), revision: copy?.revision };
    });
}

export function listCanvasesLocked(lease, notebookId) {
    requireNotebookId(notebookId);
    const warnings = recoverCanvasOperationsLocked(lease, notebookId);
    const state = loadNotebookLocked(lease, notebookId);
    const allFiles = state.attachments.filter(file => /\.canvas$/i.test(file.path)).sort((a, b) => foldKey(a.path).localeCompare(foldKey(b.path)));
    const files = allFiles.slice(0, MAX_CANVASES);
    const metadata = readMetadata(lease, notebookId);
    const existing = new Map(Object.entries(metadata.records).filter(([, record]) => !record.deleted).map(([id, record]) => [foldKey(record.path), { id, record }]));
    const paths = new Set(allFiles.map(file => foldKey(file.path)));
    const selectedPaths = new Set(files.map(file => foldKey(file.path)));
    const missing = Object.entries(metadata.records).filter(([, record]) => !record.deleted && !paths.has(foldKey(record.path)));
    const missingHashes = new Map();
    for (const item of missing) {
        if (!item[1].hash) continue;
        const matches = missingHashes.get(item[1].hash) ?? [];
        matches.push(item);
        missingHashes.set(item[1].hash, matches);
    }
    const newHashes = new Map();
    if (missingHashes.size) {
        for (const file of files) {
            if (existing.has(foldKey(file.path)) || file.size > CANVAS_LIMITS.bytes) continue;
            const source = readAuthoringFileLocked(lease, contentFile(lease, notebookId, file.path), CANVAS_LIMITS.bytes);
            if (!source) continue;
            const matches = newHashes.get(source.rawHash) ?? [];
            matches.push(file);
            newHashes.set(source.rawHash, matches);
        }
    }
    const movedPaths = new Map();
    for (const [hash, matches] of newHashes) {
        const previous = missingHashes.get(hash);
        if (matches.length === 1 && previous?.length === 1) movedPaths.set(foldKey(matches[0].path), previous[0]);
    }
    const movedIds = new Set([...movedPaths.values()].map(([id]) => id));
    let changed = false;
    for (const [id, record] of missing) {
        if (!movedIds.has(id)) { metadata.records[id] = { ...record, deleted: true, updatedAt: at() }; changed = true; }
    }
    for (const file of files) {
        const known = existing.get(foldKey(file.path));
        if (known) {
            if (known.record.path !== file.path) { known.record.path = file.path; changed = true; }
            continue;
        }
        const moved = movedPaths.get(foldKey(file.path));
        if (moved) {
            metadata.records[moved[0]] = { ...moved[1], path: file.path, deleted: false, updatedAt: at() };
            changed = true;
            continue;
        }
        const id = `cv_${sha256(`${accountRootOf(lease)}:${notebookId}:${file.path}:${file.ino}:${metadata.revision}`).slice(0, 16)}`;
        metadata.records[id] = { path: file.path, hash: null, createdAt: at(), updatedAt: at(), deleted: false };
        changed = true;
    }
    if (changed) {
        const stamp = sha256(JSON.stringify([metadata.revision, files.map(file => [file.path, file.ino, file.size, file.mtimeMs])]));
        runOperationLocked(lease, { operationId: `canvas-index:${notebookId}:${stamp}`, kind: 'canvas-index', args: { notebookId, stamp } }, () => {
            writeMetadata(lease, notebookId, metadata);
            return { status: 'success' };
        });
    }
    return { status: 'success', canvases: Object.entries(metadata.records).filter(([, record]) => !record.deleted && selectedPaths.has(foldKey(record.path))).map(([id, record]) => summary(id, record)),
        total: allFiles.length, limited: allFiles.length > files.length, warnings };
}

function rawCanvas(lease, notebookId, canvasId) {
    requireCanvasId(canvasId);
    listCanvasesLocked(lease, notebookId);
    const metadata = readMetadata(lease, notebookId);
    const record = metadata.records[canvasId];
    if (!record || record.deleted) throw new NotebookError('CANVAS_NOT_FOUND', 'That canvas could not be found.', 404);
    const file = readAuthoringFileLocked(lease, contentFile(lease, notebookId, record.path), CANVAS_LIMITS.bytes);
    if (!file) throw new NotebookError('CANVAS_NOT_FOUND', 'That canvas could not be found.', 404);
    if (record.hash !== file.rawHash) {
        const operationId = `canvas-observe:${notebookId}:${canvasId}:${file.rawHash}`;
        runJournal(lease, notebookId, operationId, 'canvas-observe', { notebookId, canvasId, path: record.path, revision: file.rawHash }, () => ({
            canvasId, record: { ...record, updatedAt: at() }, bytes: file.bytes.toString('base64'), revision: file.rawHash, previous: record.hash,
            actor: 'external', origin: 'external', reason: record.hash ? 'external-change' : 'external-create', publish: false,
            prepared: { id: `h_${sha256(operationId).slice(0, 16)}`, at: at() },
        }));
    }
    return { record: readMetadata(lease, notebookId).records[canvasId], file };
}

export function readCanvasLocked(lease, { notebookId, canvasId }) {
    const { record, file } = rawCanvas(lease, requireNotebookId(notebookId), canvasId);
    const text = file.bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(file.bytes)) throw new NotebookError('CANVAS_INVALID', 'This canvas is not a UTF-8 JSON file. Its original file is kept.', 400);
    return { status: 'success', canvas: { ...summary(canvasId, record), revision: file.rawHash, text, document: parseCanvasDocument(text) } };
}

function encodeDocument(document, original = '') {
    return Buffer.from(serializeCanvasDocument(document, original), 'utf8');
}

export function createCanvasLocked(lease, { notebookId, operationId, title = 'Untitled canvas', folder = '', document = { nodes: [], edges: [] }, actor }, options = {}) {
    requireNotebookId(notebookId);
    validateCanvasDocument(document);
    const args = { notebookId, title, folder, document };
    return runJournal(lease, notebookId, operationId, 'canvas-create', args, () => {
        const list = listCanvasesLocked(lease, notebookId);
        if (list.total >= MAX_CANVASES) throw new NotebookError('CANVAS_LIMIT', 'This notebook has reached its canvas limit.', 413);
        const state = loadNotebookLocked(lease, notebookId);
        const relative = uniquePath(normaliseFolder(folder), titleToFileStem(title), '.canvas', new Set([...state.attachments, ...state.entries].map(entry => foldKey(entry.path))));
        const bytes = encodeDocument(document);
        const canvasId = `cv_${sha256(`canvas:${accountRootOf(lease)}:${notebookId}:${operationId}`).slice(0, 16)}`;
        return { canvasId, record: { path: relative, createdAt: at(), updatedAt: at(), deleted: false }, bytes: bytes.toString('base64'),
            revision: sha256(bytes), previous: null, before: null, publish: true, actor, origin: 'user', reason: 'canvas-create',
            prepared: { id: `h_${sha256(operationId).slice(0, 16)}`, at: at() } };
    }, options);
}

export function updateCanvasLocked(lease, { notebookId, canvasId, operationId, expectedRevision, document, changes, actor, reason = 'canvas-edit' }, options = {}) {
    requireNotebookId(notebookId);
    requireCanvasId(canvasId);
    if (typeof expectedRevision !== 'string' || !/^[a-f\d]{64}$/.test(expectedRevision)) throw new NotebookError('CANVAS_REVISION_REQUIRED', 'Reload this canvas before saving it.', 409);
    const args = { notebookId, canvasId, expectedRevision, ...(document !== undefined ? { document } : { changes }), reason };
    return runJournal(lease, notebookId, operationId, 'canvas-update', args, () => {
        const { record, file } = rawCanvas(lease, notebookId, canvasId);
        if (file.rawHash !== expectedRevision) throw new NotebookError('CANVAS_CONFLICT', 'This canvas changed since you opened it. Nothing was overwritten.', 409);
        const current = parseCanvasDocument(file.bytes.toString('utf8'));
        const next = document !== undefined ? validateCanvasDocument(document) : changeCanvasDocument(current, changes);
        if (JSON.stringify(next) === JSON.stringify(current)) return { noChange: true, result: { status: 'no_change', canvasId, path: record.path, revision: file.rawHash } };
        const bytes = encodeDocument(next, file.bytes.toString('utf8'));
        if (bytes.equals(file.bytes)) return { noChange: true, result: { status: 'no_change', canvasId, path: record.path, revision: file.rawHash } };
        return { canvasId, record: { ...record, updatedAt: at(), deleted: false }, bytes: bytes.toString('base64'), revision: sha256(bytes), previous: file.rawHash,
            before: authoringEvidence(file), publish: true, actor, origin: 'user', reason,
            prepared: { id: `h_${sha256(operationId).slice(0, 16)}`, at: at() } };
    }, options);
}

export function canvasHistoryLocked(lease, { notebookId, canvasId }) {
    requireNotebookId(notebookId);
    requireCanvasId(canvasId);
    rawCanvas(lease, notebookId, canvasId);
    return { status: 'success', history: readHistoryLocked(lease, notebookId, canvasId).entries.slice().reverse() };
}

export function canvasHistoryReadLocked(lease, { notebookId, canvasId, historyId }) {
    requireNotebookId(notebookId);
    requireCanvasId(canvasId);
    readManifestLocked(lease, notebookId);
    const item = readHistoryLocked(lease, notebookId, canvasId).entries.find(entry => entry.id === historyId);
    if (!item) throw new NotebookError('CANVAS_HISTORY_NOT_FOUND', 'That canvas version could not be found.', 404);
    const bytes = historyBytes(lease, notebookId, canvasId, item.revision);
    const text = bytes.toString('utf8');
    return { status: 'success', history: item, text, document: parseCanvasDocument(text) };
}

import path from 'node:path';
import {
    deleteAuthoringFileLocked, publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked,
} from '../authoring-store.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { NotebookError, normaliseRelativePath, requireNotebookId, sha256 } from './paths.js';
import {
    accountRootOf, notebookControlRoot, pendingOperationsLocked, readJsonLocked, readManifestLocked, runOperationLocked, writeJsonLocked,
} from './store.js';

const MAX_EVENTS = 2000;
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
function historyRoot(lease, notebookId) {
    requireNotebookId(notebookId);
    return path.join(notebookControlRoot(accountRootOf(lease), notebookId), 'obsidian-history');
}
function indexFile(lease, notebookId) { return path.join(historyRoot(lease, notebookId), 'index.json'); }
function blobFile(lease, notebookId, hash) {
    if (!/^[a-f\d]{64}$/.test(hash ?? '')) throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'The private sync history needs attention.', 409);
    return path.join(historyRoot(lease, notebookId), 'blobs', `${hash}.bin`);
}
export function readObsidianHistoryIndexLocked(lease, notebookId) {
    readManifestLocked(lease, notebookId);
    const index = readJsonLocked(lease, indexFile(lease, notebookId), null);
    if (!index) return { schema: 1, revision: '', files: {}, events: [], blobs: {} };
    if (index.schema !== 1 || !index.files || !Array.isArray(index.events) || !index.blobs) throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'The private sync history needs attention.', 409);
    return index;
}

function finishRecord(lease, notebookId, args, plan) {
    if (plan?.type !== 'obsidian-file-history' || plan.notebookId !== notebookId || JSON.stringify(plan.args) !== JSON.stringify(args)) {
        throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'An interrupted sync history entry could not be verified.', 409);
    }
    const relative = normaliseRelativePath(args.path);
    if (relative !== args.path || (args.hash && !/^[a-f\d]{64}$/.test(args.hash))) throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'An interrupted sync history entry could not be verified.', 409);
    if (args.hash) {
        const file = blobFile(lease, notebookId, args.hash);
        const expected = path.relative(accountRootOf(lease), file);
        if (plan.staged?.relative !== expected || plan.staged?.after?.rawHash !== args.hash || plan.staged?.limit !== MAX_ATTACHMENT_BYTES) {
            throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'An interrupted sync history file could not be verified.', 409);
        }
        publishAuthoringFileLocked(lease, plan.staged);
    }
    const index = readObsidianHistoryIndexLocked(lease, notebookId);
    if (!index.events.some(event => event.id === plan.event.id)) {
        index.events.push(plan.event);
        index.events = index.events.slice(-MAX_EVENTS);
    }
    if (args.hash) {
        index.files[relative] = { hash: args.hash, size: args.size, stat: args.stat, deleted: false };
        index.blobs[args.hash] = args.size;
    } else if (index.files[relative]) index.files[relative].deleted = true;
    index.revision = sha256(`${index.revision}:${plan.event.id}`);
    writeJsonLocked(lease, indexFile(lease, notebookId), index);
    return { status: 'success', historyId: plan.event.id };
}

export function recoverObsidianHistoryLocked(lease, notebookId) {
    for (const entry of pendingOperationsLocked(lease)) {
        if (entry.plan?.type !== 'obsidian-file-history' || entry.plan.notebookId !== notebookId) continue;
        runOperationLocked(lease, { operationId: entry.operationId, kind: 'obsidian-file-history', args: entry.plan.args }, ({ plan }) => finishRecord(lease, notebookId, plan.args, plan));
    }
}

export function recordObsidianFileLocked(lease, notebookId, file, { origin = 'external', fault } = {}) {
    recoverObsidianHistoryLocked(lease, notebookId);
    const index = readObsidianHistoryIndexLocked(lease, notebookId);
    const relative = normaliseRelativePath(file.path);
    const previous = index.files[relative];
    if (file.hash && previous?.hash === file.hash && previous.deleted !== true) {
        if (file.stat && JSON.stringify(previous.stat) !== JSON.stringify(file.stat)) {
            const args = { notebookId, path: relative, hash: file.hash, stat: file.stat };
            const operationId = `obsidian-stat:${notebookId}:${sha256(JSON.stringify([index.revision, args])).slice(0, 32)}`;
            return runOperationLocked(lease, { operationId, kind: 'obsidian-history-stat', args }, () => {
                const current = readObsidianHistoryIndexLocked(lease, notebookId);
                if (current.files[relative]?.hash === file.hash && !current.files[relative].deleted) {
                    current.files[relative].stat = file.stat;
                    current.revision = sha256(`${current.revision}:${operationId}`);
                    writeJsonLocked(lease, indexFile(lease, notebookId), current);
                }
                return { status: 'no_change' };
            });
        }
        return { status: 'no_change' };
    }
    if (!file.hash && (!previous || previous.deleted)) return { status: 'no_change' };
    const bytes = file.hash ? Buffer.from(file.bytes ?? []) : null;
    if (bytes && (bytes.length > MAX_ATTACHMENT_BYTES || sha256(bytes) !== file.hash)) throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'A sync snapshot could not be verified.', 409);
    const operationId = `obsidian-history:${notebookId}:${sha256(`${index.revision}:${relative}:${file.hash ?? 'deleted'}`).slice(0, 32)}`;
    const args = { notebookId, path: relative, hash: file.hash ?? null, size: bytes?.length ?? 0, stat: file.stat ?? null, previous: previous?.hash ?? null };
    return runOperationLocked(lease, { operationId, kind: 'obsidian-file-history', args }, ({ setPlan, plan }) => {
        if (!plan) {
            if (bytes && !index.blobs[file.hash] && Object.values(index.blobs).reduce((sum, size) => sum + size, 0) + bytes.length > MAX_BLOB_BYTES) {
                throw new NotebookError('OBSIDIAN_HISTORY_LIMIT', 'The private sync history has reached its storage limit. Sync was paused; existing files were not changed.', 413);
            }
            const staged = bytes ? stageAuthoringFileLocked(lease, blobFile(lease, notebookId, file.hash), bytes, { limit: MAX_ATTACHMENT_BYTES }) : null;
            plan = { type: 'obsidian-file-history', notebookId, args, staged,
                event: { id: `oh_${sha256(operationId).slice(0, 16)}`, path: relative, previous: args.previous, revision: args.hash,
                    kind: !file.hash ? 'deleted' : previous ? 'changed' : 'created', origin, at: new Date().toISOString() } };
            setPlan(plan);
        }
        fault?.('planned');
        const result = finishRecord(lease, notebookId, args, plan);
        fault?.('recorded');
        return result;
    });
}

export function pruneObsidianHistoryLocked(lease, notebookId) {
    const index = readObsidianHistoryIndexLocked(lease, notebookId);
    const kept = new Set([...Object.values(index.files).map(file => file.hash), ...index.events.flatMap(event => [event.previous, event.revision])]);
    for (const operation of pendingOperationsLocked(lease)) if (operation.plan?.type === 'obsidian-file-history' && operation.plan.notebookId === notebookId) kept.add(operation.plan.args?.hash);
    let changed = false;
    for (const hash of Object.keys(index.blobs)) {
        if (kept.has(hash)) continue;
        deleteAuthoringFileLocked(lease, blobFile(lease, notebookId, hash), { limit: MAX_ATTACHMENT_BYTES });
        delete index.blobs[hash];
        changed = true;
    }
    if (changed) writeJsonLocked(lease, indexFile(lease, notebookId), index);
}

export function obsidianHistoryLocked(lease, { notebookId, limit = 100 } = {}) {
    recoverObsidianHistoryLocked(lease, notebookId);
    const index = readObsidianHistoryIndexLocked(lease, notebookId);
    return { status: 'success', history: index.events.slice(-Math.max(1, Math.min(100, Number(limit) || 100))).reverse(), total: index.events.length };
}

export function obsidianHistoryFileLocked(lease, { notebookId, historyId } = {}) {
    if (!/^oh_[a-f\d]{16}$/.test(historyId ?? '')) throw new NotebookError('OBSIDIAN_HISTORY_MISSING', 'That saved sync version was not found.', 404);
    const event = readObsidianHistoryIndexLocked(lease, notebookId).events.find(item => item.id === historyId);
    const hash = event?.revision ?? event?.previous;
    if (!event || !hash) throw new NotebookError('OBSIDIAN_HISTORY_MISSING', 'That saved sync version was not found.', 404);
    const file = readAuthoringFileLocked(lease, blobFile(lease, notebookId, hash), MAX_ATTACHMENT_BYTES);
    if (!file || file.rawHash !== hash) throw new NotebookError('OBSIDIAN_HISTORY_DAMAGED', 'That saved sync version could not be verified.', 409);
    return { bytes: file.bytes, path: event.path, revision: hash };
}

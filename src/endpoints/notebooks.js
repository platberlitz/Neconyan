import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { roleplayAccountBase, roleplayAccountStamp, withRoleplayAccount } from '../roleplay-store.js';
import { diffHunks } from '../../public/scripts/notebooks/line-diff.js';
import { NotebookError, normaliseFolder, requireNotebookId, sha256 } from '../notebooks/paths.js';
import { backlinksTo, outgoingLinks, resolveLink, searchEntries } from '../notebooks/note-index.js';
import { parseWikiTarget } from '../notebooks/markdown.js';
import { notifyNotebookChanged, subscribeNotebookChanges } from '../notebooks/events.js';
import * as store from '../notebooks/store.js';
import * as lore from '../notebooks/lore.js';
import * as attachments from '../notebooks/attachments.js';
import * as transfer from '../notebooks/transfer.js';
import * as assistant from '../notebooks/assistant.js';
import * as context from '../notebooks/context.js';
import { applyPolicyPatch, publicPolicy } from '../notebooks/permissions.js';

export const router = express.Router();

const STATUS_BY_HTTP = Object.freeze({ 400: 'failure', 403: 'denied', 404: 'not_found', 409: 'conflict', 410: 'not_found', 413: 'failure', 415: 'failure', 503: 'unavailable' });
const MAX_LIST = 500;
const ROUTE_RESULT = Symbol('notebookRouteResult');
const MAX_CAPTURE_CHARS = 200_000;

function accountError(message = 'The signed-in account changed. Reload Neconyan and try again.') {
    return new NotebookError('ACCOUNT_CHANGED', message, 409);
}

/**
 * Resolves the signed-in account and its protected store. The owner always
 * comes from the authenticated request, never from the body.
 */
function accountBase(request) {
    const handle = request.user?.profile?.handle;
    const base = roleplayAccountBase(request.user?.directories);
    if (!base) throw new NotebookError('NOTEBOOKS_UNAVAILABLE', 'Notes are not ready for this account yet.', 503);
    if (!handle || base.owner !== handle) throw accountError();
    const expected = request.get?.('X-Neconyan-Account');
    if (expected !== undefined && expected !== base.owner) throw accountError();
    return base;
}

function locked(base, operation) {
    return withRoleplayAccount(base, roleplayAccountStamp(base), operation);
}

function actorFor(base) {
    return { kind: 'user', handle: base.owner };
}

function sendError(response, error) {
    if (response.headersSent) return;
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500 && status !== 503) {
        console.warn('[notebooks] request failed', error?.code ?? error?.name ?? 'error');
    }
    const extra = {};
    for (const key of ['currentRevision', 'suggest', 'notes', 'preview', 'current', 'count']) {
        if (error?.[key] !== undefined) extra[key] = error[key];
    }
    response.status(status).json({
        status: STATUS_BY_HTTP[status] ?? 'failure',
        code: error?.code ?? 'NOTEBOOK_FAILED',
        message: status >= 500 && status !== 503 ? 'Notes could not finish that request.' : String(error?.message ?? 'Notes could not finish that request.'),
        ...extra,
    });
}

/**
 * Wraps a JSON route. The handler runs synchronously inside the account lock
 * and may wrap its payload with `changed()` so notifications go out after the
 * lock is released.
 */
function route(handler) {
    return (request, response) => {
        try {
            const base = accountBase(request);
            const body = request.body && typeof request.body === 'object' ? request.body : {};
            const result = locked(base, lease => handler({ request, body, lease, base, actor: actorFor(base), owner: base.owner }));
            const wrapped = result?.[ROUTE_RESULT] === true;
            const payload = wrapped ? result.payload : result;
            for (const change of wrapped ? result.changes : []) notifyNotebookChanged({ owner: base.owner, ...change });
            return response.json(payload);
        } catch (error) {
            return sendError(response, error);
        }
    };
}

function changed(payload, ...changes) {
    return { [ROUTE_RESULT]: true, payload, changes: changes.filter(Boolean) };
}

function noteChange(kind, result, notebookId) {
    if (!result || result.replayed || result.status === 'no_change') return null;
    return { kind, notebookId: result.notebookId ?? notebookId, noteId: result.noteId, revision: result.revision, operationId: result.operationId };
}

function intOf(value, fallback, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) return fallback;
    return Math.min(number, max);
}

function uploadedFile(request, limit) {
    const file = request.file;
    if (!file) throw new NotebookError('UPLOAD_MISSING', 'Choose a file first.', 400);
    const full = path.join(file.destination, file.filename);
    if (file.size > limit) {
        fs.rmSync(full, { force: true });
        throw new NotebookError('UPLOAD_TOO_LARGE', 'That file is too large.', 413);
    }
    try {
        return { name: String(file.originalname ?? 'file'), bytes: fs.readFileSync(full) };
    } finally {
        fs.rmSync(full, { force: true });
    }
}

function discardUpload(request) {
    if (request.file) fs.rmSync(path.join(request.file.destination, request.file.filename), { force: true });
}

/* ---------- notebooks ---------- */

router.post('/list', route(({ lease }) => {
    store.ensureDefaultNotebookLocked(lease);
    return { status: 'success', notebooks: store.listNotebooksLocked(lease) };
}));

router.post('/create', route(({ lease, body, actor }) => {
    const result = store.createNotebookLocked(lease, { operationId: body.operationId, name: body.name, actor });
    return changed(result, { kind: 'notebook', notebookId: result.notebook?.id });
}));

router.post('/rename', route(({ lease, body }) => {
    const result = store.renameNotebookLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, name: body.name });
    return changed(result, { kind: 'notebook', notebookId: body.notebookId });
}));

/**
 * The notebook overview: folders, recent notes, favourites and counts. Note
 * bodies are never included; folder contents come from /notes/list.
 */
router.post('/tree', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId);
    const policies = store.readPoliciesLocked(lease, notebookId);
    const counts = {};
    for (const entry of state.entries) counts[entry.folder] = (counts[entry.folder] ?? 0) + 1;
    const recent = [...state.entries].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, 20).map(store.noteSummary);
    const favourites = state.entries.filter(entry => entry.favourite).slice(0, 100).map(store.noteSummary);
    return {
        status: 'success',
        notebook: store.notebookSummary(lease, state.manifest),
        structureRevision: state.structureRevision,
        folders: state.folders.map(folder => ({ path: folder, count: counts[folder] ?? 0 })),
        rootCount: counts[''] ?? 0,
        noteCount: state.entries.length,
        recent,
        favourites,
        skipped: state.skipped.slice(0, 100),
        trashCount: store.listTrashLocked(lease, notebookId).length,
        policy: publicPolicy(policies),
        origin: state.manifest.origin,
    };
}));

router.post('/notes/list', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId);
    const folder = body.folder === undefined || body.folder === null ? null : normaliseFolder(body.folder);
    const offset = intOf(body.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = intOf(body.limit, 200, MAX_LIST) || 200;
    const list = state.entries
        .filter(entry => folder === null || entry.folder === folder)
        .sort((a, b) => a.path.localeCompare(b.path));
    return { status: 'success', total: list.length, offset, limit, notes: list.slice(offset, offset + limit).map(store.noteSummary) };
}));

/* ---------- notes ---------- */

router.post('/notes/read', route(({ lease, body }) => {
    const { state, entry } = store.readNoteLocked(lease, { notebookId: body.notebookId, noteId: body.noteId });
    return {
        status: 'success',
        notebookId: state.notebookId,
        note: store.noteDetail(entry),
        associations: state.manifest.associations?.[entry.id] ?? [],
        provenance: store.readProvenanceLocked(lease, state.notebookId, entry.id).slice(-10),
    };
}));

router.post('/notes/create', route(({ lease, body, actor }) => {
    const result = store.createNoteLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        folder: body.folder ?? 'Inbox',
        title: body.title ?? '',
        text: body.text ?? '',
        template: typeof body.template === 'string' ? body.template.slice(0, 64) : null,
        actor,
    });
    return changed(result, noteChange('note', result, body.notebookId));
}));

router.post('/notes/update', route(({ lease, body, actor }) => {
    const reason = ['autosave', 'edit', 'checkpoint'].includes(body.reason) ? body.reason : 'edit';
    const result = store.updateNoteLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        noteId: body.noteId,
        expectedRevision: body.expectedRevision,
        changes: body.changes,
        actor,
        reason,
    });
    let loreUpdates = [];
    if (result.committed && !result.replayed) {
        try {
            loreUpdates = lore.applyLiveUpdatesLocked(lease, { notebookId: body.notebookId, noteId: body.noteId, origin: 'user', operationId: body.operationId, actor });
        } catch (error) {
            loreUpdates = [{ status: 'failed', code: error?.code ?? 'LORE_FAILED' }];
        }
    }
    const loreChanged = loreUpdates.some(item => item.updated);
    return changed({ ...result, loreUpdates }, noteChange('note', result, body.notebookId), loreChanged ? { kind: 'lore', notebookId: body.notebookId, noteId: body.noteId } : null);
}));

router.post('/notes/move', route(({ lease, body, actor }) => {
    const result = store.moveNoteLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        noteId: body.noteId,
        title: body.title,
        folder: body.folder,
        expectedRevision: body.expectedRevision,
        updateLinks: body.updateLinks !== false,
        actor,
    });
    return changed(result, { kind: 'structure', notebookId: body.notebookId, noteId: body.noteId, revision: result.revision });
}));

router.post('/notes/favourite', route(({ lease, body }) => {
    const result = store.setFavouriteLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, noteId: body.noteId, favourite: body.favourite === true });
    return changed(result, { kind: 'structure', notebookId: body.notebookId, noteId: body.noteId });
}));

router.post('/notes/associations', route(({ lease, body }) => {
    const result = store.setAssociationsLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, noteId: body.noteId, associations: body.associations });
    return changed(result, { kind: 'structure', notebookId: body.notebookId, noteId: body.noteId });
}));

function quotePassage(text) {
    return text.split(/\r?\n/).map(line => (line ? `> ${line}` : '>')).join('\n');
}

function captureSource(body, text) {
    const source = body.source && typeof body.source === 'object' ? body.source : {};
    const clean = value => (typeof value === 'string' ? value.slice(0, 512) : undefined);
    return {
        kind: 'chat',
        chat: clean(source.chat),
        character: clean(source.character),
        speaker: clean(source.speaker),
        messageId: Number.isInteger(source.messageId) ? source.messageId : undefined,
        messageSendDate: clean(source.messageSendDate),
        swipe: Number.isInteger(source.swipe) ? source.swipe : undefined,
        messageHash: typeof source.messageHash === 'string' && /^[a-f0-9]{64}$/.test(source.messageHash) ? source.messageHash : undefined,
        textHash: sha256(text),
    };
}

/**
 * Saves a chat passage verbatim into a new note or the end of an existing one.
 * The chat locator stays in Neconyan's own provenance record, not in the note.
 */
router.post('/notes/capture', route(({ lease, body, actor }) => {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new NotebookError('CAPTURE_EMPTY', 'Select some text to save first.', 400);
    if (text.length > MAX_CAPTURE_CHARS) throw new NotebookError('CAPTURE_TOO_LARGE', 'That selection is too long to save in one go.', 413);
    const source = captureSource(body, text);
    const speaker = source.speaker ? `${source.speaker}, ` : '';
    const attribution = `*Saved from chat (${speaker}${new Date().toISOString().slice(0, 10)})*`;
    const passage = `${quotePassage(text)}\n\n${attribution}\n`;
    if (!body.noteId) {
        const result = store.createNoteLocked(lease, {
            operationId: body.operationId,
            notebookId: body.notebookId,
            folder: body.folder ?? 'Inbox',
            title: typeof body.title === 'string' && body.title.trim() ? body.title : `Saved from ${source.speaker || 'chat'}`,
            text: passage,
            origin: 'capture',
            reason: 'capture',
            actor,
            source,
        });
        return changed({ ...result, captured: true }, noteChange('note', result, body.notebookId));
    }
    const result = store.runOperationLocked(lease, { operationId: body.operationId, kind: 'capture-append', args: { notebookId: body.notebookId, noteId: body.noteId, text, source } }, () => {
        const update = store.updateNoteLocked(lease, {
            operationId: `${body.operationId}:append`,
            notebookId: body.notebookId,
            noteId: body.noteId,
            expectedRevision: body.expectedRevision,
            changes: [{ type: 'append', markdown: passage }],
            actor,
            origin: 'capture',
            reason: 'capture',
        });
        store.recordProvenanceLocked(lease, body.notebookId, body.noteId, { ...source, at: new Date().toISOString(), operationId: body.operationId });
        return { ...update, captured: true };
    });
    return changed(result, noteChange('note', result, body.notebookId));
}));

/* ---------- trash and history ---------- */

router.post('/notes/trash', route(({ lease, body, actor }) => {
    const result = store.trashNoteLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, noteId: body.noteId, actor });
    return changed(result, { kind: 'structure', notebookId: body.notebookId, noteId: body.noteId });
}));

router.post('/trash/list', route(({ lease, body }) => ({ status: 'success', trash: store.listTrashLocked(lease, requireNotebookId(body.notebookId)) })));

router.post('/trash/restore', route(({ lease, body, actor }) => {
    const result = store.restoreTrashLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, trashId: body.trashId, actor });
    return changed(result, { kind: 'structure', notebookId: body.notebookId, noteId: result.noteId });
}));

router.post('/trash/delete', route(({ lease, body }) => {
    if (body.confirm !== 'delete-permanently') {
        throw new NotebookError('CONFIRMATION_REQUIRED', 'Permanent deletion needs explicit confirmation.', 400);
    }
    const result = store.deleteTrashLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, trashId: body.trashId });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

router.post('/notes/history', route(({ lease, body }) => ({
    status: 'success',
    history: store.listHistoryLocked(lease, { notebookId: body.notebookId, noteId: body.noteId }),
})));

router.post('/notes/history/read', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const history = store.readHistoryLocked(lease, notebookId, body.noteId);
    const item = history.entries.find(entry => entry.id === body.historyId);
    if (!item) throw new NotebookError('HISTORY_NOT_FOUND', 'That saved version could not be found.', 404);
    const text = store.readBlobLocked(lease, notebookId, body.noteId, item.revision).toString('utf8');
    const state = store.loadNotebookLocked(lease, notebookId);
    const current = state.byId.get(body.noteId);
    const diff = current ? diffHunks(current.text, text, { full: body.full === true }) : null;
    return { status: 'success', historyId: item.id, revision: item.revision, at: item.at, text, currentRevision: current?.hash ?? null, diff };
}));

router.post('/notes/history/restore', route(({ lease, body, actor }) => {
    const result = store.restoreRevisionLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        noteId: body.noteId,
        historyId: body.historyId,
        expectedRevision: body.expectedRevision,
        asCopy: body.asCopy === true,
        actor,
    });
    return changed(result, noteChange('note', result, body.notebookId));
}));

/* ---------- search and links ---------- */

router.post('/search', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId);
    const property = body.property && typeof body.property.key === 'string' ? { key: body.property.key, value: body.property.value } : undefined;
    const result = searchEntries(state.entries, {
        query: typeof body.query === 'string' ? body.query.slice(0, 500) : '',
        folder: typeof body.folder === 'string' ? normaliseFolder(body.folder) : undefined,
        tag: typeof body.tag === 'string' ? body.tag : undefined,
        type: typeof body.type === 'string' ? body.type : undefined,
        property,
        offset: intOf(body.offset, 0, 100000),
        limit: intOf(body.limit, 30, 50) || 30,
    });
    return { status: 'success', ...result };
}));

router.post('/links', route(({ lease, body }) => {
    const { state, entry } = store.readNoteLocked(lease, { notebookId: body.notebookId, noteId: body.noteId });
    return {
        status: 'success',
        outgoing: outgoingLinks(state.entries, entry),
        backlinks: backlinksTo(state.entries, entry),
    };
}));

router.post('/resolve', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId);
    const from = typeof body.fromNoteId === 'string' ? state.byId.get(body.fromNoteId) : null;
    const raw = typeof body.target === 'string' ? body.target.slice(0, 1024) : '';
    const link = body.kind === 'markdown'
        ? { kind: 'markdown', target: raw, fragment: null }
        : { kind: 'wiki', ...parseWikiTarget(raw) };
    const resolved = resolveLink(state.entries, link, from?.path ?? '');
    return {
        status: 'success',
        resolution: resolved.status,
        fragment: link.fragment ?? null,
        note: resolved.entry ? store.noteSummary(resolved.entry) : null,
        candidates: (resolved.candidates ?? []).map(store.noteSummary),
        path: resolved.path ?? null,
    };
}));

router.post('/suggest', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId);
    const query = typeof body.query === 'string' ? body.query.trim().toLocaleLowerCase('und').slice(0, 200) : '';
    const scored = [];
    for (const entry of state.entries) {
        const names = [entry.title, entry.stem, ...entry.aliases].map(name => String(name).toLocaleLowerCase('und'));
        const rank = !query ? 3 : names.some(name => name === query) ? 0 : names.some(name => name.startsWith(query)) ? 1 : names.some(name => name.includes(query)) || entry.path.toLocaleLowerCase('und').includes(query) ? 2 : -1;
        if (rank >= 0) scored.push([rank, entry]);
        if (scored.length > 2000) break;
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title));
    return { status: 'success', notes: scored.slice(0, 20).map(([, entry]) => ({ ...store.noteSummary(entry), headings: entry.headings.slice(0, 50).map(h => ({ text: h.text, level: h.level, blockId: h.blockId })) })) };
}));

/* ---------- folders ---------- */

router.post('/folders/create', route(({ lease, body }) => {
    const result = store.createFolderLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, folder: body.folder });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

router.post('/folders/move', route(({ lease, body, actor }) => {
    const result = store.moveFolderLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, folder: body.folder, to: body.to, actor });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

router.post('/folders/delete', route(({ lease, body }) => {
    const result = store.deleteFolderLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, folder: body.folder });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

/* ---------- owner-only policy settings ---------- */

router.post('/policies/get', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    store.readManifestLocked(lease, notebookId);
    return { status: 'success', policy: publicPolicy(store.readPoliciesLocked(lease, notebookId)) };
}));

/**
 * Changes assistant access, context use and requested-edit mode. This is a
 * trusted owner action from the Notes UI; no assistant tool can reach it.
 * Changing the policy revision invalidates every waiting assistant proposal.
 */
router.post('/policies/update', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId);
    const current = store.readPoliciesLocked(lease, notebookId);
    if (body.expectedRevision && body.expectedRevision !== current.revision) {
        throw new NotebookError('POLICY_CONFLICT', 'These settings changed elsewhere. Reload them and try again.', 409);
    }
    const next = applyPolicyPatch(current, body.patch, { noteExists: id => state.byId.has(id) });
    store.writePoliciesLocked(lease, notebookId, next);
    context.invalidateContextCache(lease, notebookId);
    return changed({ status: 'success', committed: true, policy: publicPolicy(next) }, { kind: 'policy', notebookId });
}));

/* ---------- assistant: one-time grants, browser tool path, proposals ---------- */

router.post('/assistant/grants/create', route(({ lease, body }) => ({
    status: 'success',
    grant: assistant.createGrantLocked(lease, {
        notebookId: body.notebookId,
        noteId: body.noteId,
        folder: body.folder,
        scope: body.scope,
        selection: body.selection,
        operations: body.operations,
        minutes: body.minutes,
    }),
})));

router.post('/assistant/grants/revoke', route(({ lease, body }) => ({ status: 'success', revoked: assistant.revokeGrantLocked(lease, body.grantId) })));

router.post('/assistant/grants/list', route(({ lease }) => ({ status: 'success', grants: assistant.listGrantsLocked(lease) })));

function storedToolResult(item) {
    if (item.state === 'applied') return { ...item.result, proposalId: item.id, replayed: true };
    if (item.state === 'waiting') return { status: 'needs_approval', committed: false, proposalId: item.id, proposalHash: item.hash, summary: item.summary, message: 'Not saved yet. Waiting for your review.' };
    if (item.state === 'denied') return { status: 'denied', committed: false, proposalId: item.id, message: 'You declined this change. Nothing was saved.' };
    return { status: item.state === 'expired' ? 'cancelled' : 'conflict', committed: false, proposalId: item.id, message: 'This change is no longer valid. Read the note again before proposing a new change.' };
}

/**
 * The browser assistant path. Reads return permission-filtered data. Changes
 * become stored proposals that only the owner's review dialog can approve,
 * unless requested-edit mode is on for that notebook and operation.
 */
router.post('/assistant/tool', route(({ lease, body, actor }) => {
    const tool = String(body.tool ?? '');
    if (!assistant.isNoteTool(tool)) throw new NotebookError('ASSISTANT_TOOL_INVALID', 'That notes tool is not available.', 400);
    const callId = typeof body.callId === 'string' && body.callId.length <= 256 ? body.callId : null;
    if (!callId) throw new NotebookError('ASSISTANT_CALL_INVALID', 'The tool call needs an ID.', 400);
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    if (assistant.isNoteMutation(tool)) {
        const existing = assistant.proposalForCallLocked(lease, { callId, tool, args });
        if (existing) return storedToolResult(existing);
    }
    const captured = assistant.captureNoteToolLocked(lease, { tool, args });
    if (captured.response) return captured.response;
    if (captured.direct) {
        const result = assistant.applyDirectProposalLocked(lease, { proposal: captured.proposal, callId, request: { tool, args }, actor });
        return changed(result, noteChange('note', result, captured.proposal.notebookId));
    }
    const stored = assistant.storeProposalLocked(lease, { proposal: captured.proposal, callId, request: { tool, args } });
    return changed({
        status: 'needs_approval',
        committed: false,
        proposalId: stored.proposalId,
        proposalHash: stored.proposalHash,
        summary: assistant.proposalSummary(captured.proposal),
        message: 'Not saved yet. Waiting for your review.',
    }, { kind: 'proposal', notebookId: captured.proposal.notebookId });
}));

router.post('/assistant/proposals', route(({ lease, body }) => ({
    status: 'success',
    proposals: assistant.listProposalsLocked(lease, {
        notebookId: typeof body.notebookId === 'string' ? body.notebookId : undefined,
        state: ['waiting', 'applied', 'denied', 'failed', 'expired', 'all'].includes(body.state) ? body.state : 'waiting',
    }),
})));

router.post('/assistant/proposal', route(({ lease, body }) => {
    const item = assistant.readProposalLocked(lease, body.proposalId);
    const proposal = item.proposal;
    return {
        status: 'success',
        proposalId: item.id,
        proposalHash: item.hash,
        state: item.state,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        summary: assistant.proposalSummary(proposal),
        before: proposal.before ?? '',
        after: proposal.after ?? '',
        diff: diffHunks(proposal.before ?? '', proposal.after ?? '', { full: body.full === true }),
        result: item.result ?? null,
    };
}));

router.post('/assistant/decide', route(({ lease, body, actor }) => {
    const result = assistant.decideProposalLocked(lease, {
        proposalId: body.proposalId,
        proposalHash: body.proposalHash,
        decision: body.decision,
        actor,
    });
    return changed(result, noteChange('note', result), { kind: 'proposal', notebookId: result.notebookId });
}));

/* ---------- lore ---------- */

router.post('/lore/books', route(({ lease }) => ({ status: 'success', books: lore.listLorebooksLocked(lease) })));

router.post('/lore/entries', route(({ lease, body }) => ({ status: 'success', ...lore.listLoreEntriesLocked(lease, body.book) })));

router.post('/lore/bindings', route(({ lease, body }) => ({
    status: 'success',
    bindings: lore.listBindingsLocked(lease, requireNotebookId(body.notebookId), { noteId: typeof body.noteId === 'string' ? body.noteId : undefined }),
})));

router.post('/lore/preview', route(({ lease, body }) => ({
    status: 'success',
    preview: lore.previewPublicationLocked(lease, {
        notebookId: body.notebookId,
        noteId: body.noteId,
        selector: body.selector,
        book: body.book,
        uid: body.uid,
        title: body.title,
    }),
})));

function loreChange(result, notebookId, noteId) {
    if (!result || result.replayed || result.status === 'no_change') return null;
    return { kind: 'lore', notebookId, noteId, book: result.book, operationId: result.operationId };
}

router.post('/lore/publish', route(({ lease, body, actor }) => {
    const result = lore.publishToLoreLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        noteId: body.noteId,
        selector: body.selector,
        book: body.book,
        uid: body.uid,
        title: body.title,
        expectedSourceHash: body.expectedSourceHash,
        expectedTargetHash: body.expectedTargetHash,
        actor,
        origin: 'user',
    });
    context.invalidateContextCache(lease, body.notebookId);
    return changed(result, loreChange(result, body.notebookId, body.noteId));
}));

router.post('/lore/policy', route(({ lease, body }) => {
    const result = lore.setBindingPolicyLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, bindingId: body.bindingId, policy: body.policy, liveOrigins: body.liveOrigins });
    return changed(result, { kind: 'lore', notebookId: body.notebookId });
}));

router.post('/lore/detach', route(({ lease, body }) => {
    const result = lore.detachBindingLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, bindingId: body.bindingId });
    context.invalidateContextCache(lease, body.notebookId);
    return changed(result, { kind: 'lore', notebookId: body.notebookId });
}));

router.post('/lore/pull', route(({ lease, body, actor }) => {
    const result = lore.pullLoreIntoNoteLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        bindingId: body.bindingId,
        expectedRevision: body.expectedRevision,
        expectedLoreHash: body.expectedLoreHash,
        actor,
    });
    return changed(result, noteChange('note', result, body.notebookId), { kind: 'lore', notebookId: body.notebookId });
}));

router.post('/lore/repair', route(({ lease, body }) => {
    const result = lore.repairBindingLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, bindingId: body.bindingId, selector: body.selector });
    return changed(result, { kind: 'lore', notebookId: body.notebookId });
}));

router.post('/lore/page/read', route(({ lease, body }) => ({ status: 'success', page: lore.readLoreEntryPageLocked(lease, { book: body.book, uid: body.uid }) })));

router.post('/lore/page/save', route(({ lease, body }) => {
    const result = lore.saveLoreEntryPageLocked(lease, {
        operationId: body.operationId,
        book: body.book,
        uid: body.uid,
        expectedEntryHash: body.expectedEntryHash,
        content: body.content,
        comment: body.comment,
    });
    return changed(result, loreChange({ ...result, book: body.book }, null, null));
}));

/**
 * Exports a live lore entry into a new ordinary note. The copy is independent:
 * editing it later never changes the lorebook unless the owner publishes it.
 */
router.post('/lore/page/copy', route(({ lease, body, actor }) => {
    const page = lore.readLoreEntryPageLocked(lease, { book: body.book, uid: body.uid });
    const result = store.createNoteLocked(lease, {
        operationId: body.operationId,
        notebookId: body.notebookId,
        folder: body.folder ?? 'Inbox',
        title: page.title || `Entry ${page.uid}`,
        text: lore.exportLoreEntryMarkdown(page),
        origin: 'lore-copy',
        reason: 'lore-copy',
        actor,
    });
    return changed(result, noteChange('note', result, body.notebookId));
}));

/* ---------- attachments ---------- */

router.post('/attachments/upload', (request, response) => {
    try {
        const base = accountBase(request);
        const { name, bytes } = uploadedFile(request, attachments.MAX_ATTACHMENT_BYTES);
        const body = request.body ?? {};
        const result = locked(base, lease => attachments.saveAttachmentLocked(lease, {
            operationId: body.operationId,
            notebookId: body.notebookId,
            name: typeof body.name === 'string' && body.name ? body.name : name,
            bytes,
            folder: body.folder || store.ATTACHMENT_FOLDER,
        }));
        if (!result.replayed) notifyNotebookChanged({ owner: base.owner, kind: 'structure', notebookId: body.notebookId });
        return response.json(result);
    } catch (error) {
        discardUpload(request);
        return sendError(response, error);
    }
});

/**
 * Serves attachment bytes to the signed-in owner only. Images that passed the
 * signature check render inline; everything else, SVG included, downloads.
 */
router.get('/attachments/file', (request, response) => {
    try {
        const base = accountBase(request);
        const file = locked(base, lease => attachments.readAttachmentLocked(lease, { notebookId: String(request.query.notebookId ?? ''), path: String(request.query.path ?? '') }));
        response.set({
            'Content-Type': file.inline ? file.mime : 'application/octet-stream',
            'Content-Length': String(file.bytes.length),
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'default-src \'none\'; sandbox',
            'Cache-Control': 'private, no-store',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Content-Disposition': `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file.path))}`,
        });
        return response.end(file.bytes);
    } catch (error) {
        return sendError(response, error);
    }
});

router.post('/attachments/list', route(({ lease, body }) => ({ status: 'success', attachments: attachments.listAttachmentsLocked(lease, requireNotebookId(body.notebookId)) })));

router.post('/attachments/trash', route(({ lease, body }) => {
    const result = attachments.trashAttachmentLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, path: body.path });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

router.post('/attachments/trash/list', route(({ lease, body }) => ({ status: 'success', trash: attachments.listAttachmentTrashLocked(lease, requireNotebookId(body.notebookId)) })));

router.post('/attachments/restore', route(({ lease, body }) => {
    const result = attachments.restoreAttachmentLocked(lease, { operationId: body.operationId, notebookId: body.notebookId, trashId: body.trashId });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

/* ---------- import and export ---------- */

router.post('/export', (request, response) => {
    try {
        const base = accountBase(request);
        const collected = locked(base, lease => transfer.collectExportLocked(lease, { notebookId: request.body?.notebookId }));
        const zip = transfer.buildExportZip(collected);
        response.set({
            'Content-Type': 'application/zip',
            'Content-Length': String(zip.length),
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(transfer.exportFilename(collected.name))}`,
        });
        return response.end(zip);
    } catch (error) {
        return sendError(response, error);
    }
});

/**
 * Validates an uploaded ZIP or Markdown file outside the account lock and
 * returns a summary. Nothing is written until /import/commit or /import/update.
 */
router.post('/import/stage', (request, response) => {
    try {
        const base = accountBase(request);
        const { name, bytes } = uploadedFile(request, transfer.MAX_IMPORT_ARCHIVE_BYTES);
        const summary = transfer.stageImport(base.owner, { filename: name, bytes });
        return response.json({ status: 'success', stage: summary });
    } catch (error) {
        discardUpload(request);
        return sendError(response, error);
    }
});

router.post('/import/compare', route(({ lease, body }) => ({ status: 'success', stage: transfer.compareStageLocked(lease, { stageId: body.stageId, notebookId: body.notebookId }) })));

router.post('/import/commit', route(({ lease, body, actor }) => {
    const result = transfer.commitImportLocked(lease, { operationId: body.operationId, stageId: body.stageId, name: body.name, actor });
    return changed(result, { kind: 'notebook', notebookId: result.notebook?.id });
}));

router.post('/import/update', route(({ lease, body, actor }) => {
    const result = transfer.commitStageUpdateLocked(lease, { operationId: body.operationId, stageId: body.stageId, notebookId: body.notebookId, paths: body.paths, actor });
    return changed(result, { kind: 'structure', notebookId: body.notebookId });
}));

router.post('/import/cancel', route(({ owner, body }) => ({ status: 'success', cancelled: transfer.cancelStage(owner, body.stageId) })));

/* ---------- context (scoped reference and pinned notes) ---------- */

router.post('/context/preview', route(({ lease, body }) => ({ status: 'success', ...context.collectNoteContextLocked(lease, { scope: body.scope, budgetTokens: body.budgetTokens, query: body.query }) })));

router.post('/context/inspect', route(({ lease, body }) => ({ status: 'success', records: context.readContextRecordsLocked(lease, { chat: body.chat, limit: body.limit }) })));

/* ---------- diagnostics ---------- */

router.post('/diagnostics', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    const state = store.loadNotebookLocked(lease, notebookId, { force: true });
    const bindings = lore.listBindingsLocked(lease, notebookId, {});
    return {
        status: 'success',
        noteCount: state.entries.length,
        attachmentCount: state.attachments.length,
        skipped: state.skipped,
        unresolvedBindings: bindings.filter(binding => !['in_sync', 'draft_changed', 'unpublished'].includes(binding.status)).map(binding => ({ id: binding.id, noteId: binding.noteId, status: binding.status, reason: binding.reason ?? null, book: binding.book, uid: binding.uid })),
        failedProposals: assistant.listProposalsLocked(lease, { notebookId, state: 'failed' }).map(item => ({ id: item.id, summary: item.summary, createdAt: item.createdAt })),
        waitingProposals: assistant.listProposalsLocked(lease, { notebookId, state: 'waiting' }).length,
    };
}));

router.post('/reindex', route(({ lease, body }) => {
    const notebookId = requireNotebookId(body.notebookId);
    store.invalidateNotebookCache(lease, notebookId);
    const state = store.loadNotebookLocked(lease, notebookId, { force: true });
    context.invalidateContextCache(lease, notebookId);
    return changed({ status: 'success', noteCount: state.entries.length, skipped: state.skipped.length }, { kind: 'structure', notebookId });
}));

/* ---------- change notifications ---------- */

/**
 * Server-sent events carrying only safe identifiers and revisions, never note
 * text. Each stream is bound to the account that opened it.
 */
router.get('/events', (request, response) => {
    let owner;
    try {
        owner = accountBase(request).owner;
    } catch (error) {
        return sendError(response, error);
    }
    response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const send = text => {
        if (response.destroyed || response.writableEnded) return;
        if (response.writableLength > 64 * 1024) { response.end(); return; }
        response.write(text);
        response.flush?.();
    };
    const unsubscribe = subscribeNotebookChanges(change => {
        if (change.owner !== owner) return;
        const safe = { ...change };
        delete safe.owner;
        send(`data: ${JSON.stringify(safe)}\n\n`);
    });
    const keepalive = setInterval(() => send(': keepalive\n\n'), 15000);
    response.once('close', () => { clearInterval(keepalive); unsubscribe(); });
    send(': ready\n\n');
});

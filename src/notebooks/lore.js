import fs from 'node:fs';
import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { assertNativeMediaTargetIdle } from '../generation/media-receipts.js';
import { appendWorldInfoCommit, newWorldInfoHistory, readWorldInfoHistory, worldInfoRevision, writeWorldInfoHistory } from '../world-info-history.js';
import { lorebookEntryTitle, syncLorebookOriginalEntry } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { newWorldInfoEntryTemplate } from '../../public/scripts/world-info-entry.js';
import { headingsOf, noteBody, resolveSection, sectionBody, splitFrontmatter } from './markdown.js';
import { NotebookError, sha256 } from './paths.js';
import {
    listNotebookIdsLocked, loadNotebookLocked, notebookControlRoot, readJsonLocked, requireNoteLocked,
    runOperationLocked, updateNoteLocked, writeJsonLocked, sectionHash,
} from './store.js';

export const BINDING_SCHEMA = 1;
export const LORE_STATES = Object.freeze([
    'unpublished', 'in_sync', 'draft_changed', 'lore_changed', 'conflict',
    'source_missing', 'selector_unresolved', 'target_missing', 'failed',
]);
export const LIVE_ORIGINS = Object.freeze(['user']);
const MAX_BINDING_HISTORY = 50;
const MAX_LORE_TEXT = 512 * 1024;
const BOOK_LIMIT = 32 * 1024 * 1024;

const now = () => new Date().toISOString();

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

function worldsOf(lease) {
    const directories = roleplayLease(lease).scope.directories;
    return directories.worlds || path.join(directories.root, 'worlds');
}

function bindingsFile(lease, notebookId) {
    return path.join(notebookControlRoot(rootOf(lease), notebookId), 'lore-bindings.json');
}

export function readBindingsLocked(lease, notebookId) {
    const value = readJsonLocked(lease, bindingsFile(lease, notebookId), () => ({ schema: BINDING_SCHEMA, revision: null, bindings: {} }));
    if (value.schema > BINDING_SCHEMA) throw new NotebookError('NOTEBOOK_SCHEMA_UNSUPPORTED', 'These lore links were saved by a newer version of Neconyan.', 409);
    value.bindings ||= {};
    return value;
}

function writeBindingsLocked(lease, notebookId, value) {
    value.schema = BINDING_SCHEMA;
    value.revision = sha256(JSON.stringify(value.bindings));
    writeJsonLocked(lease, bindingsFile(lease, notebookId), value);
    return value.revision;
}

/* ---------- lorebook access ---------- */

export function bookFilename(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/\0]/.test(name) || name.startsWith('.')) {
        throw new NotebookError('LOREBOOK_INVALID', 'That lorebook name is not valid.', 400);
    }
    return name.endsWith('.json') ? name : `${name}.json`;
}

export function readBookLocked(lease, book) {
    const filename = bookFilename(book);
    const full = path.join(worldsOf(lease), filename);
    const file = readAuthoringFileLocked(lease, full, BOOK_LIMIT);
    if (!file) return null;
    let data;
    try {
        data = JSON.parse(file.bytes.toString('utf8'));
    } catch {
        throw new NotebookError('LOREBOOK_DAMAGED', 'That lorebook could not be read.', 409);
    }
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        throw new NotebookError('LOREBOOK_DAMAGED', 'That lorebook could not be read.', 409);
    }
    return { filename, name: filename.replace(/\.json$/, ''), full, file, data, revision: worldInfoRevision(data) };
}

function requireBookLocked(lease, book) {
    const value = readBookLocked(lease, book);
    if (!value) throw new NotebookError('LOREBOOK_NOT_FOUND', 'That lorebook could not be found.', 404);
    return value;
}

function entryOf(book, uid) {
    if (uid === null || uid === undefined) return null;
    const entry = book.data.entries[String(uid)];
    return entry && typeof entry === 'object' ? entry : null;
}

export function entryHash(entry) {
    return sha256(JSON.stringify(entry ?? null));
}

export function contentHash(text) {
    return sha256(String(text ?? ''));
}

function freeUid(book) {
    let max = -1;
    for (const key of Object.keys(book.data.entries)) {
        const value = Number(key);
        if (Number.isSafeInteger(value) && value > max) max = value;
    }
    return max + 1;
}

function writeBookLocked(lease, book, data, message) {
    assertNativeMediaTargetIdle(lease, { kind: 'lorebook', id: book.filename });
    const before = book.data;
    writeAuthoringFileLocked(lease, book.full, JSON.stringify(data, null, 4), {
        expected: { rawHash: book.file.rawHash, physical: book.file.physical },
        limit: BOOK_LIMIT,
    });
    try {
        let history = readWorldInfoHistory(book.full, lease);
        if (!history) history = appendWorldInfoCommit(newWorldInfoHistory(), before, 'Before notebook change');
        writeWorldInfoHistory(book.full, appendWorldInfoCommit(history, data, message), lease);
    } catch {
        /* Lorebook history is advisory; the entry itself is already saved. */
    }
    return worldInfoRevision(data);
}

export function listLorebooksLocked(lease) {
    const directory = worldsOf(lease);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(item => item.isFile() && item.name.endsWith('.json') && !item.name.startsWith('.'))
        .map(item => item.name.replace(/\.json$/, ''))
        .sort((a, b) => a.localeCompare(b));
}

export function listLoreEntriesLocked(lease, book) {
    const value = requireBookLocked(lease, book);
    return {
        book: value.name,
        revision: value.revision,
        entries: Object.entries(value.data.entries).map(([uid, entry]) => ({
            uid: Number(uid),
            title: lorebookEntryTitle(entry),
            keys: Array.isArray(entry.key) ? entry.key.slice(0, 20) : [],
            disabled: entry.disable === true,
            size: String(entry.content ?? '').length,
        })),
    };
}

/* ---------- selectors ---------- */

export function normaliseSelector(selector) {
    if (!selector || selector.kind === 'note') return { kind: 'note' };
    if (selector.kind === 'heading' && Array.isArray(selector.path) && selector.path.length > 0 && selector.path.length <= 8
        && selector.path.every(part => typeof part === 'string' && part.trim() && part.length <= 300)) {
        return { kind: 'heading', path: selector.path.map(part => part.trim()) };
    }
    if (selector.kind === 'block' && typeof selector.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(selector.id)) {
        return { kind: 'block', id: selector.id };
    }
    throw new NotebookError('LORE_SELECTOR_INVALID', 'Choose the whole note or one heading to use as lore.', 400);
}

function selectorKey(selector) {
    return selector.kind === 'note' ? 'note' : selector.kind === 'block' ? `block:${selector.id}` : `heading:${selector.path.join('\u0001')}`;
}

export function selectorLabel(selector) {
    if (selector.kind === 'note') return 'Whole note';
    if (selector.kind === 'block') return `Block ^${selector.id}`;
    return selector.path.join(' > ');
}

function childHeadings(text, heading) {
    return headingsOf(text)
        .filter(item => item.start > heading.start && item.start < heading.end)
        .map(item => item.path.join('\u0001'));
}

/**
 * Resolves the exact source text for a selector. Never falls back to the
 * whole note or a neighbouring section.
 */
export function resolveLoreSource(text, selector) {
    if (selector.kind === 'note') {
        return { status: 'ok', text: noteBody(text), children: [] };
    }
    const resolved = resolveSection(text, selector);
    if (resolved.status !== 'ok') return { status: resolved.status === 'ambiguous' ? 'ambiguous' : 'missing' };
    return { status: 'ok', text: sectionBody(text, resolved.heading), heading: resolved.heading, children: childHeadings(text, resolved.heading) };
}

/* ---------- state ---------- */

function sourceState(lease, notebookId, binding) {
    let state;
    try {
        state = loadNotebookLocked(lease, notebookId);
    } catch {
        return { status: 'source_missing' };
    }
    const entry = state.byId.get(binding.noteId);
    if (!entry) return { status: 'source_missing' };
    const source = resolveLoreSource(entry.text, binding.selector);
    if (source.status !== 'ok') return { status: 'selector_unresolved', reason: source.status, entry };
    const known = new Set(binding.publishedChildren ?? []);
    if (binding.publishedChildren && source.children.some(child => !known.has(child))) {
        return { status: 'selector_unresolved', reason: 'broadened', entry, text: source.text };
    }
    return { status: 'ok', text: source.text, entry };
}

function targetState(lease, binding) {
    let book;
    try {
        book = readBookLocked(lease, binding.book);
    } catch (error) {
        return { status: 'target_missing', reason: error.code || 'unreadable' };
    }
    if (!book) return { status: 'target_missing', reason: 'book' };
    const entry = entryOf(book, binding.uid);
    if (!entry) return { status: 'target_missing', reason: 'entry', book };
    return { status: 'ok', book, entry, text: String(entry.content ?? '') };
}

/** Pure state machine over source and target evidence. */
export function deriveLoreStatus({ published, source, target }) {
    if (!published) return 'unpublished';
    if (target.status !== 'ok') return 'target_missing';
    if (source.status === 'source_missing') return 'source_missing';
    if (source.status !== 'ok') return 'selector_unresolved';
    const draftChanged = contentHash(source.text) !== published.sourceHash;
    const loreChanged = contentHash(target.text) !== published.targetHash;
    if (draftChanged && loreChanged) return contentHash(source.text) === contentHash(target.text) ? 'in_sync' : 'conflict';
    if (draftChanged) return 'draft_changed';
    if (loreChanged) return 'lore_changed';
    return 'in_sync';
}

function finishPending(lease, notebookId, value, binding) {
    if (!binding.pending) return false;
    const target = targetState(lease, { ...binding, uid: binding.pending.uid });
    if (target.status === 'ok' && contentHash(target.text) === binding.pending.targetHash) {
        Object.assign(binding, {
            uid: binding.pending.uid,
            published: {
                sourceHash: binding.pending.sourceHash,
                targetHash: binding.pending.targetHash,
                sourceText: binding.pending.sourceText,
                targetText: binding.pending.targetText,
                at: binding.pending.at,
                noteRevision: binding.pending.noteRevision,
                operationId: binding.pending.operationId,
            },
            publishedChildren: binding.pending.children,
            lastError: null,
        });
        pushBindingHistory(binding, { action: 'publish', operationId: binding.pending.operationId, actor: binding.pending.actor, recovered: true });
    } else {
        binding.lastError = { code: 'LORE_PUBLISH_INTERRUPTED', at: now(), operationId: binding.pending.operationId };
    }
    delete binding.pending;
    writeBindingsLocked(lease, notebookId, value);
    return true;
}

function pushBindingHistory(binding, record) {
    binding.history = [...(binding.history ?? []), { at: now(), ...record }].slice(-MAX_BINDING_HISTORY);
}

export function describeBindingLocked(lease, notebookId, binding) {
    const source = sourceState(lease, notebookId, binding);
    const target = targetState(lease, binding);
    let status = deriveLoreStatus({ published: binding.published, source, target });
    if (binding.lastError) status = 'failed';
    const enabled = target.status === 'ok' ? target.entry.disable !== true : null;
    return {
        id: binding.id,
        noteId: binding.noteId,
        selector: binding.selector,
        selectorLabel: selectorLabel(binding.selector),
        book: binding.book.replace(/\.json$/, ''),
        uid: binding.uid,
        entryTitle: target.status === 'ok' ? lorebookEntryTitle(target.entry) : binding.entryTitle ?? null,
        policy: binding.policy,
        liveOrigins: binding.liveOrigins ?? [],
        status,
        reason: source.reason ?? target.reason ?? null,
        published: Boolean(binding.published),
        enabled,
        publishedAt: binding.published?.at ?? null,
        lastError: binding.lastError ?? null,
        sourceText: source.status === 'ok' || source.text ? source.text ?? null : null,
        sourceHash: source.text !== undefined ? contentHash(source.text) : null,
        publishedSourceText: binding.published?.sourceText ?? null,
        publishedTargetText: binding.published?.targetText ?? null,
        loreText: target.status === 'ok' ? target.text : null,
        loreHash: target.status === 'ok' ? contentHash(target.text) : null,
        noteRevision: source.entry?.hash ?? null,
        history: (binding.history ?? []).slice(-10),
    };
}

export function listBindingsLocked(lease, notebookId, { noteId = null } = {}) {
    const value = readBindingsLocked(lease, notebookId);
    for (const binding of Object.values(value.bindings)) {
        if (binding.pending) finishPending(lease, notebookId, value, binding);
    }
    return Object.values(value.bindings)
        .filter(binding => !noteId || binding.noteId === noteId)
        .map(binding => describeBindingLocked(lease, notebookId, binding));
}

function requireBinding(value, bindingId) {
    const binding = value.bindings[bindingId];
    if (!binding) throw new NotebookError('LORE_BINDING_NOT_FOUND', 'That lore link could not be found.', 404);
    return binding;
}

function targetTakenElsewhere(lease, notebookId, bindingId, book, uid) {
    if (uid === null || uid === undefined) return false;
    for (const id of listNotebookIdsLocked(lease)) {
        const value = readBindingsLocked(lease, id);
        for (const binding of Object.values(value.bindings)) {
            if (binding.id === bindingId && id === notebookId) continue;
            if (binding.book === book && String(binding.uid) === String(uid)) return true;
        }
    }
    return false;
}

function bindingIdFor(notebookId, noteId, selector, book) {
    return `lb_${sha256(`${notebookId}:${noteId}:${selectorKey(selector)}:${book}`).slice(0, 16)}`;
}

/* ---------- preview and publication ---------- */

export function previewPublicationLocked(lease, { notebookId, noteId, selector, book, uid = null, title = null }) {
    const normalised = normaliseSelector(selector);
    const filename = bookFilename(book);
    const state = loadNotebookLocked(lease, notebookId);
    const entry = requireNoteLocked(state, noteId);
    const source = resolveLoreSource(entry.text, normalised);
    if (source.status !== 'ok') {
        throw new NotebookError(source.status === 'ambiguous' ? 'LORE_SELECTOR_AMBIGUOUS' : 'LORE_SELECTOR_MISSING',
            source.status === 'ambiguous' ? 'More than one heading matches. Rename one so the section is clear.' : 'That section could not be found in the note.', 409);
    }
    if (!source.text.trim()) throw new NotebookError('LORE_SOURCE_EMPTY', 'That section is empty, so there is nothing to publish.', 409);
    if (Buffer.byteLength(source.text) > MAX_LORE_TEXT) throw new NotebookError('LORE_SOURCE_TOO_LARGE', 'That section is too large for one lore entry.', 413);
    const target = requireBookLocked(lease, filename);
    const existingBindings = readBindingsLocked(lease, notebookId);
    const bindingId = bindingIdFor(notebookId, noteId, normalised, filename);
    const binding = existingBindings.bindings[bindingId];
    const effectiveUid = uid ?? binding?.uid ?? null;
    const current = entryOf(target, effectiveUid);
    if (effectiveUid !== null && effectiveUid !== undefined && !current) {
        throw new NotebookError('LORE_ENTRY_NOT_FOUND', 'That lore entry no longer exists.', 404);
    }
    if (targetTakenElsewhere(lease, notebookId, bindingId, filename, effectiveUid)) {
        throw new NotebookError('LORE_TARGET_BOUND', 'Another note section already publishes to that entry. Detach it first.', 409);
    }
    const before = current ? String(current.content ?? '') : null;
    const entryTitle = current ? lorebookEntryTitle(current) : (title?.trim() || (normalised.kind === 'heading' ? normalised.path.at(-1) : entry.title));
    return {
        bindingId,
        notebookId,
        noteId,
        noteTitle: entry.title,
        noteRevision: entry.hash,
        selector: normalised,
        selectorLabel: selectorLabel(normalised),
        book: target.name,
        bookRevision: target.revision,
        uid: effectiveUid,
        createsEntry: !current,
        entryTitle,
        changes: current ? ['content'] : ['new entry: content, title'],
        before,
        after: source.text,
        sourceHash: contentHash(source.text),
        targetHash: before === null ? null : contentHash(before),
        enabled: current ? current.disable !== true : true,
        preserved: current ? Object.keys(current).filter(key => key !== 'content').sort() : [],
    };
}

/**
 * Publishes the exact selected source to one lore entry. Only `content`
 * (and `comment` for new entries) changes; every other field is kept.
 */
export function publishToLoreLocked(lease, {
    operationId, notebookId, noteId, selector, book, uid = null, title = null,
    expectedSourceHash, expectedTargetHash = null, actor = { kind: 'user' }, origin = 'user',
}) {
    const normalised = normaliseSelector(selector);
    const filename = bookFilename(book);
    const args = { notebookId, noteId, selector: normalised, book: filename, uid, title, expectedSourceHash, expectedTargetHash };
    return runOperationLocked(lease, { operationId, kind: 'lore-publish', args }, () => {
        const preview = previewPublicationLocked(lease, { notebookId, noteId, selector: normalised, book: filename, uid, title });
        if (expectedSourceHash !== preview.sourceHash) {
            throw new NotebookError('LORE_SOURCE_CHANGED', 'The note section changed after you reviewed it. Review it again.', 409, { preview });
        }
        if ((preview.targetHash ?? null) !== (expectedTargetHash ?? null)) {
            throw new NotebookError('LORE_TARGET_CHANGED', 'The lore entry changed after you reviewed it. Review it again.', 409, { preview });
        }
        const value = readBindingsLocked(lease, notebookId);
        const existing = value.bindings[preview.bindingId];
        if (existing?.pending) finishPending(lease, notebookId, value, existing);
        const target = requireBookLocked(lease, filename);
        const data = structuredClone(target.data);
        const entryUid = preview.uid ?? freeUid(target);
        const state = loadNotebookLocked(lease, notebookId);
        const source = resolveLoreSource(requireNoteLocked(state, noteId).text, normalised);
        const binding = existing ?? {
            id: preview.bindingId,
            noteId,
            selector: normalised,
            book: filename,
            uid: null,
            policy: 'manual',
            liveOrigins: [],
            createdAt: now(),
            history: [],
        };
        binding.entryTitle = preview.entryTitle;
        binding.pending = {
            operationId,
            uid: entryUid,
            sourceHash: preview.sourceHash,
            targetHash: contentHash(preview.after),
            sourceText: preview.after,
            targetText: preview.after,
            children: source.children,
            noteRevision: preview.noteRevision,
            actor,
            origin,
            at: now(),
        };
        value.bindings[binding.id] = binding;
        writeBindingsLocked(lease, notebookId, value);
        const key = String(entryUid);
        if (data.entries[key]) {
            data.entries[key] = { ...data.entries[key], content: preview.after };
        } else {
            data.entries[key] = { ...structuredClone(newWorldInfoEntryTemplate), uid: entryUid, comment: preview.entryTitle, content: preview.after, key: [] };
        }
        syncLorebookOriginalEntry(data, entryUid);
        const bookRevision = writeBookLocked(lease, target, data, `Notebook publish: ${preview.entryTitle}`);
        finishPending(lease, notebookId, value, binding);
        return {
            status: 'success',
            committed: true,
            operationId,
            bindingId: binding.id,
            book: target.name,
            uid: entryUid,
            createdEntry: preview.createsEntry,
            entryTitle: preview.entryTitle,
            bookRevision,
            enabled: data.entries[key].disable !== true,
        };
    });
}

export function setBindingPolicyLocked(lease, { operationId, notebookId, bindingId, policy, liveOrigins = ['user'] }) {
    if (!['manual', 'live'].includes(policy)) throw new NotebookError('LORE_POLICY_INVALID', 'Choose manual or live updates.', 400);
    const origins = policy === 'live' ? [...new Set(liveOrigins)].filter(origin => ['user', 'assistant', 'external'].includes(origin)) : [];
    if (policy === 'live' && !origins.length) throw new NotebookError('LORE_POLICY_INVALID', 'Live updates need at least one allowed origin.', 400);
    return runOperationLocked(lease, { operationId, kind: 'lore-policy', args: { notebookId, bindingId, policy, origins } }, () => {
        const value = readBindingsLocked(lease, notebookId);
        const binding = requireBinding(value, bindingId);
        binding.policy = policy;
        binding.liveOrigins = origins;
        binding.liveEnabledAt = policy === 'live' ? now() : null;
        pushBindingHistory(binding, { action: `policy:${policy}`, origins });
        writeBindingsLocked(lease, notebookId, value);
        return { status: 'success', committed: true, bindingId, policy, liveOrigins: origins };
    });
}

export function detachBindingLocked(lease, { operationId, notebookId, bindingId }) {
    return runOperationLocked(lease, { operationId, kind: 'lore-detach', args: { notebookId, bindingId } }, () => {
        const value = readBindingsLocked(lease, notebookId);
        const binding = requireBinding(value, bindingId);
        delete value.bindings[bindingId];
        value.detached = [...(value.detached ?? []), { ...binding, detachedAt: now(), history: undefined }].slice(-100);
        writeBindingsLocked(lease, notebookId, value);
        return { status: 'success', committed: true, bindingId, detached: true };
    });
}

/** Explicitly replaces the bound draft region with the current lore text. */
export function pullLoreIntoNoteLocked(lease, { operationId, notebookId, bindingId, expectedRevision, expectedLoreHash, actor = { kind: 'user' } }) {
    const args = { notebookId, bindingId, expectedRevision, expectedLoreHash };
    return runOperationLocked(lease, { operationId, kind: 'lore-pull', args }, () => {
        const value = readBindingsLocked(lease, notebookId);
        const binding = requireBinding(value, bindingId);
        const target = targetState(lease, binding);
        if (target.status !== 'ok') throw new NotebookError('LORE_ENTRY_NOT_FOUND', 'That lore entry no longer exists.', 404);
        if (contentHash(target.text) !== expectedLoreHash) throw new NotebookError('LORE_TARGET_CHANGED', 'The lore entry changed after you reviewed it.', 409);
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const entry = requireNoteLocked(state, binding.noteId);
        if (entry.hash !== expectedRevision) throw new NotebookError('NOTE_CONFLICT', 'This note changed since you reviewed it.', 409, { currentRevision: entry.hash });
        const source = resolveLoreSource(entry.text, binding.selector);
        if (source.status !== 'ok') throw new NotebookError('LORE_SELECTOR_MISSING', 'The linked section could not be found in the note.', 409);
        let change;
        if (binding.selector.kind === 'note') {
            const front = splitFrontmatter(entry.text);
            const prefix = front.raw === null ? entry.text.slice(0, front.bodyStart) : entry.text.slice(0, front.bodyStart);
            change = { type: 'replace_all', markdown: `${prefix}${target.text}${target.text.endsWith('\n') ? '' : '\n'}` };
        } else {
            change = { type: 'replace_section', selector: binding.selector, expectedTextHash: sectionHash(source.text), markdown: target.text };
        }
        const result = updateNoteLocked(lease, {
            operationId: `${operationId}:note`, notebookId, noteId: binding.noteId, expectedRevision, changes: [change], actor, origin: 'lore', reason: 'lore-pull',
        });
        const after = loadNotebookLocked(lease, notebookId, { force: true });
        const resolved = resolveLoreSource(requireNoteLocked(after, binding.noteId).text, binding.selector);
        binding.published = {
            ...(binding.published ?? {}),
            sourceHash: contentHash(resolved.text),
            targetHash: contentHash(target.text),
            sourceText: resolved.text,
            targetText: target.text,
            at: now(),
            noteRevision: result.revision,
            operationId,
        };
        binding.publishedChildren = resolved.children;
        binding.lastError = null;
        pushBindingHistory(binding, { action: 'pull', operationId, actor });
        writeBindingsLocked(lease, notebookId, value);
        return { status: 'success', committed: true, bindingId, noteId: binding.noteId, revision: result.revision };
    });
}

/** Re-points a binding whose heading was renamed; never guesses on its own. */
export function repairBindingLocked(lease, { operationId, notebookId, bindingId, selector }) {
    const normalised = normaliseSelector(selector);
    return runOperationLocked(lease, { operationId, kind: 'lore-repair', args: { notebookId, bindingId, selector: normalised } }, () => {
        const value = readBindingsLocked(lease, notebookId);
        const binding = requireBinding(value, bindingId);
        const state = loadNotebookLocked(lease, notebookId);
        const entry = requireNoteLocked(state, binding.noteId);
        const source = resolveLoreSource(entry.text, normalised);
        if (source.status !== 'ok') throw new NotebookError('LORE_SELECTOR_MISSING', 'That section could not be found in the note.', 409);
        binding.selector = normalised;
        binding.publishedChildren = source.children;
        pushBindingHistory(binding, { action: 'repair', operationId, selector: normalised });
        writeBindingsLocked(lease, notebookId, value);
        return { status: 'success', committed: true, bindingId };
    });
}

/**
 * Runs after a committed note save. Only bindings whose owner enabled live
 * updates for this origin, and whose lore is untouched, are updated.
 */
export function applyLiveUpdatesLocked(lease, { notebookId, noteId, origin, operationId, actor }) {
    const value = readBindingsLocked(lease, notebookId);
    const outcomes = [];
    for (const binding of Object.values(value.bindings)) {
        if (binding.noteId !== noteId || binding.policy !== 'live' || !binding.published) continue;
        const described = describeBindingLocked(lease, notebookId, binding);
        if (described.status !== 'draft_changed') {
            outcomes.push({ bindingId: binding.id, status: described.status, updated: false });
            continue;
        }
        if (!(binding.liveOrigins ?? []).includes(origin)) {
            outcomes.push({ bindingId: binding.id, status: 'needs_review', updated: false });
            continue;
        }
        try {
            const result = publishToLoreLocked(lease, {
                operationId: `${operationId}:live:${binding.id}`,
                notebookId,
                noteId,
                selector: binding.selector,
                book: binding.book,
                uid: binding.uid,
                expectedSourceHash: described.sourceHash,
                expectedTargetHash: described.loreHash,
                actor,
                origin,
            });
            outcomes.push({ bindingId: binding.id, status: 'in_sync', updated: true, bookRevision: result.bookRevision });
        } catch (error) {
            outcomes.push({ bindingId: binding.id, status: 'failed', updated: false, code: error.code || 'LORE_LIVE_FAILED' });
        }
    }
    return outcomes;
}

/* ---------- lore entry pages ---------- */

export function readLoreEntryPageLocked(lease, { book, uid }) {
    const target = requireBookLocked(lease, book);
    const entry = entryOf(target, uid);
    if (!entry) throw new NotebookError('LORE_ENTRY_NOT_FOUND', 'That lore entry could not be found.', 404);
    return {
        book: target.name,
        uid: Number(uid),
        title: lorebookEntryTitle(entry),
        comment: String(entry.comment ?? ''),
        content: String(entry.content ?? ''),
        keys: Array.isArray(entry.key) ? entry.key : [],
        secondaryKeys: Array.isArray(entry.keysecondary) ? entry.keysecondary : [],
        enabled: entry.disable !== true,
        constant: entry.constant === true,
        entryHash: entryHash(entry),
        bookRevision: target.revision,
        live: true,
    };
}

/** Saves the live World Info record itself. Only content and title change. */
export function saveLoreEntryPageLocked(lease, { operationId, book, uid, expectedEntryHash, content, comment }) {
    if (typeof content !== 'string' || content.length > MAX_LORE_TEXT) throw new NotebookError('LORE_CONTENT_INVALID', 'Entry text must be text under 512 KiB.', 400);
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 500)) throw new NotebookError('LORE_CONTENT_INVALID', 'The title is too long.', 400);
    const filename = bookFilename(book);
    const args = { book: filename, uid, expectedEntryHash, content, comment };
    return runOperationLocked(lease, { operationId, kind: 'lore-entry-save', args }, () => {
        const target = requireBookLocked(lease, filename);
        const entry = entryOf(target, uid);
        if (!entry) throw new NotebookError('LORE_ENTRY_NOT_FOUND', 'That lore entry could not be found.', 404);
        if (entryHash(entry) !== expectedEntryHash) {
            throw new NotebookError('LORE_TARGET_CHANGED', 'This entry changed in the lorebook editor since you opened it.', 409, { current: readLoreEntryPageLocked(lease, { book: filename, uid }) });
        }
        const data = structuredClone(target.data);
        const next = { ...entry, content };
        if (comment !== undefined) next.comment = comment;
        if (JSON.stringify(next) === JSON.stringify(entry)) return { status: 'no_change', committed: false, entryHash: expectedEntryHash };
        data.entries[String(uid)] = next;
        syncLorebookOriginalEntry(data, Number(uid));
        const bookRevision = writeBookLocked(lease, target, data, `Notebook page edit: ${lorebookEntryTitle(next)}`);
        return { status: 'success', committed: true, operationId, book: target.name, uid: Number(uid), entryHash: entryHash(next), bookRevision };
    });
}

export function exportLoreEntryMarkdown(page) {
    const lines = ['---', `title: ${JSON.stringify(page.title)}`, `lorebook: ${JSON.stringify(page.book)}`, `lore_uid: ${page.uid}`];
    if (page.keys.length) lines.push(`keys: ${JSON.stringify(page.keys)}`);
    lines.push('---', '', `# ${page.title}`, '', page.content, '');
    return lines.join('\n');
}

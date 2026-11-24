import crypto from 'node:crypto';

/** Saved Scratchpad changes kept per chat or shared bucket, newest first. */
export const MAX_CHANGE_HISTORY = 50;
export const MAX_HISTORY_ENTRY_BYTES = 128 * 1024;
export const TOO_LARGE_REASON = 'Too large to keep an automatic undo snapshot.';
const SHORTENED_NOTE = 'The text shown here was shortened.';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const WORD_PATTERN = /^[a-z][a-z-]{0,39}$/;
const TARGET_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_TARGET_KEYS = 16;
const MAX_TARGET_VALUE = 1000;
const MAX_UNDO_DEPTH = 8;
const MAX_UNDO_NODES = 4000;

class ChangeHistoryError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const fail = (code, message, status = 400) => new ChangeHistoryError(code, message, status);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bytes(value) {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8');
}

function text(value, max) {
    if (typeof value !== 'string') return '';
    return value.length > max ? value.slice(0, max) : value;
}

function word(value) {
    return typeof value === 'string' && WORD_PATTERN.test(value) ? value : '';
}

function id(value) {
    return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

function time(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Only flat, readable labels: the target says what was changed, never how to change it. */
function normaliseTarget(value) {
    const target = {};
    if (!isPlainObject(value)) return target;
    for (const [key, item] of Object.entries(value).slice(0, MAX_TARGET_KEYS * 2)) {
        if (Object.keys(target).length >= MAX_TARGET_KEYS) break;
        if (!TARGET_KEY.test(key)) continue;
        if (typeof item === 'string') target[key] = text(item, MAX_TARGET_VALUE);
        else if (typeof item === 'number' && Number.isFinite(item)) target[key] = item;
        else if (typeof item === 'boolean' || item === null) target[key] = item;
    }
    return target;
}

/** A JSON copy of the undo snapshot, refused when it is not plain data. */
function cloneUndo(value) {
    let nodes = 0;
    const invalid = () => fail('SCRATCHPAD_HISTORY_INVALID', 'That undo snapshot is not valid.');
    const walk = (item, depth) => {
        if (++nodes > MAX_UNDO_NODES) throw invalid();
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
        if (typeof item === 'number') return Number.isFinite(item) ? item : null;
        if (depth >= MAX_UNDO_DEPTH) throw invalid();
        if (Array.isArray(item)) return item.map(entry => walk(entry, depth + 1));
        if (isPlainObject(item)) {
            const out = {};
            for (const [key, entry] of Object.entries(item)) {
                if (key === '__proto__' || key === 'constructor' || key === 'prototype' || entry === undefined) continue;
                out[key] = walk(entry, depth + 1);
            }
            return out;
        }
        return null;
    };
    if (!isPlainObject(value)) return null;
    return walk(value, 0);
}

/** Cut a string to a UTF-8 byte budget without splitting a character. */
function cutBytes(value, max) {
    if (bytes(value) <= max) return value;
    return Buffer.from(value, 'utf8').subarray(0, Math.max(0, max)).toString('utf8').replace(/\uFFFD+$/u, '');
}

/**
 * Keep an entry inside the per-entry cap. A large entry loses its undo
 * snapshot first, honestly marked as not undoable; only if the readable text
 * is still too large is it shortened.
 */
function fitEntry(entry) {
    if (bytes(entry) <= MAX_HISTORY_ENTRY_BYTES) return entry;
    const next = { ...entry, undo: null, undoable: false, undoUnavailableReason: TOO_LARGE_REASON };
    if (bytes(next) <= MAX_HISTORY_ENTRY_BYTES) return next;
    const fixed = bytes({ ...next, before: '', after: '' }) + bytes(SHORTENED_NOTE) * 2 + 64;
    // JSON escaping can grow text, so keep trimming until the whole entry fits.
    for (let budget = Math.max(0, Math.floor((MAX_HISTORY_ENTRY_BYTES - fixed) / 2)); budget > 0; budget = Math.floor(budget * 0.8)) {
        next.before = bytes(entry.before) > budget ? `${cutBytes(entry.before, budget)}\n${SHORTENED_NOTE}` : entry.before;
        next.after = bytes(entry.after) > budget ? `${cutBytes(entry.after, budget)}\n${SHORTENED_NOTE}` : entry.after;
        if (bytes(next) <= MAX_HISTORY_ENTRY_BYTES) return next;
    }
    return { ...next, before: SHORTENED_NOTE, after: SHORTENED_NOTE };
}

/**
 * One history entry from stored or posted data, or null when it cannot be
 * trusted. Only allow-listed fields survive.
 */
export function normaliseHistoryEntry(input) {
    if (!isPlainObject(input)) return null;
    const entryId = id(input.id);
    const type = word(input.type);
    const savedAt = time(input.savedAt);
    if (!entryId || !type || !savedAt) return null;
    const status = input.status === 'undone' ? 'undone' : 'applied';
    let undo = null;
    try {
        undo = cloneUndo(input.undo);
    } catch {
        undo = null;
    }
    const undoable = input.undoable === true && Boolean(undo);
    const proposalIndex = Number.isInteger(input.proposalIndex) && input.proposalIndex >= 0 && input.proposalIndex < 1000 ? input.proposalIndex : null;
    return fitEntry({
        id: entryId,
        type,
        action: word(input.action),
        status,
        sessionId: id(input.sessionId),
        messageId: id(input.messageId),
        proposalIndex,
        description: text(input.description, 300),
        target: normaliseTarget(input.target),
        field: text(input.field, 80),
        before: typeof input.before === 'string' ? input.before : '',
        after: typeof input.after === 'string' ? input.after : '',
        undo: undoable ? undo : null,
        undoable,
        undoUnavailableReason: undoable ? '' : (text(input.undoUnavailableReason, 300) || 'Automatic undo is not available for this change.'),
        savedAt,
        undoneAt: status === 'undone' ? time(input.undoneAt) ?? savedAt : null,
    });
}

/** Stored history, newest first, bounded and free of duplicates. */
export function normaliseChangeHistory(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const history = [];
    for (const item of value.slice(0, MAX_CHANGE_HISTORY * 2)) {
        const entry = normaliseHistoryEntry(item);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        history.push(entry);
        if (history.length >= MAX_CHANGE_HISTORY) break;
    }
    return history;
}

/**
 * Add a saved change to the front of the history. The server picks the id
 * and time; the oldest entries fall off once the list is full.
 */
export function recordChange(history, input, { id: entryId = crypto.randomUUID().replaceAll('-', '').slice(0, 24), savedAt = new Date().toISOString() } = {}) {
    if (!isPlainObject(input)) throw fail('SCRATCHPAD_HISTORY_INVALID', 'That saved change could not be recorded.');
    const entry = normaliseHistoryEntry({ ...input, id: entryId, savedAt, status: 'applied', undoneAt: null });
    if (!entry) throw fail('SCRATCHPAD_HISTORY_INVALID', 'That saved change could not be recorded.');
    const rest = normaliseChangeHistory(history).filter(item => item.id !== entry.id);
    return { entry, history: [entry, ...rest].slice(0, MAX_CHANGE_HISTORY) };
}

/** Mark one applied entry as undone. The browser has already put the old text back. */
export function markChangeUndone(history, entryId, { undoneAt = new Date().toISOString() } = {}) {
    const list = normaliseChangeHistory(history);
    const index = list.findIndex(item => item.id === entryId);
    if (index < 0) throw fail('SCRATCHPAD_HISTORY_MISSING', 'That saved change is no longer in Change history.', 404);
    const entry = list[index];
    if (entry.status === 'undone') throw fail('SCRATCHPAD_HISTORY_UNDONE', 'That change was already undone.', 409);
    if (!entry.undoable) throw fail('SCRATCHPAD_HISTORY_NOT_UNDOABLE', entry.undoUnavailableReason, 409);
    const next = { ...entry, status: 'undone', undoneAt: time(undoneAt) ?? new Date().toISOString() };
    list[index] = next;
    return { entry: next, history: list };
}

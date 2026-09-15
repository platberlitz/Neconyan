import { HISTORY_KEY } from './constants.js';
import { getContext } from './host.js';
import { getSettings } from './settings.js';

const HISTORY_VERSION = 1;
const contextHistory = new WeakMap();
let orphanHistory = [];

function clone(value) {
    return structuredClone(value);
}

function storage() {
    const target = getContext()?.accountStorage;
    return typeof target?.getItem === 'function'
        && typeof target?.setItem === 'function'
        && typeof target?.removeItem === 'function'
        ? target
        : null;
}

function readMemoryHistory() {
    const context = getContext();
    return context && typeof context === 'object'
        ? (contextHistory.get(context) ?? [])
        : orphanHistory;
}

function writeMemoryHistory(items) {
    const context = getContext();
    if (context && typeof context === 'object') {
        contextHistory.set(context, clone(items));
    } else {
        orphanHistory = clone(items);
    }
}

function sanitize(items) {
    return items.map((item) => {
        const next = item && typeof item === 'object' ? clone(item) : item;
        if (next && typeof next === 'object') {
            delete next.books;
        }
        return next;
    });
}

function readHistory() {
    const target = storage();
    if (!target) {
        return readMemoryHistory();
    }
    try {
        const parsed = JSON.parse(target.getItem(HISTORY_KEY) ?? 'null');
        if (parsed?.version !== HISTORY_VERSION || !Array.isArray(parsed.items)) {
            return [];
        }
        const items = sanitize(parsed.items);
        if (parsed.items.some(item => Object.hasOwn(item ?? {}, 'books'))) {
            try {
                writeHistory(items);
            } catch {
                // Sanitizing a legacy record should not make readable history disappear.
            }
        }
        return items;
    } catch {
        return [];
    }
}

function writeHistory(items) {
    const safeItems = sanitize(items);
    const target = storage();
    if (!target) {
        writeMemoryHistory(safeItems);
        return;
    }
    target.setItem(HISTORY_KEY, JSON.stringify({
        version: HISTORY_VERSION,
        items: safeItems,
    }));
}

function makeId() {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function appendHistory(result, { name = '' } = {}) {
    if (result?.kind !== 'simulated') {
        throw new TypeError('Only completed scans can be added to recent scans.');
    }
    const item = {
        id: makeId(),
        name: String(name || result.fingerprint || 'Scan'),
        fingerprint: String(result.fingerprint ?? ''),
        createdAt: new Date().toISOString(),
        mode: result.input?.mode ?? '',
        trigger: result.input?.trigger ?? '',
        seed: result.seed ?? 0,
        activated: result.activated?.length ?? 0,
        tokens: result.budget?.used ?? 0,
        limit: result.budget?.limit ?? 0,
    };
    const limit = getSettings().historyLimit;
    writeHistory([item, ...readHistory()].slice(0, limit));
    return clone(item);
}

export function listHistory() {
    return pruneHistory();
}

export function pruneHistory() {
    const history = readHistory();
    const items = history.slice(0, getSettings().historyLimit);
    if (items.length !== history.length) {
        try {
            writeHistory(items);
        } catch {
            // Reading history should still work when browser storage is read-only.
        }
    }
    return clone(items);
}

export function clearHistory() {
    const context = getContext();
    if (context && typeof context === 'object') {
        contextHistory.delete(context);
    } else {
        orphanHistory = [];
    }
    try {
        storage()?.removeItem(HISTORY_KEY);
    } catch {
        // Browser storage may reject writes in private or sandboxed contexts.
    }
}

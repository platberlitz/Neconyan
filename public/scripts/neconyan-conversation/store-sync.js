/**
 * Conversation-ready store synchronisation.
 *
 * The Conversation store is server-owned: native jobs write messages, receipts
 * and bookkeeping directly to the settings file. A browser tab only holds a
 * copy. This module keeps that copy honest:
 *
 *   - `flushConversationStore()` waits until the store the browser currently
 *     holds has actually reached the server.
 *   - `refreshConversationStore()` reads the authoritative store and merges it
 *     with the browser's saved baseline and any unsaved local edits.
 *   - `captureConversationStore()` records the baseline/version pair, so the
 *     merge can tell "never seen" from "changed locally".
 *
 * A general settings save omits the Conversation block entirely
 * (`_conversationOmitted`), so this module is the only path that sends
 * Conversation content, and it always does so with an exact expected version.
 */
import { getCurrentUserHandle, getRequestHeaders, settings } from '../../script.js';
import { extension_settings } from '../extensions.js';
import { CONVERSATION_STORE_KEY } from './constants.js';
import { cloneConversationValue, conversationValuesEqual, mergeConversationStore } from './store-sync-utils.js';

const STORE_GET_ENDPOINT = '/api/neconyan-conversation/store/get';
const STORE_SAVE_ENDPOINT = '/api/neconyan-conversation/store/save';
const STORE_SAVE_DEBOUNCE_MS = 500;

let savedSnapshot = null;
let savedVersion = null;
let syncQueue = Promise.resolve();

function readLocalStore() {
    const store = extension_settings?.[CONVERSATION_STORE_KEY];
    return store && typeof store === 'object' ? store : null;
}

function setLocalStore(store) {
    extension_settings[CONVERSATION_STORE_KEY] = store;
}

function swallow() {}

/**
 * Remember the store and version the server currently agrees with. Called after
 * a successful read or write, and once at startup from the loaded settings.
 */
export function captureConversationStore(store = readLocalStore(), version = null) {
    if (!store || typeof store !== 'object') {
        return;
    }
    savedSnapshot = cloneConversationValue(store);
    // Never coerce null/undefined to 0: an absent version must fall through to
    // the startup seed, not claim the store is at version zero.
    const next = version === null || version === undefined ? NaN : Number(version);
    if (Number.isSafeInteger(next) && next >= 0) {
        savedVersion = next;
    } else if (savedVersion === null) {
        // Seed the first version from the loaded settings, before any
        // Conversation-only save has told us a newer one.
        const seeded = Number(settings?._version);
        if (Number.isSafeInteger(seeded) && seeded >= 0) {
            savedVersion = seeded;
        }
    }
}

export function getConversationSavedVersion() {
    return savedVersion;
}

export function getConversationSavedSnapshot() {
    return savedSnapshot;
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': getCurrentUserHandle() ?? '' },
        body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
        const error = new Error(parsed?.error || `Conversation store request failed with ${response.status}.`);
        error.status = response.status;
        error.body = parsed;
        throw error;
    }
    return parsed;
}

/** Read the authoritative store and merge it into the browser's copy. Returns
 *  the merged store, or null when a genuine conflict must be reported. */
async function refreshOnce() {
    const body = await postJson(STORE_GET_ENDPOINT, {});
    const serverStore = body?.store && typeof body.store === 'object' ? body.store : null;
    const version = Number(body?.version);
    if (!serverStore) {
        return null;
    }
    const localStore = readLocalStore();
    const merged = mergeConversationStore(serverStore, localStore, savedSnapshot);
    if (!merged) {
        // Do not move the baseline: the browser's copy still disagrees.
        return { store: serverStore, version, conflict: true };
    }
    if (localStore && !conversationValuesEqual(merged, localStore)) {
        setLocalStore(merged);
    }
    // The baseline is the server's copy, not the merged one. The merged copy can
    // contain unsaved local edits; recording those as acknowledged would let the
    // next read treat them as unchanged and replace them with the older value.
    captureConversationStore(serverStore, Number.isSafeInteger(version) ? version : savedVersion);
    return { store: merged, version, conflict: false };
}

export function refreshConversationStore() {
    const run = syncQueue.then(refreshOnce, refreshOnce);
    syncQueue = run.then(swallow, swallow);
    return run;
}

/**
 * Adopt the server's confirmation without dropping edits the browser made while
 * the request was in flight: merge the returned copy with the current store
 * against the copy that was actually submitted. The baseline only ever becomes
 * the server's copy.
 */
function absorbSaveResult(body, submitted) {
    const stored = body?.store && typeof body.store === 'object' ? body.store : submitted;
    const current = readLocalStore();
    const reconciled = mergeConversationStore(stored, current, submitted);
    if (reconciled && !conversationValuesEqual(reconciled, current)) {
        setLocalStore(reconciled);
    }
    captureConversationStore(stored, body?.version);
}

async function saveOnce() {
    if (!readLocalStore()) {
        return true;
    }
    if (!Number.isSafeInteger(savedVersion)) {
        // Learn the authoritative version before the first Conversation-only save.
        await refreshOnce();
    }
    const local = readLocalStore();
    if (!local || !Number.isSafeInteger(savedVersion)) {
        return false;
    }
    const submitted = cloneConversationValue(local);
    try {
        const body = await postJson(STORE_SAVE_ENDPOINT, { store: submitted, version: savedVersion });
        absorbSaveResult(body, submitted);
        return true;
    } catch (error) {
        if (error.status !== 409) {
            throw error;
        }
        // The version moved on under us (usually an unrelated settings save).
        // Merge the server copy, which keeps local edits, then retry once.
        const refreshed = await refreshOnce();
        if (!refreshed || refreshed.conflict) {
            return false;
        }
        const retrySource = readLocalStore();
        if (!retrySource || !Number.isSafeInteger(savedVersion)) {
            return false;
        }
        const retry = cloneConversationValue(retrySource);
        const body = await postJson(STORE_SAVE_ENDPOINT, { store: retry, version: savedVersion });
        absorbSaveResult(body, retry);
        return true;
    }
}

/** Send the browser's Conversation copy to the server under its expected version. */
export function persistConversationStoreNow() {
    const run = syncQueue.then(saveOnce, saveOnce);
    syncQueue = run.then(swallow, swallow);
    return run;
}

let saveTimer = null;
let pendingSave = null;
let resolvePendingSave = null;

/** Coalesce rapid edits into one save. The returned promise resolves once the
 *  debounced save has actually run, so `flushConversationStore` can await it. */
function scheduleConversationStoreSave() {
    if (!pendingSave) {
        pendingSave = new Promise(resolve => { resolvePendingSave = resolve; });
    }
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        const resolve = resolvePendingSave;
        pendingSave = null;
        resolvePendingSave = null;
        persistConversationStoreNow().then(resolve, resolve);
    }, STORE_SAVE_DEBOUNCE_MS);
    return pendingSave;
}

/** Queue a Conversation-only save; rapid edits coalesce into one request. */
export function persistConversationStoreDebounced() {
    void scheduleConversationStoreSave().catch(swallow);
}

/** Wait until the store the browser holds is acknowledged by the server. */
export async function flushConversationStore() {
    await scheduleConversationStoreSave();
    return persistConversationStoreNow();
}

export function initConversationStoreSync() {
    const store = readLocalStore();
    if (store) {
        captureConversationStore(store, null);
    }
}

/** Number of pending synchronisation steps; exposed for tests and diagnostics. */
export function getConversationSyncState() {
    return { savedVersion, savedSnapshot, hasSnapshot: savedSnapshot !== null };
}

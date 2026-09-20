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
import { getRequestHeaders } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { extension_settings } from '../extensions.js';
import { CONVERSATION_STORE_KEY } from './constants.js';
import { cloneConversationValue, conversationValuesEqual, mergeConversationStore } from './store-sync-utils.js';

const STORE_GET_ENDPOINT = '/api/neconyan-conversation/store/get';
const STORE_SAVE_ENDPOINT = '/api/neconyan-conversation/store/save';
const STORE_SAVE_DEBOUNCE_MS = 500;
// One stalled request must not pin the serialised sync queue forever; aborting
// lets the queue advance and a caller retry against a fresh connection.
const STORE_REQUEST_TIMEOUT_MS = 60000;

let savedSnapshot = null;
let savedVersion = null;
let loadedAccount;
let syncQueue = Promise.resolve();

function readLocalStore() {
    const store = extension_settings?.[CONVERSATION_STORE_KEY];
    return store && typeof store === 'object' ? store : null;
}

function setLocalStore(store) {
    extension_settings[CONVERSATION_STORE_KEY] = store;
}

function swallow() {}

/** Bind the downloaded settings to their authenticated owner, before profile loading. */
export function bindConversationAccount(account) {
    if (typeof account !== 'string' || !account || (loadedAccount !== undefined && loadedAccount !== account)) throw new Error('account_changed');
    loadedAccount = account;
}

/**
 * Remember the store and version the server currently agrees with. Called after
 * a successful read or write, and once at startup from the loaded settings.
 */
export function captureConversationStore(store, version) {
    checkAccount(loadedAccount);
    validateVersion(version);
    savedSnapshot = cloneConversationValue(store ?? {});
    savedVersion = version;
}

function validateVersion(version) {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid Conversation store version.');
}

function responseStore(body) {
    validateVersion(body?.version);
    if (!body?.store || typeof body.store !== 'object' || Array.isArray(body.store)) throw new Error('Invalid Conversation store response.');
    return body.store;
}

export function getConversationSavedVersion() {
    return savedVersion;
}

export function getConversationSavedSnapshot() {
    return savedSnapshot;
}

function checkAccount(account) {
    if (loadedAccount === undefined || account !== getCurrentUserHandle() || account !== loadedAccount) throw new Error('account_changed');
}

export function assertConversationAccount(account = getCurrentUserHandle()) {
    checkAccount(account);
}

async function postJson(url, body, account) {
    checkAccount(account);
    const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': account },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(STORE_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    checkAccount(account);
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
async function refreshOnce(account) {
    const body = await postJson(STORE_GET_ENDPOINT, {}, account);
    const serverStore = responseStore(body);
    const version = body?.version;
    const localStore = readLocalStore();
    const merged = mergeConversationStore(serverStore, localStore, savedSnapshot);
    if (!merged) {
        // Do not move the baseline: the browser's copy still disagrees.
        return { store: serverStore, version, conflict: true };
    }
    if (!conversationValuesEqual(merged, localStore)) {
        setLocalStore(merged);
    }
    // The baseline is the server's copy, not the merged one. The merged copy can
    // contain unsaved local edits; recording those as acknowledged would let the
    // next read treat them as unchanged and replace them with the older value.
    captureConversationStore(serverStore, version);
    return { store: merged, version, conflict: false };
}

export function refreshConversationStore(account = getCurrentUserHandle()) {
    const refresh = () => refreshOnce(account);
    const run = syncQueue.then(refresh, refresh);
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
    const stored = responseStore(body);
    const current = readLocalStore();
    const reconciled = mergeConversationStore(stored, current, submitted);
    if (!reconciled) return false;
    if (!conversationValuesEqual(reconciled, current)) {
        setLocalStore(reconciled);
    }
    captureConversationStore(stored, body?.version);
    return true;
}

async function saveOnce(account) {
    checkAccount(account);
    if (!readLocalStore()) {
        return true;
    }
    if (!Number.isSafeInteger(savedVersion)) {
        // Learn the authoritative version before the first Conversation-only save.
        const refreshed = await refreshOnce(account);
        if (!refreshed || refreshed.conflict) return false;
    }
    const local = readLocalStore();
    if (!local || !Number.isSafeInteger(savedVersion)) {
        return false;
    }
    const submitted = cloneConversationValue(local);
    try {
        const body = await postJson(STORE_SAVE_ENDPOINT, { store: submitted, version: savedVersion }, account);
        return absorbSaveResult(body, submitted);
    } catch (error) {
        if (error.status !== 409 || error.message === 'account_changed') {
            throw error;
        }
        // The version moved on under us (usually an unrelated settings save).
        // Merge the server copy, which keeps local edits, then retry once.
        const refreshed = await refreshOnce(account);
        if (!refreshed || refreshed.conflict) {
            return false;
        }
        const retrySource = readLocalStore();
        if (!retrySource || !Number.isSafeInteger(savedVersion)) {
            return false;
        }
        const retry = cloneConversationValue(retrySource);
        const body = await postJson(STORE_SAVE_ENDPOINT, { store: retry, version: savedVersion }, account);
        return absorbSaveResult(body, retry);
    }
}

/** Send the browser's Conversation copy to the server under its expected version. */
export function persistConversationStoreNow(account = getCurrentUserHandle()) {
    const save = () => saveOnce(account);
    const run = syncQueue.then(save, save);
    syncQueue = run.then(swallow, swallow);
    return run;
}

let saveTimer = null;
let pendingSave = null;
let resolvePendingSave = null;
let pendingAccount = null;

/** Coalesce rapid edits into one save. The returned promise resolves once the
 *  debounced save has actually run, so `flushConversationStore` can await it. */
function scheduleConversationStoreSave(account = getCurrentUserHandle()) {
    checkAccount(account);
    if (pendingSave && pendingAccount !== account) {
        clearTimeout(saveTimer);
        resolvePendingSave(false);
        pendingSave = null;
    }
    if (!pendingSave) {
        pendingAccount = account;
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
        pendingAccount = null;
        persistConversationStoreNow(account).then(resolve, () => resolve(false));
    }, STORE_SAVE_DEBOUNCE_MS);
    return pendingSave;
}

/** Queue a Conversation-only save; rapid edits coalesce into one request. */
export function persistConversationStoreDebounced(account = getCurrentUserHandle()) {
    void Promise.resolve().then(() => scheduleConversationStoreSave(account)).catch(swallow);
}

/** Wait until the store the browser holds is acknowledged by the server. */
export async function flushConversationStore(account = getCurrentUserHandle()) {
    await scheduleConversationStoreSave(account);
    return persistConversationStoreNow(account);
}

export function initConversationStoreSync() {
    checkAccount(loadedAccount);
    // Startup already captured the downloaded pair, before local migrations.
}

/** Number of pending synchronisation steps; exposed for tests and diagnostics. */
export function getConversationSyncState() {
    return { savedVersion, savedSnapshot, hasSnapshot: savedSnapshot !== null };
}

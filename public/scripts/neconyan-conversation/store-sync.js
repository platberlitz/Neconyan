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
import {
    applyConversationDeleteScope,
    cloneConversationValue,
    conversationValuesEqual,
    listRemovedConversationTargets,
    mergeConversationStore,
} from './store-sync-utils.js';

const STORE_GET_ENDPOINT = '/api/neconyan-conversation/store/get';
const STORE_SAVE_ENDPOINT = '/api/neconyan-conversation/store/save';
const STORE_SAVE_DEBOUNCE_MS = 500;
// One stalled request must not pin the serialised sync queue forever; aborting
// lets the queue advance and a caller retry against a fresh connection.
const STORE_REQUEST_TIMEOUT_MS = 60000;
// A save the page could not keep says so, in words the catalogue builder collects and the runtime localiser translates.
const CONVERSATION_SAVE_CONFLICT_TEXT = 'Some recent Conversation changes were not saved because they also changed on the server. The latest version is shown now; make those changes again.';
const CONVERSATION_SAVE_FAILED_TEXT = 'Could not save your last Conversation change. Try again in a moment.';
const SAVE_FAILED_NOTICE_INTERVAL_MS = 10000;
// A debounced save whose version moved twice under it tries again this many times before the person is told.
const UNSAVED_EDIT_RETRIES = 3;

let savedSnapshot = null;
let savedVersion = null;
let loadedAccount;
let syncQueue = Promise.resolve();
let lastSaveFailedNoticeAt = 0;
let unsavedEditRetries = 0;

function readLocalStore() {
    const store = extension_settings?.[CONVERSATION_STORE_KEY];
    return store && typeof store === 'object' ? store : null;
}

function setLocalStore(store) {
    extension_settings[CONVERSATION_STORE_KEY] = store;
}

function swallow() {}

/** 'conflict' (the page's edits were replaced by the server copy) always speaks; 'failed' (a save did not reach the server) at most once per 10 s. */
function noticeConversationSave(kind) {
    if (kind === 'conflict') {
        globalThis.toastr?.error?.(CONVERSATION_SAVE_CONFLICT_TEXT);
        return;
    }
    const now = Date.now();
    if (now - lastSaveFailedNoticeAt < SAVE_FAILED_NOTICE_INTERVAL_MS) return;
    lastSaveFailedNoticeAt = now;
    globalThis.toastr?.error?.(CONVERSATION_SAVE_FAILED_TEXT);
}

function dispatchRefreshed(detail) {
    globalThis.window?.dispatchEvent(new CustomEvent('neconyan:conversation-store-refreshed', { detail }));
}

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
    const knownVersion = savedSnapshot && readLocalStore() && Number.isSafeInteger(savedVersion) ? savedVersion : null;
    const body = await postJson(STORE_GET_ENDPOINT, knownVersion === null ? {} : { knownVersion }, account);
    if (body?.unchanged === true && knownVersion !== null && body.version === knownVersion && savedVersion === knownVersion && readLocalStore()) {
        // The server still holds the baseline, so merging it would return the
        // browser's copy unchanged. Skip the download, parse and deep compare.
        return { store: readLocalStore(), version: knownVersion, conflict: false, changed: false };
    }
    const serverStore = responseStore(body);
    const version = body?.version;
    const localStore = readLocalStore();
    const merged = mergeConversationStore(serverStore, localStore, savedSnapshot);
    if (!merged) {
        // Do not move the baseline: the browser's copy still disagrees.
        return { store: serverStore, version, conflict: true };
    }
    const changed = !conversationValuesEqual(merged, localStore);
    if (changed) {
        setLocalStore(merged);
    }
    // What the server took away since the baseline, read before the baseline moves, tells the views what to leave.
    const removed = listRemovedConversationTargets(savedSnapshot, serverStore);
    // The baseline is the server's copy, not the merged one. The merged copy can
    // contain unsaved local edits; recording those as acknowledged would let the
    // next read treat them as unchanged and replace them with the older value.
    captureConversationStore(serverStore, version);
    if (changed) {
        dispatchRefreshed(removed);
    }
    return { store: merged, version, conflict: false, changed };
}

export function refreshConversationStore(account = getCurrentUserHandle()) {
    const refresh = () => refreshOnce(account);
    const run = syncQueue.then(refresh, refresh);
    syncQueue = run.then(swallow, swallow);
    return run;
}

/** Persist the background worker's ownership before this page is needed again. */
export function ensureConversationAutomationOwnership({ acknowledgement = null, account = getCurrentUserHandle() } = {}) {
    const configure = async () => {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = await refreshOnce(account);
            if (current.conflict) throw new Error('Conversation settings changed in another tab. Reload to continue.');
            const automation = current.store.automation;
            if (automation?.mode === 'server' && automation.timeZone === timeZone
                && (!acknowledgement || (automation.acknowledgement?.account === acknowledgement.account
                    && automation.acknowledgement.settingsRevision >= acknowledgement.settingsRevision))) return automation;
            try {
                await postJson('/api/neconyan-conversation/automation/configure', {
                    mode: 'server', timeZone, version: current.version,
                    ...(acknowledgement ? { acknowledgement } : {}),
                }, account);
                const refreshed = await refreshOnce(account);
                if (refreshed.conflict) throw new Error('Conversation settings changed in another tab. Reload to continue.');
                return refreshed.store.automation;
            } catch (error) {
                if (attempt || error.status !== 409 || error.message === 'account_changed') throw error;
                if (error.message === 'active_settings_ack_stale') acknowledgement = null;
            }
        }
    };
    const run = syncQueue.then(configure, configure);
    syncQueue = run.then(swallow, swallow);
    return run;
}

/**
 * A save that cannot be reconciled with the server's copy: the page's changes
 * are replaced by the server's, the baseline moves with them so the next edit
 * saves, and the user is told (the page would otherwise repeat the same
 * conflict on every later save).
 */
function adoptServerCopy(refreshed, account) {
    checkAccount(account);
    const removed = listRemovedConversationTargets(savedSnapshot, refreshed.store);
    setLocalStore(cloneConversationValue(refreshed.store));
    captureConversationStore(refreshed.store, refreshed.version);
    dispatchRefreshed(removed);
    noticeConversationSave('conflict');
    return false;
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
    globalThis.window?.dispatchEvent(new CustomEvent('neconyan:conversation-store-saved'));
    return true;
}

async function saveOnce(account, skipUnchanged) {
    checkAccount(account);
    if (!readLocalStore()) {
        return true;
    }
    if (!Number.isSafeInteger(savedVersion)) {
        // Learn the authoritative version before the first Conversation-only save.
        const refreshed = await refreshOnce(account);
        if (!refreshed) return false;
        if (refreshed.conflict) return adoptServerCopy(refreshed, account);
    }
    const local = readLocalStore();
    if (!local || !Number.isSafeInteger(savedVersion)) {
        return false;
    }
    if (skipUnchanged && conversationValuesEqual(local, savedSnapshot)) return true;
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
        if (!refreshed) {
            return false;
        }
        if (refreshed.conflict) {
            return adoptServerCopy(refreshed, account);
        }
        const retrySource = readLocalStore();
        if (!retrySource || !Number.isSafeInteger(savedVersion)) {
            return false;
        }
        const retry = cloneConversationValue(retrySource);
        try {
            const body = await postJson(STORE_SAVE_ENDPOINT, { store: retry, version: savedVersion }, account);
            return absorbSaveResult(body, retry);
        } catch (retryError) {
            if (retryError.status === 409 && retryError.message !== 'account_changed') {
                // The version moved again after a clean merge: not a conflict. Keep the edit; a debounced save tries again (retryUnsavedEdit).
                return false;
            }
            throw retryError;
        }
    }
}

/** Send the browser's Conversation copy to the server under its expected version. */
export function persistConversationStoreNow(account = getCurrentUserHandle(), { skipUnchanged = false } = {}) {
    const save = () => saveOnce(account, skipUnchanged);
    const run = syncQueue.then(save, save);
    syncQueue = run.then(swallow, swallow);
    return run;
}

/**
 * Run a request the server answers with `{ scope, store, version }` (a DM
 * delete) in the sync queue, behind any save in flight, then adopt the answer:
 * the scope is applied to the page's copy and to its baseline, so what the
 * server deleted is gone from both and every other unsaved edit is merged as
 * usual. Returns the server's reply; a failed request rejects and changes nothing.
 */
export function applyConversationServerEdit(endpoint, body, account = getCurrentUserHandle()) {
    const edit = async () => {
        const reply = await postJson(endpoint, body, account);
        const serverStore = responseStore(reply);
        const localBefore = readLocalStore();
        const savedBefore = savedSnapshot;
        const merged = localBefore && savedBefore
            ? mergeConversationStore(serverStore, applyConversationDeleteScope(localBefore, reply.scope), applyConversationDeleteScope(savedBefore, reply.scope))
            : cloneConversationValue(serverStore);
        if (merged) {
            setLocalStore(merged);
        } else {
            // Another unsaved edit disagrees with the server about something else: the server's copy wins and the user is told.
            setLocalStore(cloneConversationValue(serverStore));
            noticeConversationSave('conflict');
        }
        captureConversationStore(serverStore, reply.version);
        const fromServer = listRemovedConversationTargets(savedBefore, serverStore);
        const fromPage = listRemovedConversationTargets(localBefore, readLocalStore());
        dispatchRefreshed({
            threadKeys: [...new Set([...fromServer.threadKeys, ...fromPage.threadKeys])],
            groupIds: [...new Set([...fromServer.groupIds, ...fromPage.groupIds, ...(reply.scope?.groupId ? [reply.scope.groupId] : [])])],
        });
        return reply;
    };
    const run = syncQueue.then(edit, edit);
    syncQueue = run.then(swallow, swallow);
    return run;
}

let saveTimer = null;
let pendingSave = null;
let resolvePendingSave = null;
let pendingAccount = null;

function takePendingSave() {
    clearTimeout(saveTimer);
    const resolve = resolvePendingSave;
    saveTimer = null;
    pendingSave = null;
    resolvePendingSave = null;
    pendingAccount = null;
    return resolve;
}

/** Resolve a debounced save's waiters with its result; a save that failed says so (at most once per 10 s) and resolves `false`. */
function settleDebouncedSave(save, resolve, account) {
    save.then(saved => {
        resolve(saved);
        if (saved) {
            unsavedEditRetries = 0;
        } else {
            retryUnsavedEdit(account);
        }
    }, error => {
        unsavedEditRetries = 0;
        if (error?.message !== 'account_changed') noticeConversationSave('failed');
        resolve(false);
    });
}

/**
 * A save that ended without an error but left edits unsaved (the version moved
 * again after a clean merge) schedules another save, so the edit is not left
 * only in this page. After a few tries in a row the person is told.
 */
function retryUnsavedEdit(account) {
    const local = readLocalStore();
    if (!local || conversationValuesEqual(local, savedSnapshot)) {
        unsavedEditRetries = 0;
        return;
    }
    if (unsavedEditRetries >= UNSAVED_EDIT_RETRIES) {
        unsavedEditRetries = 0;
        noticeConversationSave('failed');
        return;
    }
    unsavedEditRetries += 1;
    try {
        scheduleConversationStoreSave(account);
    } catch {
        unsavedEditRetries = 0;
    }
}

/** Coalesce rapid edits into one save. The returned promise resolves once the
 *  debounced save has actually run, so `flushConversationStore` can await it. */
function scheduleConversationStoreSave(account = getCurrentUserHandle()) {
    checkAccount(account);
    if (pendingSave && pendingAccount !== account) {
        takePendingSave()(false);
    }
    if (!pendingSave) {
        pendingAccount = account;
        pendingSave = new Promise(resolve => { resolvePendingSave = resolve; });
    }
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        const resolve = takePendingSave();
        settleDebouncedSave(persistConversationStoreNow(account, { skipUnchanged: true }), resolve, account);
    }, STORE_SAVE_DEBOUNCE_MS);
    return pendingSave;
}

/** Queue a Conversation-only save; rapid edits coalesce into one request. */
export function persistConversationStoreDebounced(account = getCurrentUserHandle()) {
    void Promise.resolve().then(() => scheduleConversationStoreSave(account)).catch(swallow);
}

/** Wait until the store the browser holds is acknowledged by the server. */
export async function flushConversationStore(account = getCurrentUserHandle()) {
    await Promise.resolve();
    checkAccount(account);
    const resolve = pendingAccount === account ? takePendingSave() : null;
    const save = persistConversationStoreNow(account, { skipUnchanged: true });
    if (resolve) settleDebouncedSave(save, resolve, account);
    if (!await save) return false;
    return conversationValuesEqual(readLocalStore(), savedSnapshot) || !readLocalStore()
        || persistConversationStoreNow(account, { skipUnchanged: true });
}

/** Navigation waits for real edits, but must not force a save just to view a link. */
export async function waitForConversationEdits(account = getCurrentUserHandle()) {
    await Promise.resolve();
    checkAccount(account);
    if (pendingSave && await pendingSave === false) return false;
    await syncQueue;
    checkAccount(account);
    return true;
}

export function initConversationStoreSync() {
    checkAccount(loadedAccount);
    // Startup already captured the downloaded pair, before local migrations.
}

/** Number of pending synchronisation steps; exposed for tests and diagnostics. */
export function getConversationSyncState() {
    return { savedVersion, savedSnapshot, hasSnapshot: savedSnapshot !== null };
}

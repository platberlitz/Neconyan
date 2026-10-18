/**
 * Browser-local custom macros. These definitions live in this browser's
 * localStorage under the signed-in account handle, never in extension settings
 * or accountStorage, because those are saved to the server as part of the
 * account. Each account gets its own key, so switching accounts cannot read or
 * overwrite another account's macros.
 *
 * The module is deliberately inert at import time: it only touches storage and
 * asks for the account when one of its functions is called. Storage and account
 * can be injected, which keeps the unit tests off the real browser stores.
 */
export const BROWSER_STORAGE_PREFIX = 'MacroEnhanced.browserMacros.v1:';
export const BROWSER_STORE_VERSION = 1;
export const MAX_BROWSER_MACROS = 200;
export const MAX_BROWSER_TEMPLATE_LENGTH = 20000;
export const MAX_AUTHORING_PROPOSAL_ID_LENGTH = 512;

/** @type {WeakMap<object, Map<string, string>>} */
const unreadableStores = new WeakMap();

class BrowserMacroStoreError extends Error {
    constructor(message, { code = 'BROWSER_MACRO_STORE' } = {}) {
        super(message);
        this.name = 'BrowserMacroStoreError';
        this.code = code;
    }
}

function storageError(message, cause) {
    const error = new BrowserMacroStoreError(message, { code: 'BROWSER_MACRO_STORAGE' });
    if (cause) {
        error.cause = cause;
    }
    return error;
}

function resolveStorage(injected) {
    if (injected) {
        return injected;
    }
    try {
        if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage) {
            throw new Error('localStorage is unavailable');
        }
        return globalThis.localStorage;
    } catch (error) {
        throw storageError('This browser is blocking local storage, so its macros cannot be read or saved. Allow site data for Neconyan and reload.', error);
    }
}

function resolveAccount({ account, ctx } = {}) {
    if (account !== undefined && account !== null && String(account).trim()) {
        return String(account);
    }
    let context = ctx;
    if (!context) {
        try {
            context = globalThis.SillyTavern?.getContext?.();
        } catch {
            context = null;
        }
    }
    const value = typeof context?.currentUserHandle === 'function'
        ? context.currentUserHandle()
        : typeof context?.getCurrentUserHandle === 'function'
            ? context.getCurrentUserHandle()
            : context?.currentUserHandle;
    if (value !== undefined && value !== null && String(value).trim()) {
        return String(value);
    }
    throw new BrowserMacroStoreError('Could not tell which account is signed in, so this browser\'s macros were left alone. Reload and try again.', { code: 'BROWSER_MACRO_ACCOUNT' });
}

/** The exact localStorage key for one account. */
export function getBrowserStoreKey(account) {
    return `${BROWSER_STORAGE_PREFIX}${encodeURIComponent(String(account))}`;
}

/** Whether a storage event key belongs to this extension's browser scope. */
export function isBrowserStoreKey(key) {
    return typeof key === 'string' && key.startsWith(BROWSER_STORAGE_PREFIX);
}

function markUnreadable(storage, key, problem) {
    let markers = unreadableStores.get(storage);
    if (!markers) {
        markers = new Map();
        unreadableStores.set(storage, markers);
    }
    markers.set(key, problem);
}

function clearUnreadable(storage, key) {
    unreadableStores.get(storage)?.delete(key);
}

function unreadableProblem() {
    return 'The browser macros saved under this account could not be read, so they were not overwritten. Clear this site\'s data for Neconyan, then reload.';
}

/**
 * Assistant review metadata rides along with a browser macro so a retry can
 * recognise a proposal already applied. It is not a custom macro field, so the
 * editor and pack export never add it; the browser store keeps it verbatim
 * within a bounded length.
 */
function authoringProposalId(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    return value.slice(0, MAX_AUTHORING_PROPOSAL_ID_LENGTH);
}

function storedDef(raw) {
    const def = {
        ...raw,
        args: Array.isArray(raw.args) ? raw.args : [],
        enabled: raw.enabled !== false,
    };
    const proposalId = authoringProposalId(def.authoringProposalId);
    if (proposalId === undefined) {
        delete def.authoringProposalId;
    } else {
        def.authoringProposalId = proposalId;
    }
    return def;
}

function normaliseStoredMacros(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'the saved value is not an object' };
    }
    if (parsed.version !== BROWSER_STORE_VERSION) {
        return { error: `the saved value has an unsupported version (${String(parsed.version)})` };
    }
    if (!Array.isArray(parsed.macros)) {
        return { error: 'the saved value has no macro list' };
    }
    const macros = [];
    for (const raw of parsed.macros) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { error: 'one of the saved macros is not an object' };
        }
        if (typeof raw.name !== 'string' || typeof raw.template !== 'string') {
            return { error: 'one of the saved macros has no name or template' };
        }
        macros.push(storedDef(raw));
    }
    return { macros };
}

/**
 * Reads one account's browser macros.
 *
 * @param {object} [options]
 * @param {Storage} [options.storage]
 * @param {string} [options.account]
 * @param {object} [options.ctx]
 * @returns {{defs: object[], problem: string, account: string, key: string}}
 */
function readBrowserStore(options = {}) {
    const storage = resolveStorage(options.storage);
    const account = resolveAccount(options);
    const key = getBrowserStoreKey(account);

    let raw;
    try {
        raw = storage.getItem(key);
    } catch (error) {
        throw storageError('This browser could not read its saved macros. Allow site data for Neconyan, then reload.', error);
    }

    if (raw === null || raw === undefined || raw === '') {
        clearUnreadable(storage, key);
        return { defs: [], problem: '', account, key };
    }

    let parsed;
    try {
        parsed = JSON.parse(String(raw));
    } catch {
        const problem = unreadableProblem();
        markUnreadable(storage, key, problem);
        return { defs: [], problem, account, key };
    }

    const normalised = normaliseStoredMacros(parsed);
    if (normalised.error) {
        const problem = unreadableProblem();
        markUnreadable(storage, key, problem);
        return { defs: [], problem, account, key };
    }

    clearUnreadable(storage, key);
    return { defs: normalised.macros, problem: '', account, key };
}

/**
 * The browser-scoped definitions for the signed-in account. Corrupted or
 * unsupported data reads as an empty list; `getBrowserStoreProblem()` says why,
 * and a write refuses instead of replacing it.
 *
 * @param {object} [options]
 * @returns {object[]}
 */
export function getBrowserDefs(options = {}) {
    return readBrowserStore(options).defs;
}

/**
 * Why the browser scope could not be read, or '' when it is healthy.
 *
 * @param {object} [options]
 * @returns {string}
 */
export function getBrowserStoreProblem(options = {}) {
    try {
        return readBrowserStore(options).problem;
    } catch (error) {
        return error?.message ?? String(error);
    }
}

/** The account that owns this browser scope right now. */
export function getBrowserIdentity(options = {}) {
    return resolveAccount(options);
}

/**
 * Whether this browser can read and write browser-scoped macros for the
 * signed-in account. A damaged stored value or a failed read makes the scope
 * unavailable, so the editor does not offer a target whose list it cannot see.
 */
export function browserScopeAvailability(options = {}) {
    try {
        const state = readBrowserStore(options);
        if (state.problem) {
            return { available: false, reason: state.problem };
        }
        return { available: true, reason: '' };
    } catch (error) {
        return { available: false, reason: error?.message ?? String(error) };
    }
}

function validateBeforeWrite(defs) {
    if (!Array.isArray(defs)) {
        throw new BrowserMacroStoreError('The browser macro list was not a list, so nothing was saved.', { code: 'BROWSER_MACRO_SHAPE' });
    }
    if (defs.length > MAX_BROWSER_MACROS) {
        throw new BrowserMacroStoreError(`This browser scope holds at most ${MAX_BROWSER_MACROS} macros. Delete some before adding more.`, { code: 'BROWSER_MACRO_LIMIT' });
    }
    for (const def of defs) {
        const template = String(def?.template ?? '');
        if (template.length > MAX_BROWSER_TEMPLATE_LENGTH) {
            throw new BrowserMacroStoreError(`{{${String(def?.name ?? 'macro')}}} is longer than the 20,000-character limit for a browser macro. Shorten it and try again.`, { code: 'BROWSER_MACRO_TEMPLATE_LIMIT' });
        }
    }
}

function isQuotaError(error) {
    return error?.name === 'QuotaExceededError'
        || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || error?.code === 22
        || error?.code === 1014;
}

/**
 * Saves one account's browser macros. Refuses to overwrite unreadable data,
 * enforces the scope limits and reports a full browser storage explicitly.
 *
 * @param {object[]} defs
 * @param {object} [options]
 * @returns {void}
 */
export function writeBrowserDefs(defs, options = {}) {
    const storage = resolveStorage(options.storage);
    const account = resolveAccount(options);
    const key = getBrowserStoreKey(account);

    // Read first, not last: a direct caller that never read through getBrowserDefs
    // must still be unable to replace damaged data with a shorter list.
    const existing = readBrowserStore({ ...options, storage, account });
    if (existing.problem) {
        throw new BrowserMacroStoreError(existing.problem, { code: 'BROWSER_MACRO_UNREADABLE' });
    }

    validateBeforeWrite(defs);

    // The editor does not carry review metadata in its draft. Keep the existing
    // marker for the same macro id so a later retry of the same assistant
    // proposal still recognises that it was applied.
    const existingById = new Map(existing.defs.map(def => [def.id, def]));
    const toStore = defs.map(def => {
        if (def?.authoringProposalId === undefined) {
            const previous = existingById.get(def?.id);
            if (previous?.authoringProposalId !== undefined) {
                return { ...def, authoringProposalId: previous.authoringProposalId };
            }
        }
        return def;
    });

    const payload = JSON.stringify({ version: BROWSER_STORE_VERSION, macros: toStore.map(storedDef) });
    try {
        storage.setItem(key, payload);
    } catch (error) {
        if (isQuotaError(error)) {
            throw storageError('This browser has no room left for macros. Nothing was changed. Delete macros or free some site storage, then try again.', error);
        }
        throw storageError(`This browser could not save its macros. Nothing was changed. ${error?.message ?? error}`, error);
    }
    clearUnreadable(storage, key);
}

/**
 * Record-only read for Prompting Lab. Never throws: a missing account, blocked
 * storage or damaged data records as no browser macros.
 *
 * @param {object} [options]
 * @returns {object[]}
 */
export function readBrowserMacros(options = {}) {
    try {
        return getBrowserDefs(options);
    } catch {
        return [];
    }
}

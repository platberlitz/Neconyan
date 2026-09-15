/**
 * Retained public BotBooru and Saucepan account state.
 *
 * Credentials are sent to the account routes, never copied into retained state.
 * Only bounded public status keeps the settings drawer and open dialogs in
 * agreement when a login, logout or account preference changes.
 */

import { post } from './api.js';

const SOURCE = 'botbooru';
const USERNAME_LIMIT = 64;

const listeners = new Set();
let operation = 0;
let pendingMutations = 0;
let state = Object.freeze({
    known: false,
    loggedIn: false,
    username: '',
    nsfwEnabled: false,
    nsflEnabled: false,
    nsflActive: null,
    error: null,
    revision: 0,
});

function normalize(value) {
    return {
        known: true,
        loggedIn: value?.loggedIn === true,
        username: typeof value?.username === 'string' ? value.username.slice(0, USERNAME_LIMIT) : '',
        nsfwEnabled: value?.nsfwEnabled === true,
        nsflEnabled: value?.nsflEnabled === true,
        nsflActive: typeof value?.nsflActive === 'boolean' ? value.nsflActive : null,
    };
}

function samePublicState(left, right) {
    return left.known === right.known
        && left.loggedIn === right.loggedIn
        && left.username === right.username
        && left.nsfwEnabled === right.nsfwEnabled
        && left.nsflEnabled === right.nsflEnabled
        && left.nsflActive === right.nsflActive;
}

function publish(value, { forceRevision = false, error = null } = {}) {
    const next = normalize(value);
    const changed = forceRevision || !samePublicState(state, next) || state.error !== error;
    state = Object.freeze({
        ...next,
        error,
        revision: state.revision + (changed ? 1 : 0),
    });
    for (const listener of listeners) {
        listener(state);
    }
    return state;
}

export function getBotbooruAccount() {
    return state;
}

export function subscribeBotbooruAccount(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
}

// A read cannot describe a session being replaced. Older replies, including
// failures, return retained state rather than reaching a newer control's catch.
export async function refreshBotbooruAccount({ signal } = {}) {
    if (pendingMutations > 0) {
        return getBotbooruAccount();
    }
    const expectedOperation = ++operation;
    try {
        const result = await post('/account/status', { source: SOURCE }, { signal });
        if (expectedOperation === operation) {
            publish(result);
        }
    } catch (error) {
        if (expectedOperation !== operation) {
            return getBotbooruAccount();
        }
        publishAccountError(error);
        throw error;
    }
    return getBotbooruAccount();
}

export async function loginBotbooruAccount(username, password, { signal } = {}) {
    pendingMutations++;
    const expectedOperation = ++operation;
    try {
        const result = await post('/account/login', {
            source: SOURCE,
            username,
            password,
        }, { signal });
        if (expectedOperation === operation) {
            publish(result, { forceRevision: true });
        }
        return getBotbooruAccount();
    } catch (error) {
        if (expectedOperation !== operation) {
            return getBotbooruAccount();
        }
        publishAccountError(error);
        throw error;
    } finally {
        pendingMutations--;
    }
}

export async function setBotbooruNsfw(enabled, { signal } = {}) {
    pendingMutations++;
    const expectedOperation = ++operation;
    try {
        const result = await post('/account/nsfw', {
            source: SOURCE,
            enabled: enabled === true,
        }, { signal });
        if (expectedOperation === operation) {
            publish(result, { forceRevision: true });
        }
        return getBotbooruAccount();
    } catch (error) {
        if (expectedOperation !== operation) {
            return getBotbooruAccount();
        }
        publishAccountError(error);
        throw error;
    } finally {
        pendingMutations--;
    }
}

export async function logoutBotbooruAccount({ signal } = {}) {
    pendingMutations++;
    const expectedOperation = ++operation;
    try {
        const result = await post('/account/logout', { source: SOURCE }, { signal });
        if (expectedOperation === operation) {
            publish(result, { forceRevision: true });
        }
        return getBotbooruAccount();
    } catch (error) {
        if (expectedOperation !== operation) {
            return getBotbooruAccount();
        }
        publishAccountError(error);
        throw error;
    } finally {
        pendingMutations--;
    }
}

/**
 * Synchronizes an account failure returned by search or detail with every open
 * surface. Merged-search failures also use this path; the browser removes only
 * BotBooru records while preserving valid results from other sources.
 */
export function noteBotbooruAccountError(error) {
    // A response from a request issued before a login or preference mutation
    // cannot authoritatively describe the session that mutation is replacing.
    if (pendingMutations > 0) {
        return false;
    }
    return publishAccountError(error);
}

function publishAccountError(error) {
    const code = error?.code;
    if (![
        'botbooru_login_required',
        'botbooru_session_expired',
        'botbooru_nsfw_disabled',
    ].includes(code)) {
        return false;
    }

    operation++;
    if (code === 'botbooru_nsfw_disabled' && state.loggedIn) {
        publish({ ...state, nsfwEnabled: false }, { forceRevision: true, error: code });
    } else {
        publish({ loggedIn: false }, { forceRevision: true, error: code });
    }
    return true;
}

const saucepanListeners = new Set();
let saucepanOperation = 0;
let saucepanPendingMutations = 0;
let saucepanState = Object.freeze({ known: false, loggedIn: false, error: null, revision: 0 });

function publishSaucepan(value, { forceRevision = false, error = null } = {}) {
    const loggedIn = value?.loggedIn === true;
    const changed = forceRevision || !saucepanState.known
        || saucepanState.loggedIn !== loggedIn || saucepanState.error !== error;
    saucepanState = Object.freeze({
        known: true, loggedIn, error,
        revision: saucepanState.revision + (changed ? 1 : 0),
    });
    for (const listener of saucepanListeners) {
        listener(saucepanState);
    }
    return saucepanState;
}

export function getSaucepanAccount() {
    return saucepanState;
}

export function subscribeSaucepanAccount(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    saucepanListeners.add(listener);
    listener(saucepanState);
    return () => saucepanListeners.delete(listener);
}

export async function refreshSaucepanAccount({ signal } = {}) {
    if (saucepanPendingMutations > 0) {
        return getSaucepanAccount();
    }
    const expectedOperation = ++saucepanOperation;
    try {
        const result = await post('/account/status', { source: 'saucepan' }, { signal });
        if (expectedOperation === saucepanOperation) {
            publishSaucepan(result);
        }
    } catch (error) {
        if (expectedOperation !== saucepanOperation) {
            return getSaucepanAccount();
        }
        publishSaucepanError(error);
        throw error;
    }
    return getSaucepanAccount();
}

export function loginSaucepanAccount(username, password, options) {
    return mutateSaucepan('/account/login', { username, password }, options);
}

export function setSaucepanToken(token, options) {
    return mutateSaucepan('/account/token', { token }, options);
}

export function logoutSaucepanAccount(options) {
    return mutateSaucepan('/account/logout', {}, options);
}

async function mutateSaucepan(path, body, { signal } = {}) {
    saucepanPendingMutations++;
    const expectedOperation = ++saucepanOperation;
    try {
        const result = await post(path, { source: 'saucepan', ...body }, { signal });
        if (expectedOperation === saucepanOperation) {
            publishSaucepan(result, { forceRevision: true });
        }
        return getSaucepanAccount();
    } catch (error) {
        if (expectedOperation !== saucepanOperation) {
            return getSaucepanAccount();
        }
        publishSaucepanError(error);
        throw error;
    } finally {
        saucepanPendingMutations--;
    }
}

export function noteSaucepanAccountError(error) {
    return saucepanPendingMutations === 0 && publishSaucepanError(error);
}

function publishSaucepanError(error) {
    if (!['saucepan_login_required', 'saucepan_session_expired'].includes(error?.code)) {
        return false;
    }
    saucepanOperation++;
    publishSaucepan({ loggedIn: false }, { forceRevision: true, error: error.code });
    return true;
}

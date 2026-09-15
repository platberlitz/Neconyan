import crypto from 'node:crypto';

import { FIELD_LIMITS } from '../shared/schema.js';
import { botbooru } from './sources/botbooru.js';
import { contextFor } from './http.js';
import { UpstreamError } from './guards.js';
import { saucepan } from './sources/saucepan.js';

const VALIDATION_TTL_MS = 60_000;

export class AccountError extends Error {
    constructor(code, status) {
        super(code);
        this.name = 'AccountError';
        this.code = code;
        this.status = status;
    }
}

export function accountProfileHandle(request) {
    const handle = request?.user?.profile?.handle;
    return typeof handle === 'string'
        && handle.trim() !== ''
        && handle.length <= FIELD_LIMITS.id
        ? handle
        : null;
}

function signedOut() {
    return {
        source: 'botbooru',
        loggedIn: false,
        username: null,
        nsfwEnabled: false,
        nsflEnabled: false,
        nsflActive: null,
    };
}

function publicSession(session) {
    return {
        source: 'botbooru',
        loggedIn: true,
        username: session.username,
        nsfwEnabled: session.showNsfw,
        nsflEnabled: session.showNsfl,
        nsflActive: session.showNsflActive,
    };
}

function requireHandle(handle) {
    if (typeof handle !== 'string' || handle.trim() === '' || handle.length > FIELD_LIMITS.id) {
        throw new AccountError('account_profile_required', 401);
    }
    return handle;
}

function validToken(token) {
    return typeof token === 'string'
        && token.length <= FIELD_LIMITS.accountToken
        && /^[\x21-\x7e]+$/.test(token);
}

function hasHttpStatus(error, statuses) {
    return error instanceof UpstreamError
        && error.code === 'http_error'
        && statuses.includes(String(error.detail));
}

const isCredentialRejection = (error) => hasHttpStatus(error, ['400', '401', '403']);
const isExpiredSession = (error) => hasHttpStatus(error, ['401']);

function accountUnavailable(error) {
    if (error instanceof AccountError) {
        return error;
    }
    return new AccountError('botbooru_auth_unavailable', 502);
}

function normalizeAccount(value, fallbackUsername) {
    const username = typeof value?.username === 'string'
        ? value.username.trim().slice(0, FIELD_LIMITS.accountUsername)
        : fallbackUsername;
    if (username === '') {
        throw new AccountError('botbooru_auth_unavailable', 502);
    }
    return {
        username,
        showNsfw: value?.showNsfw === true,
        showNsfl: value?.showNsfl === true,
        showNsflActive: typeof value?.showNsflActive === 'boolean' ? value.showNsflActive : null,
    };
}

/**
 * Per-Neconyan-profile BotBooru sessions. Passwords never enter this store;
 * only the opaque bearer returned after login is retained, and only in RAM.
 */
export function createBotbooruAccounts({
    adapter = botbooru,
    makeContext = contextFor,
    now = () => Date.now(),
    randomNonce = () => crypto.randomBytes(18).toString('base64url'),
    validationTtlMs = VALIDATION_TTL_MS,
} = {}) {
    const sessions = new Map();
    const generations = new Map();
    const activeMutations = new Map();
    const activeRefreshes = new Map();

    const generation = (handle) => generations.get(handle) ?? 0;
    const beginMutation = (handle) => {
        const next = generation(handle) + 1;
        generations.set(handle, next);
        return next;
    };
    const beginExclusiveMutation = (handle) => {
        if (activeMutations.has(handle)) {
            throw new AccountError('botbooru_account_changed', 409);
        }
        const operation = beginMutation(handle);
        activeMutations.set(handle, operation);
        return operation;
    };
    const finishMutation = (handle, operation) => {
        if (activeMutations.get(handle) === operation) {
            activeMutations.delete(handle);
        }
    };

    const authenticatedContext = (token, options) => makeContext(adapter, { ...options, bearerToken: token });

    async function performRefresh(handle, session) {
        const expectedGeneration = generation(handle);
        let account;
        try {
            account = normalizeAccount(
                await adapter.getAccount(authenticatedContext(session.token), session.username),
                session.username,
            );
        } catch (error) {
            if (isExpiredSession(error)) {
                if (generation(handle) === expectedGeneration && sessions.get(handle) === session) {
                    sessions.delete(handle);
                }
                throw new AccountError('botbooru_session_expired', 401);
            }
            throw accountUnavailable(error);
        }

        if (generation(handle) !== expectedGeneration || sessions.get(handle) !== session) {
            throw new AccountError('botbooru_account_changed', 409);
        }

        const refreshed = Object.freeze({ ...session, ...account, validatedAt: now() });
        sessions.set(handle, refreshed);
        return refreshed;
    }

    async function refresh(handle, session) {
        const active = activeRefreshes.get(handle);
        if (active?.session === session) {
            return active.promise;
        }

        const promise = performRefresh(handle, session);
        const entry = { session, promise };
        activeRefreshes.set(handle, entry);
        try {
            return await promise;
        } finally {
            if (activeRefreshes.get(handle) === entry) {
                activeRefreshes.delete(handle);
            }
        }
    }

    async function requireSession(handle, { requireNsfw = false } = {}) {
        requireHandle(handle);
        let session = sessions.get(handle);
        if (!session) {
            throw new AccountError('botbooru_login_required', 401);
        }
        if (now() - session.validatedAt >= validationTtlMs) {
            session = await refresh(handle, session);
        }
        if (requireNsfw && !session.showNsfw) {
            throw new AccountError('botbooru_nsfw_disabled', 403);
        }
        return session;
    }

    return Object.freeze({
        async status(handle) {
            requireHandle(handle);
            const session = sessions.get(handle);
            return session ? publicSession(await requireSession(handle)) : signedOut();
        },

        async login(handle, username, password) {
            requireHandle(handle);
            const normalizedUsername = typeof username === 'string' ? username.trim() : '';
            if (normalizedUsername === '' || normalizedUsername.length > FIELD_LIMITS.accountUsername
                || typeof password !== 'string' || password.length === 0
                || password.length > FIELD_LIMITS.accountPassword) {
                throw new AccountError('bad_account_request', 400);
            }

            const operation = beginExclusiveMutation(handle);
            try {
                let token;
                try {
                    token = await adapter.login(makeContext(adapter), normalizedUsername, password);
                } catch (error) {
                    if (isCredentialRejection(error)) {
                        throw new AccountError('botbooru_invalid_credentials', 401);
                    }
                    throw accountUnavailable(error);
                }
                if (!validToken(token)) {
                    throw new AccountError('botbooru_auth_unavailable', 502);
                }

                let account;
                try {
                    account = normalizeAccount(
                        await adapter.getAccount(authenticatedContext(token), normalizedUsername),
                        normalizedUsername,
                    );
                } catch (error) {
                    if (isCredentialRejection(error)) {
                        throw new AccountError('botbooru_invalid_credentials', 401);
                    }
                    throw accountUnavailable(error);
                }

                if (generation(handle) !== operation) {
                    throw new AccountError('botbooru_account_changed', 409);
                }

                const session = Object.freeze({
                    token,
                    ...account,
                    validatedAt: now(),
                    generation: operation,
                    nonce: randomNonce(),
                });
                sessions.set(handle, session);
                return publicSession(session);
            } finally {
                finishMutation(handle, operation);
            }
        },

        async setNsfw(handle, enabled) {
            requireHandle(handle);
            if (typeof enabled !== 'boolean') {
                throw new AccountError('bad_account_request', 400);
            }
            const operation = beginExclusiveMutation(handle);
            try {
                const current = await requireSession(handle);
                if (generation(handle) !== operation) {
                    throw new AccountError('botbooru_account_changed', 409);
                }
                let patched = false;
                let account;
                try {
                    // Finish the bounded write/verification even if the browser
                    // disconnects, so local state reflects the upstream outcome.
                    const ctx = authenticatedContext(current.token);
                    await adapter.updateNsfw(ctx, enabled);
                    patched = true;
                    account = normalizeAccount(await adapter.getAccount(ctx, current.username), current.username);
                } catch (error) {
                    if (isExpiredSession(error)) {
                        if (generation(handle) === operation) {
                            sessions.delete(handle);
                        }
                        throw new AccountError('botbooru_session_expired', 401);
                    }
                    if (patched && generation(handle) === operation && sessions.get(handle) === current) {
                        sessions.set(handle, Object.freeze({ ...current, validatedAt: 0 }));
                    }
                    throw accountUnavailable(error);
                }

                if (generation(handle) !== operation) {
                    throw new AccountError('botbooru_account_changed', 409);
                }
                const session = Object.freeze({
                    ...current,
                    ...account,
                    validatedAt: now(),
                    generation: operation,
                    nonce: randomNonce(),
                });
                sessions.set(handle, session);
                return publicSession(session);
            } finally {
                finishMutation(handle, operation);
            }
        },

        logout(handle) {
            requireHandle(handle);
            beginMutation(handle);
            sessions.delete(handle);
            return signedOut();
        },

        preflightSearch(handle, sfwOnly) {
            if (sfwOnly !== false) {
                return;
            }
            requireHandle(handle);
            const session = sessions.get(handle);
            if (!session) {
                throw new AccountError('botbooru_login_required', 401);
            }
            if (!session.showNsfw) {
                throw new AccountError('botbooru_nsfw_disabled', 403);
            }
        },

        async searchRequest(handle, sfwOnly, options) {
            // Only an explicit false opts into account-visible content. Missing
            // or malformed input must fail closed to the anonymous SFW catalog.
            if (sfwOnly !== false) {
                return { context: makeContext(adapter, options), sessionNonce: null };
            }
            const session = await requireSession(handle, { requireNsfw: true });
            return { context: authenticatedContext(session.token, options), sessionNonce: session.nonce };
        },

        async detailRequest(handle, nonce, options) {
            if (typeof nonce !== 'string') {
                return { context: makeContext(adapter, options), sessionNonce: null };
            }
            const session = await requireSession(handle, { requireNsfw: true });
            if (session.nonce !== nonce) {
                throw new AccountError('botbooru_account_changed', 409);
            }
            return { context: authenticatedContext(session.token, options), sessionNonce: session.nonce };
        },

        async thumbnailRequest(handle, nonce) {
            const session = await requireSession(handle, { requireNsfw: true });
            if (typeof nonce !== 'string' || session.nonce !== nonce) {
                throw new AccountError('botbooru_account_changed', 409);
            }
            // Preview URLs are public once known. Validate the live account and
            // nonce here, then fetch without forwarding the full bearer.
            return makeContext(adapter);
        },

        invalidate(handle, nonce) {
            if (typeof handle !== 'string') {
                return;
            }
            const session = sessions.get(handle);
            if (session && (nonce === undefined || session.nonce === nonce)) {
                beginMutation(handle);
                sessions.delete(handle);
            }
        },

        clear() {
            sessions.clear();
            generations.clear();
            activeMutations.clear();
            activeRefreshes.clear();
        },
    });
}

/**
 * Profile-scoped Saucepan bearer sessions. Passwords and pasted tokens never
 * leave this process after the upstream call; status responses contain no
 * credential material.
 */
export function createSaucepanAccounts({
    adapter = saucepan,
    makeContext = contextFor,
} = {}) {
    const sessions = new Map();
    const generations = new Map();
    const generation = (handle) => generations.get(handle) ?? 0;
    const beginMutation = (handle) => {
        const next = generation(handle) + 1;
        generations.set(handle, next);
        return next;
    };

    const signedOut = () => ({ source: 'saucepan', loggedIn: false });
    const signedIn = () => ({ source: 'saucepan', loggedIn: true });
    const requireHandle = (handle) => {
        if (typeof handle !== 'string' || handle.trim() === '' || handle.length > FIELD_LIMITS.id) {
            throw new AccountError('account_profile_required', 401);
        }
        return handle;
    };
    const validToken = (token) => typeof token === 'string'
        && token.length > 0
        && token.length <= FIELD_LIMITS.accountToken
        && /^[\x21-\x7e]+$/.test(token);
    const tokenContext = (token, options) => makeContext(adapter, { ...options, bearerToken: token });

    return Object.freeze({
        status(handle) {
            requireHandle(handle);
            return sessions.has(handle) ? signedIn() : signedOut();
        },

        async login(handle, username, password) {
            requireHandle(handle);
            const normalizedUsername = typeof username === 'string' ? username.trim() : '';
            if (normalizedUsername === '' || normalizedUsername.length > FIELD_LIMITS.accountUsername
                || typeof password !== 'string' || password.length === 0
                || password.length > FIELD_LIMITS.accountPassword) {
                throw new AccountError('bad_saucepan_request', 400);
            }

            const operation = beginMutation(handle);
            let token;
            try {
                token = await adapter.login(makeContext(adapter), normalizedUsername, password);
            } catch (error) {
                if (hasHttpStatus(error, ['400', '401', '403'])) {
                    throw new AccountError('saucepan_invalid_credentials', 401);
                }
                throw new AccountError('saucepan_auth_unavailable', 502);
            }
            if (!validToken(token)) {
                throw new AccountError('saucepan_auth_unavailable', 502);
            }
            if (generation(handle) !== operation) {
                throw new AccountError('saucepan_account_changed', 409);
            }
            sessions.set(handle, token);
            return signedIn();
        },

        setToken(handle, token) {
            requireHandle(handle);
            if (!validToken(token)) {
                throw new AccountError('bad_saucepan_request', 400);
            }
            beginMutation(handle);
            sessions.set(handle, token);
            return signedIn();
        },

        cardRequest(handle, options) {
            requireHandle(handle);
            const token = sessions.get(handle);
            if (!token) {
                throw new AccountError('saucepan_login_required', 401);
            }
            return { context: tokenContext(token, options), sessionVersion: generation(handle) };
        },

        logout(handle) {
            requireHandle(handle);
            beginMutation(handle);
            sessions.delete(handle);
            return signedOut();
        },

        invalidate(handle, sessionVersion) {
            if (typeof handle === 'string' && generation(handle) === sessionVersion) {
                beginMutation(handle);
                sessions.delete(handle);
            }
        },

        clear() {
            sessions.clear();
            generations.clear();
        },
    });
}

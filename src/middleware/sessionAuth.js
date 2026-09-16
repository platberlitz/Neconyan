import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import storage from 'node-persist';

import { getConfigValue } from '../util.js';
import { toKey, getPasswordHash } from '../users.js';

export const SESSION_DURATION_MS = getConfigValue('sessionAuth.durationMinutes', 480, 'number') * 60 * 1000;
const SESSION_AUTH_ENABLED = getConfigValue('sessionAuth.enabled', false, 'boolean');

// How long a sign-in lasts when 'Remember this device for 30 days' is ticked.
export const REMEMBER_AUTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Applies the cookie lifetime for a browser sign-in. Own properties are set on
 * sessionOptions so they shadow the defaults inherited from the cookie-session
 * configuration; when the cookie is serialised, a numeric maxAge overrides any
 * expires value, and a null maxAge produces a browser-session cookie.
 * @param {import('express').Request} request
 * @param {number|null} rememberMs Absolute lifetime in milliseconds, or null for a browser-session cookie
 */
export function applySessionCookieOptions(request, rememberMs) {
    const options = request.sessionOptions;
    if (!options) return;
    options.maxAge = null;
    options.expires = rememberMs == null ? undefined : new Date(Date.now() + rememberMs);
}

/** @type {Map<string, {username: string, expires: number}>} */
const sessions = new Map();
let loadedRoot;

function sessionKey(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function loadSessions() {
    const root = globalThis.DATA_ROOT;
    if (!root || loadedRoot === root) return;
    sessions.clear();
    const filename = path.join(root, '_auth', 'sessions.json');
    try {
        for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(filename, 'utf8')))) {
            if (/^[a-f0-9]{64}$/.test(key) && typeof value?.username === 'string' && value.expires > Date.now()) sessions.set(key, value);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    loadedRoot = root;
}

function persistSessions() {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    if (!globalThis.DATA_ROOT) return;
    const directory = path.join(globalThis.DATA_ROOT, '_auth');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(path.join(directory, 'sessions.json'), JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
}

export function credentialVersion(username, passwordHash) {
    return crypto.createHash('sha256').update(JSON.stringify([username, passwordHash])).digest('hex');
}

/**
 * Creates a new session for the given username.
 * @param {string} username
 * @param {{durationMs?: number, credentialVersion?: string, remember?: boolean}} [options]
 * @returns {string} Session token
 */
export function createSession(username, options = {}) {
    loadSessions();
    const token = crypto.randomBytes(48).toString('base64url');
    sessions.set(sessionKey(token), {
        username,
        expires: Date.now() + (options.durationMs || SESSION_DURATION_MS),
        ...(options.credentialVersion ? { credentialVersion: options.credentialVersion } : {}),
        ...(typeof options.remember === 'boolean' ? { remember: options.remember } : {}),
    });
    try {
        persistSessions();
    } catch (error) {
        sessions.delete(sessionKey(token));
        throw error;
    }
    return token;
}

/**
 * Validates a session token and returns the session if valid.
 * @param {string} token
 * @returns {{username: string, expires: number}|null}
 */
export function validateSession(token) {
    loadSessions();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(token)) return null;
    const key = sessionKey(token);
    const session = sessions.get(key);
    if (!session) {
        return null;
    }
    if (Date.now() >= session.expires) {
        sessions.delete(key);
        persistSessions();
        return null;
    }
    return session;
}

/**
 * Destroys a session by token.
 * @param {string} token
 */
export function destroySession(token) {
    loadSessions();
    sessions.delete(sessionKey(token));
    persistSessions();
}

/**
 * Checks if session auth is enabled.
 * @returns {boolean}
 */
export function isSessionAuthEnabled() {
    return SESSION_AUTH_ENABLED;
}

/**
 * Validates credentials against configured users.
 * Supports both single-user basic auth and per-user accounts.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function validateCredentials(username, password) {
    if (typeof username !== 'string' || !username || username.length > 320
        || typeof password !== 'string' || !password || password.length > 4096) return false;
    const perUserAuth = getConfigValue('perUserBasicAuth', false, 'boolean');
    const enableAccounts = getConfigValue('enableUserAccounts', false, 'boolean');
    const usePerUserAuth = perUserAuth && enableAccounts;

    if (!usePerUserAuth) {
        const configUsername = getConfigValue('basicAuthUser.username');
        const configPassword = getConfigValue('basicAuthUser.password');
        return username === configUsername && typeof configPassword === 'string' && !!configPassword
            && crypto.timingSafeEqual(crypto.createHash('sha256').update(password).digest(), crypto.createHash('sha256').update(configPassword).digest());
    }

    const user = await storage.getItem(toKey(username));
    return !!(user?.enabled && user.password && user.password === getPasswordHash(password, user.salt));
}

/**
 * Computes the credential fingerprint a remembered browser session must match.
 * Returns null when the identity no longer has a usable password.
 * @param {string} username
 * @returns {Promise<string|null>}
 */
export async function getSessionCredentialVersion(username) {
    const perUserAuth = getConfigValue('perUserBasicAuth', false, 'boolean');
    const enableAccounts = getConfigValue('enableUserAccounts', false, 'boolean');

    if (perUserAuth && enableAccounts) {
        const user = await storage.getItem(toKey(username));
        if (!user?.enabled || !user.password) return null;
        return credentialVersion(username, user.password);
    }

    const configuredUsername = getConfigValue('basicAuthUser.username');
    const password = getConfigValue('basicAuthUser.password');
    if (username !== configuredUsername || typeof password !== 'string' || !password) return null;
    return credentialVersion(username, password);
}

/** Validate browser tokens against the current credentials and keep every cookie rewrite within its original lifetime. */
export async function validateBrowserSession(request) {
    const token = request.session?.basicAuthToken;
    if (!token) return null;
    const session = validateSession(token);
    const version = session ? await getSessionCredentialVersion(session.username) : null;
    if (!version || session.credentialVersion !== version) {
        destroySession(token);
        request.session = {};
        return null;
    }
    applySessionCookieOptions(request, session.remember === false ? null : session.expires - Date.now());
    return session;
}

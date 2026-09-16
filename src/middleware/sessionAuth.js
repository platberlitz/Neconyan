import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import storage from 'node-persist';

import { getConfigValue } from '../util.js';
import { getAllUserHandles, toKey, getPasswordHash } from '../users.js';

const SESSION_DURATION_MS = getConfigValue('sessionAuth.durationMinutes', 480, 'number') * 60 * 1000;
const SESSION_AUTH_ENABLED = getConfigValue('sessionAuth.enabled', false, 'boolean');

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
 * @param {{durationMs?: number, credentialVersion?: string}} [options]
 * @returns {string} Session token
 */
export function createSession(username, options = {}) {
    loadSessions();
    const token = crypto.randomBytes(48).toString('base64url');
    sessions.set(sessionKey(token), {
        username,
        expires: Date.now() + (options.durationMs || SESSION_DURATION_MS),
        ...(options.credentialVersion ? { credentialVersion: options.credentialVersion } : {}),
    });
    persistSessions();
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
    if (Date.now() > session.expires) {
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
    const perUserAuth = getConfigValue('perUserBasicAuth', false, 'boolean');
    const enableAccounts = getConfigValue('enableUserAccounts', false, 'boolean');
    const usePerUserAuth = perUserAuth && enableAccounts;

    if (!usePerUserAuth) {
        const configUsername = getConfigValue('basicAuthUser.username');
        const configPassword = getConfigValue('basicAuthUser.password');
        return username === configUsername && password === configPassword;
    }

    const userHandles = await getAllUserHandles();
    for (const userHandle of userHandles) {
        if (username === userHandle) {
            const user = await storage.getItem(toKey(userHandle));
            if (user && user.enabled && user.password && user.password === getPasswordHash(password, user.salt)) {
                return true;
            }
        }
    }
    return false;
}

import crypto from 'node:crypto';
import storage from 'node-persist';

import { getConfigValue } from '../util.js';
import { getAllUserHandles, toKey, getPasswordHash } from '../users.js';

const SESSION_DURATION_MS = getConfigValue('sessionAuth.durationMinutes', 480, 'number') * 60 * 1000;
const SESSION_AUTH_ENABLED = getConfigValue('sessionAuth.enabled', false, 'boolean');

/** @type {Map<string, {username: string, expires: number}>} */
const sessions = new Map();

/**
 * Creates a new session for the given username.
 * @param {string} username
 * @returns {string} Session token
 */
export function createSession(username) {
    const token = crypto.randomBytes(48).toString('base64url');
    sessions.set(token, {
        username,
        expires: Date.now() + SESSION_DURATION_MS,
    });
    return token;
}

/**
 * Validates a session token and returns the session if valid.
 * @param {string} token
 * @returns {{username: string, expires: number}|null}
 */
export function validateSession(token) {
    const session = sessions.get(token);
    if (!session) {
        return null;
    }
    if (Date.now() > session.expires) {
        sessions.delete(token);
        return null;
    }
    return session;
}

/**
 * Destroys a session by token.
 * @param {string} token
 */
export function destroySession(token) {
    sessions.delete(token);
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

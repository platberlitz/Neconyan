/**
 * Browser sign-in endpoints: session status, username/password sign-in for the
 * shared workspace login, and passkey enrolment/sign-in for the same identity.
 *
 * Mounted inside the global CSRF protection, so every POST here requires a
 * valid X-CSRF-Token header. Passkey management additionally requires a valid
 * browser session and a password reconfirm.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { Router } from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { getConfigValue } from '../util.js';
import {
    validateCredentials,
    createSession,
    validateBrowserSession,
    destroySession,
    applySessionCookieOptions,
    getSessionCredentialVersion,
    REMEMBER_AUTH_MS,
    SESSION_DURATION_MS,
} from '../middleware/sessionAuth.js';
import { getIpAddress, retryAfter } from '../express-common.js';

const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const PER_USER_AUTH = ENABLE_ACCOUNTS && getConfigValue('perUserBasicAuth', false, 'boolean');
const PREFER_REAL_IP_HEADER = !!getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const AUTH_ATTEMPTS = getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number');

const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
};

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 1000;
const RP_NAME = 'Neconyan';

let basicAuthMode = false;

/**
 * Records whether the Basic authentication middleware guards this server, so
 * /api/auth/status can report it without the report itself being blocked by it.
 * @param {boolean} value
 */
export function setAuthRouterBasicAuthMode(value) {
    basicAuthMode = !!value;
}

const authLimiter = new RateLimiterMemory({
    points: AUTH_ATTEMPTS > 0 ? AUTH_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const challengeLimiter = new RateLimiterMemory({ points: 20, duration: 60 });

// In-memory, single-use challenge store: id → {challenge, kind, label, remember, username, expires}.
// Entries are consumed atomically on use, so a captured response cannot be replayed.
const challenges = new Map();

function createChallenge(request, kind, { challenge, label = '', remember = false, username = '' }) {
    for (const [id, entry] of challenges) {
        if (entry.expires <= Date.now()) challenges.delete(id);
    }
    if (challenges.size >= MAX_PENDING_CHALLENGES) return null;
    const id = crypto.randomBytes(24).toString('base64url');
    if (!request.session.passkeyBinding) request.session.passkeyBinding = crypto.randomBytes(32).toString('base64url');
    challenges.set(id, {
        challenge: challenge || crypto.randomBytes(32).toString('base64url'),
        kind,
        label: typeof label === 'string' ? label.slice(0, 64) : '',
        remember: remember === true,
        username: String(username || ''),
        expires: Date.now() + CHALLENGE_TTL_MS,
        binding: request.session.passkeyBinding,
        token: request.session.basicAuthToken,
        origin: getRequestOrigin(request),
    });
    return id;
}

function consumeChallenge(request, id, kind) {
    const key = String(id || '');
    const entry = challenges.get(key);
    challenges.delete(key);
    if (!entry || entry.kind !== kind || entry.expires <= Date.now()
        || entry.binding !== request.session?.passkeyBinding || entry.origin !== getRequestOrigin(request)
        || (kind === 'register' && entry.token !== request.session?.basicAuthToken)) return null;
    return entry;
}

// Passkey registry for the shared workspace login. Stored beside the session
// store with the same restrictive permissions. Identity is fixed at enrolment
// (identityUsername), so mode changes never reassign a credential.
/** @type {Map<string, {publicKey: string, counter: number, transports: string[], label: string, createdAt: number, lastUsedAt: number|null, identityUsername: string, deviceType: string, backedUp: boolean}>} */
const passkeys = new Map();
let registryUserId = '';
let loadedRegistryRoot = null;

function getRegistryFile() {
    return path.join(globalThis.DATA_ROOT, '_auth', 'passkeys.json');
}

function loadPasskeys() {
    const root = globalThis.DATA_ROOT;
    if (!root || loadedRegistryRoot === root) return;
    passkeys.clear();
    registryUserId = '';
    try {
        const data = JSON.parse(fs.readFileSync(getRegistryFile(), 'utf8'));
        if (typeof data?.webauthnUserId === 'string' && data.webauthnUserId) registryUserId = data.webauthnUserId;
        for (const [id, value] of Object.entries(data?.credentials || {})) {
            if (typeof value?.publicKey === 'string') passkeys.set(id, value);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    loadedRegistryRoot = root;
}

function persistPasskeys() {
    loadPasskeys();
    if (!globalThis.DATA_ROOT) return;
    if (!registryUserId) {
        registryUserId = crypto.randomBytes(32).toString('base64url');
    }
    const directory = path.join(globalThis.DATA_ROOT, '_auth');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(getRegistryFile(), JSON.stringify({
        webauthnUserId: registryUserId,
        credentials: Object.fromEntries(passkeys),
    }), { mode: 0o600 });
}

// Commit synchronously after verification, restoring memory if the disk write fails.
function savePasskey(id, value) {
    const previous = passkeys.get(id);
    if (value) passkeys.set(id, value); else passkeys.delete(id);
    try {
        persistPasskeys();
    } catch (error) {
        if (previous) passkeys.set(id, previous); else passkeys.delete(id);
        throw error;
    }
}

// The WebAuthn verifier is loaded lazily so that a runtime without it (or a
// broken install) degrades to password sign-in instead of blocking server boot.
let webauthnModule;
async function getWebAuthn() {
    if (!webauthnModule) {
        webauthnModule = await import('@simplewebauthn/server');
    }
    return webauthnModule;
}

function isLoopbackPeer(request) {
    const remote = request.socket?.remoteAddress || '';
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * Derives the canonical origin a passkey will be bound to. The forwarded
 * protocol header is only trusted when the peer is the local reverse proxy.
 * @param {import('express').Request} request
 * @returns {string|null}
 */
function getRequestOrigin(request) {
    const host = request.get('host');
    if (!host) return null;
    let proto = request.protocol;
    if (isLoopbackPeer(request)) {
        const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        if (forwarded === 'http' || forwarded === 'https') proto = forwarded;
    }
    try {
        return new URL(`${proto}://${host}`).origin;
    } catch {
        return null;
    }
}

function getRpId(origin) {
    try {
        return new URL(origin).hostname;
    } catch {
        return null;
    }
}

function base64urlToBytes(value) {
    return new Uint8Array(Buffer.from(String(value), 'base64url'));
}

function rejectCrossOrigin(credential) {
    const data = JSON.parse(Buffer.from(credential?.response?.clientDataJSON || '', 'base64url').toString());
    if (data.crossOrigin === true || data.topOrigin) throw new Error('Cross-origin passkeys are not supported');
}

function getIp(request) {
    return getIpAddress(request, PREFER_REAL_IP_HEADER);
}

/**
 * Validates the request's remembered browser session token.
 * @returns {{username: string, expires: number}|null}
 */
function getBrowserSession(request) {
    return request.browserAuth;
}

/**
 * Creates the remembered server-side token and matching cookie lifetime.
 * @returns {Promise<boolean>} false when the identity lost its password
 */
async function establishBrowserSession(request, username, remember, credentialId, record) {
    const version = await getSessionCredentialVersion(username);
    if (!version) return false;
    if (record && (passkeys.get(credentialId) !== record || record.credentialVersion !== version)) return false;
    if (request.session?.basicAuthToken) destroySession(request.session.basicAuthToken);
    request.session.basicAuthToken = createSession(username, {
        durationMs: remember ? REMEMBER_AUTH_MS : SESSION_DURATION_MS,
        credentialVersion: version,
        remember,
    });
    applySessionCookieOptions(request, remember ? REMEMBER_AUTH_MS : null);
    return true;
}

const router = Router();

router.use(async (request, response, next) => {
    response.set(NO_STORE_HEADERS);
    response.vary('Cookie');
    try {
        request.browserAuth = await validateBrowserSession(request);
        if (request.path === '/status') return next();
        if (!basicAuthMode || (request.path.startsWith('/passkeys') && PER_USER_AUTH)) return response.sendStatus(404);
        if (request.method === 'POST') {
            const origin = request.get('origin');
            if (origin && origin !== getRequestOrigin(request)) return response.status(403).json({ error: 'Sign in from this server address.' });
            const limit = await authLimiter.get(getIp(request));
            if (limit && limit.consumedPoints >= authLimiter.points) throw limit;
            if (request.path.endsWith('-options')) await challengeLimiter.consume(getIp(request));
        }
        if (request.path.startsWith('/passkeys')) loadPasskeys();
        return next();
    } catch (error) {
        if (error instanceof RateLimiterRes) return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
        console.error('Browser authentication unavailable:', error.message);
        return response.status(503).json({ error: 'Sign-in is unavailable right now.' });
    }
});

router.get('/status', (request, response) => {
    response.set(NO_STORE_HEADERS);
    response.vary('Cookie');
    const session = getBrowserSession(request);
    const handle = request.session?.handle || null;
    return response.json({
        authenticated: Boolean(session || handle),
        browserSession: Boolean(session),
        accountsEnabled: ENABLE_ACCOUNTS,
        basicAuthMode,
        passkeysEnabled: basicAuthMode && !PER_USER_AUTH,
        username: session?.username ?? handle,
    });
});

router.post('/browser/login', async (request, response) => {
    const ip = getIp(request);
    try {
        const rateLimit = await authLimiter.get(ip);
        if (rateLimit !== null && rateLimit.consumedPoints >= authLimiter.points) {
            throw rateLimit;
        }

        const { username, password, remember } = request.body || {};
        const valid = typeof username === 'string'
            && typeof password === 'string'
            && password.length > 0
            && username.length <= 320
            && await validateCredentials(username, password);
        if (!valid) {
            await authLimiter.consume(ip);
            return response.status(401).json({ error: 'That name or password did not match.' });
        }

        if (!request.session) {
            return response.status(503).json({ error: 'Sign-in is unavailable right now.' });
        }
        if (!(await establishBrowserSession(request, username, remember === true))) {
            return response.status(503).json({ error: 'Sign-in is unavailable right now.' });
        }
        await authLimiter.delete(ip);
        return response.json({ ok: true, remember: remember === true });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Browser sign-in rate limited:', ip, request.originalUrl);
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
        }
        console.error('Browser sign-in error:', error);
        return response.status(500).json({ error: 'Sign-in failed unexpectedly.' });
    }
});

router.post('/passkeys/login-options', async (request, response) => {
    const origin = getRequestOrigin(request);
    const rpId = getRpId(origin || '');
    if (!origin || !rpId) {
        return response.status(400).json({ error: 'Cannot determine the server address.' });
    }
    loadPasskeys();
    if (passkeys.size === 0) {
        return response.status(404).json({ error: 'No passkey is enrolled on this server yet.' });
    }
    const remember = request.body?.remember === true;
    try {
        const { generateAuthenticationOptions } = await getWebAuthn();
        const options = await generateAuthenticationOptions({
            rpID: rpId,
            userVerification: 'required',
            allowCredentials: [],
        });
        const challengeId = createChallenge(request, 'login', { challenge: options.challenge, remember });
        if (!challengeId) {
            return response.status(503).json({ error: 'Too many pending sign-in requests.' });
        }
        response.set(NO_STORE_HEADERS);
        return response.json({ challengeId, remember, options });
    } catch (error) {
        console.error('Passkey sign-in options error:', error);
        return response.status(503).json({ error: 'Passkeys are unavailable right now.' });
    }
});

router.post('/passkeys/login', async (request, response) => {
    const ip = getIp(request);
    try {
        const { challengeId, response: credentialResponse } = request.body || {};
        const entry = consumeChallenge(request, challengeId, 'login');
        if (!entry) {
            return response.status(400).json({ error: 'That sign-in request expired. Start again.' });
        }
        const origin = getRequestOrigin(request);
        const rpId = getRpId(origin || '');
        if (!origin || !rpId) {
            return response.status(400).json({ error: 'Cannot determine the server address.' });
        }
        loadPasskeys();
        const credentialId = credentialResponse?.id;
        const record = typeof credentialId === 'string' ? passkeys.get(credentialId) : null;
        if (!record) {
            await authLimiter.consume(ip);
            return response.status(401).json({ error: 'That passkey is not enrolled on this server.' });
        }
        if (record.credentialVersion !== await getSessionCredentialVersion(record.identityUsername)
            || record.origin !== origin || credentialResponse.response?.userHandle !== registryUserId) {
            throw new Error('Passkey owner or origin does not match');
        }
        const { verifyAuthenticationResponse } = await getWebAuthn();
        rejectCrossOrigin(credentialResponse);
        const verification = await verifyAuthenticationResponse({
            response: credentialResponse,
            expectedChallenge: entry.challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            requireUserVerification: true,
            credential: {
                id: credentialId,
                publicKey: base64urlToBytes(record.publicKey),
                counter: record.counter,
                transports: record.transports,
            },
        });
        if (!verification.verified) {
            await authLimiter.consume(ip);
            return response.status(401).json({ error: 'The passkey did not verify.' });
        }
        if (passkeys.get(credentialId) !== record) throw new Error('Passkey changed during verification');
        const updated = { ...record, counter: verification.authenticationInfo.newCounter, lastUsedAt: Date.now() };
        savePasskey(credentialId, updated);
        if (!request.session) {
            return response.status(503).json({ error: 'Sign-in is unavailable right now.' });
        }
        const wantsRemember = entry.remember;
        if (!(await establishBrowserSession(request, record.identityUsername, wantsRemember, credentialId, updated))) {
            return response.status(503).json({ error: 'Sign-in is unavailable right now.' });
        }
        await authLimiter.delete(ip);
        return response.json({ ok: true, remember: wantsRemember });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Passkey sign-in rate limited:', ip, request.originalUrl);
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
        }
        await authLimiter.consume(ip).catch(() => {});
        console.error('Passkey sign-in error:', error.message);
        return response.status(400).json({ error: 'The passkey could not be verified.' });
    }
});

router.post('/passkeys/register-options', async (request, response) => {
    const session = getBrowserSession(request);
    if (!session) {
        return response.status(401).json({ error: 'Sign in first.' });
    }
    const ip = getIp(request);
    try {
        const { label, password } = request.body || {};
        const cleanLabel = typeof label === 'string' ? label.trim().slice(0, 64) : '';
        if (!cleanLabel) {
            return response.status(400).json({ error: 'Give the passkey a short name.' });
        }
        const valid = typeof password === 'string' && password.length > 0 && await validateCredentials(session.username, password);
        if (!valid) {
            await authLimiter.consume(ip);
            return response.status(401).json({ error: 'That password did not match.' });
        }

        const origin = getRequestOrigin(request);
        const rpId = getRpId(origin || '');
        if (!origin || !rpId) {
            return response.status(400).json({ error: 'Cannot determine the server address.' });
        }
        loadPasskeys();
        if (passkeys.size >= 64) return response.status(400).json({ error: 'Remove an unused passkey before adding another.' });
        if (!registryUserId) {
            registryUserId = crypto.randomBytes(32).toString('base64url');
        }
        const { generateRegistrationOptions } = await getWebAuthn();
        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: rpId,
            userName: session.username,
            userDisplayName: session.username,
            userID: base64urlToBytes(registryUserId),
            attestationType: 'none',
            excludeCredentials: [...passkeys.entries()].map(([id, passkey]) => ({
                id,
                transports: passkey.transports,
            })),
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required',
            },
        });
        const challengeId = createChallenge(request, 'register', { challenge: options.challenge, label: cleanLabel, username: session.username });
        if (!challengeId) {
            return response.status(503).json({ error: 'Too many pending passkey requests.' });
        }
        response.set(NO_STORE_HEADERS);
        return response.json({ challengeId, options });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
        }
        console.error('Passkey enrolment options error:', error);
        return response.status(503).json({ error: 'Passkeys are unavailable right now.' });
    }
});

router.post('/passkeys/register-verify', async (request, response) => {
    const session = getBrowserSession(request);
    if (!session) {
        return response.status(401).json({ error: 'Sign in first.' });
    }
    const { challengeId, response: credentialResponse } = request.body || {};
    const entry = consumeChallenge(request, challengeId, 'register');
    if (!entry) {
        return response.status(400).json({ error: 'That enrolment request expired. Start again.' });
    }
    if (entry.username !== session.username) {
        return response.status(403).json({ error: 'That enrolment request belongs to a different sign-in.' });
    }
    const origin = getRequestOrigin(request);
    const rpId = getRpId(origin || '');
    if (!origin || !rpId) {
        return response.status(400).json({ error: 'Cannot determine the server address.' });
    }
    try {
        const { verifyRegistrationResponse } = await getWebAuthn();
        rejectCrossOrigin(credentialResponse);
        const verification = await verifyRegistrationResponse({
            response: credentialResponse,
            expectedChallenge: entry.challenge,
            expectedOrigin: origin,
            expectedRPID: rpId,
            requireUserVerification: true,
        });
        if (!verification.verified) {
            return response.status(400).json({ error: 'The passkey could not be verified.' });
        }
        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
        loadPasskeys();
        if (!await validateBrowserSession(request)) return response.sendStatus(401);
        if (passkeys.has(credential.id)) {
            return response.status(409).json({ error: 'That passkey is already enrolled.' });
        }
        savePasskey(credential.id, {
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            transports: credential.transports ?? [],
            label: entry.label,
            createdAt: Date.now(),
            lastUsedAt: null,
            identityUsername: session.username,
            credentialVersion: session.credentialVersion,
            origin,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
        });
        return response.json({ ok: true });
    } catch (error) {
        console.error('Passkey enrolment error:', error);
        return response.status(400).json({ error: 'The passkey could not be verified.' });
    }
});

router.get('/passkeys', (request, response) => {
    const session = getBrowserSession(request);
    if (!session) {
        return response.status(401).json({ error: 'Sign in first.' });
    }
    loadPasskeys();
    response.set(NO_STORE_HEADERS);
    return response.json({
        passkeys: [...passkeys.entries()].map(([id, passkey]) => ({
            id,
            label: passkey.label,
            createdAt: passkey.createdAt,
            lastUsedAt: passkey.lastUsedAt,
            deviceType: passkey.deviceType,
            backedUp: passkey.backedUp,
        })),
    });
});

router.post('/passkeys/remove', async (request, response) => {
    const session = getBrowserSession(request);
    if (!session) {
        return response.status(401).json({ error: 'Sign in first.' });
    }
    const ip = getIp(request);
    try {
        const { id, password } = request.body || {};
        loadPasskeys();
        if (typeof id !== 'string' || !passkeys.has(id)) {
            return response.status(404).json({ error: 'That passkey is already gone.' });
        }
        const valid = typeof password === 'string' && password.length > 0 && await validateCredentials(session.username, password);
        if (!valid) {
            await authLimiter.consume(ip);
            return response.status(401).json({ error: 'That password did not match.' });
        }
        savePasskey(id, null);
        return response.json({ ok: true });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
        }
        console.error('Passkey removal error:', error);
        return response.status(500).json({ error: 'The passkey could not be removed.' });
    }
});

export default router;

import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, toAvatarKey, getAccountVersion, isAcceptablePasswordInput, verifyPasswordHash } from '../users.js';
import { SETTINGS_FILE } from '../constants.js';
import { CONTENT_TYPES, getContentOfType } from './content-manager.js';
import { acceptAccountReset } from '../operations/account-reset.js';
import { readOperation } from '../operations/store.js';
import { publicRecord } from './operations.js';
import { restoreSettingsSnapshot } from '../settings-version.js';
import { color, Cache, getConfigValue } from '../util.js';
import { destroySession } from '../middleware/sessionAuth.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { writeTerminalOnly } from '../server-log-buffer.js';

const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const PRIVATE_AUTH_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const MAX_RESET_VERIFY_ATTEMPTS = 5;
const RESET_CACHE = new Cache(5 * 60 * 1000);
const RESET_FAILURE_CACHE = new Cache(5 * 60 * 1000);
const privatePasswordLimiter = new RateLimiterMemory({
    points: PRIVATE_AUTH_POINTS > 0 ? PRIVATE_AUTH_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const resetRequestLimiter = new RateLimiterMemory({
    points: PRIVATE_AUTH_POINTS > 0 ? PRIVATE_AUTH_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const resetVerifyLimiter = new RateLimiterMemory({
    points: PRIVATE_AUTH_POINTS > 0 ? PRIVATE_AUTH_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

function timingSafeStringEqual(candidate, expected) {
    if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
    const candidateBytes = Buffer.from(candidate, 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (candidateBytes.length !== expectedBytes.length) return false;
    return crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function getPrivateLimitKey(request) {
    const handle = request.user?.profile?.handle || 'anonymous';
    return `${handle}:${getIpAddress(request, PREFER_REAL_IP_HEADER)}`;
}

export const router = express.Router();

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }
        if (request.session.basicAuthToken) destroySession(request.session.basicAuthToken);
        request.session.handle = null;
        request.session.csrfToken = null;
        request.session.version = null;
        request.session = null;
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.get('/me', async (request, response) => {
    try {
        if (!request.user) return response.sendStatus(403);
        const user = request.user.profile;
        return response.json({ handle: user.handle, name: user.name, avatar: await getUserAvatar(user.handle),
            admin: user.admin, password: !!user.password, created: user.created });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-avatar', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change avatar failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }
        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'You do not have permission to do that.' });
        }
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            console.warn('Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'That picture could not be read.' });
        }
        const user = await storage.getItem(toKey(request.body.handle));
        if (!user) {
            console.error('Change avatar failed: User not found');
            return response.status(404).json({ error: 'That user could not be found.' });
        }
        await storage.setItem(toAvatarKey(request.body.handle), request.body.avatar);
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-password', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle) {
            console.warn('Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }
        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change password failed: Unauthorized');
            return response.status(403).json({ error: 'You do not have permission to do that.' });
        }
        if (request.body.newPassword !== undefined && request.body.newPassword !== '' && !isAcceptablePasswordInput(request.body.newPassword)) {
            return response.status(400).json({ error: 'That password is not valid.' });
        }
        const limitKey = getPrivateLimitKey(request);
        const rateLimit = await privatePasswordLimiter.get(limitKey);
        if (rateLimit !== null && rateLimit.consumedPoints >= privatePasswordLimiter.points) {
            throw rateLimit;
        }
        const user = await storage.getItem(toKey(request.body.handle));
        if (!user) {
            console.error('Change password failed: User not found');
            return response.status(404).json({ error: 'That user could not be found.' });
        }
        if (!user.enabled) {
            console.error('Change password failed: User is disabled');
            return response.status(403).json({ error: 'This account is turned off. Ask an admin to turn it back on.' });
        }
        if (!request.user.profile.admin && user.password) {
            if (!verifyPasswordHash(request.body.oldPassword ?? '', user.password, user.salt)) {
                await privatePasswordLimiter.consume(limitKey);
                console.error('Change password failed: Incorrect password');
                return response.status(403).json({ error: 'That password is not correct.' });
            }
            await privatePasswordLimiter.delete(limitKey);
        }
        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
        } else {
            user.password = '';
            user.salt = '';
        }
        await storage.setItem(toKey(request.body.handle), user);
        if (request.session && request.session.handle === user.handle) request.session.version = getAccountVersion(user);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Try again later.' });
        }
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/backup', (_request, response) => {
    response.status(409).json({ code: 'NATIVE_OPERATION_REQUIRED', error: 'Submit an account-backup operation to /api/operations/submit and download its saved result.' });
});

router.post(['/import-sillytavern/folder', '/import-sillytavern/extensions', '/import-sillytavern/zip'], async (request, response) => {
    if (request.file?.path) await fsPromises.rm(request.file.path, { force: true }).catch(() => {});
    response.status(409).json({ code: 'NATIVE_OPERATION_REQUIRED', error: 'Retain ZIP uploads through /api/operations/import-input, then submit an account-import operation and observe its saved result.' });
});

router.post('/reset-settings', async (request, response) => {
    try {
        const limitKey = getPrivateLimitKey(request);
        const rateLimit = await privatePasswordLimiter.get(limitKey);
        if (rateLimit !== null && rateLimit.consumedPoints >= privatePasswordLimiter.points) {
            throw rateLimit;
        }
        const password = request.body?.password ?? '';
        if (request.user.profile.password) {
            if (!verifyPasswordHash(password, request.user.profile.password, request.user.profile.salt)) {
                await privatePasswordLimiter.consume(limitKey);
                console.warn('Reset settings failed: Incorrect password');
                return response.status(403).json({ error: 'That password is not correct.' });
            }
            await privatePasswordLimiter.delete(limitKey);
        }
        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        restoreSettingsSnapshot(pathToFile, getContentOfType(CONTENT_TYPES.SETTINGS, 'json')[0]);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Try again later.' });
        }
        console.error('Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            console.warn('Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }
        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change name failed: Unauthorized');
            return response.status(403).json({ error: 'You do not have permission to do that.' });
        }
        const user = await storage.getItem(toKey(request.body.handle));
        if (!user) {
            console.warn('Change name failed: User not found');
            return response.status(404).json({ error: 'That user could not be found.' });
        }
        user.name = request.body.name;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Change name failed', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const limitKey = getPrivateLimitKey(request);
        const verifyLimit = await resetVerifyLimiter.get(limitKey);
        if (verifyLimit !== null && verifyLimit.consumedPoints >= resetVerifyLimiter.points) {
            throw verifyLimit;
        }
        await resetRequestLimiter.consume(limitKey);
        const resetCode = String(crypto.randomInt(1000, 10000));
        writeTerminalOnly(
            '',
            color.magenta(`${request.user.profile.name}, your account reset code is: `) + color.red(resetCode),
            '',
        );
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        RESET_FAILURE_CACHE.remove(request.user.profile.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Try again later.' });
        }
        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        const base = { owner: request.user.profile.handle, directories: request.user.directories };
        const key = request.body?.key;
        if (typeof key !== 'string' || !key || key.length > 200) return response.status(400).json({ error: 'The account reset request is missing. Start again.' });
        const previous = readOperation(base, key);
        if (previous) {
            if (previous.kind !== 'account-reset') return response.status(409).json({ error: 'This request belongs to a different task. Start again.' });
            const accepted = await acceptAccountReset(request, key);
            response.set('Cache-Control', 'no-store');
            return response.status(200).json({ ...accepted, record: publicRecord(accepted.record) });
        }
        const limitKey = getPrivateLimitKey(request);
        const rateLimit = await resetVerifyLimiter.get(limitKey);
        if (rateLimit !== null && rateLimit.consumedPoints >= resetVerifyLimiter.points) {
            throw rateLimit;
        }
        if (typeof request.body?.code !== 'string' || !request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }
        const handle = request.user.profile.handle;
        const recordResetFailure = async () => {
            const failures = (RESET_FAILURE_CACHE.get(handle) || 0) + 1;
            if (failures >= MAX_RESET_VERIFY_ATTEMPTS) {
                RESET_CACHE.remove(handle);
                RESET_FAILURE_CACHE.remove(handle);
            } else {
                RESET_FAILURE_CACHE.set(handle, failures);
            }
            await resetVerifyLimiter.consume(limitKey);
        };
        if (request.user.profile.password && !verifyPasswordHash(request.body.password ?? '', request.user.profile.password, request.user.profile.salt)) {
            await recordResetFailure();
            console.warn('Recover step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'That password is not correct.' });
        }
        const code = RESET_CACHE.get(handle);
        if (!code || !timingSafeStringEqual(request.body.code, code)) {
            await recordResetFailure();
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'That code is not correct.' });
        }
        console.info('Resetting account data:', handle);
        const accepted = await acceptAccountReset(request, key);
        await resetVerifyLimiter.delete(limitKey);
        await resetRequestLimiter.delete(limitKey);
        RESET_CACHE.remove(handle);
        RESET_FAILURE_CACHE.remove(handle);
        response.set('Cache-Control', 'no-store').set('X-Neconyan-Job', accepted.job.id);
        return response.status(202).json({ ...accepted, record: publicRecord(accepted.record) });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Try again later.' });
        }
        console.error('Recover step 2 failed:', error);
        if (String(error?.code).startsWith('ROLEPLAY_')) {
            return response.status(error.code === 'ROLEPLAY_INTENT_CONFLICT' ? 409 : 503).json({ error: error.code.slice(9).toLowerCase(), code: error.code });
        }
        return response.sendStatus(500);
    }
});

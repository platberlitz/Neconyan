import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { KEY_PREFIX, getUserAvatar, toKey, getPasswordHash, getPasswordSalt, getAccountVersion, isAcceptablePasswordInput, verifyPasswordHash } from '../users.js';
import { writeTerminalOnly } from '../server-log-buffer.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const MAX_CODE_VERIFY_ATTEMPTS = 5;
const MFA_CACHE = new Cache(5 * 60 * 1000);
const MFA_FAILURE_CACHE = new Cache(5 * 60 * 1000);

const generateRecoveryCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

function timingSafeStringEqual(candidate, expected) {
    if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
    const candidateBytes = Buffer.from(candidate, 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (candidateBytes.length !== expectedBytes.length) return false;
    return crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: LOGIN_POINTS > 0 ? LOGIN_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const recoverRequestLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const recoverVerifyLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .filter(x => x.enabled)
            .map(async user => {
                const avatar = await getUserAvatar(user.handle);
                return {
                    handle: user.handle,
                    name: user.name,
                    created: user.created,
                    avatar,
                    password: !!user.password,
                };
            });

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/login', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }

        const candidatePassword = request.body.password ?? '';
        if (!isAcceptablePasswordInput(candidatePassword)) {
            console.warn('Login failed: Invalid password input');
            return response.status(400).json({ error: 'That name or password is not correct.' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            verifyPasswordHash(candidatePassword, '', '');
            console.error('Login failed: User', request.body.handle, 'not found');
            return response.status(403).json({ error: 'That name or password is not correct.' });
        }

        if (!user.enabled) {
            verifyPasswordHash(candidatePassword, user.password, user.salt);
            console.warn('Login failed: User', user.handle, 'is disabled');
            if (DISCREET_LOGIN) {
                return response.status(403).json({ error: 'That name or password is not correct.' });
            }
            return response.status(403).json({ error: 'This account is turned off. Ask an admin to turn it back on.' });
        }

        if (user.password && !verifyPasswordHash(candidatePassword, user.password, user.salt)) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: 'That name or password is not correct.' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        await loginLimiter.delete(ip);
        request.session.handle = user.handle;
        request.session.version = getAccountVersion(user);
        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or recover your password.' });
        }

        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step1', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle) {
            console.warn('Recover step 1 failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await recoverRequestLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Recover step 1 failed: User', request.body.handle, 'not found');
            if (DISCREET_LOGIN) {
                return response.sendStatus(204);
            }
            return response.status(404).json({ error: 'That user could not be found.' });
        }

        if (!user.enabled) {
            console.error('Recover step 1 failed: User', user.handle, 'is disabled');
            if (DISCREET_LOGIN) {
                return response.sendStatus(204);
            }
            return response.status(403).json({ error: 'This account is turned off. Ask an admin to turn it back on.' });
        }

        const mfaCode = generateRecoveryCode();
        writeTerminalOnly(
            '',
            color.blue(`${user.name}, your password recovery code is: `) + color.magenta(mfaCode),
            '',
        );
        MFA_CACHE.set(user.handle, mfaCode);
        MFA_FAILURE_CACHE.remove(user.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 1 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step2', async (request, response) => {
    try {
        if (typeof request.body?.handle !== 'string' || !request.body.handle || typeof request.body?.code !== 'string' || !request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Some details are missing. Fill in every field and try again.' });
        }

        if (request.body.newPassword !== undefined && request.body.newPassword !== '' && !isAcceptablePasswordInput(request.body.newPassword)) {
            return response.status(400).json({ error: 'That password is not valid.' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await recoverVerifyLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints >= recoverVerifyLimiter.points) {
            throw rateLimit;
        }

        if (!user) {
            await recoverVerifyLimiter.consume(ip);
            console.error('Recover step 2 failed: User', request.body.handle, 'not found');
            if (DISCREET_LOGIN) {
                return response.status(403).json({ error: 'That code is not correct.' });
            }
            return response.status(404).json({ error: 'That user could not be found.' });
        }

        if (!user.enabled) {
            await recoverVerifyLimiter.consume(ip);
            console.warn('Recover step 2 failed: User', user.handle, 'is disabled');
            if (DISCREET_LOGIN) {
                return response.status(403).json({ error: 'That code is not correct.' });
            }
            return response.status(403).json({ error: 'This account is turned off. Ask an admin to turn it back on.' });
        }

        const mfaCode = MFA_CACHE.get(user.handle);

        if (!mfaCode || !timingSafeStringEqual(request.body.code, mfaCode)) {
            const failures = (MFA_FAILURE_CACHE.get(user.handle) || 0) + 1;
            if (failures >= MAX_CODE_VERIFY_ATTEMPTS) {
                MFA_CACHE.remove(user.handle);
                MFA_FAILURE_CACHE.remove(user.handle);
            } else {
                MFA_FAILURE_CACHE.set(user.handle, failures);
            }
            await recoverVerifyLimiter.consume(ip);
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(403).json({ error: 'That code is not correct.' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
            await storage.setItem(toKey(user.handle), user);
        } else {
            user.password = '';
            user.salt = '';
            await storage.setItem(toKey(user.handle), user);
        }

        if (request.session && request.session.handle === user.handle) {
            request.session.version = getAccountVersion(user);
        }

        await recoverVerifyLimiter.delete(ip);
        await recoverRequestLimiter.delete(ip);
        MFA_CACHE.remove(user.handle);
        MFA_FAILURE_CACHE.remove(user.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 2 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});

import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';
import storage from 'node-persist';
import express from 'express';
import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, toAvatarKey, getAccountVersion } from '../users.js';
import { SETTINGS_FILE } from '../constants.js';
import { CONTENT_TYPES, getContentOfType } from './content-manager.js';
import { acceptAccountReset } from '../operations/account-reset.js';
import { readOperation } from '../operations/store.js';
import { publicRecord } from './operations.js';
import { restoreSettingsSnapshot } from '../settings-version.js';
import { color, Cache } from '../util.js';
import { destroySession } from '../middleware/sessionAuth.js';

const RESET_CACHE = new Cache(5 * 60 * 1000);
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
            return response.status(400).json({ error: 'Missing required fields' });
        }
        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            console.warn('Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'Invalid data URL' });
        }
        const user = await storage.getItem(toKey(request.body.handle));
        if (!user) {
            console.error('Change avatar failed: User not found');
            return response.status(404).json({ error: 'User not found' });
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
        if (!request.body.handle) {
            console.warn('Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }
        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change password failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }
        const user = await storage.getItem(toKey(request.body.handle));
        if (!user) {
            console.error('Change password failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }
        if (!user.enabled) {
            console.error('Change password failed: User is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }
        if (!request.user.profile.admin && user.password && user.password !== getPasswordHash(request.body.oldPassword, user.salt)) {
            console.error('Change password failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
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
        const password = request.body.password;
        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(password, request.user.profile.salt)) {
            console.warn('Reset settings failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }
        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        restoreSettingsSnapshot(pathToFile, getContentOfType(CONTENT_TYPES.SETTINGS, 'json')[0]);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            console.warn('Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }
        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change name failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }
        const user = await storage.getItem(toKey(request.body.handle));
        if (!user) {
            console.warn('Change name failed: User not found');
            return response.status(404).json({ error: 'User not found' });
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
        const resetCode = String(crypto.randomInt(1000, 9999));
        console.log();
        console.log(color.magenta(`${request.user.profile.name}, your account reset code is: `) + color.red(resetCode));
        console.log();
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        const base = { owner: request.user.profile.handle, directories: request.user.directories };
        const key = request.body.key;
        if (typeof key !== 'string' || !key || key.length > 200) return response.status(400).json({ error: 'A reset operation key is required.' });
        const previous = readOperation(base, key);
        if (previous) {
            if (previous.kind !== 'account-reset') return response.status(409).json({ error: 'This key belongs to different work.' });
            const accepted = await acceptAccountReset(request, key);
            response.set('Cache-Control', 'no-store');
            return response.status(200).json({ ...accepted, record: publicRecord(accepted.record) });
        }
        if (!request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }
        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(request.body.password, request.user.profile.salt)) {
            console.warn('Recover step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'Incorrect password' });
        }
        const code = RESET_CACHE.get(request.user.profile.handle);
        if (!code || code !== request.body.code) {
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'Incorrect code' });
        }
        console.info('Resetting account data:', request.user.profile.handle);
        const accepted = await acceptAccountReset(request, key);
        RESET_CACHE.remove(request.user.profile.handle);
        response.set('Cache-Control', 'no-store').set('X-Neconyan-Job', accepted.job.id);
        return response.status(202).json({ ...accepted, record: publicRecord(accepted.record) });
    } catch (error) {
        console.error('Recover step 2 failed:', error);
        if (String(error?.code).startsWith('ROLEPLAY_')) {
            return response.status(error.code === 'ROLEPLAY_INTENT_CONFLICT' ? 409 : 503).json({ error: error.code.slice(9).toLowerCase(), code: error.code });
        }
        return response.sendStatus(500);
    }
});

/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import storage from 'node-persist';
import { csrfSync } from 'csrf-sync';
import { setConfigFilePath } from '../src/util.js';

test('account sign-out is marked before CSRF rejection, unlike provider and permission errors', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-account-expiry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, 'enableUserAccounts: true\n');
    setConfigFilePath(config);
    const { initUserStorage, toKey, getAccountVersion, setUserDataMiddleware, requireLoginMiddleware } = await import('../src/users.js');
    await initUserStorage(root);
    const user = await storage.getItem(toKey('default-user'));
    const app = express();
    app.use(cookieSession({ name: 'account-test', secret: 'account-test-secret' }));
    // Test-only sign-in establishes a real signed cookie with the current account version.
    app.get('/test-login', (req, res) => {
        req.session = { handle: user.handle, version: getAccountVersion(user), csrfToken: 'current-token' };
        res.sendStatus(204);
    });
    app.use(setUserDataMiddleware);
    app.use(csrfSync({
        getTokenFromState: req => req.session?.csrfToken,
        getTokenFromRequest: req => req.headers['x-csrf-token'],
    }).csrfSynchronisedProtection);
    app.use(requireLoginMiddleware);
    app.get('/private', (_req, res) => res.sendStatus(200));
    app.post('/save', (_req, res) => res.sendStatus(204));
    app.get('/provider', (_req, res) => res.sendStatus(401));
    app.get('/permission', (_req, res) => res.sendStatus(403));
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(url + '/test-login');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const headers = { Cookie: cookie, 'X-CSRF-Token': 'current-token' };

    for (const [route, status] of [['/private', 200], ['/provider', 401], ['/permission', 403]]) {
        const result = await fetch(url + route, { headers });
        assert.equal(result.status, status);
        assert.equal(result.headers.get('X-Neconyan-Auth'), null);
    }
    const staleCsrf = await fetch(url + '/save', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': 'stale-token' } });
    assert.equal(staleCsrf.status, 403);
    assert.equal(staleCsrf.headers.get('X-Neconyan-Auth'), null);

    // Cookie expiry loses both login and CSRF state. The sign-out marker must survive.
    for (const options of [{}, { method: 'POST', headers: { 'X-CSRF-Token': 'current-token' } }]) {
        const result = await fetch(url + (options.method ? '/save' : '/private'), options);
        assert.equal(result.status, 403);
        assert.equal(result.headers.get('X-Neconyan-Auth'), 'required');
    }

    for (const changedUser of [{ ...user, password: 'changed' }, { ...user, enabled: false }, null]) {
        if (changedUser) await storage.setItem(toKey(user.handle), changedUser);
        else await storage.removeItem(toKey(user.handle));
        const result = await fetch(url + '/private', { headers });
        assert.equal(result.status, 403);
        assert.equal(result.headers.get('X-Neconyan-Auth'), 'required');
    }
});

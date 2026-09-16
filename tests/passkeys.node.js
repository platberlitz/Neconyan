import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import { getConfig, setConfigFilePath } from '../src/util.js';

test('passkey management requires a current login, password, CSRF and a single-use browser-bound challenge', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-passkeys-'));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, 'basicAuthUser:\n  username: test-user\n  password: test-password\n');
    setConfigFilePath(config);
    const { default: router, setAuthRouterBasicAuthMode } = await import('../src/endpoints/auth.js');
    setAuthRouterBasicAuthMode(true);
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.use(cookieSession({ name: 'passkey-test', secret: 'test-secret', sameSite: 'lax', httpOnly: true }));
    const csrf = csrfSync({
        getTokenFromState: req => req.session.csrfToken,
        getTokenFromRequest: req => req.get('x-csrf-token'),
        storeTokenInState: (req, token) => { req.session.csrfToken = token; },
    });
    app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
    app.use(csrf.csrfSynchronisedProtection);
    app.use('/api/auth', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    async function browser() {
        const jar = new Map();
        let token;
        async function request(route, body, extraHeaders = {}) {
            const response = await fetch(url + route, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { Cookie: [...jar.values()].join('; '), 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}), ...extraHeaders },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            for (const cookie of response.headers.getSetCookie()) {
                const pair = cookie.split(';')[0];
                jar.set(pair.split('=')[0], pair);
            }
            return response;
        }
        token = (await (await request('/csrf-token')).json()).token;
        return request;
    }
    try {
        const request = await browser();
        for (const route of ['/passkeys/register-options', '/passkeys/register-verify', '/passkeys/remove']) {
            assert.equal((await request('/api/auth' + route, {})).status, 401);
        }
        assert.equal((await request('/api/auth/passkeys')).status, 401);
        assert.equal((await request('/api/auth/passkeys/login-options', {})).status, 404);
        const login = { username: 'test-user', password: 'test-password' };
        assert.equal((await request('/api/auth/browser/login', login)).status, 200);
        const enrol = { label: 'My phone', password: login.password };
        assert.equal((await request('/api/auth/passkeys/register-options', enrol, { 'X-CSRF-Token': 'wrong' })).status, 403);
        assert.equal((await request('/api/auth/passkeys/register-options', { ...enrol, password: 'wrong' })).status, 401);
        assert.equal((await request('/api/auth/passkeys/register-options', enrol, { Origin: 'https://foreign.example' })).status, 403);
        const options = async () => {
            const response = await request('/api/auth/passkeys/register-options', enrol);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('cache-control'), /no-store/);
            const data = await response.json();
            assert.equal(data.options.authenticatorSelection.residentKey, 'required');
            assert.equal(data.options.authenticatorSelection.userVerification, 'required');
            return data;
        };
        const first = await options();
        const verify = { challengeId: first.challengeId, response: {} };
        assert.equal((await request('/api/auth/passkeys/register-verify', verify)).status, 400);
        assert.match((await (await request('/api/auth/passkeys/register-verify', verify)).json()).error, /expired/);

        const second = await options();
        const otherBrowser = await browser();
        assert.equal((await otherBrowser('/api/auth/browser/login', login)).status, 200);
        const stolen = await otherBrowser('/api/auth/passkeys/register-verify', { challengeId: second.challengeId, response: {} });
        assert.match((await stolen.json()).error, /expired/);

        const expired = await options();
        const now = Date.now();
        t.mock.method(Date, 'now', () => now + 121000);
        const expiryResult = await request('/api/auth/passkeys/register-verify', { challengeId: expired.challengeId, response: {} });
        assert.match((await expiryResult.json()).error, /expired/);
        t.mock.restoreAll();

        // A copied cookie must stop working when the shared password changes.
        getConfig().basicAuthUser.password = 'changed-password';
        assert.equal((await (await request('/api/auth/status')).json()).browserSession, false);
        assert.equal((await request('/api/auth/passkeys')).status, 401);
        setAuthRouterBasicAuthMode(false);
        assert.equal((await request('/api/auth/browser/login', login)).status, 404);
    } finally {
        t.mock.restoreAll();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
/* global globalThis */

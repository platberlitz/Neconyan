import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import { getConfig, setConfigFilePath } from '../src/util.js';

test('browser sign-in page flow: allowlist, password login, remember choice, no popup, Basic ignored for browsers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-browser-auth-'));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, [
        'basicAuthUser:',
        '  username: test-user',
        '  password: test-password',
        'rateLimiting:',
        '  basicAuthMaxAttempts: 3',
        '',
    ].join('\n'));
    setConfigFilePath(config);
    const { default: basicAuth } = await import('../src/middleware/basicAuth.js');
    const { default: authRouter, setAuthRouterBasicAuthMode } = await import('../src/endpoints/auth.js');
    const { validateSession, getSessionCredentialVersion, SESSION_DURATION_MS, REMEMBER_AUTH_MS } = await import('../src/middleware/sessionAuth.js');
    const { router: usersRouter } = await import('../src/endpoints/users-private.js');
    setAuthRouterBasicAuthMode(true);

    const app = express();
    app.use(express.json());
    // Small inherited cookie lifetime on purpose: sign-ins must override it.
    app.use(cookieSession({ name: 'browser-test', secret: 'browser-secret', httpOnly: true, sameSite: 'lax', maxAge: 5000 }));
    app.use(basicAuth);
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => req.session?.csrfToken,
        getTokenFromRequest: (req) => req.headers['x-csrf-token']?.toString(),
        storeTokenInState: (req, token) => {
            if (req.session) req.session.csrfToken = token;
        },
        size: 32,
    });
    app.get('/csrf-token', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ token: csrfSyncProtection.generateToken(req) });
    });
    app.use(csrfSyncProtection.csrfSynchronisedProtection);
    app.use('/api/auth', authRouter);
    app.use('/api/users', usersRouter);
    app.get('/private', (_req, res) => res.json({ ok: true }));
    app.post('/touch', (req, res) => { req.session.touch = Date.now(); res.sendStatus(204); });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const jar = [];
    const withCookies = (headers = {}) => ({ ...headers, cookie: jar.join('; ') });
    const storeCookies = (response) => {
        for (const value of response.headers.getSetCookie()) {
            const [pair] = value.split(';');
            const name = pair.split('=')[0];
            const index = jar.findIndex(entry => entry.startsWith(name + '='));
            if (index >= 0) jar[index] = pair; else jar.push(pair);
        }
    };

    try {
        // The sign-in endpoints work without credentials; a plain API route does not.
        const tokenResponse = await fetch(url + '/csrf-token');
        assert.equal(tokenResponse.status, 200);
        const { token: csrfToken } = await tokenResponse.json();
        storeCookies(tokenResponse);

        const status = await fetch(url + '/api/auth/status', { headers: withCookies() });
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { authenticated: false, browserSession: false, accountsEnabled: false, basicAuthMode: true, passkeysEnabled: true, username: null });
        assert.equal(await getSessionCredentialVersion('former-owner'), null);

        // No passkeys enrolled yet: the login-options endpoint says so without credentials.
        const noPasskeys = await fetch(url + '/api/auth/passkeys/login-options', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }), body: '{}' });
        assert.equal(noPasskeys.status, 404);

        // A private route never challenges: navigations redirect, API calls get a plain 401.
        const navigation = await fetch(url + '/private', { headers: { accept: 'text/html' }, redirect: 'manual' });
        assert.equal(navigation.status, 302);
        assert.ok(navigation.headers.get('location').startsWith('/login'));
        assert.ok(!navigation.headers.get('www-authenticate'));
        const api = await fetch(url + '/private', { headers: { accept: 'application/json' } });
        assert.equal(api.status, 401);
        assert.ok(!api.headers.get('www-authenticate'));

        // Basic credentials are ignored for browser-style requests...
        const basicBrowser = await fetch(url + '/private', {
            headers: { accept: 'text/html', authorization: 'Basic ' + Buffer.from('test-user:test-password').toString('base64') },
            redirect: 'manual',
        });
        assert.equal(basicBrowser.status, 302);
        // ...and honoured for API clients, which cannot render the popup.
        const basicApi = await new Promise((resolve, reject) => http.get(url + '/private', { headers: { authorization: 'Basic ' + Buffer.from('test-user:test-password').toString('base64') } }, res => { res.resume(); resolve(res); }).on('error', reject));
        assert.equal(basicApi.statusCode, 200);
        assert.equal(basicApi.headers['set-cookie'], undefined);
        const cachedBasic = await fetch(url + '/private', { headers: { 'sec-fetch-mode': 'cors', authorization: 'Basic ' + Buffer.from('test-user:test-password').toString('base64') } });
        assert.equal(cachedBasic.status, 401);

        // CSRF protects the password sign-in endpoint.
        const noCsrf = await fetch(url + '/api/auth/browser/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json' }), body: '{}' });
        assert.equal(noCsrf.status, 403);
        const foreignOrigin = await fetch(url + '/api/auth/browser/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: 'https://another.example' }), body: '{}' });
        assert.equal(foreignOrigin.status, 403);

        const badLogin = await fetch(url + '/api/auth/browser/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }), body: JSON.stringify({ username: 'test-user', password: 'wrong' }) });
        assert.equal(badLogin.status, 401);

        // Browser-session sign-in (remember unchecked): session cookie, short-lived token.
        const login = await fetch(url + '/api/auth/browser/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }), body: JSON.stringify({ username: 'test-user', password: 'test-password', remember: false }) });
        assert.equal(login.status, 200);
        const setCookies = login.headers.getSetCookie();
        const sessionCookie = setCookies.find(value => value.startsWith('browser-test='));
        assert.ok(sessionCookie, 'session cookie is set');
        assert.ok(!/expires=|max-age=/i.test(sessionCookie), 'unchecked remember gives a browser-session cookie');
        storeCookies(login);
        const sessionValue = decodeURIComponent(sessionCookie.split(';')[0].split('=').slice(1).join('='));
        const tokenBody = JSON.parse(Buffer.from(sessionValue, 'base64').toString('utf8'));
        const serverSession = validateSession(tokenBody.basicAuthToken);
        assert.equal(serverSession.username, 'test-user');
        assert.ok(Math.abs(serverSession.expires - Date.now() - SESSION_DURATION_MS) < 60000, 'unchecked remember token lasts the default session duration');

        // The cookie alone now authenticates the private route.
        const authenticated = await fetch(url + '/private', { headers: withCookies() });
        assert.equal(authenticated.status, 200);
        const touch = await fetch(url + '/touch', { method: 'POST', headers: withCookies({ 'X-CSRF-Token': csrfToken }) });
        assert.equal(touch.status, 204);
        assert.ok(touch.headers.getSetCookie().every(cookie => !/expires=|max-age=/i.test(cookie)), 'later writes keep a temporary cookie temporary');
        storeCookies(touch);

        // Status now reports an authenticated browser session.
        const statusAfter = await fetch(url + '/api/auth/status', { headers: withCookies() });
        const statusData = await statusAfter.json();
        assert.equal(statusData.authenticated, true);
        assert.equal(statusData.browserSession, true);
        assert.equal(statusData.username, 'test-user');

        // Remember checked: 30 day token and matching cookie expiry.
        const rememberLogin = await fetch(url + '/api/auth/browser/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }), body: JSON.stringify({ username: 'test-user', password: 'test-password', remember: true }) });
        assert.equal(rememberLogin.status, 200);
        const rememberCookie = rememberLogin.headers.getSetCookie().find(value => value.startsWith('browser-test='));
        const expires = /expires=([^;]+)/i.exec(rememberCookie)?.[1];
        assert.ok(expires, 'checked remember sets an explicit cookie expiry');
        assert.ok(Math.abs(Date.parse(expires) - Date.now() - REMEMBER_AUTH_MS) < 120000, 'checked remember cookie lasts about 30 days');
        storeCookies(rememberLogin);
        const rememberedValue = decodeURIComponent(rememberCookie.split(';')[0].split('=').slice(1).join('='));
        const rememberedToken = JSON.parse(Buffer.from(rememberedValue, 'base64').toString('utf8')).basicAuthToken;
        const rememberedSession = validateSession(rememberedToken);
        assert.ok(Math.abs(rememberedSession.expires - Date.now() - REMEMBER_AUTH_MS) < 120000, 'checked remember token lasts 30 days');
        const secondTouch = await fetch(url + '/touch', { method: 'POST', headers: withCookies({ 'X-CSRF-Token': csrfToken }) });
        const touchedCookie = secondTouch.headers.getSetCookie().find(value => value.startsWith('browser-test='));
        assert.ok(Math.abs(Date.parse(/expires=([^;]+)/i.exec(touchedCookie)[1]) - rememberedSession.expires) < 1000, 'cookie rewrites retain the absolute expiry');
        storeCookies(secondTouch);

        // Passkey sign-in with a bogus challenge is rejected, and the challenge is single-use.
        const bogusChallenge = await fetch(url + '/api/auth/passkeys/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }), body: JSON.stringify({ challengeId: 'nope', response: { id: 'x' } }) });
        assert.equal(bogusChallenge.status, 400);
        const oldCookie = jar.join('; ');
        const logout = await fetch(url + '/api/users/logout', { method: 'POST', headers: withCookies({ 'X-CSRF-Token': csrfToken }) });
        assert.equal(logout.status, 204);
        assert.equal(validateSession(rememberedToken), null);
        assert.equal((await fetch(url + '/private', { headers: { Cookie: oldCookie } })).status, 401);
        assert.equal((await (await fetch(url + '/api/auth/status', { headers: { Cookie: oldCookie } })).json()).browserSession, false);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('repeated failed browser sign-ins are rate limited', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-browser-auth-limit-'));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, [
        'basicAuthUser:',
        '  username: test-user',
        '  password: test-password',
        'rateLimiting:',
        '  basicAuthMaxAttempts: 2',
        '',
    ].join('\n'));
    getConfig().rateLimiting.basicAuthMaxAttempts = 2;
    const { default: basicAuth } = await import('../src/middleware/basicAuth.js');
    const { default: authRouter, setAuthRouterBasicAuthMode } = await import('../src/endpoints/auth.js?rate-limit-test');
    setAuthRouterBasicAuthMode(true);
    const app = express();
    app.use(express.json());
    app.use(cookieSession({ name: 'browser-test', secret: 'browser-secret', httpOnly: true }));
    app.use(basicAuth);
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => req.session?.csrfToken,
        getTokenFromRequest: (req) => req.headers['x-csrf-token']?.toString(),
        storeTokenInState: (req, token) => {
            if (req.session) req.session.csrfToken = token;
        },
        size: 32,
    });
    app.get('/csrf-token', (req, res) => res.json({ token: csrfSyncProtection.generateToken(req) }));
    app.use(csrfSyncProtection.csrfSynchronisedProtection);
    app.use('/api/auth', authRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const jar = [];
    const withCookies = (headers = {}) => ({ ...headers, cookie: jar.join('; ') });
    const storeCookies = (response) => {
        for (const value of response.headers.getSetCookie()) {
            const [pair] = value.split(';');
            const name = pair.split('=')[0];
            const index = jar.findIndex(entry => entry.startsWith(name + '='));
            if (index >= 0) jar[index] = pair; else jar.push(pair);
        }
    };
    try {
        const tokenResponse = await fetch(url + '/csrf-token');
        storeCookies(tokenResponse);
        const csrfToken = (await tokenResponse.json()).token;
        const attempt = () => fetch(url + '/api/auth/browser/login', { method: 'POST', headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }), body: JSON.stringify({ username: 'test-user', password: 'wrong' }) });
        storeCookies(await attempt());
        assert.equal((await attempt()).status, 401);
        const limited = await attempt();
        assert.equal(limited.status, 429);
        assert.ok(limited.headers.get('retry-after'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
/* global globalThis */

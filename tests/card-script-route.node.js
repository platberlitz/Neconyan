import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { serveCardScriptSandbox, CARD_SCRIPT_RESPONSE_HEADERS } from '../src/card-script-sandbox.js';
import { CARD_SCRIPT_SANDBOX_PATH } from '../public/scripts/card-script-sandbox/policy.js';

const usersSource = readFileSync(new URL('../src/users.js', import.meta.url), 'utf8');
const loginSource = usersSource.match(/^export (function requireLoginMiddleware\([\s\S]*?^})/m)[1];
const requireLogin = new Function(`${loginSource};return requireLoginMiddleware;`)();

test('authenticated fixed route preserves all security headers for GET/HEAD and both static modes', async () => {
    for (const hashed of [false, true]) {
        const app = express();
        app.use(cookieSession({ name: 'session', keys: ['owned-test-key'], httpOnly: true, sameSite: 'lax' }));
        app.get('/login-fixture', (request, response) => { request.session.handle = 'tester'; response.end('signed in'); });
        app.use((request, _response, next) => { if (request.session?.handle === 'tester') request.user = { profile: { name: 'Private account' } }; next(); });
        app.get(CARD_SCRIPT_SANDBOX_PATH, requireLogin, serveCardScriptSandbox);
        app.use((_request, response) => response.end(hashed ? 'hashed static must not shadow the route' : 'static must not shadow the route'));
        const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
        const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
            const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, headers, method }, response => {
                let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
            }); request.on('error', reject); request.end();
        });
        try {
            assert.equal((await get(CARD_SCRIPT_SANDBOX_PATH)).status, 403);
            const login = await get('/login-fixture');
            const cookie = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
            const normal = await get(CARD_SCRIPT_SANDBOX_PATH + '?v=2', { Cookie: cookie });
            assert.equal(normal.status, 200);
            for (const [header, value] of Object.entries(CARD_SCRIPT_RESPONSE_HEADERS)) assert.equal(normal.headers[header.toLowerCase()], value);
            assert.ok(normal.body.startsWith('<!doctype html>')); assert.doesNotMatch(normal.body, /Private account|Reporting-Endpoints|response-origin/);
            const hostile = await get(CARD_SCRIPT_SANDBOX_PATH + '?document=private-card-content&nonce=secret-token', { Cookie: cookie });
            assert.equal(hostile.body, normal.body); assert.doesNotMatch(hostile.body, /private-card-content|secret-token/);
            const head = await get(CARD_SCRIPT_SANDBOX_PATH, { Cookie: cookie }, 'HEAD');
            assert.equal(head.status, 200); assert.equal(head.body, '');
            assert.equal(head.headers['connection-allowlist'], normal.headers['connection-allowlist']);
            assert.equal((await get(CARD_SCRIPT_SANDBOX_PATH, { Cookie: 'session=invalid' })).status, 403);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
});

test('real route is registered after auth/user/CSRF and before either static handler', () => {
    const source = readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');
    const route = source.indexOf('app.get(CARD_SCRIPT_SANDBOX_PATH, requireLoginMiddleware, serveCardScriptSandbox)');
    for (const marker of ['app.use(cookieSession(', 'app.use(basicAuthMiddleware)', 'app.use(setUserDataMiddleware)', 'app.use(csrfSyncProtection.csrfSynchronisedProtection)']) assert.ok(source.indexOf(marker) < route);
    for (const marker of ['app.use(FRONTEND_ASSET_PREFIX', 'express.static']) assert.ok(source.indexOf(marker) > route);
});

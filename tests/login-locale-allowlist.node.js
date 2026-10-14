import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieSession from 'cookie-session';
import { setConfigFilePath } from '../src/util.js';

// This file imports only a module that exists before the change too, so it can also be run on the code before it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const languages = JSON.parse(fs.readFileSync(path.join(root, 'public', 'locales', 'lang.json'), 'utf8'));
const codes = languages.map(language => language.lang);

const GET_ROUTES = [
    '/login', '/login.html', '/css/login.css', '/scripts/login.js', '/lib/jquery-3.5.1.min.js', '/manifest.json', '/favicon.ico',
    '/img/neconyan-pixel-cat-rest.webp', '/img/neconyan-pixel-cat.webp', '/img/neconyan.png', '/img/neconyan-icon-180.png',
    '/csrf-token', '/api/auth/status',
];
const POST_ROUTES = ['/api/auth/browser/login', '/api/auth/passkeys/login-options', '/api/auth/passkeys/login'];
const NEW_ROUTES = [
    '/scripts/page-locale.js',
    '/locales/lang.json',
    ...codes.flatMap(code => [`/locales/${code}.json`, `/locales/neconyan/${code}.json`]),
];

// The configuration is read when basicAuth.js is first imported, so it is written and set once, before that.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-login-locale-'));
process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
globalThis.DATA_ROOT = folder;
const config = path.join(folder, 'config.yaml');
fs.writeFileSync(config, ['basicAuthUser:', '  username: test-user', '  password: test-password', ''].join('\n'));
setConfigFilePath(config);

async function startServer(t) {
    const { default: basicAuth } = await import('../src/middleware/basicAuth.js');
    const app = express();
    app.use(cookieSession({ name: 'locale-test', secret: 'locale-secret', httpOnly: true, sameSite: 'lax' }));
    app.use(basicAuth);
    app.use((_req, res) => res.status(200).send('passed'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
    return server;
}

function send(server, method, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port, method, path: requestPath, headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end();
    });
}

// A browser fetch sends Fetch Metadata; a command-line client does not. Both must get the same answer.
const CLIENTS = [{ 'sec-fetch-mode': 'cors' }, {}];
const isAllowed = response => response.status === 200 && response.body === 'passed';

test('A1 the sign-in page may fetch its script and the dictionaries without a session', async t => {
    const server = await startServer(t);
    assert.equal(NEW_ROUTES.length, 34);
    for (const headers of CLIENTS) {
        for (const route of NEW_ROUTES) {
            const response = await send(server, 'GET', route, headers);
            assert.ok(isAllowed(response), `${route} ${JSON.stringify(headers)}: ${response.status} ${response.body}`);
        }
    }
});

test('A2 nothing else under /locales or /scripts is opened to a signed-out client', async t => {
    const server = await startServer(t);
    const refused = [
        ['GET', '/locales/en.json'], ['GET', '/locales/neconyan/en.json'], ['GET', '/locales/xx-yy.json'], ['GET', '/locales/neconyan/xx-yy.json'],
        ['GET', '/locales/neconyan/../lang.json'], ['GET', '/locales/DE-DE.json'], ['GET', '/locales/de-de.json/'], ['GET', '/locales/de-de.json.map'],
        ['GET', '/scripts/i18n.js'], ['GET', '/scripts/ui-localization.js'], ['POST', '/locales/de-de.json'], ['POST', '/scripts/page-locale.js'],
    ];
    for (const headers of CLIENTS) {
        for (const [method, route] of refused) {
            const response = await send(server, method, route, headers);
            assert.equal(response.status, 401, `${method} ${route} ${JSON.stringify(headers)}`);
            assert.deepEqual(JSON.parse(response.body), { error: 'You are signed out. Sign in to continue.' });
        }
    }
});

test('A3 the sign-in routes of before still pass, and a private route is still refused', async t => {
    const server = await startServer(t);
    for (const headers of CLIENTS) {
        for (const route of GET_ROUTES) assert.ok(isAllowed(await send(server, 'GET', route, headers)), `GET ${route}`);
        for (const route of POST_ROUTES) assert.ok(isAllowed(await send(server, 'POST', route, headers)), `POST ${route}`);
        assert.ok(isAllowed(await send(server, 'GET', '/webfonts/Nunito/stylesheet.css', headers)));
        assert.equal((await send(server, 'GET', '/api/chats/get', headers)).status, 401);
        assert.equal((await send(server, 'GET', '/script.js', headers)).status, 401);
    }
    const redirect = await send(server, 'GET', '/', { accept: 'text/html' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/login');
});

function walkJson(folder, prefix) {
    return fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => `${prefix}${entry.name}`);
}

test('A4 exactly 34 new paths are opened: the script, the language list and two dictionaries for each of 16 languages', async t => {
    const server = await startServer(t);
    const candidates = [
        '/scripts/page-locale.js', '/scripts/i18n.js', '/scripts/ui-localization.js',
        ...walkJson(path.join(root, 'public', 'locales'), '/locales/'),
        ...walkJson(path.join(root, 'public', 'locales', 'neconyan'), '/locales/neconyan/'),
    ];
    const passing = [];
    for (const route of candidates) {
        if (isAllowed(await send(server, 'GET', route))) passing.push(route);
    }
    assert.equal(passing.length, 1 + 2 * codes.length + 1);
    assert.equal(passing.length, 34);
    assert.deepEqual([...passing].sort(), [...NEW_ROUTES].sort());
});

test('A5 every icon the manifest names is open to a signed-out client, so the sign-in page gets no 401 for them', async t => {
    // The paths come from the manifest itself: the full browser fetches every icon it names while the sign-in page loads.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8'));
    const icons = [...new Set(manifest.icons.map(icon => new URL(icon.src, 'http://localhost/').pathname))];
    assert.ok(icons.length > 0, 'the manifest names at least one icon');
    const server = await startServer(t);
    for (const headers of CLIENTS) {
        for (const route of icons) {
            const response = await send(server, 'GET', route, headers);
            assert.ok(isAllowed(response), `${route} ${JSON.stringify(headers)}: ${response.status} ${response.body}`);
        }
    }
});

/* global globalThis */

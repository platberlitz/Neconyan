import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Handlebars from 'handlebars';
import { load } from 'cheerio';

import { setConfigFilePath } from '../src/util.js';

// This file is also run on the code before the change (tests/ cases B1, B2, B4, B5, B6 a to c), so it imports none of
// the modules the change adds at the top: the tests that need one import it inside their own body, after the
// assertions the old code can answer. Express reads NODE_ENV when an app is created, which happens inside the tests.
process.env.NODE_ENV = 'production';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shippedFolder = path.join(root, 'default', 'content', 'errors');
const fixtureFolder = path.join(root, 'tests', 'fixtures', 'shipped-error-pages');
const fixtureLocales = path.join(root, 'tests', 'fixtures', 'page-locales');
const realLocales = path.join(root, 'public', 'locales');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-blocked-pages-'));
const dataRoot = path.join(base, 'data');
const errorsFolder = path.join(dataRoot, '_errors');
fs.mkdirSync(dataRoot, { recursive: true });
globalThis.DATA_ROOT = dataRoot;
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
const config = path.join(base, 'config.yaml');
fs.writeFileSync(config, [
    'whitelist:',
    '  - 10.9.8.7',
    'enableForwardedWhitelist: true',
    'whitelistDockerHosts: false',
    'hostWhitelist:',
    '  enabled: true',
    '  hosts:',
    '    - allowed.test',
    'requireHttps: true',
    '',
].join('\n'));
setConfigFilePath(config);

const HTTPS_SENTENCE = 'This connection is not secure, so Neconyan cannot be opened from another computer yet. Ask the person running Neconyan to turn on HTTPS (the secure, padlock address) in config.yaml, then reload.';
const CHROMIUM_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const JQUERY_ACCEPT = 'application/json, text/javascript, */*; q=0.01';
const MARKER = '<!-- customised by the administrator for the C5 reproduction -->';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = (page, blob) => fs.readFileSync(path.join(fixtureFolder, `${page}.${blob}.html`));
const collapse = text => text.replace(/\s+/g, ' ').trim();
const fill = (text, ...holes) => text.replace(/\$\{(\d+)\}/g, (_match, index) => holes[Number(index)]);

function resetErrors(names) {
    fs.rmSync(errorsFolder, { recursive: true, force: true });
    fs.mkdirSync(errorsFolder, { recursive: true });
    for (const name of names ?? fs.readdirSync(shippedFolder)) {
        const source = path.join(shippedFolder, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(errorsFolder, name));
    }
}

function realDictionary(locale) {
    const read = file => JSON.parse(fs.readFileSync(path.join(realLocales, file), 'utf8'));
    return { ...read(`${locale}.json`), ...read(`neconyan/${locale}.json`) };
}

async function serve(t, ...handlers) {
    const app = express();
    for (const handler of handlers) app.use(handler);
    app.use((_req, res) => res.status(200).send('passed'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
    return server;
}

function send(server, { method = 'GET', path: requestPath = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port, method, path: requestPath, headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.end();
    });
}

const customise = bytes => Buffer.from(bytes.toString('utf8').replace('<h1>', `${MARKER}\n    <h1>Custom: `));
const varies = (response, name) => String(response.headers.vary ?? '').toLowerCase().split(',').map(item => item.trim()).includes(name.toLowerCase());

test('B1 the first request after a fresh start gets the page, not an empty body', async t => {
    resetErrors([]);
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    const middleware = await getWhitelistMiddleware();
    // What the content seeding does later in the same start.
    fs.copyFileSync(path.join(shippedFolder, 'forbidden-by-whitelist.html'), path.join(errorsFolder, 'forbidden-by-whitelist.html'));
    const server = await serve(t, middleware);
    t.mock.method(console, 'warn', () => {});
    const response = await send(server, { headers: { accept: CHROMIUM_ACCEPT } });
    assert.equal(response.status, 403);
    assert.notEqual(response.body.length, 0, 'the 403 body is not empty');
    assert.match(response.body.toString('utf8'), /<title>[^<]*Forbidden[^<]*<\/title>/);
});

test('B2 the whitelist page follows Accept-Language and reads like the real dictionary', async t => {
    resetErrors();
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    const server = await serve(t, await getWhitelistMiddleware());
    t.mock.method(console, 'warn', () => {});
    const response = await send(server, { headers: { 'accept': CHROMIUM_ACCEPT, 'accept-language': 'de-DE,de;q=0.9' } });
    assert.equal(response.status, 403);
    const $ = load(response.body.toString('utf8'));
    assert.equal($('html').attr('lang'), 'de-de');
    assert.equal(response.headers['content-language'], 'de-de');
    assert.ok(varies(response, 'Accept-Language'));
    assert.match(response.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.equal(response.headers['cache-control'], 'no-store');

    const { translationFor } = await import('../public/scripts/page-locale.js');
    const german = realDictionary('de-de');
    const pick = key => translationFor(german, key) ?? key;
    assert.notEqual(pick('Forbidden'), 'Forbidden', 'Forbidden is translated in every language today');
    assert.equal($('title').text(), pick('Forbidden'));
    assert.equal($('h1').text(), pick('Forbidden'));
    assert.equal(collapse($('p').eq(0).text()), fill(pick('If you run this Neconyan, add your IP address (the number that identifies your internet connection) to the allowed list, or turn the allowed list off, by editing ${0} in the main Neconyan folder. The allowed list is called the whitelist in that file.'), 'config.yaml'));
    assert.equal(collapse($('em').text()), fill(pick('This connection from ${0} was blocked. The attempt was logged.'), '127.0.0.1'));
    assert.equal($('p code').text(), 'config.yaml');
});

test('B3 a forwarded address that is a tag is shown as text and the refusal is logged', async t => {
    resetErrors();
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    const server = await serve(t, await getWhitelistMiddleware());
    const warn = t.mock.method(console, 'warn', () => {});
    const hostile = '<img src=x onerror=1>';
    for (const language of ['en-GB', 'de-DE']) {
        const response = await send(server, { headers: { 'accept-language': language, 'x-forwarded-for': hostile } });
        assert.equal(response.status, 403);
        const body = response.body.toString('utf8');
        assert.equal(body.includes(hostile), false);
        assert.equal(load(body)('img').length, 0);
        assert.match(body, /&lt;img src&#x3D;x onerror&#x3D;1&gt;/);
    }
    assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('Blocked connection from')), 'the refusal is logged');
});

test('B3 the forwarded sentence is used when a forwarded address is present', async t => {
    resetErrors();
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    const server = await serve(t, await getWhitelistMiddleware());
    t.mock.method(console, 'warn', () => {});
    const response = await send(server, { headers: { 'accept-language': 'en-GB', 'x-real-ip': '198.51.100.7' } });
    assert.equal(collapse(load(response.body.toString('utf8'))('em').text()), 'This connection from 127.0.0.1 (forwarded from 198.51.100.7) was blocked. The attempt was logged.');
});

test('B4 an administrator\'s whitelist page is rendered as before, with no new headers', async t => {
    resetErrors();
    const page = customise(fixture('forbidden-by-whitelist', '70ff71852b'));
    fs.writeFileSync(path.join(errorsFolder, 'forbidden-by-whitelist.html'), page);
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    const server = await serve(t, await getWhitelistMiddleware());
    t.mock.method(console, 'warn', () => {});
    const response = await send(server, { headers: { 'accept': CHROMIUM_ACCEPT, 'accept-language': 'de-DE' } });
    assert.equal(response.status, 403);
    assert.equal(response.body.toString('utf8'), Handlebars.compile(page.toString('utf8'))({ ipDetails: '127.0.0.1' }));
    assert.equal(varies(response, 'Accept-Language'), false);
    assert.equal(response.headers['content-language'], undefined);
    assert.match(response.headers['content-type'], /^text\/html/);
});

test('B5(a) the host page follows Accept-Language', async t => {
    resetErrors();
    const { default: hostWhitelistMiddleware } = await import('../src/middleware/hostWhitelist.js');
    const server = await serve(t, hostWhitelistMiddleware);
    const response = await send(server, { headers: { 'host': 'blocked.test', 'accept': CHROMIUM_ACCEPT, 'accept-language': 'pt-PT' } });
    assert.equal(response.status, 403);
    const $ = load(response.body.toString('utf8'));
    assert.equal($('html').attr('lang'), 'pt-pt');
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['content-language'], 'pt-pt');
    assert.ok(varies(response, 'Accept-Language'));
    const { translationFor } = await import('../public/scripts/page-locale.js');
    const portuguese = realDictionary('pt-pt');
    const pick = key => translationFor(portuguese, key) ?? key;
    assert.notEqual(pick('Forbidden'), 'Forbidden');
    assert.equal($('title').text(), pick('Forbidden'));
    assert.equal($('h1').text(), pick('Forbidden'));
    assert.equal(collapse($('em').text()), pick('This address is not allowed to open Neconyan. The attempt was logged.'));
});

test('B5(b) an administrator\'s host page is sent byte for byte with its old header', async t => {
    resetErrors();
    const page = Buffer.from(customise(fixture('host-not-allowed', '19ec5e990b')).toString('utf8').replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(errorsFolder, 'host-not-allowed.html'), page);
    const { default: hostWhitelistMiddleware } = await import('../src/middleware/hostWhitelist.js');
    const server = await serve(t, hostWhitelistMiddleware);
    const response = await send(server, { headers: { 'host': 'blocked.test', 'accept-language': 'de-DE' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers['content-type'], 'text/html');
    assert.deepEqual(response.body, page);
});

test('B5(c) an allowed host passes through', async t => {
    resetErrors();
    const { default: hostWhitelistMiddleware } = await import('../src/middleware/hostWhitelist.js');
    const server = await serve(t, hostWhitelistMiddleware);
    for (const host of ['allowed.test', 'allowed.test:8000', '127.0.0.1', 'localhost', 'app.localhost']) {
        const response = await send(server, { headers: { host } });
        assert.equal(response.status, 200, host);
        assert.equal(response.body.toString('utf8'), 'passed');
    }
    assert.equal((await send(server, { headers: { host: 'blocked.test' } })).status, 403);
});

test('B6(a) a browser page load gets the HTTPS page in the language of Accept-Language', async t => {
    resetErrors();
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    const server = await serve(t, requireHttpsMiddleware);
    const load403 = acceptLanguage => send(server, { headers: { 'host': 'neconyan.test', 'accept': CHROMIUM_ACCEPT, ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}) } });
    const german = await load403('de-DE');
    assert.equal(german.status, 403);
    assert.equal(german.headers['content-type'], 'text/html; charset=utf-8');
    const $ = load(german.body.toString('utf8'));
    assert.equal($('html').attr('lang'), 'de-de');
    assert.equal(german.headers['content-language'], 'de-de');
    assert.ok(varies(german, 'Accept') && varies(german, 'Accept-Language'));
    assert.equal(german.headers['cache-control'], 'no-store');
    const { translationFor } = await import('../public/scripts/page-locale.js');
    const dictionary = realDictionary('de-de');
    const pick = key => translationFor(dictionary, key) ?? key;
    assert.equal($('title').text(), pick('Connection not secure'));
    assert.equal($('h1').text(), pick('Connection not secure'));
    assert.equal(collapse($('p').text()), pick(HTTPS_SENTENCE));
    for (const english of [await load403('fr-CH'), await load403(undefined)]) {
        assert.equal(english.status, 403);
        const page = load(english.body.toString('utf8'));
        assert.equal(page('html').attr('lang'), 'en');
        assert.equal(page('title').text(), 'Connection not secure');
        assert.equal(collapse(page('p').text()), HTTPS_SENTENCE);
    }
});

test('B6(a2) the HTTPS page shows translated text from a dictionary (fixture values)', async t => {
    resetErrors();
    const { sendHttpsRequired } = await import('../src/error-pages.js');
    const server = await serve(t, (req, res) => sendHttpsRequired(req, res, { localesRoot: fixtureLocales }));
    const response = await send(server, { headers: { 'accept': CHROMIUM_ACCEPT, 'accept-language': 'de-DE' } });
    const $ = load(response.body.toString('utf8'));
    assert.equal(response.status, 403);
    assert.equal($('html').attr('lang'), 'de-de');
    assert.equal($('title').text(), '«de» Verbindung nicht sicher');
    assert.equal($('h1').text(), '«de» Verbindung nicht sicher');
    assert.equal(collapse($('p').text()), '«de» Diese Verbindung ist nicht sicher. Bitte HTTPS in config.yaml einschalten, dann neu laden.');
});

test('B6(b) an API request gets today\'s JSON, whatever the language', async t => {
    resetErrors();
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    const server = await serve(t, requireHttpsMiddleware);
    const expected = Buffer.from(JSON.stringify({ error: HTTPS_SENTENCE }));
    const requests = [
        { method: 'GET', path: '/api/ping', headers: { 'accept': CHROMIUM_ACCEPT, 'accept-language': 'de-DE' } },
        { method: 'GET', path: '/', headers: { 'accept': '*/*', 'accept-language': 'de-DE' } },
        { method: 'GET', path: '/', headers: { 'accept': JQUERY_ACCEPT, 'accept-language': 'pt-PT' } },
        { method: 'GET', path: '/', headers: { 'accept-language': 'it-IT' } },
        { method: 'POST', path: '/api/ping', headers: { 'accept-language': 'de-DE' } },
    ];
    const responses = [];
    for (const request of requests) {
        request.headers.host = 'neconyan.test';
        responses.push(await send(server, request));
    }
    for (const [index, response] of responses.entries()) {
        assert.equal(response.status, 403, JSON.stringify(requests[index]));
        assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
        assert.deepEqual(response.body, expected);
    }
    // The one intended difference: the answer now depends on Accept, so caches are told.
    for (const response of responses) assert.ok(varies(response, 'Accept'));
});

test('B6(c) local addresses and a secure proxy pass through', async t => {
    resetErrors();
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    const server = await serve(t, requireHttpsMiddleware);
    for (const headers of [{ host: '127.0.0.1' }, { host: 'localhost' }, { host: 'neconyan.test', 'x-forwarded-proto': 'https' }]) {
        const response = await send(server, { headers });
        assert.equal(response.status, 200, JSON.stringify(headers));
        assert.equal(response.body.toString('utf8'), 'passed');
    }
});

test('B6(d) a HEAD page load gets the HTML headers and no body', async t => {
    resetErrors();
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    const server = await serve(t, requireHttpsMiddleware);
    const response = await send(server, { method: 'HEAD', headers: { 'host': 'neconyan.test', 'accept': CHROMIUM_ACCEPT, 'accept-language': 'de-DE' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['content-language'], 'de-de');
    assert.equal(response.body.length, 0);
});

test('B6(e) the HTTPS page falls back to the shipped page, then to the JSON, and always refuses', async t => {
    resetErrors();
    fs.rmSync(path.join(errorsFolder, 'https-required.html'), { force: true });
    fs.mkdirSync(path.join(errorsFolder, 'https-required.html'));
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    const { sendHttpsRequired } = await import('../src/error-pages.js');
    const headers = { 'host': 'neconyan.test', 'accept': CHROMIUM_ACCEPT };
    const server = await serve(t, requireHttpsMiddleware);
    const shipped = await send(server, { headers });
    assert.equal(shipped.status, 403);
    assert.match(shipped.body.toString('utf8'), /<h1>Connection not secure<\/h1>/);

    t.mock.method(console, 'error', () => {});
    const noCopy = await serve(t, (req, res) => sendHttpsRequired(req, res, { shippedRoot: path.join(base, 'no-such-folder') }));
    for (let attempt = 0; attempt < 2; attempt++) {
        const json = await send(noCopy, { headers });
        assert.equal(json.status, 403);
        assert.equal(json.headers['content-type'], 'application/json; charset=utf-8');
        assert.deepEqual(json.body, Buffer.from(JSON.stringify({ error: HTTPS_SENTENCE })));
    }
});

test('B6(f) an administrator\'s HTTPS page is rendered and left as it is', async t => {
    resetErrors();
    const page = fs.readFileSync(path.join(shippedFolder, 'https-required.html'), 'utf8').replace('<h1>', '<h1 class="mine">My own: ');
    fs.writeFileSync(path.join(errorsFolder, 'https-required.html'), page);
    const before = sha256(fs.readFileSync(path.join(errorsFolder, 'https-required.html')));
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    const server = await serve(t, requireHttpsMiddleware);
    const response = await send(server, { headers: { 'host': 'neconyan.test', 'accept': CHROMIUM_ACCEPT } });
    assert.equal(response.status, 403);
    assert.match(response.body.toString('utf8'), /<h1 class="mine">My own: Connection not secure<\/h1>/);
    assert.equal(sha256(fs.readFileSync(path.join(errorsFolder, 'https-required.html'))), before);
});

test('B7 a blocked page is one self-contained response', async t => {
    resetErrors();
    const { default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js');
    const { default: hostWhitelistMiddleware } = await import('../src/middleware/hostWhitelist.js');
    const { default: requireHttpsMiddleware } = await import('../src/middleware/requireHttps.js');
    t.mock.method(console, 'warn', () => {});
    const whitelist = await serve(t, await getWhitelistMiddleware());
    const host = await serve(t, hostWhitelistMiddleware);
    const https = await serve(t, requireHttpsMiddleware);
    const pages = [];
    for (const language of ['en-GB', 'de-DE']) {
        const accept = { 'accept': CHROMIUM_ACCEPT, 'accept-language': language };
        pages.push(await send(whitelist, { headers: accept }));
        pages.push(await send(whitelist, { headers: { ...accept, 'x-real-ip': '198.51.100.7' } }));
        pages.push(await send(host, { headers: { ...accept, host: 'blocked.test' } }));
        pages.push(await send(https, { headers: { ...accept, host: 'neconyan.test' } }));
    }
    assert.equal(pages.length, 8);
    for (const response of pages) {
        assert.equal(response.status, 403);
        const body = response.body.toString('utf8');
        for (const forbidden of ['<script', '<style', 'src=', 'url(', '@import']) assert.equal(body.includes(forbidden), false, forbidden);
        assert.deepEqual(body.match(/<link\b[^>]*>/g), ['<link rel="icon" href="data:,">']);
        assert.match(body, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    }
});

test('B8 when no copy of a page can be read the answer is a plain 403', async t => {
    const { sendBlockedPage } = await import('../src/error-pages.js');
    const emptyData = path.join(base, 'data-without-errors');
    fs.mkdirSync(emptyData, { recursive: true });
    const error = t.mock.method(console, 'error', () => {});
    const options = { dataRoot: emptyData, shippedRoot: path.join(base, 'no-such-shipped-folder') };
    const server = await serve(t, (req, res) => sendBlockedPage(req, res, req.path === '/host' ? 'host-not-allowed.html' : 'forbidden-by-whitelist.html', {}, options));
    for (const requestPath of ['/', '/', '/host', '/host']) {
        const response = await send(server, { path: requestPath, headers: { accept: CHROMIUM_ACCEPT } });
        assert.equal(response.status, 403);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.body.toString('utf8'), 'Forbidden');
    }
    const reports = error.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith('No copy of the error page'));
    assert.equal(reports.length, 2, 'one line for each page, however many requests');
});

/* global globalThis */

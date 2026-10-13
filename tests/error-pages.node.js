import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MANAGED_ERROR_PAGES, SHIPPED_ERROR_PAGE_HASHES, isPageLoad, readErrorPage, readNotFoundPage, syncErrorPages } from '../src/error-pages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shippedRoot = path.join(root, 'default', 'content', 'errors');
const fixtureFolder = path.join(root, 'tests', 'fixtures', 'shipped-error-pages');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const toLf = bytes => Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
const toCrlf = bytes => Buffer.from(toLf(bytes).toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
const shipped = name => fs.readFileSync(path.join(shippedRoot, name));
const fixture = (page, blob) => fs.readFileSync(path.join(fixtureFolder, `${page.replace(/\.html$/, '')}.${blob}.html`));

// Every version of a managed page that earlier releases shipped (section 4.4 of the C5 plan), pinned here on purpose.
const HISTORICAL = [
    ['forbidden-by-whitelist.html', '70ff71852b', 'fb177a81be2d7d7648fd5fa9df0a9d8b70cd8cd2e53fc69719de0918493cb5a0', '123b84855ce2104be082c58438641532a92b71fb17848ac828000c1b88f0ede0'],
    ['forbidden-by-whitelist.html', '8a0722beee', '3cf4f89d0448c48897062e736ead115352c04350ec2c97c77cf82b37d451b327', 'e6c23ded13b70e2b60766f85be46a1ae2c3ab21dadb2fa07e3247a2aeec06a0b'],
    ['host-not-allowed.html', '19ec5e990b', '01a8748f57751cceb2af35c4568734707fc2bd290d038b03dd6b73773cd16db5', 'abe2288467514e97897ea10981116f55cc23050f88be797b7f5b808b4370b0eb'],
    ['host-not-allowed.html', '06a5cedc65', '2e70f9de45d1deaa58129f39304a1cc2c4a56b6254b2938cbf54452c3dc0e8d9', 'f42c1feee224c6c82e80cb307766871dad3fbbbb01a04e04c607744daa678318'],
    ['invalid-csrf.html', 'f72eb8cf14', 'f12a673046b026ff038a1a03131602fd565b3e35c8ec4564bd57652a0101ae86', '88c3239a0c066a93894af0ef19c19a6734504ff35d89aad13a229d3c898c462c'],
    ['invalid-csrf.html', 'a96a8cdba9', '3743f4eb12d6459fe808d66a607fdfcbe62f058aa03ad7e705b232119bcde525', '40d1b7243cadee2f0dcd64254a6198205c1b9ba42c06325944c65bc6ceb3f86a'],
    ['url-not-found.html', '87974145f7', '2fe1a07c6871f156112a415625ef15955cab8c8b9b320285c6beb9fa6017e1d7', 'f6f27bd40fb4812c8d7156256e334a3f3481aae574dcad7b72f18339906a40e7'],
    ['url-not-found.html', '9c881dfc21', '5b142e6d20753118256ddf86c40095aaedf09f64619af7613fb2b77b9174ce1c', '3c9c01243df0eb3beaa4cd0b55c8b1caa30b54fd30348bca1e8452f91a101cbe'],
    ['url-not-found.html', '2c1fbbb301', '96c6be93236da2fecae436275bb11044600f122458e5ea1bafe9fc2cec094d2f', '90d8bce09439c41480a07a565b68fb399f1a1af7f065fb6da542b60b5115eb28'],
    ['url-not-found.html', 'c331cd018e', '7f28c4caef0586e2eca4b242985607ee4811f94fe9469c65c91e088504b9b3de', 'be2fa9f2bc98d17ca82bc88183366e6ff586f67505496225a059a196769b67d2'],
];

test('G1 every page in default/content/errors has its current bytes in the hash list, and the old hashes are the real shipped ones', () => {
    assert.deepEqual([...MANAGED_ERROR_PAGES], ['forbidden-by-whitelist.html', 'host-not-allowed.html', 'https-required.html', 'invalid-csrf.html', 'url-not-found.html']);
    assert.deepEqual(Object.keys(SHIPPED_ERROR_PAGE_HASHES), [...MANAGED_ERROR_PAGES]);
    for (const name of MANAGED_ERROR_PAGES) {
        const bytes = shipped(name);
        const missing = [sha256(toLf(bytes)), sha256(toCrlf(bytes))].filter(hash => !SHIPPED_ERROR_PAGE_HASHES[name].includes(hash));
        assert.deepEqual(missing, [], `Add these sha256 values for ${name} to SHIPPED_ERROR_PAGE_HASHES in src/error-pages.js, with a comment naming the version: ${missing.join(' ')}`);
    }
    for (const [page, blob, lf, crlf] of HISTORICAL) {
        assert.ok(SHIPPED_ERROR_PAGE_HASHES[page].includes(lf), `${page} ${blob} (LF) is in the list`);
        assert.ok(SHIPPED_ERROR_PAGE_HASHES[page].includes(crlf), `${page} ${blob} (CRLF) is in the list`);
        const bytes = fixture(page, blob);
        assert.equal(sha256(toLf(bytes)), lf, `${page} ${blob}: the fixture holds the real shipped bytes (LF)`);
        assert.equal(sha256(toCrlf(bytes)), crlf, `${page} ${blob}: the fixture holds the real shipped bytes (CRLF)`);
    }
    const all = Object.values(SHIPPED_ERROR_PAGE_HASHES).flat();
    assert.equal(all.length, 30, 'twenty old hashes and ten for the five pages of this change');
    assert.equal(new Set(all).size, all.length, 'no duplicates');
    for (const hash of all) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(SHIPPED_ERROR_PAGE_HASHES));
});

function captureLog() {
    const lines = [];
    const make = level => (...args) => {
        assert.equal(args.length, 1, 'each log line is one argument');
        assert.equal(typeof args[0], 'string');
        assert.doesNotMatch(args[0], /\u001b\[/, 'no colour codes');
        lines.push({ level, message: args[0] });
    };
    return { info: make('info'), warn: make('warn'), error: make('error'), lines };
}

function newInstall(t, { seeded = false } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-error-pages-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const install = {
        base,
        dataRoot: path.join(base, 'data'),
        errors: path.join(base, 'data', '_errors'),
        publicErrorRoot: path.join(base, 'public', 'error'),
        shippedRoot,
    };
    fs.mkdirSync(install.dataRoot, { recursive: true });
    if (seeded) {
        fs.mkdirSync(install.errors, { recursive: true });
        for (const name of ['forbidden-by-whitelist.html', 'host-not-allowed.html', 'unauthorized.html', 'url-not-found.html']) {
            fs.copyFileSync(path.join(shippedRoot, name), path.join(install.errors, name));
        }
    }
    return install;
}

const run = (install, log, extra = {}) => syncErrorPages({ dataRoot: install.dataRoot, shippedRoot: install.shippedRoot, publicErrorRoot: install.publicErrorRoot, log, ...extra });
const put = (install, name, bytes) => {
    fs.mkdirSync(install.errors, { recursive: true });
    fs.writeFileSync(path.join(install.errors, name), bytes);
};
const OLD_TIME = new Date('2020-01-01T00:00:00Z');
const age = file => fs.utimesSync(file, OLD_TIME, OLD_TIME);
const state = file => {
    const stats = fs.statSync(file);
    return { sha256: sha256(fs.readFileSync(file)), mtimeMs: stats.mtimeMs, size: stats.size };
};
const messages = (log, level) => log.lines.filter(line => !level || line.level === level).map(line => line.message);

test('G2 a missing page is created with the shipped bytes', t => {
    const install = newInstall(t);
    const log = captureLog();
    run(install, log);
    for (const name of MANAGED_ERROR_PAGES) {
        assert.deepEqual(fs.readFileSync(path.join(install.errors, name)), shipped(name), name);
    }
    assert.deepEqual(messages(log, 'info').sort(), MANAGED_ERROR_PAGES.map(name => `Created the error page _errors/${name}.`).sort());
    assert.deepEqual(messages(log, 'warn'), []);
    assert.deepEqual(messages(log, 'error'), []);
    const again = captureLog();
    run(install, again);
    assert.deepEqual(again.lines, [], 'a second start changes nothing and logs nothing');
});

test('G2 every historical version of every page, LF and CRLF, is replaced by the current page', t => {
    let cases = 0;
    for (const [page, blob] of HISTORICAL) {
        for (const [form, convert] of [['LF', toLf], ['CRLF', toCrlf]]) {
            const install = newInstall(t, { seeded: true });
            fs.rmSync(path.join(install.errors, page), { force: true });
            put(install, page, convert(fixture(page, blob)));
            const log = captureLog();
            run(install, log);
            assert.deepEqual(fs.readFileSync(path.join(install.errors, page)), shipped(page), `${page} ${blob} ${form}`);
            assert.ok(messages(log, 'info').includes(`Updated _errors/${page} to the current version (it was an unchanged copy of an earlier version).`), `${page} ${blob} ${form}`);
            assert.deepEqual(messages(log, 'warn'), []);
            cases++;
        }
    }
    assert.equal(cases, 20);
});

test('G2 a current page keeps its bytes and its modification time, and nothing is logged for it', t => {
    const install = newInstall(t);
    for (const name of MANAGED_ERROR_PAGES) {
        put(install, name, shipped(name));
        age(path.join(install.errors, name));
    }
    const before = Object.fromEntries(MANAGED_ERROR_PAGES.map(name => [name, state(path.join(install.errors, name))]));
    const log = captureLog();
    run(install, log);
    assert.deepEqual(log.lines, []);
    for (const name of MANAGED_ERROR_PAGES) assert.deepEqual(state(path.join(install.errors, name)), before[name], name);
});

test('G2 an administrator\'s page is kept byte for byte and logged, including near-misses', t => {
    const current = name => shipped(name).toString('utf8');
    const whitelist = 'forbidden-by-whitelist.html';
    const host = 'host-not-allowed.html';
    const csrf = 'invalid-csrf.html';
    const https = 'https-required.html';
    const notFound = 'url-not-found.html';
    const customised = [
        [whitelist, Buffer.from(fixture(whitelist, '8a0722beee').toString('utf8').replace('<title>', '<!-- my own page -->\n    <title>').replace('<h1>Forbidden</h1>', '<h1>Custom: Forbidden</h1>'))],
        [host, toCrlf(Buffer.from(fixture(host, '06a5cedc65').toString('utf8').replace('<h1>Forbidden</h1>', '<h1>Custom: Forbidden</h1>')))],
        [csrf, Buffer.from('<!DOCTYPE html><html><body>Our own sign-in help</body></html>\n')],
        [https, Buffer.from(current(https).replace('<h1>', '<h1 class="mine">'))],
        // Near misses: any byte that differs from every shipped version makes the page the administrator's.
        [notFound, Buffer.concat([shipped(notFound), Buffer.from('\n')])],
        [whitelist, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), shipped(whitelist)])],
        [host, Buffer.from(current(host).replace('\n', '\r\n'))],
    ];
    for (const [name, bytes] of customised) {
        const install = newInstall(t, { seeded: true });
        put(install, name, bytes);
        age(path.join(install.errors, name));
        const before = state(path.join(install.errors, name));
        const log = captureLog();
        run(install, log);
        assert.deepEqual(state(path.join(install.errors, name)), before, name);
        assert.ok(messages(log, 'warn').includes(`Kept your own _errors/${name}; it is not updated or translated. Delete it and restart to get the current page.`), name);
        assert.ok(!messages(log).some(message => message.startsWith('Updated') && message.includes(name)), name);
    }
});

test('G2 an empty page counts as missing and is replaced', t => {
    for (const name of MANAGED_ERROR_PAGES) {
        const install = newInstall(t, { seeded: true });
        put(install, name, '');
        const log = captureLog();
        run(install, log);
        assert.deepEqual(fs.readFileSync(path.join(install.errors, name)), shipped(name), name);
        assert.ok(messages(log, 'info').includes(`Created the error page _errors/${name} (it was empty).`), name);
        const again = captureLog();
        run(install, again);
        assert.deepEqual(again.lines.filter(line => line.message.includes(name)), [], 'a second run logs nothing for it');
    }
});

test('G2 a shipped page that cannot be read is skipped with one error line, and the others go on', t => {
    for (const reason of ['missing', 'empty']) {
        for (const withOldCopy of [false, true]) {
            const install = newInstall(t);
            const brokenShipped = path.join(install.base, 'shipped');
            fs.cpSync(shippedRoot, brokenShipped, { recursive: true });
            if (reason === 'missing') fs.rmSync(path.join(brokenShipped, 'host-not-allowed.html'));
            else fs.writeFileSync(path.join(brokenShipped, 'host-not-allowed.html'), '');
            const target = path.join(install.errors, 'host-not-allowed.html');
            if (withOldCopy) {
                put(install, 'host-not-allowed.html', toCrlf(fixture('host-not-allowed.html', '06a5cedc65')));
                age(target);
            }
            const before = withOldCopy ? state(target) : null;
            const log = captureLog();
            assert.doesNotThrow(() => run(install, log, { shippedRoot: brokenShipped }));
            const detail = reason === 'missing' ? 'ENOENT' : 'empty';
            assert.deepEqual(messages(log, 'error'), [`Could not read the shipped error page default/content/errors/host-not-allowed.html (${detail}); _errors/host-not-allowed.html is left as it is.`]);
            if (withOldCopy) assert.deepEqual(state(target), before, 'the data copy is neither created nor changed');
            else assert.equal(fs.existsSync(target), false);
            for (const name of MANAGED_ERROR_PAGES.filter(name => name !== 'host-not-allowed.html')) {
                assert.deepEqual(fs.readFileSync(path.join(install.errors, name)), shipped(name), name);
            }
        }
    }
});

test('G2 log levels: created and updated are info, kept is warn, failures are error', t => {
    const install = newInstall(t, { seeded: true });
    put(install, 'forbidden-by-whitelist.html', fixture('forbidden-by-whitelist.html', '70ff71852b'));
    put(install, 'invalid-csrf.html', '<p>mine</p>');
    const log = captureLog();
    run(install, log);
    assert.deepEqual(log.lines.map(line => line.level).sort(), ['info', 'info', 'warn']);
});

test('G2 a folder in place of a page is left alone and logged', t => {
    const install = newInstall(t, { seeded: true });
    const target = path.join(install.errors, 'invalid-csrf.html');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inside.txt'), 'kept');
    const log = captureLog();
    assert.doesNotThrow(() => run(install, log));
    assert.equal(fs.statSync(target).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(target, 'inside.txt'), 'utf8'), 'kept');
    assert.ok(messages(log, 'warn').includes('Kept _errors/invalid-csrf.html: it is not a plain file, so it is not updated.'));
});

test('G2 a symbolic link to an old page is not written through', t => {
    const install = newInstall(t, { seeded: true });
    const real = path.join(install.base, 'old-copy.html');
    fs.writeFileSync(real, fixture('invalid-csrf.html', 'a96a8cdba9'));
    const link = path.join(install.errors, 'invalid-csrf.html');
    try {
        fs.symlinkSync(real, link);
    } catch (error) {
        t.skip(`this system does not allow symbolic links (${error.code})`);
        return;
    }
    const log = captureLog();
    run(install, log);
    assert.deepEqual(fs.readFileSync(real), fixture('invalid-csrf.html', 'a96a8cdba9'));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.ok(messages(log, 'warn').includes('Kept _errors/invalid-csrf.html: it is not a plain file, so it is not updated.'));
    assert.equal(readErrorPage('invalid-csrf.html', { dataRoot: install.dataRoot, shippedRoot }), fixture('invalid-csrf.html', 'a96a8cdba9').toString('utf8'), 'still served through the link');
});

test('G2 _errors that is a file is logged once and the server goes on', t => {
    const install = newInstall(t);
    fs.writeFileSync(install.errors, 'not a folder');
    const log = captureLog();
    assert.doesNotThrow(() => run(install, log));
    assert.deepEqual(messages(log).filter(message => message.startsWith('Could not create the folder _errors')).length, 1);
    assert.equal(log.lines.length, 1);
});

test('G3 readErrorPage prefers a readable data copy and falls back to the shipped copy', t => {
    const install = newInstall(t);
    const reads = name => readErrorPage(name, { dataRoot: install.dataRoot, shippedRoot });
    const error = t.mock.method(console, 'error', () => {});
    assert.equal(reads('invalid-csrf.html'), shipped('invalid-csrf.html').toString('utf8'), 'no data copy');
    put(install, 'invalid-csrf.html', '<p>data copy</p>');
    assert.equal(reads('invalid-csrf.html'), '<p>data copy</p>');
    fs.rmSync(path.join(install.errors, 'invalid-csrf.html'));
    fs.mkdirSync(path.join(install.errors, 'invalid-csrf.html'));
    assert.equal(reads('invalid-csrf.html'), shipped('invalid-csrf.html').toString('utf8'), 'a folder in the way');
    fs.rmdirSync(path.join(install.errors, 'invalid-csrf.html'));
    put(install, 'invalid-csrf.html', '');
    assert.equal(reads('invalid-csrf.html'), shipped('invalid-csrf.html').toString('utf8'), 'an empty data copy');
    assert.equal(error.mock.callCount(), 0);
});

test('G3 readErrorPage returns null, never an empty string, when no copy can be read, and says so once', t => {
    const install = newInstall(t);
    const nowhere = path.join(install.base, 'no-shipped-folder');
    const error = t.mock.method(console, 'error', () => {});
    const options = { dataRoot: install.dataRoot, shippedRoot: nowhere };
    assert.equal(readErrorPage('host-not-allowed.html', options), null, 'both missing');
    assert.equal(readErrorPage('host-not-allowed.html', options), null);
    assert.equal(error.mock.callCount(), 1, 'one line for repeated reads of the same page');
    assert.equal(error.mock.calls[0].arguments[0], 'No copy of the error page host-not-allowed.html could be read; a plain answer is sent instead.');
    put(install, 'host-not-allowed.html', '');
    assert.equal(readErrorPage('host-not-allowed.html', options), null, 'empty data copy and no shipped folder');
    const emptyShipped = path.join(install.base, 'empty-shipped');
    fs.mkdirSync(emptyShipped);
    fs.writeFileSync(path.join(emptyShipped, 'invalid-csrf.html'), '');
    assert.equal(readErrorPage('invalid-csrf.html', { dataRoot: install.dataRoot, shippedRoot: emptyShipped }), null, 'data copy missing and shipped copy empty');
});

test('G3 readErrorPage uses the data folder of the server when none is given', t => {
    const install = newInstall(t);
    put(install, 'invalid-csrf.html', '<p>from DATA_ROOT</p>');
    const previous = globalThis.DATA_ROOT;
    t.after(() => { globalThis.DATA_ROOT = previous; });
    globalThis.DATA_ROOT = install.dataRoot;
    assert.equal(readErrorPage('invalid-csrf.html'), '<p>from DATA_ROOT</p>');
});

const notFound = 'url-not-found.html';
const currentNotFound = () => shipped(notFound).toString('utf8');

test('G4 an administrator\'s public/error 404 page is served; shipped versions there are ignored', t => {
    const install = newInstall(t, { seeded: true });
    const options = { dataRoot: install.dataRoot, shippedRoot, publicErrorRoot: install.publicErrorRoot };
    assert.equal(readNotFoundPage(options), currentNotFound(), 'no public/error folder');
    fs.mkdirSync(install.publicErrorRoot, { recursive: true });
    const file = path.join(install.publicErrorRoot, notFound);
    fs.writeFileSync(file, '<h1>Our own 404</h1>');
    assert.equal(readNotFoundPage(options), '<h1>Our own 404</h1>');
    for (const [page, blob] of HISTORICAL.filter(([page]) => page === notFound)) {
        for (const convert of [toLf, toCrlf]) {
            fs.writeFileSync(file, convert(fixture(page, blob)));
            assert.equal(readNotFoundPage(options), currentNotFound(), `${blob} in public/error is ignored`);
        }
    }
    fs.writeFileSync(file, shipped(notFound));
    assert.equal(readNotFoundPage(options), currentNotFound());
});

test('G4 both historical 404 variants, side by side after the start-up pass', t => {
    const pairs = [
        ['2c1fbbb301', 'c331cd018e'],
        ['c331cd018e', '2c1fbbb301'],
        ['9c881dfc21', '87974145f7'],
        ['87974145f7', '9c881dfc21'],
    ];
    for (const [inErrors, inPublic] of pairs) {
        const install = newInstall(t, { seeded: true });
        put(install, notFound, fixture(notFound, inErrors));
        fs.mkdirSync(install.publicErrorRoot, { recursive: true });
        const publicFile = path.join(install.publicErrorRoot, notFound);
        fs.writeFileSync(publicFile, fixture(notFound, inPublic));
        age(publicFile);
        const before = state(publicFile);
        const log = captureLog();
        run(install, log);
        assert.equal(readNotFoundPage({ dataRoot: install.dataRoot, shippedRoot, publicErrorRoot: install.publicErrorRoot }), currentNotFound(), `${inErrors} with ${inPublic}`);
        assert.deepEqual(state(publicFile), before, 'public/error is never written');
        assert.deepEqual(messages(log, 'warn').filter(message => message.includes('public/error')), []);
    }
});

test('G4 an empty page is passed over', t => {
    const install = newInstall(t, { seeded: true });
    fs.mkdirSync(install.publicErrorRoot, { recursive: true });
    const publicFile = path.join(install.publicErrorRoot, notFound);
    fs.writeFileSync(publicFile, '');
    age(publicFile);
    const before = state(publicFile);
    assert.equal(readNotFoundPage({ dataRoot: install.dataRoot, shippedRoot, publicErrorRoot: install.publicErrorRoot }), currentNotFound());
    assert.deepEqual(state(publicFile), before);
    fs.rmSync(publicFile);
    put(install, notFound, '');
    assert.equal(readNotFoundPage({ dataRoot: install.dataRoot, shippedRoot, publicErrorRoot: install.publicErrorRoot }), currentNotFound(), 'an empty data copy gives the shipped page');
});

test('G5 the public/error line is logged for an administrator\'s copy only', t => {
    const line = 'Missing pages use your own public/error/url-not-found.html; _errors/url-not-found.html is not used while it exists.';
    const cases = [
        ['<h1>Our own 404</h1>', true],
        [fixture(notFound, 'c331cd018e'), false],
        [fixture(notFound, '87974145f7'), false],
        [toCrlf(fixture(notFound, '2c1fbbb301')), false],
        [shipped(notFound), false],
        ['', false],
    ];
    for (const [bytes, expected] of cases) {
        const install = newInstall(t, { seeded: true });
        fs.mkdirSync(install.publicErrorRoot, { recursive: true });
        fs.writeFileSync(path.join(install.publicErrorRoot, notFound), bytes);
        const log = captureLog();
        run(install, log);
        assert.equal(messages(log, 'warn').includes(line), expected, String(bytes).slice(0, 40));
    }
    const none = newInstall(t, { seeded: true });
    const log = captureLog();
    run(none, log);
    assert.equal(messages(log).includes(line), false, 'no public/error folder');
});

test('G6 isPageLoad tells a page load from an API request', () => {
    const request = (method, requestPath, headers = {}) => ({ method, path: requestPath, headers });
    const navigation = {
        chromium: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        firefox: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        safari: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        plain: 'text/html',
    };
    for (const accept of Object.values(navigation)) {
        assert.equal(isPageLoad(request('GET', '/', { accept })), true, accept);
        assert.equal(isPageLoad(request('GET', '/some/page', { accept })), true, accept);
        assert.equal(isPageLoad(request('POST', '/', { accept })), true, 'a form navigation');
        assert.equal(isPageLoad(request('HEAD', '/', { accept })), true);
        assert.equal(isPageLoad(request('GET', '/api/ping', { accept })), false, accept);
        assert.equal(isPageLoad(request('GET', '/api', { accept })), false, accept);
        assert.equal(isPageLoad(request('POST', '/api/chats/get', { accept })), false, accept);
    }
    assert.equal(isPageLoad(request('GET', '/api-docs', { accept: navigation.plain })), true, 'only /api and /api/ are API paths');
    for (const accept of ['*/*', 'application/json', 'application/json, text/javascript, */*; q=0.01', undefined]) {
        assert.equal(isPageLoad(request('GET', '/', accept === undefined ? {} : { accept })), false, String(accept));
    }
    assert.equal(isPageLoad(request('GET', '/', { 'accept': '*/*', 'sec-fetch-mode': 'navigate' })), false, 'Fetch Metadata is not used');
    assert.equal(isPageLoad(request('GET', '/', { 'accept': 'text/html', 'sec-fetch-mode': 'cors' })), true, 'Fetch Metadata is not used');
});

test('G7 a fresh install gets every page, and neither run touches public/error', t => {
    const empty = newInstall(t);
    const log = captureLog();
    run(empty, log);
    assert.deepEqual(fs.readdirSync(empty.errors).sort(), [...MANAGED_ERROR_PAGES].sort());
    for (const name of MANAGED_ERROR_PAGES) assert.deepEqual(fs.readFileSync(path.join(empty.errors, name)), shipped(name), name);
    assert.equal(fs.existsSync(empty.publicErrorRoot), false);
    assert.equal(fs.existsSync(path.dirname(empty.publicErrorRoot)), false);

    const seeded = newInstall(t, { seeded: true });
    const seededLog = captureLog();
    run(seeded, seededLog);
    assert.deepEqual(messages(seededLog), [
        'Created the error page _errors/https-required.html.',
        'Created the error page _errors/invalid-csrf.html.',
    ]);
    assert.deepEqual(fs.readdirSync(seeded.errors).sort(), [...MANAGED_ERROR_PAGES, 'unauthorized.html'].sort());
    assert.equal(fs.existsSync(seeded.publicErrorRoot), false);
    assert.equal(fs.readFileSync(path.join(seeded.errors, 'unauthorized.html'), 'utf8'), fs.readFileSync(path.join(shippedRoot, 'unauthorized.html'), 'utf8'), 'unauthorized.html is left to the content seeding');
});

/* global globalThis */

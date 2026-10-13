/* global window, document */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The loader in a real browser. No Neconyan server: a route handler on a made-up origin serves the checkout's files
// and dictionaries made for the test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://c5-pages.test';
const pageKeys = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'page-text-keys.json'), 'utf8'));
const MARK = '«de» ';
const LANGUAGES = [{ lang: 'de-de', display: 'Deutsch' }, { lang: 'pt-pt', display: 'Português' }, { lang: 'it-it', display: 'Italiano' }];

const marker = keys => Object.fromEntries(keys.map(key => [key, MARK + key]));
const json = (body, status = 200) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };

/** A file of the checkout's public folder, or null. */
function publicFile(requestPath) {
    const file = path.join(root, 'public', decodeURIComponent(requestPath));
    if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return { status: 200, contentType: contentTypes[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) };
}

/**
 * Opens a page in a fresh context.
 * options.dictionary / supplement: contents of the two dictionary files of de-de; mode: how /locales/* answers
 * (ok, abort, unauthorised); documents: extra served documents by path.
 */
async function open(browser, { locale = 'en-US', stored, storageBlocked = false, dictionary = {}, supplement = {}, mode = 'ok', documents = {}, handlers = {} } = {}) {
    const context = await browser.newContext({ locale, serviceWorkers: 'block' });
    if (stored !== undefined) await context.addInitScript(value => window.localStorage.setItem('language', value), stored);
    if (storageBlocked) {
        await context.addInitScript(() => {
            window.Storage.prototype.getItem = function () { throw new window.DOMException('blocked', 'SecurityError'); };
        });
    }
    const page = await context.newPage();
    const state = { requests: [], errors: [], warnings: [] };
    page.on('pageerror', error => state.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'warning') state.warnings.push(message.text()); });
    await page.route(`${ORIGIN}/**`, async route => {
        const url = new URL(route.request().url());
        state.requests.push(url.pathname);
        if (handlers[url.pathname]) return route.fulfill(await handlers[url.pathname](route));
        if (documents[url.pathname]) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: documents[url.pathname] });
        if (url.pathname.startsWith('/locales/')) {
            if (mode === 'abort') return route.abort();
            if (mode === 'unauthorised') return route.fulfill(json({ error: 'You are signed out. Sign in to continue.' }, 401));
            if (url.pathname === '/locales/lang.json') return route.fulfill(json(LANGUAGES));
            if (url.pathname === '/locales/de-de.json') return route.fulfill(json(dictionary));
            if (url.pathname === '/locales/neconyan/de-de.json') return route.fulfill(json(supplement));
            if (url.pathname.startsWith('/locales/')) return route.fulfill(json({}));
        }
        const file = publicFile(url.pathname);
        return route.fulfill(file ?? { status: 404, contentType: 'text/plain', body: 'not found' });
    });
    return { context, page, state };
}

const E1_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title data-i18n="E1 title">E1 title</title>
<script type="module">import { startPageLocale } from '/scripts/page-locale.js'; window.loaded = startPageLocale();</script></head>
<body>
<h1 id="heading" data-i18n="Heading">Heading</h1>
<img id="logo" alt="A logo" data-i18n="[alt]A logo" src="data:,">
<p id="compose" data-i18n-compose="Run \${0} now, then \${1}.">Run <code id="c0">alpha</code> now, then <code id="c1">beta</code>.</p>
<p id="lost" data-i18n-compose="Keep \${0} please.">Keep <code>this</code> please.</p>
<p id="parent" data-i18n="Parent">Parent <b>child</b></p>
<input id="value-key" value="typed" data-i18n="[value]Value caption">
<input id="hint" placeholder="Hint" data-i18n="[placeholder]Hint">
<input id="self-label" aria-label="Self label" data-i18n="[aria-label]Self label">
<section id="section" aria-label="Section label" data-i18n="[aria-label]Section label"><label for="inner">Inner label</label><input id="inner" value="typed text"></section>
<div id="wrapper" data-i18n="Wrapper"><input id="wrapped" value="inside"></div>
<p id="unmarked">Unmarked text</p>
</body></html>`;

const E1_DICTIONARY = {
    ...marker(['E1 title', 'Heading', 'A logo', 'Parent', 'Value caption', 'Hint', 'Self label', 'Section label', 'Wrapper']),
    'Run ${0} now, then ${1}.': MARK + 'Dann ${1}, zuvor ${0}.',
    'Keep ${0} please.': MARK + 'Behalte bitte',
};

async function openE1(browser, options = {}) {
    const opened = await open(browser, { dictionary: E1_DICTIONARY, documents: { '/e1.html': E1_PAGE }, ...options });
    await opened.page.goto(`${ORIGIN}/e1.html`);
    await opened.page.evaluate(() => window.loaded);
    return opened;
}

test.describe('E1 the loader in a browser', () => {
    test('the browser language picks the dictionary, and translated text, attributes and language are set', async ({ browser }) => {
        const { page, state, context } = await openE1(browser, { locale: 'de-DE' });
        await expect(page.locator('html')).toHaveAttribute('lang', 'de-de');
        await expect(page.locator('#heading')).toHaveText(MARK + 'Heading');
        await expect(page.locator('#logo')).toHaveAttribute('alt', MARK + 'A logo');
        expect(await page.title()).toBe(MARK + 'E1 title');
        await expect(page.locator('#unmarked')).toHaveText('Unmarked text');
        expect(state.requests.filter(request => request.startsWith('/locales/')).sort()).toEqual(['/locales/de-de.json', '/locales/lang.json', '/locales/neconyan/de-de.json']);
        expect(state.errors).toEqual([]);
        await context.close();
    });

    test('a composed text puts the same code elements in the order the translation needs', async ({ browser }) => {
        const { page, context } = await openE1(browser, { locale: 'de-DE' });
        const result = await page.evaluate(() => {
            const compose = document.querySelector('#compose');
            return { text: compose.textContent, order: [...compose.querySelectorAll('code')].map(code => code.id), texts: [...compose.querySelectorAll('code')].map(code => code.textContent) };
        });
        expect(result.text).toBe(MARK + 'Dann beta, zuvor alpha.');
        expect(result.order).toEqual(['c1', 'c0']);
        expect(result.texts).toEqual(['beta', 'alpha']);
        await context.close();
    });

    test('the same code nodes survive a composed translation', async ({ browser }) => {
        const opened = await open(browser, { locale: 'de-DE', dictionary: E1_DICTIONARY, documents: { '/e1.html': E1_PAGE.replace('window.loaded = startPageLocale();', 'document.querySelector("#c0").tagged = 1; document.querySelector("#c1").tagged = 2; window.loaded = startPageLocale();') } });
        await opened.page.goto(`${ORIGIN}/e1.html`);
        await opened.page.evaluate(() => window.loaded);
        const tags = await opened.page.evaluate(() => [document.querySelector('#c0').tagged, document.querySelector('#c1').tagged, document.querySelector('#compose').lastElementChild.id]);
        expect(tags).toEqual([1, 2, 'c0']);
        await opened.context.close();
    });

    test('a value that lost its hole leaves the English text', async ({ browser }) => {
        const { page, context } = await openE1(browser, { locale: 'de-DE' });
        await expect(page.locator('#lost')).toHaveText('Keep this please.');
        expect(await page.locator('#lost code').count()).toBe(1);
        await context.close();
    });

    test('the stored choice wins over the browser language, and stored English or an unsupported choice show English', async ({ browser }) => {
        const stored = await openE1(browser, { locale: 'it-IT', stored: 'de-de' });
        await expect(stored.page.locator('#heading')).toHaveText(MARK + 'Heading');
        await stored.context.close();

        const english = await openE1(browser, { locale: 'de-DE', stored: 'en' });
        await expect(english.page.locator('#heading')).toHaveText('Heading');
        await expect(english.page.locator('html')).toHaveAttribute('lang', 'en');
        expect(english.state.requests.filter(request => request.startsWith('/locales/'))).toEqual([]);
        await english.context.close();

        const unsupported = await openE1(browser, { locale: 'de-DE', stored: 'xx-yy' });
        await expect(unsupported.page.locator('#heading')).toHaveText('Heading');
        expect(unsupported.state.requests).toContain('/locales/lang.json');
        expect(unsupported.state.requests).not.toContain('/locales/de-de.json');
        await unsupported.context.close();

        const wholeTag = await openE1(browser, { locale: 'de' });
        await expect(wholeTag.page.locator('#heading')).toHaveText('Heading');
        await wholeTag.context.close();
    });

    test('blocked storage falls back to the browser language', async ({ browser }) => {
        const { page, context } = await openE1(browser, { locale: 'de-DE', storageBlocked: true });
        await expect(page.locator('#heading')).toHaveText(MARK + 'Heading');
        await context.close();
    });

    test('an aborted or refused dictionary leaves English and sets no error', async ({ browser }) => {
        for (const mode of ['abort', 'unauthorised']) {
            const { page, state, context } = await openE1(browser, { locale: 'de-DE', mode });
            await expect(page.locator('#heading')).toHaveText('Heading');
            await expect(page.locator('html')).toHaveAttribute('lang', 'en');
            expect(state.errors).toEqual([]);
            expect(state.warnings.length).toBeLessThanOrEqual(1);
            await context.close();
        }
    });

    test('the in-place rules skip elements with children, value and placeholder keys and fields', async ({ browser }) => {
        const { page, state, context } = await openE1(browser, { locale: 'de-DE' });
        const result = await page.evaluate(() => ({
            parent: document.querySelector('#parent').innerHTML,
            valueKey: [document.querySelector('#value-key').value, document.querySelector('#value-key').getAttribute('value')],
            hint: document.querySelector('#hint').getAttribute('placeholder'),
            selfLabel: document.querySelector('#self-label').getAttribute('aria-label'),
            wrapper: document.querySelector('#wrapper').innerHTML,
        }));
        expect(result.parent).toBe('Parent <b>child</b>');
        expect(result.valueKey).toEqual(['typed', 'typed']);
        expect(result.hint).toBe('Hint');
        expect(result.selfLabel).toBe('Self label');
        expect(result.wrapper).toBe('<input id="wrapped" value="inside">');
        expect(state.warnings.filter(text => text.includes('child elements'))).toHaveLength(1);
        await context.close();
    });

    test('an aria-label key on a wrapper of a field sets that attribute only and leaves the field alone', async ({ browser }) => {
        const opened = await open(browser, { locale: 'de-DE', dictionary: E1_DICTIONARY, documents: { '/e1.html': E1_PAGE.replace('window.loaded = startPageLocale();', 'const inner = document.querySelector("#inner"); inner.tagged = 7; inner.focus(); inner.setSelectionRange(2, 2); window.loaded = startPageLocale();') } });
        await opened.page.goto(`${ORIGIN}/e1.html`);
        await opened.page.evaluate(() => window.loaded);
        const result = await opened.page.evaluate(() => {
            const inner = document.querySelector('#inner');
            return {
                label: document.querySelector('#section').getAttribute('aria-label'),
                tagged: inner.tagged,
                same: inner === document.querySelector('#section input'),
                focused: document.activeElement === inner,
                value: inner.value,
                caret: [inner.selectionStart, inner.selectionEnd],
                innerLabel: document.querySelector('#section label').textContent,
            };
        });
        expect(result).toEqual({ label: MARK + 'Section label', tagged: 7, same: true, focused: true, value: 'typed text', caret: [2, 2], innerLabel: 'Inner label' });
        await opened.context.close();
    });
});

const LOGIN_ACCOUNTS = [{ handle: 'cancel', name: 'Cancel', avatar: '/img/neconyan.png', password: true }, { handle: 'password', name: 'Password', avatar: '/img/neconyan.png', password: true }];

test.describe('E2 the three client pages show a marker for every marked text', () => {
    const csrfPage = fs.readFileSync(path.join(root, 'default', 'content', 'errors', 'invalid-csrf.html'), 'utf8');
    const notFoundPage = fs.readFileSync(path.join(root, 'default', 'content', 'errors', 'url-not-found.html'), 'utf8');

    /** Everything marked on the page that does not show its expected marker. */
    const mismatches = page => page.evaluate(mark => {
        const problems = [];
        for (const element of document.querySelectorAll('[data-i18n]')) {
            for (const spec of element.getAttribute('data-i18n').split(';')) {
                const match = spec.match(/^\[([^\]]+)\](.+)$/s);
                const shown = match ? element.getAttribute(match[1]) : element.textContent;
                if (shown !== mark + (match ? match[2] : spec)) problems.push(`${element.tagName} ${spec}: ${shown}`);
            }
        }
        for (const element of document.querySelectorAll('[data-i18n-compose]')) {
            const key = element.getAttribute('data-i18n-compose');
            const codes = [...element.querySelectorAll('code')].map(code => code.textContent);
            const expected = (mark + key).replace(/\$\{(\d+)\}/g, (_match, index) => codes[Number(index)]);
            if (element.textContent !== expected) problems.push(`${element.tagName} ${key}: ${element.textContent}`);
        }
        return problems;
    }, MARK);

    test('the sign-in page, with account names left as they are', async ({ browser }) => {
        const keys = pageKeys['public/login.html'];
        const { page, state, context } = await open(browser, {
            locale: 'de-DE',
            dictionary: marker(keys),
            handlers: {
                '/login': async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(root, 'public', 'login.html')) }),
                '/csrf-token': async () => json({ token: 'token' }),
                '/api/auth/status': async () => json({ authenticated: false, browserSession: false, accountsEnabled: true, basicAuthMode: false, passkeysEnabled: false }),
                '/api/users/list': async () => json(LOGIN_ACCOUNTS),
            },
        });
        await page.goto(`${ORIGIN}/login`);
        await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
        await expect(page.locator('.userName')).toHaveText(['Cancel', 'Password']);
        expect(await mismatches(page)).toEqual([]);
        expect(await page.title()).toBe(MARK + 'Sign in · Neconyan');
        await expect(page.locator('html')).toHaveAttribute('lang', 'de-de');
        expect(state.errors).toEqual([]);
        await context.close();
    });

    test('the session-expired page, with its three code examples unchanged', async ({ browser }) => {
        const keys = pageKeys['default/content/errors/invalid-csrf.html'];
        const { page, state, context } = await open(browser, { locale: 'de-DE', dictionary: marker(keys), documents: { '/csrf': csrfPage } });
        await page.goto(`${ORIGIN}/csrf`);
        await expect(page.locator('h1')).toHaveText(MARK + 'Session expired');
        expect(await mismatches(page)).toEqual([]);
        await expect(page.locator('code')).toHaveText(['Invalid CSRF token', 'sudo systemctl restart neconyan', 'https://neconyan.purabunny.cc']);
        expect(await page.title()).toBe(MARK + 'Session expired');
        expect(state.errors).toEqual([]);
        await context.close();
    });

    test('the 404 page', async ({ browser }) => {
        const keys = pageKeys['default/content/errors/url-not-found.html'];
        const { page, state, context } = await open(browser, { locale: 'de-DE', dictionary: marker(keys), documents: { '/missing': notFoundPage } });
        await page.goto(`${ORIGIN}/missing`);
        await expect(page.locator('h1')).toHaveText(MARK + 'Not found');
        expect(await mismatches(page)).toEqual([]);
        await expect(page.locator('p')).toHaveText(MARK + 'This page does not exist. Check the address for typos, or go back to the main Neconyan page.');
        expect(state.errors).toEqual([]);
        await context.close();
    });

    test('the session-expired and 404 pages stay English when the language has no dictionary values', async ({ browser }) => {
        const { page, context } = await open(browser, { locale: 'de-DE', dictionary: {}, documents: { '/csrf': csrfPage } });
        await page.goto(`${ORIGIN}/csrf`);
        await expect(page.locator('h1')).toHaveText('Session expired');
        await expect(page.locator('code').first()).toHaveText('Invalid CSRF token');
        await context.close();
    });
});

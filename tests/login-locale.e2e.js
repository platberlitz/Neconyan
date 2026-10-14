/* global window, document, MutationObserver, HTMLInputElement, requestAnimationFrame, getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The sign-in page with a slow, a failed and a late dictionary. No Neconyan server: the page, its script, the loader,
// jQuery, the stylesheet, the fonts and the images come from the checkout through a route handler on a made-up
// origin, and the sign-in requests are stubbed. Every test runs on a desktop and on a phone (393x852, touch).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://c5-login.test';
const MARK = '«de» ';
const pageKeys = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'page-text-keys.json'), 'utf8'));
const CAPTIONS = pageKeys['public/login.html'];
const MESSAGES = ['That name or password did not match.', 'Type your username first.', 'Type your password first.', 'Could not reach the server. Refresh to try again.'];
const marker = keys => Object.fromEntries(keys.map(key => [key, MARK + key]));
const json = (body, status = 200) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };

function publicFile(requestPath) {
    const file = path.join(root, 'public', decodeURIComponent(requestPath));
    if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return { status: 200, contentType: contentTypes[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) };
}

function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

const VIEWPORTS = [
    { name: 'desktop', viewport: { width: 1280, height: 900 }, phone: false },
    { name: 'phone', viewport: { width: 393, height: 852 }, phone: true },
];

/**
 * Opens a context and a page with the stubs. Options:
 * variant: 'basic' (workspace form) or 'accounts' (discreet login); locale; hold (a gate that holds every dictionary
 * request); files (what /locales/* and the loader answer, by path: 'abort', { status, body } or an object);
 * login (a function returning the answer to the next sign-in request).
 */
async function openLogin(browser, { variant = 'basic', locale = 'de-DE', phone, dictionary = marker([...CAPTIONS, ...MESSAGES]), hold = null, files = {}, login = () => ({ status: 200, body: { handle: 'ana' } }), loginGate = null } = {}) {
    const viewport = VIEWPORTS.find(entry => entry.phone === phone);
    const context = await browser.newContext({ locale, viewport: viewport.viewport, hasTouch: phone, isMobile: phone, serviceWorkers: 'block' });
    const page = await context.newPage();
    const state = { requests: [], posts: [], errors: [], warnings: [] };
    page.on('pageerror', error => state.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'warning') state.warnings.push(message.text()); });
    await page.addInitScript(() => {
        window.__frames = 0;
        window.__hiddenFrames = 0;
        const tick = () => {
            const dialogue = document.getElementById('dialogue_popup');
            if (dialogue) {
                window.__frames++;
                const style = getComputedStyle(dialogue);
                if (style.visibility === 'hidden' || style.opacity === '0' || style.display === 'none') window.__hiddenFrames++;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const safely = async (route, response) => { try { await route.fulfill(response); } catch { /* the page has moved on */ } };
    await page.route(`${ORIGIN}/**`, async route => {
        const url = new URL(route.request().url());
        const request = route.request();
        state.requests.push(`${request.method()} ${url.pathname}`);
        const { pathname } = url;
        if (pathname === '/login') return safely(route, { status: 200, contentType: contentTypes['.html'], body: fs.readFileSync(path.join(root, 'public', 'login.html')) });
        if (pathname === '/') return safely(route, { status: 200, contentType: contentTypes['.html'], body: '<!DOCTYPE html><title>Home</title><p id="home">Home</p>' });
        if (pathname === '/csrf-token') return safely(route, json({ token: 'token' }));
        if (pathname === '/api/auth/status') {
            return safely(route, json(variant === 'basic'
                ? { authenticated: false, browserSession: false, accountsEnabled: false, basicAuthMode: true, passkeysEnabled: false }
                : { authenticated: false, browserSession: false, accountsEnabled: true, basicAuthMode: false, passkeysEnabled: false }));
        }
        if (pathname === '/api/users/list') return safely(route, { status: 204, body: '' });
        if (pathname === '/api/auth/browser/login' || pathname === '/api/users/login') {
            state.posts.push(JSON.parse(request.postData() ?? '{}'));
            if (loginGate) await loginGate.promise;
            const answer = login(state.posts.length);
            return safely(route, json(answer.body, answer.status));
        }
        const isLocale = pathname.startsWith('/locales/');
        const spec = files[pathname] ?? (isLocale ? undefined : null);
        if (spec === 'abort') return route.abort().catch(() => {});
        if (isLocale || spec) {
            if (hold) await hold.promise;
            if (spec) return safely(route, spec.raw ? { status: spec.status, contentType: spec.contentType ?? 'application/json', body: spec.raw } : json(spec.body ?? {}, spec.status ?? 200));
            if (pathname === '/locales/lang.json') return safely(route, json([{ lang: 'de-de', display: 'Deutsch' }]));
            if (pathname === '/locales/de-de.json') return safely(route, json(dictionary));
            return safely(route, json({}));
        }
        const file = publicFile(pathname);
        return safely(route, file ?? { status: 404, contentType: 'text/plain', body: 'not found' });
    });
    return { context, page, state };
}

const formVisible = page => expect(page.locator('#workspaceLoginBlock')).toBeVisible();

for (const { name, phone } of VIEWPORTS) {
    test.describe(`sign-in page on ${name}`, () => {
        test('L1 the form is usable at once while the dictionary is held', async ({ browser }) => {
            const hold = gate();
            const { page, state, context } = await openLogin(browser, { phone, hold });
            await page.goto(`${ORIGIN}/login`);
            await formVisible(page);
            await expect(page.locator('#workspaceUsername')).toBeEnabled();
            await expect(page.locator('#workspacePassword')).toBeEnabled();
            await expect(page.locator('#workspaceLoginButton')).toBeEnabled();
            await expect(page.locator('h1')).toHaveText('Meowlcome back');
            await page.locator('#workspaceUsername').fill('ana');
            await page.locator('#workspacePassword').fill('secret99');
            await page.locator('#workspacePassword').press('Enter');
            await page.waitForURL(`${ORIGIN}/`);
            expect(state.posts).toEqual([{ username: 'ana', password: 'secret99', remember: false }]);
            hold.release();
            expect(state.errors).toEqual([]);
            await context.close();
        });

        test('L1 the dialogue is never hidden, from the first frame', async ({ browser }) => {
            const hold = gate();
            const { page, context } = await openLogin(browser, { phone, hold });
            await page.goto(`${ORIGIN}/login`);
            await formVisible(page);
            await page.waitForTimeout(500);
            const frames = await page.evaluate(() => ({ frames: window.__frames, hidden: window.__hiddenFrames }));
            expect(frames.frames).toBeGreaterThan(3);
            expect(frames.hidden).toBe(0);
            hold.release();
            await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
            const after = await page.evaluate(() => ({ frames: window.__frames, hidden: window.__hiddenFrames }));
            expect(after.hidden).toBe(0);
            await context.close();
        });

        test('L1 the account sign-in works the same way while the dictionary is held', async ({ browser }) => {
            const hold = gate();
            const { page, state, context } = await openLogin(browser, { phone, hold, variant: 'accounts' });
            await page.goto(`${ORIGIN}/login`);
            await expect(page.locator('#userHandle')).toBeVisible();
            await page.locator('#userHandle').fill('ana');
            await page.locator('#userPassword').fill('secret99');
            await page.locator('#loginButton').click();
            await page.waitForURL(`${ORIGIN}/`);
            expect(state.posts).toEqual([{ handle: 'ana', password: 'secret99' }]);
            hold.release();
            await context.close();
        });

        const failures = {
            'the loader answered 404': { files: { '/scripts/page-locale.js': { status: 404, raw: 'not found', contentType: 'text/plain' } } },
            'the loader answered 401 JSON': { files: { '/scripts/page-locale.js': { status: 401, body: { error: 'You are signed out. Sign in to continue.' } } } },
            'the loader was aborted': { files: { '/scripts/page-locale.js': 'abort' } },
            'lang.json answered 401 JSON': { files: { '/locales/lang.json': { status: 401, body: { error: 'You are signed out. Sign in to continue.' } } } },
            'the base dictionary answered 500': { files: { '/locales/de-de.json': { status: 500, raw: 'broken', contentType: 'text/plain' }, '/locales/neconyan/de-de.json': { body: marker(CAPTIONS) } }, partial: true },
            'the supplement is not JSON': { files: { '/locales/neconyan/de-de.json': { status: 200, raw: '{ not json' } }, dictionary: marker(CAPTIONS), partial: true },
            'both dictionaries were aborted': { files: { '/locales/de-de.json': 'abort', '/locales/neconyan/de-de.json': 'abort' } },
        };
        for (const [title, failure] of Object.entries(failures)) {
            test(`L2 sign-in still works when ${title}`, async ({ browser }) => {
                const { page, state, context } = await openLogin(browser, { phone, files: failure.files, dictionary: failure.dictionary, login: attempt => (attempt === 1 ? { status: 401, body: {} } : { status: 200, body: { handle: 'ana' } }) });
                await page.goto(`${ORIGIN}/login`);
                await formVisible(page);
                await page.locator('#workspaceUsername').fill('ana');
                await page.locator('#workspacePassword').fill('wrong-one');
                await page.locator('#workspaceLoginButton').click();
                await expect(page.locator('#errorMessage')).toHaveText('That name or password did not match.');
                if (failure.partial) await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
                else await expect(page.locator('h1')).toHaveText('Meowlcome back');
                await page.locator('#workspacePassword').fill('secret99');
                await page.locator('#workspaceLoginButton').click();
                await page.waitForURL(`${ORIGIN}/`);
                expect(state.posts).toEqual([{ username: 'ana', password: 'wrong-one', remember: false }, { username: 'ana', password: 'secret99', remember: false }]);
                expect(state.errors).toEqual([]);
                const loaderWarnings = state.warnings.filter(text => text.includes('page-locale') || text.includes('translation unavailable'));
                expect(loaderWarnings.length).toBeLessThanOrEqual(1);
                await context.close();
            });
        }

        /** Records every event on an input and every change under the dialogue, from now on. */
        const startRecording = page => page.evaluate(() => {
            window.__events = [];
            window.__mutations = [];
            const describe = node => (node.nodeType === 1 ? { tag: node.nodeName, id: node.id, containsInput: node.matches('input') || !!node.querySelector('input') } : { text: true });
            for (const type of ['input', 'change', 'focus', 'blur', 'focusin', 'focusout']) {
                document.addEventListener(type, event => { if (event.target instanceof HTMLInputElement) window.__events.push(`${type}:${event.target.id}`); }, true);
            }
            new MutationObserver(records => {
                for (const record of records) {
                    window.__mutations.push({ type: record.type, target: record.target.nodeName, targetId: record.target.id ?? '', attribute: record.attributeName, added: [...record.addedNodes].map(describe), removed: [...record.removedNodes].map(describe) });
                }
            }).observe(document.getElementById('dialogue_popup'), { subtree: true, childList: true, attributes: true, characterData: true });
        });

        const expectUntouched = async page => {
            const recorded = await page.evaluate(() => ({ events: window.__events, mutations: window.__mutations }));
            expect(recorded.events).toEqual([]);
            for (const mutation of recorded.mutations) {
                expect(mutation.target, JSON.stringify(mutation)).not.toBe('INPUT');
                for (const node of [...mutation.added, ...mutation.removed]) expect(node.containsInput, JSON.stringify(mutation)).not.toBe(true);
            }
            expect(recorded.mutations.length).toBeGreaterThan(0);
        };

        test('L3 typed values, caret and focus stay when the captions switch', async ({ browser }) => {
            const hold = gate();
            const { page, context } = await openLogin(browser, { phone, hold });
            await page.goto(`${ORIGIN}/login`);
            await formVisible(page);
            await page.locator('#workspaceUsername').fill('ana');
            await page.locator('#rememberDevice').check();
            await page.locator('#workspacePassword').click();
            await page.keyboard.type('secret99');
            await page.evaluate(() => {
                document.querySelectorAll('input').forEach((input, index) => { input.tagged = index + 1; });
                document.querySelector('#workspacePassword').setSelectionRange(3, 3);
            });
            await startRecording(page);
            hold.release();
            await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
            await expect(page.locator('label[for="workspaceUsername"]')).toHaveText(MARK + 'Username');
            const state = await page.evaluate(() => {
                const password = document.querySelector('#workspacePassword');
                return {
                    activeId: document.activeElement.id,
                    activeTag: document.activeElement.tagged,
                    caret: [password.selectionStart, password.selectionEnd],
                    username: document.querySelector('#workspaceUsername').value,
                    password: password.value,
                    remember: document.querySelector('#rememberDevice').checked,
                    tags: [...document.querySelectorAll('input')].map(input => input.tagged),
                };
            });
            expect(state.activeId).toBe('workspacePassword');
            expect(state.activeTag).toBeGreaterThan(0);
            expect(state.caret).toEqual([3, 3]);
            expect(state.username).toBe('ana');
            expect(state.password).toBe('secret99');
            expect(state.remember).toBe(true);
            expect(state.tags).toEqual([1, 2, 3, 4, 5, 6, 7]);
            await expectUntouched(page);
            await page.keyboard.type('X');
            await expect(page.locator('#workspacePassword')).toHaveValue('secXret99');
            await context.close();
        });

        test('L3 the same holds for the account fields', async ({ browser }) => {
            const hold = gate();
            const { page, context } = await openLogin(browser, { phone, hold, variant: 'accounts' });
            await page.goto(`${ORIGIN}/login`);
            await expect(page.locator('#userHandle')).toBeVisible();
            await page.locator('#userHandle').fill('ana');
            await page.locator('#userPassword').click();
            await page.keyboard.type('secret99');
            await page.evaluate(() => {
                document.querySelectorAll('input').forEach((input, index) => { input.tagged = index + 1; });
                document.querySelector('#userPassword').setSelectionRange(2, 2);
            });
            await startRecording(page);
            hold.release();
            await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
            const state = await page.evaluate(() => ({
                activeId: document.activeElement.id,
                caret: [document.querySelector('#userPassword').selectionStart, document.querySelector('#userPassword').selectionEnd],
                handle: document.querySelector('#userHandle').value,
                password: document.querySelector('#userPassword').value,
            }));
            expect(state).toEqual({ activeId: 'userPassword', caret: [2, 2], handle: 'ana', password: 'secret99' });
            await expectUntouched(page);
            await context.close();
        });

        test('L4 fields filled by a password manager are untouched', async ({ browser }) => {
            const hold = gate();
            const { page, context } = await openLogin(browser, { phone, hold });
            await page.goto(`${ORIGIN}/login`);
            await formVisible(page);
            const attributesBefore = await page.evaluate(() => {
                const fill = (id, value) => {
                    const input = document.getElementById(id);
                    input.value = value;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                };
                fill('workspaceUsername', 'ana');
                fill('workspacePassword', 'secret99');
                document.querySelectorAll('input').forEach((input, index) => { input.tagged = index + 1; });
                const read = id => Object.fromEntries([...document.getElementById(id).attributes].map(attribute => [attribute.name, attribute.value]));
                return { username: read('workspaceUsername'), password: read('workspacePassword') };
            });
            await startRecording(page);
            hold.release();
            await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
            const after = await page.evaluate(() => {
                const read = id => Object.fromEntries([...document.getElementById(id).attributes].map(attribute => [attribute.name, attribute.value]));
                return {
                    username: read('workspaceUsername'), password: read('workspacePassword'),
                    values: [document.getElementById('workspaceUsername').value, document.getElementById('workspacePassword').value],
                    tags: [...document.querySelectorAll('input')].map(input => input.tagged),
                    attributeMutationsOnInputs: window.__mutations.filter(mutation => mutation.type === 'attributes' && mutation.target === 'INPUT').length,
                };
            });
            expect(after.username).toEqual(attributesBefore.username);
            expect(after.password).toEqual(attributesBefore.password);
            expect(after.values).toEqual(['ana', 'secret99']);
            expect(after.tags).toEqual([1, 2, 3, 4, 5, 6, 7]);
            expect(after.attributeMutationsOnInputs).toBe(0);
            await expectUntouched(page);
            await context.close();
        });

        test('L5 English needs no dictionary; German with an immediate dictionary shows every caption', async ({ browser }) => {
            const english = await openLogin(browser, { phone, locale: 'en-GB' });
            await english.page.goto(`${ORIGIN}/login`);
            await formVisible(english.page);
            await expect(english.page.locator('h1')).toHaveText('Meowlcome back');
            await expect(english.page.locator('label[for="workspaceUsername"]')).toHaveText('Username');
            expect(english.state.requests).toContain('GET /scripts/page-locale.js');
            // English fetches the included-language index for the selector, but no translation dictionary.
            await expect(english.page.locator('#loginLanguage option[value="de-de"]')).toHaveCount(1);
            expect(english.state.requests.filter(request => request.includes('/locales/'))).toEqual(['GET /locales/lang.json']);
            await english.context.close();

            const german = await openLogin(browser, { phone, locale: 'de-DE' });
            await german.page.goto(`${ORIGIN}/login`);
            await formVisible(german.page);
            await expect(german.page.locator('html')).toHaveAttribute('lang', 'de-de');
            const problems = await german.page.evaluate(mark => {
                const found = [];
                for (const element of document.querySelectorAll('[data-i18n]')) {
                    const match = element.getAttribute('data-i18n').match(/^\[([^\]]+)\](.+)$/s);
                    const shown = match ? element.getAttribute(match[1]) : element.textContent;
                    if (shown !== mark + (match ? match[2] : element.getAttribute('data-i18n'))) found.push(`${element.tagName}: ${shown}`);
                }
                return found;
            }, MARK);
            expect(problems).toEqual([]);
            await german.context.close();
        });

        test('L6 a message shows in English at once and switches when the dictionary arrives', async ({ browser }) => {
            const hold = gate();
            const loginHold = gate();
            const { page, context } = await openLogin(browser, { phone, hold, loginGate: loginHold, login: () => ({ status: 401, body: {} }) });
            await page.goto(`${ORIGIN}/login`);
            await formVisible(page);

            // An empty submit is refused on the page, without a request.
            await page.locator('#workspaceLoginButton').click();
            await expect(page.locator('#errorMessage')).toHaveText('Type your username first.');
            await page.locator('#workspaceUsername').fill('ana');
            await page.locator('#workspacePassword').fill('wrong-one');
            // The next submit clears the message before it asks the server, and the server answer is held.
            await page.locator('#workspaceLoginButton').click();
            await expect(page.locator('#errorMessage')).toHaveText('');
            hold.release();
            await expect(page.locator('h1')).toHaveText(MARK + 'Meowlcome back');
            await expect(page.locator('#errorMessage')).toHaveText('');

            // An answer that arrives after the dictionary is shown translated straight away.
            loginHold.release();
            await expect(page.locator('#errorMessage')).toHaveText(MARK + 'That name or password did not match.');
            await page.locator('#workspaceUsername').fill('');
            await page.locator('#workspaceLoginButton').click();
            await expect(page.locator('#errorMessage')).toHaveText(MARK + 'Type your username first.');
            await context.close();
        });

        test('L6 a message shown before the dictionary arrives is replaced by its translation', async ({ browser }) => {
            const hold = gate();
            const { page, context } = await openLogin(browser, { phone, hold });
            await page.goto(`${ORIGIN}/login`);
            await formVisible(page);
            await page.locator('#workspaceLoginButton').click();
            await expect(page.locator('#errorMessage')).toHaveText('Type your username first.');
            hold.release();
            await expect(page.locator('#errorMessage')).toHaveText(MARK + 'Type your username first.');
            await context.close();
        });
    });
}

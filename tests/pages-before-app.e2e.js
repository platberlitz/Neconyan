/* global window, document */
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { mergePageDictionary, translationFor } from '../public/scripts/page-locale.js';

// The pages that load before the app, against real, owned, disposable servers (the pattern of notebooks-obsidian.e2e.js):
// S1 accounts mode, S2 basic-auth mode, S3 the blocked pages, and a display pass in five languages at two sizes.
// Expectations are computed from the real dictionaries as translationFor(merged, key) ?? key, so they hold before and after
// the translation stage adds values. Run with NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 and --workers=1.
const root = fileURLToPath(new URL('../', import.meta.url));
const localesRoot = path.join(root, 'public', 'locales');
const screenshotRoot = path.join(root, 'screenshots', 'pages-before-app');
const pageKeys = JSON.parse(readFileSync(path.join(root, 'tests', 'fixtures', 'page-text-keys.json'), 'utf8'));

// Only the made-up name blocked.test is sent to this computer; tests/playwright.config.js sets no launchOptions.
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP blocked.test 127.0.0.1'] }, serviceWorkers: 'block' });
test.setTimeout(240000);

const LANGUAGES = [
    { name: 'en', code: 'en', locale: 'en-GB' },
    { name: 'de', code: 'de-de', locale: 'de-DE' },
    { name: 'pt', code: 'pt-pt', locale: 'pt-PT' },
    { name: 'it', code: 'it-it', locale: 'it-IT' },
    { name: 'ar', code: 'ar-sa', locale: 'ar-SA' },
];
const VIEWPORTS = [
    { name: 'phone', options: { viewport: { width: 393, height: 852 }, hasTouch: true } },
    { name: 'desktop', options: { viewport: { width: 1280, height: 900 } } },
];

const keyOf = (file, start) => {
    const key = pageKeys[file].find(candidate => candidate.startsWith(start));
    if (!key) throw new Error(`No key starting ${start} in ${file}`);
    return key;
};
const KEYS = {
    loginTitle: 'Sign in · Neconyan',
    wrongPasswordWorkspace: 'That name or password did not match.',
    wrongPasswordAccount: 'That name or password is not correct.',
    notFoundTitle: 'Not found',
    notFoundText: keyOf('default/content/errors/url-not-found.html', 'This page does not exist'),
    sessionTitle: 'Session expired',
    sessionLead: keyOf('default/content/errors/invalid-csrf.html', 'This page is holding'),
    sessionSteps: [
        { start: 'Reload the page first', holes: [] },
        { start: 'Still refused after reloading', holes: ['Invalid CSRF token'] },
        { start: 'Every page failing', holes: [] },
        { start: 'Still failing in every browser', holes: ['sudo systemctl restart neconyan'] },
        { start: 'Old bookmark', holes: ['https://neconyan.purabunny.cc'] },
        { start: 'An extension or script', holes: [] },
    ].map(step => ({ key: keyOf('default/content/errors/invalid-csrf.html', step.start), holes: step.holes })),
    forbidden: 'Forbidden',
    whitelist: keyOf('default/content/errors/forbidden-by-whitelist.html', 'If you run this Neconyan'),
    connection: keyOf('default/content/errors/forbidden-by-whitelist.html', 'This connection from ${0} was blocked'),
    forwarded: keyOf('default/content/errors/forbidden-by-whitelist.html', 'This connection from ${0} (forwarded'),
    host: keyOf('default/content/errors/host-not-allowed.html', 'If you run this Neconyan'),
    hostBlocked: keyOf('default/content/errors/host-not-allowed.html', 'This address is not allowed'),
    httpsTitle: 'Connection not secure',
    https: keyOf('default/content/errors/https-required.html', 'This connection is not secure'),
};

const dictionaries = new Map();
function dictionary(code) {
    if (!dictionaries.has(code)) {
        const read = file => {
            try {
                return JSON.parse(readFileSync(path.join(localesRoot, file), 'utf8'));
            } catch {
                return {};
            }
        };
        dictionaries.set(code, mergePageDictionary(read(`${code}.json`), read(`neconyan/${code}.json`)));
    }
    return dictionaries.get(code);
}

/** The text a page shows for a key in a language: the dictionary's value if the pages accept it, else English; holes filled. */
function expected(code, key, holes = []) {
    const text = code === 'en' ? key : (translationFor(dictionary(code), key) ?? key);
    return text.replace(/\$\{(\d+)\}/g, (_, index) => holes[Number(index)] ?? '');
}
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// ---- owned servers -------------------------------------------------------------------------------------------------

function merge(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            target[key] ??= {};
            merge(target[key], value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

async function freePort() {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const { port } = reservation.address();
    await new Promise(resolve => reservation.close(resolve));
    return port;
}

/** Starts one disposable server (scratch data root and config, --browserLaunchEnabled false) and waits until it listens. */
async function startApp(patch = {}) {
    if (process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1') {
        throw new Error('Set NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 to run this owned, disposable fixture.');
    }
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pages-before-app-')));
    const port = await freePort();
    const dataRoot = path.join(directory, 'data');
    const config = YAML.parse(await fs.readFile(path.join(root, 'default/config.yaml'), 'utf8'));
    merge(config, {
        port,
        dataRoot,
        browserLaunch: { enabled: false },
        extensions: { autoUpdate: false, models: { autoDownload: false } },
        enableServerPlugins: false,
        enableServerPluginsAutoUpdate: false,
        enableDownloadableTokenizers: false,
        performance: { frontendBuild: { enabled: process.env.NECONYAN_TEST_FRONTEND_BUILD === '1' } },
    });
    merge(config, patch);
    await fs.mkdir(dataRoot);
    const configPath = path.join(directory, 'config.yaml');
    await fs.writeFile(configPath, YAML.stringify(config));
    let output = '';
    const child = spawn(process.execPath, ['server.js', '--configPath', configPath, '--dataRoot', dataRoot, '--port', String(port), '--browserLaunchEnabled', 'false'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', NECONYAN_SUPERVISED: '1' },
    });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
            try { await exited; } finally { clearTimeout(timer); }
        }
        await fs.rm(directory, { recursive: true, force: true });
    };
    try {
        const deadline = Date.now() + 180000;
        while (!/is listening on/.test(output)) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Disposable server exited: ${output}`);
            if (Date.now() > deadline) throw new Error(`Disposable server did not become ready: ${output}`);
            await delay(250);
        }
    } catch (error) {
        await stop();
        throw error;
    }
    return { url: `http://127.0.0.1:${port}`, port, directory, dataRoot, stop };
}

const LISTEN_LOCAL = {
    listen: true, listenAddress: { ipv4: '127.0.0.1', ipv6: '[::1]' }, protocol: { ipv4: true, ipv6: false },
};

function basicAuthPatch(extra = {}) {
    const username = 'c5-' + randomBytes(4).toString('hex');
    const password = randomBytes(12).toString('base64url');
    return { username, password, patch: { ...LISTEN_LOCAL, basicAuthMode: true, basicAuthUser: { username, password }, ...extra } };
}

/** Gives the default account a password and adds a second account named Cancel, through the server's own endpoints. */
async function prepareAccounts(url, password) {
    const jar = new Map();
    const call = async (route, options = {}) => {
        const response = await fetch(url + route, { ...options, headers: { ...options.headers, cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } });
        for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(';');
            const index = pair.indexOf('=');
            jar.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return response;
    };
    const token = (await (await call('/csrf-token')).json()).token;
    const post = (route, body) => call(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(body) });
    expect((await post('/api/users/login', { handle: 'default-user', password: '' })).ok).toBe(true);
    expect((await post('/api/users/change-password', { handle: 'default-user', oldPassword: '', newPassword: password })).status).toBe(204);
    expect((await post('/api/users/create', { handle: 'cancel', name: 'Cancel', password: '', admin: false })).ok).toBe(true);
}

// ---- helpers for the pages ------------------------------------------------------------------------------------------

const LOGIN_ENTRIES = [
    { selector: '#logoBlock h1', key: 'Meowlcome back' },
    { selector: '#logoBlock p', key: 'Get back to roleplaying, nya!' },
    { selector: '#logoBlock img', attribute: 'alt', key: 'A resting calico cat' },
    { selector: '#workspaceLoginBlock', attribute: 'aria-label', key: 'Workspace sign-in' },
    { selector: '#passkeyLoginBlock', attribute: 'aria-label', key: 'Passkey sign-in' },
    { selector: '#userSelectBlock', attribute: 'aria-label', key: 'Account sign-in' },
    { selector: 'label[for=workspaceUsername]', key: 'Username' },
    { selector: 'label[for=workspacePassword]', key: 'Password' },
    { selector: '#rememberBlock span', key: 'Remember this device for 30 days' },
    { selector: '#workspaceLoginButton', key: 'Sign in' },
    { selector: '#loginDivider span', key: 'or' },
    { selector: '#passkeyLoginButton', key: 'Sign in with a passkey' },
    { selector: '#normalLoginPrompt', key: 'Choose your account' },
    { selector: '#discreetLoginPrompt', key: 'Sign in' },
    { selector: 'label[for=userHandle]', key: 'Account' },
    { selector: 'label[for=userPassword]', key: 'Password' },
    { selector: '#loginButton', key: 'Sign in' },
    { selector: '#recoverPassword', key: 'Forgot password?' },
    { selector: '#recoverMessage', key: keyOf('public/login.html', 'The recovery code is printed') },
    { selector: 'label[for=recoveryCode]', key: 'Recovery code' },
    { selector: 'label[for=newPassword]', key: 'New password' },
    { selector: '#sendRecovery', key: 'Reset password' },
    { selector: '#cancelRecovery', key: 'Cancel' },
];

/** Differences between the sign-in page and what the language should show; an empty list means every caption matches. */
async function loginMismatches(page, code) {
    const actual = await page.evaluate(entries => ({
        lang: document.documentElement.lang,
        title: document.title,
        values: entries.map(entry => {
            const element = document.querySelector(entry.selector);
            if (!element) return null;
            return entry.attribute ? element.getAttribute(entry.attribute) : element.textContent.replace(/\s+/g, ' ').trim();
        }),
    }), LOGIN_ENTRIES.map(({ selector, attribute }) => ({ selector, attribute })));
    const problems = [];
    if (actual.lang !== code) problems.push(`lang ${actual.lang} != ${code}`);
    if (actual.title !== expected(code, KEYS.loginTitle)) problems.push(`title ${actual.title}`);
    LOGIN_ENTRIES.forEach((entry, index) => {
        if (actual.values[index] !== squash(expected(code, entry.key))) problems.push(`${entry.selector}: '${actual.values[index]}' != '${squash(expected(code, entry.key))}'`);
    });
    return problems;
}

async function bodyText(page) {
    return squash(await page.locator('body').innerText());
}

async function pageLang(page) {
    return page.evaluate(() => document.documentElement.lang);
}

/** Submits a form without the security token from a page of the same server and waits for the answer. */
async function postWithoutToken(page, url) {
    await Promise.all([
        page.waitForURL(/c5-probe/),
        page.evaluate(() => {
            const form = document.createElement('form');
            form.method = 'post';
            form.action = '/c5-probe';
            document.body.append(form);
            form.submit();
        }),
    ]);
    expect(page.url()).toBe(url + '/c5-probe');
}

async function signInAccount(page, password) {
    await page.locator('#userList .userSelect', { hasText: 'default-user' }).click();
    await page.locator('#userPassword').fill(password);
    await page.locator('#loginButton').click();
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 90000 });
}

async function signInWorkspace(page, username, password) {
    await page.locator('#workspaceUsername').fill(username);
    await page.locator('#workspacePassword').fill(password);
    await page.locator('#workspaceLoginButton').click();
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 90000 });
}

async function accountContext(browser, app, options) {
    const context = await browser.newContext({ serviceWorkers: 'block', ...options });
    const csrf = await (await context.request.get(app.url + '/csrf-token')).json();
    const login = await context.request.post(app.url + '/api/users/login', { headers: { 'X-CSRF-Token': csrf.token }, data: { handle: 'default-user', password: app.password } });
    expect(login.ok()).toBe(true);
    return context;
}

async function shoot(page, name, language, viewport) {
    mkdirSync(screenshotRoot, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(screenshotRoot, `${name}-${language.name}-${viewport.name}.png`), fullPage: true });
}

/** Opens a page in a fresh context with the given language and returns what was requested. */
async function visit(browser, url, { locale = 'en-US', javaScriptEnabled = true, headers, viewport } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block', locale, javaScriptEnabled, extraHTTPHeaders: headers, ...(viewport ?? {}) });
    const page = await context.newPage();
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const response = await page.goto(url);
    // A short wait so that any further request the page would make (icon, script, asset) is logged before the caller counts.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);
    return { context, page, response, requests };
}

// ---- S1: accounts mode ----------------------------------------------------------------------------------------------

test.describe('S1 accounts mode', () => {
    test.describe.configure({ mode: 'serial' });
    let app;
    test.beforeAll(async () => {
        test.setTimeout(300000);
        app = await startApp({ enableUserAccounts: true });
        app.password = randomBytes(12).toString('base64url');
        await prepareAccounts(app.url, app.password);
    });
    test.afterAll(async () => { await app?.stop(); });

    test('S1 sign in, choose Italiano, the 404 and session-expired pages follow it, sign out gives the Italian sign-in page', async ({ browser }) => {
        expect(expected('it-it', 'Meowlcome back')).not.toBe('Meowlcome back');
        const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US', viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        await page.goto(app.url + '/login');
        await expect.poll(() => loginMismatches(page, 'en'), { timeout: 20000 }).toEqual([]);
        await signInAccount(page, app.password);
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        await page.locator('#ui_language_select').selectOption('it-it');
        await expect(page.locator('html')).toHaveAttribute('lang', 'it-it', { timeout: 90000 });
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 90000 });

        // Signed in, in a second tab: the 404 page and the session-expired page follow the stored choice.
        const side = await context.newPage();
        const notFound = await side.goto(app.url + '/no-such-page');
        expect(notFound.status()).toBe(404);
        await expect.poll(() => pageLang(side)).toBe('it-it');
        await expect(side.locator('h1')).toHaveText(expected('it-it', KEYS.notFoundTitle));
        await expect(side.locator('p')).toHaveText(expected('it-it', KEYS.notFoundText));
        expect(await side.title()).toBe(expected('it-it', KEYS.notFoundTitle));
        await postWithoutToken(side, app.url);
        await expect.poll(() => pageLang(side)).toBe('it-it');
        await expect(side.locator('h1')).toHaveText(expected('it-it', KEYS.sessionTitle));
        await expect(side.locator('p.lead')).toHaveText(expected('it-it', KEYS.sessionLead));
        const steps = await side.locator('ol li span').allInnerTexts();
        expect(steps.map(squash)).toEqual(KEYS.sessionSteps.map(step => squash(expected('it-it', step.key, step.holes))));
        expect(await side.locator('code').allInnerTexts()).toEqual(['Invalid CSRF token', 'sudo systemctl restart neconyan', 'https://neconyan.purabunny.cc']);
        await side.close();

        // Sign out: the sign-in page is Italian.
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        await page.locator('.sb-settings-tab-btn[data-tab="cache-account"]').click();
        await page.locator('#logout_button').click();
        await expect(page).toHaveURL(/\/login/);
        await expect.poll(() => loginMismatches(page, 'it-it'), { timeout: 20000 }).toEqual([]);
        // A wrong password shows its message in the stored language (or English where it has no translation yet).
        await page.locator('#userList .userSelect', { hasText: 'default-user' }).click();
        await page.locator('#userPassword').fill('not-the-password');
        await page.locator('#loginButton').click();
        await expect(page.locator('#errorMessage')).toHaveText(expected('it-it', KEYS.wrongPasswordAccount), { timeout: 20000 });
        await context.close();
    });

    test('S1 a fresh browser: de-DE shows German, fr-CH shows English, an account named Cancel stays Cancel', async ({ browser }) => {
        expect(expected('de-de', 'Meowlcome back')).not.toBe('Meowlcome back');
        const german = await browser.newContext({ serviceWorkers: 'block', locale: 'de-DE' });
        const germanPage = await german.newPage();
        await germanPage.goto(app.url + '/login');
        await expect(germanPage.locator('#userList .userSelect')).toHaveCount(2, { timeout: 20000 });
        await expect.poll(() => loginMismatches(germanPage, 'de-de'), { timeout: 20000 }).toEqual([]);
        expect(await germanPage.locator('#userList .userName').allInnerTexts()).toContain('Cancel');
        expect(expected('de-de', 'Cancel')).not.toBe('Cancel');
        await expect(germanPage.locator('#cancelRecovery')).toHaveText(expected('de-de', 'Cancel'));
        await german.close();

        const swiss = await browser.newContext({ serviceWorkers: 'block', locale: 'fr-CH' });
        const swissPage = await swiss.newPage();
        const dictionaryRequests = [];
        swissPage.on('request', request => { if (new URL(request.url()).pathname.startsWith('/locales/')) dictionaryRequests.push(new URL(request.url()).pathname); });
        await swissPage.goto(app.url + '/login');
        await expect(swissPage.locator('#userList .userSelect')).toHaveCount(2, { timeout: 20000 });
        await expect.poll(() => loginMismatches(swissPage, 'en'), { timeout: 20000 }).toEqual([]);
        expect(dictionaryRequests.every(route => route === '/locales/lang.json')).toBe(true);
        await swiss.close();
    });

    test('display: 404 and session-expired pages in five languages at two sizes', async ({ browser }) => {
        for (const language of LANGUAGES) {
            for (const viewport of VIEWPORTS) {
                const context = await accountContext(browser, app, { locale: language.locale, ...viewport.options });
                const page = await context.newPage();
                await page.goto(app.url + '/no-such-page');
                await expect(page.locator('h1')).toHaveText(expected(language.code, KEYS.notFoundTitle));
                await shoot(page, 'not-found', language, viewport);
                await postWithoutToken(page, app.url);
                await expect(page.locator('h1')).toHaveText(expected(language.code, KEYS.sessionTitle));
                await expect.poll(() => pageLang(page)).toBe(language.code);
                await shoot(page, 'session-expired', language, viewport);
                await context.close();
            }
        }
    });
});

// ---- S2: basic-auth mode --------------------------------------------------------------------------------------------

test.describe('S2 basic-auth mode', () => {
    test.describe.configure({ mode: 'serial' });
    let app;
    test.beforeAll(async () => {
        test.setTimeout(300000);
        const auth = basicAuthPatch();
        app = await startApp(auth.patch);
        app.username = auth.username;
        app.password = auth.password;
    });
    test.afterAll(async () => { await app?.stop(); });

    test('S2 de-DE: German captions, no 401, exactly three dictionary requests, a wrong password in German', async ({ browser }) => {
        expect(expected('de-de', KEYS.wrongPasswordWorkspace)).not.toBe(KEYS.wrongPasswordWorkspace);
        const context = await browser.newContext({ serviceWorkers: 'block', locale: 'de-DE' });
        const page = await context.newPage();
        const answers = [];
        page.on('response', response => answers.push({ path: new URL(response.url()).pathname, status: response.status() }));
        await page.goto(app.url + '/login');
        await expect(page.locator('#workspaceLoginBlock')).toBeVisible();
        await expect.poll(() => loginMismatches(page, 'de-de'), { timeout: 20000 }).toEqual([]);
        const bad = answers.filter(answer => ![200, 304].includes(answer.status));
        expect(bad).toEqual([]);
        expect(answers.filter(answer => answer.path.startsWith('/locales/')).map(answer => answer.path).sort())
            .toEqual(['/locales/de-de.json', '/locales/lang.json', '/locales/neconyan/de-de.json']);
        await page.locator('#workspaceUsername').fill(app.username);
        await page.locator('#workspacePassword').fill('not-the-password');
        await page.locator('#workspaceLoginButton').click();
        await expect(page.locator('#errorMessage')).toHaveText(expected('de-de', KEYS.wrongPasswordWorkspace), { timeout: 20000 });
        await context.close();
    });

    test('S2 a stored pt-pt beats the browser language; after sign-in the 404 and session-expired pages follow it', async ({ browser }) => {
        const context = await browser.newContext({ serviceWorkers: 'block', locale: 'de-DE', viewport: { width: 1280, height: 900 } });
        await context.addInitScript(() => window.localStorage.setItem('language', 'pt-pt'));
        const page = await context.newPage();
        await page.goto(app.url + '/login');
        await expect.poll(() => loginMismatches(page, 'pt-pt'), { timeout: 20000 }).toEqual([]);
        await signInWorkspace(page, app.username, app.password);
        const notFound = await page.goto(app.url + '/no-such-page');
        expect(notFound.status()).toBe(404);
        await expect.poll(() => pageLang(page)).toBe('pt-pt');
        await expect(page.locator('h1')).toHaveText(expected('pt-pt', KEYS.notFoundTitle));
        await postWithoutToken(page, app.url);
        await expect.poll(() => pageLang(page)).toBe('pt-pt');
        await expect(page.locator('h1')).toHaveText(expected('pt-pt', KEYS.sessionTitle));
        await context.close();
    });

    test('S2 against the real server: the sign-in finishes before a dictionary held for five seconds arrives', async ({ browser }) => {
        const context = await browser.newContext({ serviceWorkers: 'block', locale: 'de-DE' });
        const page = await context.newPage();
        let released = false;
        await page.route(/\/locales\//, async route => {
            await delay(5000);
            released = true;
            await route.continue().catch(() => {});
        });
        await page.goto(app.url + '/login');
        await expect(page.locator('#workspaceLoginBlock')).toBeVisible();
        await expect(page.locator('#logoBlock h1')).toHaveText('Meowlcome back');
        await page.locator('#workspaceUsername').fill(app.username);
        await page.locator('#workspacePassword').fill(app.password);
        await page.locator('#workspaceLoginButton').click();
        await page.waitForURL(url => !url.pathname.startsWith('/login'), { waitUntil: 'commit', timeout: 20000 });
        expect(released).toBe(false);
        await context.close();
    });

    test('S2 against the real server: with the dictionaries refused the sign-in completes and the page stays English', async ({ browser }) => {
        const context = await browser.newContext({ serviceWorkers: 'block', locale: 'de-DE' });
        const page = await context.newPage();
        await page.route(/\/locales\//, route => route.abort());
        await page.goto(app.url + '/login');
        await expect(page.locator('#workspaceLoginBlock')).toBeVisible();
        // The dictionaries are refused, so there is nothing to wait for: give the page time to (wrongly) change.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(1000);
        expect(await loginMismatches(page, 'en')).toEqual([]);
        await page.locator('#workspaceUsername').fill(app.username);
        await page.locator('#workspacePassword').fill('not-the-password');
        await page.locator('#workspaceLoginButton').click();
        await expect(page.locator('#errorMessage')).toHaveText(KEYS.wrongPasswordWorkspace, { timeout: 20000 });
        // The right password signs in. The app that follows needs the dictionaries, so the check ends when the page leaves /login.
        const answer = page.waitForResponse(response => response.url().endsWith('/api/auth/browser/login') && response.request().method() === 'POST');
        await page.locator('#workspaceUsername').fill(app.username);
        await page.locator('#workspacePassword').fill(app.password);
        await page.locator('#workspaceLoginButton').click();
        expect((await answer).status()).toBe(200);
        await page.waitForURL(url => !url.pathname.startsWith('/login'), { waitUntil: 'commit', timeout: 20000 });
        await context.close();
    });

    test('display: the sign-in page in five languages at two sizes (no sideways scroll, controls at least 44 px high)', async ({ browser }) => {
        for (const language of LANGUAGES) {
            for (const viewport of VIEWPORTS) {
                const context = await browser.newContext({ serviceWorkers: 'block', locale: language.locale, ...viewport.options });
                const page = await context.newPage();
                await page.goto(app.url + '/login');
                await expect(page.locator('#workspaceLoginBlock')).toBeVisible();
                await expect.poll(() => loginMismatches(page, language.code), { timeout: 20000 }).toEqual([]);
                await page.evaluate(() => document.fonts.ready);
                const geometry = await page.evaluate(() => ({
                    overflow: document.documentElement.scrollWidth > window.innerWidth,
                    width: window.innerWidth,
                    controls: [...document.querySelectorAll('#workspaceLoginForm input:not([type=checkbox]), #workspaceLoginButton, #passkeyLoginButton, .remember-option')]
                        .filter(element => element.getClientRects().length > 0)
                        .map(element => ({ id: element.id || element.className, height: element.getBoundingClientRect().height, right: element.getBoundingClientRect().right })),
                }));
                expect(geometry.overflow, `${language.name} ${viewport.name} overflows sideways`).toBe(false);
                expect(geometry.controls.length).toBeGreaterThan(0);
                for (const control of geometry.controls) {
                    expect(control.height, `${language.name} ${viewport.name} ${control.id}`).toBeGreaterThanOrEqual(44);
                    expect(control.right, `${language.name} ${viewport.name} ${control.id}`).toBeLessThanOrEqual(geometry.width);
                }
                await shoot(page, 'login', language, viewport);
                await context.close();
            }
        }
    });
});

// ---- S3: the blocked pages ------------------------------------------------------------------------------------------

/** One blocked page loaded with JavaScript on and off, in the given languages: status, language, title, text, one request. */
async function expectBlockedPage(browser, url, { status = 403, titleKey, texts, headers }) {
    for (const [locale, code] of [['de-DE', 'de-de'], ['fr-CH', 'en']]) {
        for (const javaScriptEnabled of [true, false]) {
            const { context, page, response, requests } = await visit(browser, url, { locale, javaScriptEnabled, headers });
            const label = `${url} ${locale} JavaScript ${javaScriptEnabled ? 'on' : 'off'}`;
            expect(response.status(), label).toBe(status);
            expect(await pageLang(page), label).toBe(code);
            expect(await page.title(), label).toBe(expected(code, titleKey));
            const text = await bodyText(page);
            for (const sentence of texts(code)) expect(text, label).toContain(squash(sentence));
            expect(requests, `${label}: the page load makes exactly one request, the document`).toHaveLength(1);
            await context.close();
        }
    }
}

async function displayBlockedPage(browser, name, url, { titleKey, headers }) {
    for (const language of LANGUAGES) {
        for (const viewport of VIEWPORTS) {
            const { context, page } = await visit(browser, url, { locale: language.locale, headers, viewport: viewport.options });
            expect(await page.title()).toBe(expected(language.code, titleKey));
            await shoot(page, name, language, viewport);
            await context.close();
        }
    }
}

test.describe('S3 whitelist page', () => {
    test.describe.configure({ mode: 'serial' });
    let app;
    test.beforeAll(async () => {
        test.setTimeout(300000);
        app = await startApp({ whitelistMode: true, whitelist: ['::1'], enableForwardedWhitelist: true });
    });
    test.afterAll(async () => { await app?.stop(); });

    test('S3 a direct connection that is not on the list gets the whitelist page', async ({ browser }) => {
        expect(expected('de-de', KEYS.forbidden)).not.toBe(KEYS.forbidden);
        await expectBlockedPage(browser, app.url + '/', {
            titleKey: KEYS.forbidden,
            texts: code => [expected(code, KEYS.forbidden), expected(code, KEYS.whitelist, ['config.yaml']), expected(code, KEYS.connection, ['127.0.0.1'])],
        });
    });

    test('S3 behind a proxy (X-Forwarded-For) the page names the forwarded address', async ({ browser }) => {
        await expectBlockedPage(browser, app.url + '/', {
            titleKey: KEYS.forbidden,
            headers: { 'X-Forwarded-For': '203.0.113.7' },
            texts: code => [expected(code, KEYS.forwarded, ['127.0.0.1', '203.0.113.7'])],
        });
    });

    test('display: the whitelist page in five languages at two sizes', async ({ browser }) => {
        await displayBlockedPage(browser, 'whitelist', app.url + '/', { titleKey: KEYS.forbidden });
    });
});

test.describe('S3 whitelist page in basic-auth mode', () => {
    let app;
    test.beforeAll(async () => {
        test.setTimeout(300000);
        app = await startApp(basicAuthPatch({ whitelistMode: true, whitelist: ['::1'] }).patch);
    });
    test.afterAll(async () => { await app?.stop(); });

    test('S3 the /login redirect of basic-auth mode ends on the whitelist page', async ({ browser }) => {
        const { context, page, response, requests } = await visit(browser, app.url + '/', { locale: 'de-DE' });
        expect(page.url()).toBe(app.url + '/login');
        expect(response.status()).toBe(403);
        expect(await pageLang(page)).toBe('de-de');
        expect(await page.title()).toBe(expected('de-de', KEYS.forbidden));
        expect(await bodyText(page)).toContain(squash(expected('de-de', KEYS.connection, ['127.0.0.1'])));
        expect(requests.filter(request => !request.endsWith('/login') && !request.endsWith('/'))).toEqual([]);
        await context.close();
    });
});

test.describe('S3 host page', () => {
    test.describe.configure({ mode: 'serial' });
    let app;
    test.beforeAll(async () => {
        test.setTimeout(300000);
        app = await startApp({ hostWhitelist: { enabled: true, scan: false, hosts: ['allowed.test'] } });
    });
    test.afterAll(async () => { await app?.stop(); });

    test('S3 an address that is not on the host list gets the host page (blocked.test mapped to 127.0.0.1)', async ({ browser, request }) => {
        // The same server answers the loopback address normally, so a wrong set-up cannot pass vacuously.
        expect((await request.get(app.url + '/csrf-token')).ok()).toBe(true);
        await expectBlockedPage(browser, `http://blocked.test:${app.port}/`, {
            titleKey: KEYS.forbidden,
            texts: code => [expected(code, KEYS.forbidden), expected(code, KEYS.host, ['config.yaml']), expected(code, KEYS.hostBlocked)],
        });
    });

    test('display: the host page in five languages at two sizes', async ({ browser }) => {
        await displayBlockedPage(browser, 'host', `http://blocked.test:${app.port}/`, { titleKey: KEYS.forbidden });
    });
});

test.describe('S3 HTTPS-required page', () => {
    test.describe.configure({ mode: 'serial' });
    let app;
    test.beforeAll(async () => {
        test.setTimeout(300000);
        app = await startApp({ requireHttps: true });
        app.pageUrl = `http://neconyan.localhost:${app.port}`;
    });
    test.afterAll(async () => { await app?.stop(); });

    test('S3 a page load gets the HTML page, in the browser language, with no further request', async ({ browser }) => {
        await expectBlockedPage(browser, app.pageUrl + '/', {
            titleKey: KEYS.httpsTitle,
            texts: code => [expected(code, KEYS.httpsTitle), expected(code, KEYS.https)],
        });
    });

    test('S3 an address under /api/ keeps the English JSON, as a page load and as a script request', async ({ browser }) => {
        const { context, page, response } = await visit(browser, app.pageUrl + '/api/ping', { locale: 'de-DE' });
        expect(response.status()).toBe(403);
        expect(response.headers()['content-type']).toContain('application/json');
        expect(await response.json()).toEqual({ error: KEYS.https });
        const posted = await page.evaluate(async () => {
            const answer = await fetch('/api/ping', { method: 'POST' });
            return { status: answer.status, contentType: answer.headers.get('content-type'), body: await answer.json() };
        });
        expect(posted.status).toBe(403);
        expect(posted.contentType).toContain('application/json');
        expect(posted.body).toEqual({ error: KEYS.https });
        await context.close();
    });

    test('display: the HTTPS page in five languages at two sizes', async ({ browser }) => {
        await displayBlockedPage(browser, 'https-required', app.pageUrl + '/', { titleKey: KEYS.httpsTitle });
    });
});

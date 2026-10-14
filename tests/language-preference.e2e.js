/* global window, document, localStorage, chrome, getComputedStyle */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(360000);
const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = path.join(root, 'screenshots', 'language-choice');
const marker = 'NeconyanLanguagePolicy.v1';

async function profile(channel, languages, phone = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'language-choice-test-'));
    fs.mkdirSync(path.join(directory, 'Default'));
    fs.writeFileSync(path.join(directory, 'Default', 'Preferences'), JSON.stringify({ intl: {
        accept_languages: languages.join(','), selected_languages: languages.join(','),
    } }));
    const context = await chromium.launchPersistentContext(directory, { channel, headless: true, locale: undefined,
        serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
        hasTouch: phone, isMobile: phone });
    return { context, page: context.pages()[0], async close() {
        await context.close();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } };
}

async function api(context, url) {
    const token = (await (await context.request.get(url + '/csrf-token')).json()).token;
    return async (route, data = {}) => {
        const response = await context.request.post(url + route, { headers: { 'X-CSRF-Token': token }, data });
        expect(response.ok(), route + ': ' + await response.text()).toBe(true);
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    };
}

async function openApp(page, url) {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext) && !document.getElementById('preloader'), null, { timeout: 120000 });
    // APP_READY runs after the loader has gone; the marker prevents assertions racing the prompt's dynamic import.
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), null, { timeout: 120000 });
}

const language = page => page.evaluate(() => window.SillyTavern.getContext().getCurrentLocale());

async function moveLanguageToTop(context, code, channel) {
    const settings = await context.newPage();
    await settings.goto(channel === 'msedge' ? 'edge://settings/languages' : 'chrome://settings/languages');
    await settings.waitForFunction(() => Boolean(chrome.languageSettingsPrivate));
    await settings.evaluate(value => {
        chrome.languageSettingsPrivate.enableLanguage(value);
        chrome.languageSettingsPrivate.moveLanguage(value, 'TOP');
    }, code);
    await settings.close();
}

for (const channel of ['chromium', 'msedge']) {
    test(`${channel}: migration, existing automatic translations and saved choices`, async ({ app }) => {
        for (const entry of [
            { name: 'new', newInstallation: true, expected: 'de-de' },
            { name: 'existing', prompt: true, expected: 'en' },
            { name: 'skipped-onboarding', firstRun: true, prompt: true, expected: 'en' },
            { name: 'existing-automatic', languages: ['de-DE', 'de', 'en-US', 'en'], expected: 'de-de' },
            { name: 'saved-English', stored: 'en', expected: 'en' },
            { name: 'saved-Italian', stored: 'it-it', expected: 'it-it' },
            { name: 'saved-browser', stored: 'browser', expected: 'de-de' },
            { name: 'dictionary-failed', stored: 'it-it', expected: 'en', failDictionary: true },
        ]) {
            const session = await profile(channel, entry.languages || ['de', 'en-US', 'en']);
            const { context, page } = session;
            try {
                const post = await api(context, app.url);
                await post('/api/users/login', { handle: 'default-user', password: '' });
                const settings = JSON.parse((await post('/api/settings/get')).settings);
                settings.firstRun = Boolean(entry.firstRun);
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                if (entry.newInstallation) settings.accountStorage[marker] = 'browser';
                else delete settings.accountStorage[marker];
                await post('/api/settings/save', settings);
                if (entry.stored) await context.addInitScript(value => {
                    // Seed once: reloads must read what the actual settings controls subsequently wrote.
                    if (!localStorage.getItem('language') && !localStorage.getItem('NeconyanLanguageChoice.v1')) localStorage.setItem('language', value);
                }, entry.stored);
                if (entry.failDictionary) await page.route('**/locales/**/it-it.json', route => route.abort());
                if (entry.failDictionary) await page.route('**/locales/it-it.json', route => route.abort());
                await openApp(page, app.url);
                await expect.poll(() => language(page), { message: entry.name }).toBe(entry.expected);
                if (entry.prompt) {
                    await expect(page.locator('#language-choice-prompt')).toBeVisible();
                    await expect(page.locator('#language-choice-select')).toHaveValue('de-de');
                    await expect(page.locator('#language-choice-select option')).toHaveCount(18);
                    await expect(page.locator('.popup-button-ok').filter({ hasText: 'Use Deutsch' })).toBeVisible();
                    if (entry.name === 'existing') {
                        await page.keyboard.press('Escape');
                        await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
                        await page.reload();
                        await openApp(page, app.url);
                        await expect.poll(() => language(page)).toBe('en');
                        await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
                        await moveLanguageToTop(context, 'it', channel);
                        await openApp(page, app.url);
                        await expect.poll(() => language(page)).toBe('en');
                        await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
                        // A later settings choice explicitly opts back into browser following.
                        await page.evaluate(() => document.querySelector('[data-neconyan-route="settings"]')?.click());
                        await page.locator('#ui_language_select').selectOption('');
                        await page.waitForEvent('load');
                        await expect.poll(() => language(page), { timeout: 120000 }).toBe('it-it');
                    } else {
                        await page.locator('#language-choice-select').selectOption('pt-pt');
                        await page.locator('.popup-button-ok').click();
                        await page.waitForEvent('load');
                        await expect.poll(() => language(page), { timeout: 120000 }).toBe('pt-pt');
                    }
                } else {
                    await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
                }
                if (entry.name === 'new' || entry.name === 'saved-browser') {
                    await moveLanguageToTop(context, 'it', channel);
                    await openApp(page, app.url);
                    await expect.poll(() => language(page)).toBe('it-it');
                    await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
                }
            } finally { await session.close(); }
        }
    });

    for (const phone of [false, true]) {
        test(`${channel}: sign-in selector preserves input, focus and preference (${phone ? 'phone' : 'desktop'})`, async ({ app }) => {
            const session = await profile(channel, ['de', 'en-US', 'en'], phone);
            const { context, page } = session;
            try {
                const post = await api(context, app.url);
                await post('/api/users/login', { handle: 'default-user', password: '' });
                await post('/api/users/change-password', { handle: 'default-user', oldPassword: '', newPassword: 'language-fixture' });
                await post('/api/users/create', { handle: 'second', name: 'Second account', password: '', admin: false });
                await context.clearCookies();
                await page.goto(app.url + '/login');
                await expect(page.locator('#loginLanguage option')).toHaveCount(18);
                await expect(page.locator('html')).toHaveAttribute('lang', 'de-de');
                await page.locator('.userSelect').filter({ hasText: 'default-user' }).click();
                await page.locator('#userPassword').fill('language-fixture');
                await page.locator('#userPassword').focus();
                for (const code of ['it-it', 'pt-pt', 'en', 'de-de']) {
                    await page.locator('#loginLanguage').selectOption(code);
                    await expect(page.locator('html')).toHaveAttribute('lang', code);
                    await expect(page.locator('#userPassword')).toHaveValue('language-fixture');
                    await expect(page.locator('#userPassword')).toBeFocused();
                }
                // Failed dictionary loading restores English, and does not disturb credentials or sign-in.
                await page.route('**/locales/**/it-it.json', route => route.abort());
                await page.route('**/locales/it-it.json', route => route.abort());
                await page.locator('#loginLanguage').selectOption('it-it');
                await expect(page.locator('html')).toHaveAttribute('lang', 'en');
                await expect(page.locator('h1')).toHaveText('Meowlcome back');
                await expect(page.locator('#userPassword')).toHaveValue('language-fixture');
                await page.locator('#loginLanguage').selectOption('pt-pt');
                await expect(page.locator('html')).toHaveAttribute('lang', 'pt-pt');
                fs.mkdirSync(screenshots, { recursive: true });
                await page.screenshot({ path: path.join(screenshots, `signin-${channel}-${phone ? 'phone' : 'desktop'}-after.png`) });
                const geometry = await page.locator('#loginLanguage').evaluate(select => ({ height: select.getBoundingClientRect().height,
                    overflow: document.documentElement.scrollWidth > window.innerWidth }));
                expect(geometry.height).toBeGreaterThanOrEqual(44);
                expect(geometry.overflow).toBe(false);
                await page.locator('#loginButton').click();
                await page.waitForURL(app.url + '/');
                await expect.poll(() => language(page), { timeout: 120000 }).toBe('pt-pt');
                await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
            } finally { await session.close(); }
        });
    }
}

test('sign-in remains usable when storage is blocked and a dictionary response is late', async ({ app }) => {
    const session = await profile('chromium', ['de', 'en-US', 'en']);
    const { page, context } = session;
    try {
        await context.addInitScript(() => {
            window.Storage.prototype.getItem = () => { throw new Error('storage blocked'); };
            window.Storage.prototype.setItem = () => { throw new Error('storage blocked'); };
        });
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let listRequests = 0;
        await page.route('**/locales/lang.json', async route => { listRequests++; await held; await route.continue(); });
        await page.route('**/locales/**de-de.json', async route => { await held; await route.continue(); });
        await page.goto(app.url + '/login?noauto=1');
        await expect.poll(() => listRequests).toBeGreaterThan(0);
        await page.locator('#loginLanguage').selectOption('en');
        release();
        await expect(page.locator('#loginLanguage option')).toHaveCount(18);
        await expect(page.locator('#loginLanguage')).toHaveValue('en');
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
        await expect(page.locator('h1')).toHaveText('Meowlcome back');
        await page.locator('#loginLanguage').selectOption('pt-pt');
        await expect(page.locator('html')).toHaveAttribute('lang', 'pt-pt');
        await expect(page.locator('#loginLanguage')).toBeEnabled();
    } finally { await session.close(); }
});


test('language-choice controls fit and retain label contrast with default, pale and dark accents', async ({ app }) => {
    const session = await profile('chromium', ['de', 'en-US', 'en'], true);
    const { page, context } = session;
    try {
        const post = await api(context, app.url);
        await post('/api/users/login', { handle: 'default-user', password: '' });
        const settings = JSON.parse((await post('/api/settings/get')).settings);
        delete settings.accountStorage[marker];
        settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
        await post('/api/settings/save', settings);
        await openApp(page, app.url);
        await expect(page.locator('#language-choice-prompt')).toBeVisible();
        for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
            await page.setViewportSize(viewport);
            for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
                await page.evaluate(name => window.$('#themes').val(name).trigger('change'), theme);
                for (const accent of ['default', 'Mint Glass', 'Plum Wine']) {
                    if (accent !== 'default') await page.evaluate(async name => {
                        const { power_user } = await import('/scripts/power-user.js');
                        const index = power_user.sb_accent_profiles.findIndex(profile => profile.name === name);
                        document.querySelector(`.sb-accent-profile-apply[data-accent-profile-index="${index}"]`).click();
                    }, accent);
                    await expect.poll(() => page.locator('dialog.popup .popup-button-ok').evaluate(button => {
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                        const ctx = canvas.getContext('2d');
                        const light = color => {
                            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
                            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                                value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
                            }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
                        };
                        const style = getComputedStyle(button), a = light(style.color), b = light(style.backgroundColor);
                        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
                    }), { message: `${theme}, ${accent}, ${viewport.width}` }).toBeGreaterThanOrEqual(4.5);
                }
            }
            const geometry = await page.locator('#language-choice-select').evaluate(select => ({
                height: select.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > window.innerWidth,
                surface: getComputedStyle(select.closest('dialog')).backgroundColor,
            }));
            expect(geometry.height).toBeGreaterThanOrEqual(44);
            expect(geometry.overflow).toBe(false);
            expect(geometry.surface).not.toContain(' / 0.9');
        }
    } finally { await session.close(); }
});


test('a failed language index leaves the app usable without recording a false legacy language', async ({ app }) => {
    const session = await profile('chromium', ['de-DE', 'de', 'en-US', 'en']);
    const { page, context } = session;
    try {
        const post = await api(context, app.url);
        await post('/api/users/login', { handle: 'default-user', password: '' });
        const settings = JSON.parse((await post('/api/settings/get')).settings);
        delete settings.accountStorage[marker];
        settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
        await post('/api/settings/save', settings);
        await page.route('**/locales/lang.json', route => route.fulfill({ json: { error: 'unavailable' } }));
        await openApp(page, app.url);
        await expect.poll(() => language(page)).toBe('en');
        expect(await page.evaluate(() => localStorage.getItem('NeconyanLanguageChoice.v1'))).toBeNull();
        await page.unroute('**/locales/lang.json');
        await openApp(page, app.url);
        await expect.poll(() => language(page)).toBe('de-de');
        await expect(page.locator('#language-choice-prompt')).toHaveCount(0);
    } finally { await session.close(); }
});

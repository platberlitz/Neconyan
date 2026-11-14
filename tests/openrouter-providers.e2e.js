/* global $, document, window, setOpenRouterProviders, syncOpenRouterProvidersForModel */
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = await fs.readFile(path.join(root, 'public/scripts/textgen-models.js'), 'utf8');
const tierCode = (await fs.readFile(path.join(root, 'public/scripts/service-tiers.js'), 'utf8')).replaceAll('export ', '');
const providerCode = models.slice(models.indexOf('const OPENROUTER_PROVIDER_WARNING_SELECTORS'), models.indexOf('let nanoGptProvidersRequest')).replaceAll('export ', '');
// The real picker setup for the provider lists, so the test follows any change to it.
const pickerCode = models.slice(models.indexOf('    for (const select of providersSelect) {'), models.indexOf('    for (const select of nanoGptProvidersSelect) {'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css' };

const page_html = ['text', 'chat'].map(mode => `<div><select multiple class="openrouter_providers" id="openrouter_providers_${mode}"></select>
    <select id="openrouter_service_tier_${mode}"><option value="">Default</option><option value="flex">Flex</option><option value="priority">Priority</option></select></div>`).join('');

async function mount(page) {
    await page.route('http://providers.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><link rel="stylesheet" href="/css/neconyan-menus.css"><body class="neconyan">${page_html}<script src="/lib/jquery-3.5.1.min.js"></script></body>` });
        }
        if (pathname === '/scripts/i18n.js') {
            return route.fulfill({ contentType: 'text/javascript', body: 'export const t = (strings, ...values) => String.raw({ raw: strings }, ...values);' });
        }
        const file = path.resolve(root, 'public', `.${pathname}`);
        if (!file.startsWith(path.join(root, 'public') + path.sep)) return route.abort();
        await route.fulfill({ contentType: TYPES[path.extname(file)] ?? 'text/plain', body: await fs.readFile(file, 'utf8') });
    });
    await page.goto('http://providers.test/');
    await page.addScriptTag({ content: `
        let openRouterProvidersRequest = null;
        const getRequestHeaders = () => ({});
        const t = (strings, ...values) => String.raw({ raw: strings }, ...values);
        window.pending = [];
        window.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
        ${tierCode}
        ${providerCode}
    ` });
    await page.addScriptTag({ type: 'module', content: `
        import { createSelectPicker } from '/scripts/select-picker.js';
        const providersSelect = $('.openrouter_providers');
        ${pickerCode}
        window.pickersReady = true;
    ` });
    await page.waitForFunction(() => window.pickersReady === true);
}

const selectedProviders = page => page.evaluate(() => Array.from(document.querySelector('#openrouter_providers_chat').selectedOptions, option => option.value));

for (const mobile of [false, true]) {
    test.describe(`${mobile ? 'phone' : 'desktop'} provider picker`, () => {
        test.use(mobile ? { viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } });

        test(`live provider catalogue preserves choices and ignores stale responses (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
            await mount(page);
            const press = locator => mobile ? locator.tap() : locator.click();
            const trigger = page.locator('#sb-openrouter_providers_chat-picker-button');
            const menu = page.locator('#sb-openrouter_providers_chat-picker');
            await expect(page.locator('#openrouter_providers_chat')).toBeHidden();

            await page.evaluate(() => {
                window.changes = 0;
                $('.openrouter_providers').on('change', () => window.changes++);
                for (const mode of ['text', 'chat']) {
                    setOpenRouterProviders(`#openrouter_providers_${mode}`, ['Zeta', 'Missing']);
                }
                window.loading = Promise.all(['text', 'chat'].map(mode => syncOpenRouterProvidersForModel('test/old', `#openrouter_providers_${mode}`)));
            });
            await expect(trigger).toHaveText('Zeta, Missing');
            // The list stays open while the catalogue loads and redraws in place.
            await press(trigger);
            await expect(menu).toBeVisible();
            expect(await page.evaluate(() => window.pending.length)).toBe(1);
            // A saved preset or user change during loading must win over the earlier selection.
            await page.evaluate(() => {
                setOpenRouterProviders('#openrouter_providers_chat', ['Missing', 'Zeta']);
                window.pending.shift().resolve({ ok: true, json: async () => ['Alpha', 'Zeta', '<img src=x>'] });
            });
            await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(2);
            await page.evaluate(async () => {
                for (const request of window.pending.splice(0)) request.resolve({ ok: true, json: async () => ({ providers: ['Alpha', 'Zeta'], service_tiers: ['flex', 'priority'] }) });
                await window.loading;
            });
            for (const mode of ['text', 'chat']) {
                await expect(page.locator(`#openrouter_providers_${mode} option`)).toHaveCount(4);
                await expect(page.locator(`#openrouter_service_tier_${mode}`)).toBeEnabled();
                await page.locator(`#openrouter_service_tier_${mode}`).selectOption('flex');
            }
            expect(await selectedProviders(page)).toEqual(['Missing', 'Zeta']);
            await expect(page.locator('img')).toHaveCount(0);
            expect(await page.evaluate(() => window.changes)).toBe(0);
            await expect(menu).toBeVisible();
            // Rows are sorted by name; a provider the model lacks is only listed while it is still chosen.
            await expect(menu.locator('.sb-chat-picker-row-title')).toHaveText(['Alpha', 'Missing', 'Zeta']);
            await expect(menu.getByRole('button', { name: 'Missing', exact: true })).toHaveAttribute('aria-pressed', 'true');

            // The newest choice goes last, because OpenRouter tries providers in list order.
            await press(menu.getByRole('button', { name: 'Alpha', exact: true }));
            expect(await selectedProviders(page)).toEqual(['Missing', 'Zeta', 'Alpha']);
            await expect(menu).toBeVisible();
            await press(menu.getByRole('button', { name: 'Missing', exact: true }));
            expect(await selectedProviders(page)).toEqual(['Zeta', 'Alpha']);
            await expect(menu.getByRole('button', { name: 'Missing', exact: true })).toHaveCount(0);
            await expect(trigger).toHaveText('Zeta, Alpha');
            const changes = await page.evaluate(() => window.changes);
            expect(changes).toBeGreaterThan(0);
            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');

            // Failed refreshes retain the last catalogue; newer model availability wins.
            await page.evaluate(() => {
                window.old = syncOpenRouterProvidersForModel('test/old', '#openrouter_providers_chat');
                window.pending.shift().resolve({ ok: false, status: 502 });
            });
            await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(1);
            await page.evaluate(() => {
                window.newer = syncOpenRouterProvidersForModel('test/new', '#openrouter_providers_chat');
                window.pending.pop().resolve({ ok: true, json: async () => [] });
            });
            await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(2);
            await page.evaluate(async () => {
                window.pending.pop().resolve({ ok: true, json: async () => ({ providers: ['Alpha'], service_tiers: ['priority'] }) });
                await window.newer;
                window.pending.pop().resolve({ ok: true, json: async () => ({ providers: ['Zeta'], service_tiers: ['flex'] }) });
                await window.old;
            });
            await expect(page.locator('#openrouter_providers_chat option')).toHaveCount(4);
            expect(await page.locator('#openrouter_providers_chat option:enabled').allTextContents()).toEqual(['Alpha']);
            expect(await page.evaluate(() => window.changes)).toBe(changes);
            await expect(page.locator('#openrouter_service_tier_chat')).toHaveValue('flex');
            await expect(page.locator('#openrouter_service_tier_chat option[value="flex"]')).toBeDisabled();
            await expect(page.locator('#openrouter_service_tier_chat option[value="priority"]')).toBeEnabled();
        });
    });
}

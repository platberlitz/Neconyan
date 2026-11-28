// @ts-check
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop expect different button heights. */
import { test, expect } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { PLUGIN_ID, PROTOCOL_VERSION } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/shared/schema.js';

const pluginBase = `/api/plugins/${PLUGIN_ID}`;
const extensionPath = '/scripts/extensions/third-party/Neconyan-BotSearcher/client/browser.js';

const searchCapabilities = { search: true, query: true, urlImport: true, sorts: ['latest'], filters: [], paging: 'cursor' };
const SOURCES = [
    { id: 'botbooru', label: 'Botbooru', tier: 1, state: 'up', clientHosts: ['botbooru.com'], capabilities: { ...searchCapabilities, accountLogin: true } },
    { id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'], capabilities: searchCapabilities },
    { id: 'wyvern', label: 'Wyvern', tier: 1, state: 'up', clientHosts: ['app.wyvern.chat'], capabilities: searchCapabilities },
];

async function openBrowser(page) {
    const requests = [];
    await page.route(`**${pluginBase}/healthz`, route => route.fulfill({ json: { protocol: PROTOCOL_VERSION, sources: SOURCES } }));
    await page.route(`**${pluginBase}/search`, route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    });
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60_000 });
    await page.evaluate(async (path) => {
        const { openBrowser } = await import(path);
        void openBrowser({ query: 'moon' });
    }, extensionPath);
    await expect(page.locator('#sbbs_query')).toBeVisible();
    await expect(page.locator('.popup:has(#sbbs_query)')).not.toHaveAttribute('opening');
    return requests;
}

const sourceOptions = page => page.locator('#sbbs_source option').evaluateAll(options => options.map(option => option.value));

for (const [name, options] of [
    ['phone', { viewport: { width: 393, height: 852 }, hasTouch: true }],
    ['desktop', { viewport: { width: 1280, height: 900 }, hasTouch: false }],
]) {
    test.describe(`${name}`, () => {
        test.use({ ...options, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
        test.setTimeout(90_000);

        test.beforeEach(async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'NeconyanSimpleMode.v1': 'off',
                };
            });
        });

        test('Sources and logins switches sources inside the search window', async ({ page }) => {
            const requests = await openBrowser(page);
            const root = page.locator('.sbbs-root');
            const gear = page.getByRole('button', { name: 'Sources and logins', exact: true });
            await expect(gear).toBeVisible();
            const box = await gear.boundingBox();
            // Phones get the taller tap target the source and sort pickers already have.
            expect(box.height).toBeGreaterThanOrEqual(name === 'phone' ? 40 : 36);
            const filters = await page.locator('#sbbs_filters_toggle').boundingBox();
            expect(Math.abs(filters.height - box.height)).toBeLessThanOrEqual(1);
            const overlaps = filters.x < box.x + box.width && box.x < filters.x + filters.width
                && filters.y < box.y + box.height && box.y < filters.y + filters.height;
            expect(overlaps).toBe(false);
            expect(box.x + box.width).toBeLessThanOrEqual(options.viewport.width);
            expect(await gear.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            expect(await sourceOptions(page)).toEqual(['__all__', 'botbooru', 'chub', 'wyvern']);

            await page.locator('#sbbs_source').selectOption('chub');
            await root.evaluate(element => { element.dataset.marker = 'first'; });

            // Opening and leaving without a change keeps the same results.
            await gear.click();
            await expect(root).toHaveAttribute('data-view', 'settings');
            const back = page.locator('#sbbs_settings_view .sbbs-back');
            await expect(back).toBeFocused();
            await expect(page.locator('#sbbs_query')).toBeHidden();
            await page.keyboard.press('Escape');
            await expect(root).toHaveAttribute('data-view', 'grid');
            await expect(root).toHaveAttribute('data-marker', 'first');
            await expect(gear).toBeFocused();

            // Logins sit in the same panel.
            await gear.click();
            const account = page.locator('#sbbs_settings_view details.sbbs-account-details', { hasText: 'BotBooru account' });
            await expect(account).toBeVisible();
            await account.locator('summary').click();
            await expect(account.locator('input[type="password"]')).toBeVisible();

            // Turning a source off rebuilds the picker and keeps the search.
            const wyvern = page.locator('#sbbs_settings_view input[data-source-id="wyvern"]');
            await expect(wyvern).toBeChecked();
            await wyvern.uncheck();
            await back.click();
            await expect(root).toHaveAttribute('data-view', 'grid');
            await expect(root).not.toHaveAttribute('data-marker', 'first');
            await expect(page.locator('#sbbs_query')).toHaveValue('moon');
            await expect(page.locator('#sbbs_source')).toHaveValue('chub');
            expect(await sourceOptions(page)).toEqual(['__all__', 'botbooru', 'chub']);
            await expect(gear).toBeFocused();
            await expect.poll(() => requests.at(-1)?.query).toBe('moon');
            await expect(page.locator('.popup:has(#sbbs_query)')).toBeVisible();
        });

        test('Choose sources recovers from every source being off', async ({ page }) => {
            await openBrowser(page);
            const root = page.locator('.sbbs-root');
            await page.getByRole('button', { name: 'Sources and logins', exact: true }).click();
            for (const source of SOURCES) {
                await page.locator(`#sbbs_settings_view input[data-source-id="${source.id}"]`).uncheck();
            }
            await page.locator('#sbbs_settings_view .sbbs-back').click();
            await expect(page.locator('#sbbs_state')).toContainText('Press Choose sources');
            const chooser = page.getByRole('button', { name: 'Choose sources', exact: true });
            await expect(chooser).toBeVisible();
            await expect(chooser).toBeFocused();

            await chooser.click();
            await expect(root).toHaveAttribute('data-view', 'settings');
            await page.locator('#sbbs_settings_view input[data-source-id="chub"]').check();
            await page.keyboard.press('Escape');
            await expect(root).toHaveAttribute('data-view', 'grid');
            await expect(chooser).toHaveCount(0);
            expect(await sourceOptions(page)).toEqual(['chub']);
            await expect(page.locator('#sbbs_query')).toHaveValue('moon');
        });

        test('All BotSearcher settings opens the full page with sources first', async ({ page }) => {
            await openBrowser(page);
            await page.getByRole('button', { name: 'Sources and logins', exact: true }).click();
            await page.getByRole('button', { name: 'All BotSearcher settings', exact: true }).click();
            await expect(page.locator('.popup:has(#sbbs_query)')).toHaveCount(0);
            const settings = page.locator('#sbbs_settings_content');
            await expect(settings.locator('.sbbs-setting-sources')).toBeVisible();
            await expect(settings.locator('details.sbbs-account-details', { hasText: 'BotBooru account' })).toBeVisible();
            const order = await settings.evaluate(element => {
                const children = [...element.children];
                const sourcesIndex = children.findIndex(child => child.classList.contains('sbbs-setting-sources'));
                const preferencesIndex = children.findIndex(child => child.tagName === 'LABEL' && child.textContent === 'Preferences');
                return { sourcesIndex, preferencesIndex };
            });
            expect(order.sourcesIndex).toBeGreaterThanOrEqual(0);
            expect(order.sourcesIndex).toBeLessThan(order.preferencesIndex);
        });
    });
}

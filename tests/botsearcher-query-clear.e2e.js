// @ts-check
/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Fixed viewport cases include iPhone emulation. */
import { test, expect } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';
import { PLUGIN_ID, PROTOCOL_VERSION } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/shared/schema.js';

const pluginBase = `/api/plugins/${PLUGIN_ID}`;
const extensionPath = '/scripts/extensions/third-party/Neconyan-BotSearcher/client/browser.js';

async function openBrowser(page, { searchable = true, query = '' } = {}) {
    const requests = [];
    await page.route(`**${pluginBase}/healthz`, route => route.fulfill({ json: {
        protocol: PROTOCOL_VERSION,
        sources: [{
            id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'],
            capabilities: { search: searchable, query: true, urlImport: true, sorts: ['latest'], filters: [], paging: 'cursor' },
        }],
    } }));
    await page.route(`**${pluginBase}/search`, route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    });
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async ({ path, query }) => {
        const { openBrowser } = await import(path);
        void openBrowser({ query });
    }, { path: extensionPath, query });
    await expect(page.locator('#sbbs_query')).toBeVisible();
    // Popup arrival scales its contents; measure touch targets after that animation finishes.
    await expect(page.locator('.popup:has(#sbbs_query)')).not.toHaveAttribute('opening');
    return requests;
}

for (const [name, options] of [
    ['phone', { viewport: { width: 393, height: 852 }, hasTouch: true }],
    ['desktop', { viewport: { width: 1280, height: 900 }, hasTouch: true }],
    ['iPhone emulation', IPHONE_SAFARI_CONTEXT],
]) {
    test.describe(`${name}`, () => {
        test.use({ ...options, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test.setTimeout(90_000);

        test.beforeEach(async ({ page, context }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'NeconyanSimpleMode.v1': 'off',
                };
            });
            if (name === 'iPhone emulation') {
                await installIPhoneSafari(context, { standalone: false });
            }
        });

        test('clear has a 44px target, cancels pending typing and restores input focus', async ({ page }) => {
            const requests = await openBrowser(page, { query: 'moon' });
            if (name === 'iPhone emulation') await applyIOSOnlyCss(page);
            const input = page.locator('#sbbs_query');
            const clear = page.getByRole('button', { name: 'Clear search', exact: true });
            await expect.poll(() => requests.some(request => request.query === 'moon')).toBe(true);
            await expect(clear).toBeVisible();
            const box = await clear.boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            const field = await input.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(field.x);
            expect(box.x + box.width).toBeLessThanOrEqual(field.x + field.width + 1);
            expect(await input.evaluate(element => parseFloat(getComputedStyle(element).paddingRight))).toBeGreaterThanOrEqual(44);

            for (const accent of ['', '#fff4f0', '#2f173d']) {
                await page.locator('.sbbs-root').evaluate((element, colour) => {
                    element.style.setProperty('--neco-ginger', colour);
                }, accent);
                await clear.hover();
                const contrast = await clear.evaluate(element => {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const ctx = canvas.getContext('2d');
                    const luminance = colour => {
                        ctx.clearRect(0, 0, 1, 1);
                        ctx.fillStyle = getComputedStyle(document.querySelector('#sbbs_query')).backgroundColor;
                        ctx.fillRect(0, 0, 1, 1);
                        ctx.fillStyle = colour;
                        ctx.fillRect(0, 0, 1, 1);
                        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                            const channel = value / 255;
                            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                        });
                        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                    };
                    const style = getComputedStyle(element);
                    const foreground = luminance(style.color);
                    const background = luminance(style.backgroundColor);
                    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
                });
                expect(contrast, `clear icon contrast with accent ${accent || 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
            await page.locator('.sbbs-root').evaluate(element => element.style.removeProperty('--neco-ginger'));

            await input.fill('pending query');
            // Press near the edge, not on the X glyph itself.
            await page.touchscreen.tap(box.x + 3, box.y + box.height / 2);
            await expect(input).toHaveValue('');
            await expect(input).toBeFocused();
            await expect(clear).toBeHidden();
            await expect.poll(() => requests.some(request => request.query === '')).toBe(true);
            expect(requests.some(request => request.query === 'pending query')).toBe(false);

            await input.fill('keyboard query');
            await input.press('Tab');
            await expect(clear).toBeFocused();
            await expect(clear).toHaveCSS('outline-style', 'solid');
            await clear.press('Enter');
            await expect(input).toHaveValue('');
            await expect(input).toBeFocused();
            await expect(clear).toBeHidden();
        });

        test('clear resets a pasted URL in URL-only mode without opening an import', async ({ page }) => {
            const requests = await openBrowser(page, { searchable: false });
            if (name === 'iPhone emulation') await applyIOSOnlyCss(page);
            const input = page.locator('#sbbs_query');
            const state = page.locator('#sbbs_state');
            const initialMessage = await state.textContent();
            await expect(page.locator('#sbbs_query_clear')).toBeHidden();
            await input.fill('https://chub.ai/characters/example/card');
            await expect(page.locator('#sbbs_go')).toBeEnabled();
            await page.getByRole('button', { name: 'Clear search', exact: true }).tap();
            await expect(input).toHaveValue('');
            await expect(input).toBeFocused();
            await expect(page.locator('#sbbs_query_clear')).toBeHidden();
            await expect(state).toHaveText(initialMessage);
            await expect(page.locator('#sbbs_go')).toHaveAttribute('aria-label', 'Search');
            await expect(page.locator('.sbbs-root')).toHaveAttribute('data-view', 'grid');
            expect(requests).toEqual([]);
        });
    });
}

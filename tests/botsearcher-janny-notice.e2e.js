// @ts-check
/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Fixed viewport cases include iPhone emulation. */
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';
import { PLUGIN_ID, PROTOCOL_VERSION } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/shared/schema.js';

const pluginBase = `/api/plugins/${PLUGIN_ID}`;
const clientBase = '/scripts/extensions/third-party/Neconyan-BotSearcher/client';
const sources = [
    { id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'] },
    { id: 'jannyai', label: 'JannyAI', tier: 1, state: 'up', clientHosts: ['jannyai.com'] },
].map(source => ({ ...source, capabilities: {
    search: true, query: true, urlImport: true, browserImport: source.id === 'jannyai',
    sorts: ['latest'], filters: [], paging: 'cursor',
} }));

async function openBrowser(page, { enabled = true, searchable = true } = {}) {
    const browserRequests = [];
    await page.route(`**${pluginBase}/healthz`, route => route.fulfill({ json: {
        protocol: PROTOCOL_VERSION,
        sources: sources.map(source => ({ ...source, capabilities: { ...source.capabilities, search: searchable } })),
        capabilities: { jannyBrowser: { available: true } },
    } }));
    await page.route(`**${pluginBase}/search`, route => route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }));
    await page.route(`**${pluginBase}/janny/**`, route => {
        browserRequests.push(route.request().url());
        return route.fulfill({ json: { available: true, running: false } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async ({ path, enabled }) => {
        const { updateSettings } = await import(`${path}/settings.js`);
        updateSettings({ defaultSource: 'chub', enabledSources: enabled ? ['chub', 'jannyai'] : ['chub'] });
        const { openBrowser } = await import(`${path}/browser.js`);
        void openBrowser();
    }, { path: clientBase, enabled });
    await expect(page.locator('#sbbs_query')).toBeVisible();
    // Popup arrival scales its contents; measure touch targets after that animation finishes.
    await expect(page.locator('.popup:has(#sbbs_query)')).not.toHaveAttribute('opening');
    return browserRequests;
}

for (const [name, options] of [
    ['phone', { viewport: { width: 393, height: 852 }, hasTouch: true }],
    ['desktop', { viewport: { width: 1280, height: 900 }, hasTouch: true }],
    ['iPhone emulation', IPHONE_SAFARI_CONTEXT],
]) {
    test.describe(`${name}`, () => {
        test.use({ ...options, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test.setTimeout(240_000);

        test.beforeEach(async ({ page, context }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'NeconyanSimpleMode.v1': 'off',
                };
            });
            if (name === 'iPhone emulation') await installIPhoneSafari(context, { standalone: false });
        });

        test('notice is compact and only follows an explicit JannyAI source or enabled URL', async ({ page }) => {
            const browserRequests = await openBrowser(page);
            if (name === 'iPhone emulation') await applyIOSOnlyCss(page);
            const picker = page.locator('#sbbs_source');
            const query = page.locator('#sbbs_query');
            const notice = page.locator('.sbbs-janny-notice');
            await expect(notice).toBeHidden();
            await picker.selectOption('jannyai');
            await expect(notice).toBeVisible();
            await expect(notice).not.toHaveAttribute('open');
            const summary = notice.locator('summary');
            const box = await notice.boundingBox();
            const target = await summary.boundingBox();
            const padding = await notice.evaluate(element => {
                const style = getComputedStyle(element);
                return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            });
            console.log(`${name}: notice ${box.height}px; summary ${target.height}px; outer padding ${padding}px`);
            if (process.env.NECONYAN_JANNY_SCREENSHOTS) {
                await mkdir('../screenshots', { recursive: true });
                await page.screenshot({ path: `../screenshots/janny-notice-${name}-${process.env.NECONYAN_JANNY_SCREENSHOTS}.png` });
            }
            expect(padding).toBe(0);
            expect(target.height).toBeGreaterThanOrEqual(44);
            expect(box.height - target.height).toBeLessThanOrEqual(2);
            for (const accent of ['', '#fff4f0', '#2f173d']) {
                await page.locator('.sbbs-root').evaluate((element, colour) => {
                    element.style.setProperty('--neco-ginger', colour);
                }, accent);
                const contrast = await summary.evaluate(element => {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const ctx = canvas.getContext('2d');
                    const ancestors = [];
                    for (let parent = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
                    const luminance = foreground => {
                        ctx.fillStyle = '#000';
                        ctx.fillRect(0, 0, 1, 1);
                        for (const parent of ancestors) {
                            ctx.fillStyle = getComputedStyle(parent).backgroundColor;
                            ctx.fillRect(0, 0, 1, 1);
                        }
                        if (foreground) {
                            ctx.fillStyle = getComputedStyle(element).color;
                            ctx.fillRect(0, 0, 1, 1);
                        }
                        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                            const channel = value / 255;
                            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                        });
                        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                    };
                    const background = luminance(false);
                    const foreground = luminance(true);
                    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
                });
                expect(contrast, `notice contrast with accent ${accent || 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
            await page.locator('.sbbs-root').evaluate(element => element.style.removeProperty('--neco-ginger'));
            await expect(notice.locator('.sbbs-setting-account')).toHaveCount(0);
            const requestsBeforeExpansion = browserRequests.length;
            await summary.focus();
            await expect(summary).toHaveCSS('outline-style', 'solid');
            await summary.press('Enter');
            await expect(notice).toHaveAttribute('open');
            await expect(notice.locator('.sbbs-setting-account')).toBeVisible();
            await expect.poll(() => browserRequests.length).toBeGreaterThan(requestsBeforeExpansion);

            await picker.selectOption('chub');
            await expect(notice).toBeHidden();
            await picker.selectOption('__all__');
            await expect(notice).toBeHidden();
            await query.fill('ordinary search');
            await expect(notice).toBeHidden();
            await query.fill('https://jannyai.com/characters/example');
            await expect(notice).toBeVisible();
            await expect(notice).not.toHaveAttribute('open');
            await query.fill('https://chub.ai/characters/example/card');
            await expect(notice).toBeHidden();
            await picker.selectOption('jannyai');
            await expect(notice).toBeHidden();
            await query.fill('https://example.com/card');
            await expect(notice).toBeHidden();
            await page.getByRole('button', { name: 'Clear search', exact: true }).click();
            await expect(notice).toBeVisible();
            await expect(notice).not.toHaveAttribute('open');
            await summary.press('Enter');
            await expect(notice).toHaveAttribute('open');
            await expect(notice.locator('.sbbs-setting-account')).toHaveCount(1);
            await expect(notice.locator('.sbbs-setting-account')).toBeVisible();
            await picker.selectOption('__all__');
            await expect(notice).toBeHidden();
        });

        test('disabled JannyAI links do not offer the security check', async ({ page }) => {
            await openBrowser(page, { enabled: false });
            const query = page.locator('#sbbs_query');
            await query.fill('https://jannyai.com/characters/example');
            await expect(page.locator('#sbbs_go')).toBeDisabled();
            await expect(page.locator('.sbbs-janny-notice')).toBeHidden();
        });

        test('URL-only mode shows the notice only for enabled JannyAI links', async ({ page }) => {
            await openBrowser(page, { searchable: false });
            const query = page.locator('#sbbs_query');
            const notice = page.locator('.sbbs-janny-notice');
            await expect(notice).toBeHidden();
            await query.fill('https://jannyai.com/characters/example');
            await expect(notice).toBeVisible();
            await query.fill('https://chub.ai/characters/example/card');
            await expect(notice).toBeHidden();
            await query.fill('https://jannyai.com/characters/example');
            await page.getByRole('button', { name: 'Clear search', exact: true }).click();
            await expect(notice).toBeHidden();
        });
    });
}

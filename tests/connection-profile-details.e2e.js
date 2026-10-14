/* global document, window */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshots = path.join(repoRoot, 'screenshots', 'connection-profile-details');
const phase = process.env.NECONYAN_DETAILS_CAPTURE_PHASE || 'after';
const profile = {
    id: 'details-layout-profile', name: 'Details layout profile', mode: 'cc',
    api: 'nanogpt', model: 'moonshotai/kimi-k2.5',
    'reasoning-effort': 'low', verbosity: 'auto',
    'enable-web-search': 'false', 'request-images': 'false',
    'request-image-resolution': '', 'request-image-aspect-ratio': '',
    'custom-reasoning-param-format': 'openai',
    'custom-reasoning-param-name': 'reasoning_effort', exclude: [],
};

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

for (const { size, viewport, hasTouch, widths } of [
    { size: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false, widths: [1280, 997] },
    { size: 'phone', viewport: { width: 393, height: 852 }, hasTouch: true, widths: [393] },
]) {
    test(`Saved connection details stay readable on ${size}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        try {
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const envelope = await response.json();
                if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
                const settings = JSON.parse(envelope.settings);
                settings.firstRun = false;
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'sb-theme': 'windows-aero' };
                settings.extension_settings.connectionManager = {
                    ...settings.extension_settings.connectionManager,
                    profiles: [profile], selectedProfile: profile.id,
                };
                await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            const management = page.locator('.neconyan-connection-management');
            await management.locator('summary').click();
            await page.locator('#view_connection_profile').click();
            const details = page.locator('#connection_profile_details_content');
            await expect(details).toBeVisible();
            await expect(details.locator('.profile-summary-label', { hasText: 'Custom Reasoning Parameter Name' })).toBeVisible();
            mkdirSync(screenshots, { recursive: true });

            for (const width of widths) {
                await page.setViewportSize({ width, height: viewport.height });
                await details.scrollIntoViewIfNeeded();
                await page.evaluate(() => { document.activeElement?.blur(); window.toastr?.remove(); });
                const geometry = await details.evaluate(element => {
                    const bounds = node => {
                        const rect = node.getBoundingClientRect();
                        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
                    };
                    return {
                        details: bounds(element),
                        rows: [...element.querySelectorAll('li')].map(row => {
                            const label = row.querySelector('.profile-summary-label');
                            const value = row.querySelector('.profile-summary-value');
                            const range = document.createRange();
                            range.selectNodeContents(value);
                            return {
                                labelText: label.textContent, valueText: value.textContent,
                                row: bounds(row), label: bounds(label), value: bounds(value),
                                valueLines: range.getClientRects().length,
                            };
                        }),
                    };
                });
                const name = `${size}-${width}-${phase}`;
                writeFileSync(path.join(screenshots, `${name}.json`), JSON.stringify(geometry, null, 2));
                await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
                await details.screenshot({ path: path.join(screenshots, `${name}-details.png`) });
                for (const row of geometry.rows) {
                    expect(row.label.right, row.labelText).toBeLessThanOrEqual(row.row.right + 1);
                    expect(row.value.right, row.labelText).toBeLessThanOrEqual(row.row.right + 1);
                    expect(row.row.right, row.labelText).toBeLessThanOrEqual(geometry.details.right + 1);
                    expect(row.value.width, row.labelText).toBeGreaterThan(80);
                    const overlapWidth = Math.max(0, Math.min(row.label.right, row.value.right) - Math.max(row.label.x, row.value.x));
                    const overlapHeight = Math.max(0, Math.min(row.label.bottom, row.value.bottom) - Math.max(row.label.y, row.value.y));
                    expect(overlapWidth * overlapHeight, row.labelText).toBe(0);
                }
                for (const row of geometry.rows.filter(row => ['false', 'auto', '<Empty>'].includes(row.valueText))) {
                    expect(row.valueLines, row.labelText).toBe(1);
                }
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
            }
            await page.locator('#view_connection_profile').scrollIntoViewIfNeeded();
            await page.locator('#view_connection_profile').click();
            await expect(details).toBeHidden();
        } finally {
            await context.close();
        }
    });
}

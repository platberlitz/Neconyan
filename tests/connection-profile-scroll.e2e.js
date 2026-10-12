/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

for (const { size, viewport, hasTouch } of [
    { size: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
    { size: 'phone', viewport: { width: 393, height: 852 }, hasTouch: true },
]) {
    test(`New connection profile options scroll and save on ${size}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        try {
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const envelope = await response.json();
                if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
                const settings = JSON.parse(envelope.settings);
                settings.firstRun = false;
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
                await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('#main_api').selectOption('openai');

            const popup = page.locator('dialog[open]').filter({ hasText: 'Creating a Connection Profile' });
            const content = popup.locator('.popup-content');
            const lastOption = popup.locator('input[name="exclude"][value="World Info Active Entries"]');
            const scrollToLastOption = async () => {
                await expect(popup).toBeVisible();
                const bounds = await content.boundingBox();
                await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                await page.mouse.wheel(0, 2000);
                await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
                expect(await content.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
                const optionBounds = await lastOption.boundingBox();
                expect(optionBounds.y).toBeGreaterThanOrEqual(bounds.y);
                expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
                for (const selector of ['.popup-input', '.popup-button-ok', '.popup-button-cancel']) {
                    const controlBounds = await popup.locator(selector).boundingBox();
                    expect(controlBounds.y).toBeGreaterThanOrEqual(0);
                    expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(viewport.height);
                }
            };

            await page.locator('#create_connection_profile').click();
            await scrollToLastOption();
            await lastOption.uncheck();
            await popup.locator('.popup-button-cancel').click();
            await expect(popup).toBeHidden();
            expect(await page.evaluate(async () => (await import('/scripts/extensions.js')).extension_settings.connectionManager.profiles.length)).toBe(0);

            await page.locator('#create_connection_profile').click();
            await scrollToLastOption();
            await expect(lastOption).toBeChecked();
            await lastOption.uncheck();
            const name = `Scroll regression ${size}`;
            await popup.locator('.popup-input').fill(name);
            await popup.locator('.popup-button-ok').click();
            await expect(popup).toBeHidden();
            await expect(page.locator('#connection_profiles option:checked')).toHaveText(name);
            const saved = await page.evaluate(async () => {
                const { extension_settings } = await import('/scripts/extensions.js');
                return extension_settings.connectionManager.profiles.find(profile => profile.id === extension_settings.connectionManager.selectedProfile);
            });
            expect(saved.name).toBe(name);
            expect(saved.exclude).toContain('world-info-active-count');
            expect(saved).not.toHaveProperty('world-info-active-count');
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
        }
    });
}

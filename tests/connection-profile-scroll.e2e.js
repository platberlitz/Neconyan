/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

// mode 'cc' renders 31 commands, so the Edit popup is taller than a desktop viewport.
const ccProfile = (id, name) => ({ id, name, mode: 'cc', api: 'openai', model: 'gpt-4o', exclude: [] });

async function seedConnections(page, profiles, selectedProfile) {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const envelope = await response.json();
        if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
        const settings = JSON.parse(envelope.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles, selectedProfile };
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
}

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

    test(`Edit connection profile options scroll on ${size}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const profile = ccProfile(`scroll-edit-${size}`, `Scroll edit ${size}`);
        try {
            await seedConnections(page, [profile], profile.id);
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('.neconyan-connection-management summary').click();
            await page.locator('#edit_connection_profile').click();

            const popup = page.locator('dialog[open]').filter({ hasText: 'Included settings:' });
            await expect(popup).toBeVisible();
            const content = popup.locator('.popup-content');
            const lastOptionRow = content.locator('label.checkbox_label').last();
            const bounds = await content.boundingBox();
            expect(await content.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
            expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
            if (hasTouch) {
                await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
            } else {
                await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                await page.mouse.wheel(0, 2000);
                await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
            }
            const optionBounds = await lastOptionRow.boundingBox();
            expect(optionBounds.y).toBeGreaterThanOrEqual(bounds.y - 1);
            expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);

            const okButtons = popup.locator('.popup-button-ok');
            expect(await okButtons.count()).toBe(2);
            for (const control of [popup.locator('.popup-input'), okButtons.nth(0), okButtons.nth(1), popup.locator('.popup-button-cancel')]) {
                const controlBounds = await control.boundingBox();
                expect(controlBounds.y).toBeGreaterThanOrEqual(0);
                expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(viewport.height);
            }
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
        }
    });

    test(`Delete selected connection profiles scroll on ${size}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const profiles = Array.from({ length: 40 }, (_, index) => ccProfile(`scroll-delete-${index}`, `Scroll delete ${index}`));
        try {
            await seedConnections(page, profiles, '');
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('.neconyan-connection-management summary').click();
            await page.locator('#delete_all_connection_profiles').click();

            const popup = page.locator('dialog[open]').filter({ hasText: 'Select the connection profiles you want to delete.' });
            await expect(popup).toBeVisible();
            const content = popup.locator('.popup-content');
            const lastRow = content.locator('label.checkbox_label').last();
            const bounds = await content.boundingBox();
            expect(await content.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
            expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
            if (hasTouch) {
                await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
            } else {
                await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                await page.mouse.wheel(0, 2000);
                await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
            }
            const rowBounds = await lastRow.boundingBox();
            expect(rowBounds.y).toBeGreaterThanOrEqual(bounds.y - 1);
            expect(rowBounds.y + rowBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);

            for (const control of [popup.locator('.popup-button-ok'), popup.locator('.popup-button-cancel')]) {
                const controlBounds = await control.boundingBox();
                expect(controlBounds.y).toBeGreaterThanOrEqual(0);
                expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(viewport.height);
            }
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
        }
    });
}

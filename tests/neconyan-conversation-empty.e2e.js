/* global window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(180000);

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`Conversation without characters at ${viewport.width}px`, () => {
        const phone = viewport.width < 769;
        test.use({ viewport, isMobile: phone, hasTouch: phone });
        const press = locator => phone ? locator.tap() : locator.click();
        async function chooseMode(page, mode) {
            if (phone) await press(page.locator('#sb-hamburger'));
            await press(page.locator(`#neconyan-workspace-rail [data-neconyan-chat-mode="${mode}"]`));
        }

        test('opens from the workspace rail and can return to Roleplay', async ({ page }, info) => {
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/api/characters/all', route => route.fulfill({ json: [] }));
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch({ maxRetries: 2 });
                const data = await response.json();
                if (typeof data.settings !== 'string') return route.fulfill({ response });
                const settings = JSON.parse(data.settings);
                settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
                settings.firstRun = false;
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                data.settings = JSON.stringify(settings);
                await route.fulfill({ response, json: data });
            });
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
            await expect(page.locator('#preloader')).toHaveCount(0, { timeout: 90000 });
            expect(await page.evaluate(() => window.SillyTavern.getContext().characters.length)).toBe(0);

            await chooseMode(page, 'conversation');

            const stage = page.locator('#sb_conversation_stage');
            await expect(stage).toBeVisible();
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
            await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible|neconyan-rail-drawer-open/);
            await expect(stage.locator('.sb-conversation-thread-empty strong')).toHaveText('Choose a DM to begin');
            await expect(page.locator('#sb_conversation_input')).toBeDisabled();
            await expect(page.locator('#sb_conversation_send')).toBeDisabled();
            const geometry = await stage.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { x: rect.x, right: rect.right, height: rect.height, display: getComputedStyle(element).display };
            });
            expect(geometry.display).not.toBe('none');
            expect(geometry.height).toBeGreaterThan(300);
            expect(geometry.x).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
            await page.screenshot({ path: info.outputPath('empty-conversation.png') });

            await chooseMode(page, 'roleplay');
            await expect(stage).toBeHidden();
            expect(errors).toEqual([]);
        });
    });
}

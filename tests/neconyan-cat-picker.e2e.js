/* global window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`sleeping cat picker at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 393, serviceWorkers: 'block' });

        test('opens under Interface and changes both cat previews', async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.power_user.neconyan_shell_style = 'calico';
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'sb-kittyless': 'false',
                };
            });
            await page.goto('/');
            await expect(page.locator('.neconyan-assistant-row').first()).toBeAttached();
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
            for (const id of ['AppearanceSection', 'sb-interface-drawer']) {
                const header = page.locator(`#${id} > .inline-drawer-header`);
                if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
            }

            const picker = page.locator('#sb-interface-drawer .sb-sleeper-coat-setting');
            const pair = picker.getByLabel('Pair', { exact: true });
            const user = picker.getByLabel('Your cat', { exact: true });
            const character = picker.getByLabel('Character cat', { exact: true });
            await expect(picker).toBeVisible();
            await expect(page.locator('#sb-shell-style-drawer .sb-sleeper-coat-setting')).toHaveCount(0);
            await expect(page.locator('#sb-shell-style-drawer #sb-kittyless-enabled-input')).toBeAttached();
            await pair.selectOption('snow-mittens');
            await expect(user).toHaveValue('birman');
            await expect(character).toHaveValue('snowshoe');
            const previews = picker.locator('.sb-sleeper-coat-preview');
            await expect(previews.nth(0)).toHaveAttribute('src', /sleeping-birman-left\.webp$/);
            await expect(previews.nth(1)).toHaveAttribute('src', /sleeping-snowshoe-left\.webp$/);
            await user.selectOption('calico');
            await expect(pair).toHaveValue('');
            await expect(character).toHaveValue('snowshoe');
        });
    });
}

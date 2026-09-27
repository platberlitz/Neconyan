/* global window */
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });

test('account loading failure is visible and the next attempt opens the profile', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });

    let accountRequests = 0;
    await page.route('**/api/users/me', async route => {
        accountRequests++;
        if (accountRequests === 1) {
            await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
        } else {
            await route.continue();
        }
    });
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
    await page.locator('.sb-settings-category-select').selectOption('cache-account');
    await page.locator('#account_button').click();
    await expect(page.locator('.toast-error')).toContainText('Could not load your account. Please try again.');
    await expect(page.locator('dialog.popup:visible')).toHaveCount(0);

    await page.locator('#account_button').click();
    await expect(page.locator('dialog.popup:visible')).toContainText('Account Info');
    expect(accountRequests).toBe(2);
    expect(pageErrors).toEqual([]);
});

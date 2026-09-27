/* global window */
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });

test('account loading failure is visible and the next attempt opens the profile', async ({ page }) => {
    test.setTimeout(90000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });

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
    await page.locator('.sb-settings-tab-btn[data-tab="cache-account"]').click();
    await page.locator('#account_button').click();
    await expect(page.locator('.toast-error')).toContainText('Could not load your account. Please try again.');
    await expect(page.locator('dialog.popup:visible')).toHaveCount(0);

    await page.locator('#account_button').click();
    await expect(page.locator('dialog.popup:visible')).toContainText('Account Info');
    expect(accountRequests).toBe(2);
    expect(pageErrors).toEqual([]);
});

test('account profile opens while saved-work lists are delayed and reports their failure inline', async ({ page }) => {
    test.setTimeout(120000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let lookups = 0;
    await page.route('**/api/operations/records?*', async route => {
        lookups++;
        await held;
        await route.fulfill({ status: 503, json: { error: 'Saved account work is temporarily unavailable.' } });
    });
    await page.route('**/api/operations/recovery', route => route.fulfill({ json: [] }));
    try {
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
        await page.locator('.sb-settings-tab-btn[data-tab="cache-account"]').click();
        await page.locator('#account_button').click();
        const popup = page.locator('dialog.popup:visible');
        await expect(popup).toContainText('Account Info', { timeout: 1000 });
        await expect.poll(() => lookups).toBe(2);
        release();
        await expect(popup.getByRole('status').filter({ hasText: 'Saved account work is temporarily unavailable.' })).toHaveCount(2);
        await expect(popup.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
        expect(pageErrors).toEqual([]);
    } finally {
        release();
    }
});

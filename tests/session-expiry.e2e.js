/* global window, getComputedStyle */
import { expect, test } from '@playwright/test';

const username = process.env.NECONYAN_AUTH_TEST_USERNAME;
const password = process.env.NECONYAN_AUTH_TEST_PASSWORD;

for (const phone of [true, false]) {
    test.describe(`${phone ? 'phone' : 'desktop'} session expiry`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
        test('keeps the draft and shows one persistent error for fetch and jQuery sign-out', async ({ page, context }, testInfo) => {
            test.skip(!username || !password, 'Requires an isolated basic-auth preview with NECONYAN_AUTH_TEST_USERNAME and NECONYAN_AUTH_TEST_PASSWORD.');
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => window.addEventListener('neconyan:ready', () => { window.sessionExpiryReady = true; }));
            await page.goto('/');
            await page.locator('#workspaceUsername').fill(username);
            await page.locator('#workspacePassword').fill(password);
            await page.locator('#workspaceLoginButton').click();
            await expect(page).not.toHaveURL(/\/login/);
            await page.waitForFunction(() => window.sessionExpiryReady);
            await expect(page.locator('body')).not.toHaveClass(/neconyan-home-booting/);
            await page.locator('#send_textarea').waitFor({ state: 'attached' });
            await page.evaluate(() => window.toastr.clear());
            await page.clock.install();

            await page.route('**/api/test-provider', route => route.fulfill({ status: 401, json: { error: 'Invalid provider key' } }));
            await page.route('**/api/test-permission', route => route.fulfill({ status: 403, body: 'Forbidden' }));
            expect(await page.evaluate(async () => Promise.all([
                fetch('/api/test-provider').then(response => response.status),
                fetch('/api/test-permission').then(response => response.status),
            ]))).toEqual([401, 403]);
            const toast = page.locator('.toast-error', { hasText: 'Session expired' });
            await expect(toast).toHaveCount(0);
            const draft = 'Keep this unsaved message until I sign in again.';
            await page.locator('#send_textarea').evaluate((element, text) => { element.value = text; }, draft);
            await context.clearCookies();
            const result = await page.evaluate(async useFetch => {
                if (useFetch) {
                    const response = await fetch('/version');
                    return { status: response.status, body: await response.text() };
                }
                return new Promise(resolve => window.$.ajax({ url: '/version', complete: xhr => resolve({ status: xhr.status, body: xhr.responseText }) }));
            }, phone);
            expect(result.status).toBe(401);
            expect(result.body).toContain('You are signed out');
            await expect(toast).toBeVisible();
            await expect(toast).toContainText('Copy any unsaved text, then reload this page to sign in again.');
            await page.evaluate(async () => Promise.all([fetch('/version'), fetch('/api/ping', { method: 'POST' })]));
            await page.clock.fastForward(15000);
            await expect(toast).toHaveCount(1);
            await expect(toast).toBeVisible();
            await expect(page.locator('#send_textarea')).toHaveValue(draft);
            await expect(page).not.toHaveURL(/\/login/);
            const geometry = await toast.evaluate(element => {
                const rect = element.getBoundingClientRect();
                const message = element.querySelector('.toast-message');
                return { left: rect.left, right: rect.right, width: window.innerWidth, overflow: message.scrollWidth > message.clientWidth + 1, colour: getComputedStyle(message).color };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            expect(geometry.overflow).toBe(false);
            expect(geometry.colour).not.toBe('rgba(0, 0, 0, 0)');
            await page.screenshot({ path: testInfo.outputPath('session-expired.png') });
            await toast.locator('.toast-close-button').click();
            await expect(toast).toHaveCount(0);
            await page.evaluate(() => fetch('/version'));
            await expect(toast).toHaveCount(0);
            expect(errors).toEqual([]);
        });
    });
}

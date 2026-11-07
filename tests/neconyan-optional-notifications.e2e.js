/* global window, document, localStorage, caches */
/* eslint-disable playwright/no-skipped-test -- This test must use an explicitly disposable preview. */
import { expect, test, webkit } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari } from './ios-safari-emulation.js';

const base = process.env.NECONYAN_TEST_BASE_URL;
test.skip(!base, 'Requires this worktree\'s disposable preview.');
test.setTimeout(180000);

test('a blocked optional notifications module does not block startup, toasts or logout', async () => {
    const browser = await webkit.launch();
    const context = await browser.newContext({
        ...IPHONE_SAFARI_CONTEXT,
        serviceWorkers: 'block',
    });
    await installIPhoneSafari(context, { standalone: false });
    await context.addInitScript(() => {
        window.__notificationsFixtureReady = false;
        window.addEventListener('neconyan:ready', () => { window.__notificationsFixtureReady = true; });
    });
    let moduleRequests = 0;
    let logoutRequests = 0;
    let logoutSnapshot = null;
    await context.route('**/scripts/push-notifications.js', route => {
        moduleRequests++;
        return route.abort('failed');
    });
    const page = await context.newPage();
    await context.route('**/api/users/logout', async route => {
        logoutSnapshot = await page.evaluate(async () => {
            const local = JSON.parse(localStorage.getItem('neconyan-system-notifications'));
            const cache = await caches.open('neconyan-notification-preferences');
            const response = await cache.match('/__neconyan_notification_preferences');
            return { local, cached: response ? await response.json() : null };
        });
        logoutRequests++;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__notificationsFixtureReady, null, { timeout: 120000 });
        await expect(page.locator('#neconyan-startup-failure')).toHaveCount(0);
        await expect.poll(() => moduleRequests, { timeout: 10000 }).toBe(1);
        await expect(page.locator('#push_notifications')).toBeDisabled();
        await expect(page.locator('#push_notifications')).not.toBeChecked();
        await expect(page.locator('#push_notifications_status')).toContainText('blocked or did not load');
        const requestsBeforeToasts = moduleRequests;

        await page.evaluate(() => {
            window.toastr.info('Optional notifications fixture', '', { timeOut: 0, extendedTimeOut: 0 });
            window.toastr.info('Optional notifications fixture two', '', { timeOut: 0, extendedTimeOut: 0 });
        });
        await expect(page.locator('#toast-container').first()).toContainText('Optional notifications fixture');
        // eslint-disable-next-line playwright/no-wait-for-timeout -- Allow any mistaken toast-triggered import to start.
        await page.waitForTimeout(300);
        expect(moduleRequests).toBe(requestsBeforeToasts);
        expect(errors.filter(message => /push-notifications|notifications/i.test(message))).toEqual([]);

        const seeded = {
            owner: 'fixture-owner',
            device: '00000000-0000-4000-8000-000000000000',
            enabled: true,
        };
        await page.evaluate(async state => {
            localStorage.setItem('neconyan-system-notifications', JSON.stringify(state));
            const cache = await caches.open('neconyan-notification-preferences');
            await cache.put('/__neconyan_notification_preferences', new Response(JSON.stringify(state)));
        }, seeded);

        await page.evaluate(() => { document.getElementById('logout_button').click(); });
        await expect.poll(() => logoutRequests, { timeout: 10000 }).toBe(1);
        expect(logoutSnapshot).toMatchObject({
            local: { ...seeded, enabled: false },
            cached: { ...seeded, enabled: false },
        });
    } finally {
        await context.close();
        await browser.close();
    }
});

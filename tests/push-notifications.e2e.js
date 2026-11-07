/* global window, navigator, localStorage, caches */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

// Exercise the shipped controller in a real browser, with permission and transport
// fakes so the suite neither prompts a person nor sends external notifications.
async function setup(page, { permission = 'granted', native = false, unsupported = false, holdPermission = false } = {}) {
    await page.route('https://notifications.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/push-notifications.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(new URL('../public/scripts/push-notifications.js', import.meta.url), 'utf8') });
        if (url.pathname === '/i18n.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const t = strings => strings.join(\'\');' });
        if (url.pathname === '/android-native-bridge.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const androidNotificationState = () => null; export const setAndroidNotifications = async () => null;' });
        if (url.pathname.startsWith('/api/')) {
            const body = route.request().postDataJSON();
            await page.evaluate(record => window.requests.push(record), { route: url.pathname, body, owner: route.request().headers()['x-neconyan-account'] });
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ publicKey: 'BAECAw', native: true }) });
        }
        return route.fulfill({ contentType: 'text/html', body: '<label>Push notifications<input id="push_notifications" type="checkbox"></label><p id="push_notifications_status"></p>' });
    });
    await page.goto('https://notifications.test/');
    await page.evaluate(({ permission, native, unsupported, holdPermission }) => {
        window.requests = [];
        window.permissionRequests = 0;
        window.nativeEnabled = false;
        window.subscription = null;
        const subscription = { options: { applicationServerKey: new Uint8Array([4, 1, 2, 3]).buffer }, toJSON: () => ({ endpoint: 'https://web.push.apple.com/test', keys: {} }), unsubscribe: async () => { window.subscription = null; return true; } };
        Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'default', requestPermission: async () => {
            window.permissionRequests++;
            if (holdPermission) await new Promise(resolve => { window.releasePermission = resolve; });
            window.Notification.permission = permission;
            return permission;
        } } });
        Object.defineProperty(window, 'PushManager', { configurable: true, value: function () {} });
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => ({ active: true, getNotifications: async () => [], pushManager: {
            getSubscription: async () => window.subscription,
            subscribe: async () => { window.subscription = subscription; return subscription; },
        } }) } });
        if (native) window.webkit = { messageHandlers: { neconyanNotifications: { postMessage: async message => {
            if (message.action === 'set') { window.permissionRequests += Number(message.enabled); window.nativeEnabled = message.enabled && permission === 'granted'; }
            return { enabled: window.nativeEnabled };
        } } } };
        if (unsupported) delete window.PushManager;
    }, { permission, native, unsupported, holdPermission });
    await page.evaluate(async () => {
        window.notifications = await import('/push-notifications.js');
        await window.notifications.initPushNotifications({ owner: 'alice', headers: () => ({ 'Content-Type': 'application/json' }) });
    });
}

test('web opt-in is explicit, mirrors toasts once, persists, then disables locally and remotely', async ({ page }) => {
    await setup(page);
    const toggle = page.locator('#push_notifications');
    await expect(toggle).not.toBeChecked();
    expect(await page.evaluate(() => [window.permissionRequests, window.requests.length])).toEqual([0, 0]);
    await toggle.check();
    await expect(page.locator('#push_notifications_status')).toContainText('On for this device');
    expect(await page.evaluate(() => window.permissionRequests)).toBe(1);
    await page.evaluate(() => {
        window.notifications.mirrorToastNotification({ state: 'visible', map: { title: '<b>Saved</b>', message: '<i>Hello</i>' } });
        window.notifications.mirrorToastNotification({ state: 'visible', map: { message: 'Already pushed DM', optionsOverride: { neconyanSystemNotification: false } } });
    });
    await expect.poll(() => page.evaluate(() => window.requests.filter(item => item.route.endsWith('/toast')).length)).toBe(1);
    const state = await page.evaluate(async () => ({ local: JSON.parse(localStorage.getItem('neconyan-system-notifications')), worker: await (await (await caches.open('neconyan-notification-preferences')).match('/__neconyan_notification_preferences')).json() }));
    expect(state.local).toEqual(state.worker);
    expect(state.local).toMatchObject({ enabled: true, owner: 'alice' });
    await toggle.uncheck();
    await expect(toggle).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('neconyan-system-notifications')).enabled)).toBe(false);
    expect(await page.evaluate(() => window.subscription)).toBeNull();
    expect(await page.evaluate(() => window.requests.at(-1))).toMatchObject({ owner: 'alice', body: { enabled: false } });
});

test('denied permission keeps the checkbox off and never registers a subscription', async ({ page }) => {
    await setup(page, { permission: 'denied' });
    await page.locator('#push_notifications').check();
    await expect(page.locator('#push_notifications_status')).toContainText('Allow notifications');
    await expect(page.locator('#push_notifications')).not.toBeChecked();
    expect(await page.evaluate(() => window.requests.some(item => item.body.enabled))).toBe(false);
});

test('iOS native bridge opts in and out without browser push APIs', async ({ page }) => {
    await setup(page, { native: true, unsupported: true });
    await page.locator('#push_notifications').check();
    await expect(page.locator('#push_notifications_status')).toContainText('On for this device');
    expect(await page.evaluate(() => window.requests.at(-1).body.native)).toBe(true);
    await page.locator('#push_notifications').uncheck();
    await expect(page.locator('#push_notifications')).toBeEnabled();
    expect(await page.evaluate(() => window.nativeEnabled)).toBe(false);
});

test('unsupported browsers explain Home Screen support without asking permission', async ({ page }) => {
    await setup(page, { unsupported: true });
    await expect(page.locator('#push_notifications')).toBeDisabled();
    await expect(page.locator('#push_notifications_status')).toContainText('Home Screen');
    expect(await page.evaluate(() => window.permissionRequests)).toBe(0);
});

test('a cache write failure cannot prevent native opt-out', async ({ page }) => {
    await setup(page, { native: true, unsupported: true });
    await page.locator('#push_notifications').check();
    await expect(page.locator('#push_notifications_status')).toContainText('On for this device');
    await page.evaluate(() => { caches.open = async () => { throw new Error('Storage unavailable'); }; });
    await page.locator('#push_notifications').uncheck();
    await expect(page.locator('#push_notifications')).toBeEnabled();
    expect(await page.evaluate(() => window.nativeEnabled)).toBe(false);
    expect(await page.evaluate(() => window.requests.at(-1).body.enabled)).toBe(false);
});

test('logging out while permission is pending cannot re-enable notifications', async ({ page }) => {
    await setup(page, { holdPermission: true });
    await page.locator('#push_notifications').check();
    await page.evaluate(async () => { await window.notifications.disablePushNotifications(); window.releasePermission(); });
    await expect(page.locator('#push_notifications')).toBeEnabled();
    await expect(page.locator('#push_notifications')).not.toBeChecked();
    expect(await page.evaluate(() => window.requests.some(item => item.body.enabled))).toBe(false);
});

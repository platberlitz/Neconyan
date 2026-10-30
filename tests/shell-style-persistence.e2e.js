/* global document, localStorage, window */
import { expect, test } from '@playwright/test';

const styles = ['calico', 'kittyless', 'windows-aero', 'windows-xp', 'windows-98', 'clean-minimal', 'macos-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat'];
test.describe.configure({ mode: 'serial' });
test.setTimeout(360000);

async function prepare(page) {
    // Keep onboarding out of the way while retaining the server's actual settings.
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response, json: data });
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function ready(page) {
    await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
}

async function openStylePicker(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    for (const selector of ['#AppearanceSection > .inline-drawer-header', '#sb-shell-style-drawer > .inline-drawer-header']) {
        const header = page.locator(selector);
        if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
    }
}

async function readSavedStyle(page) {
    return page.evaluate(async () => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        if (!response.ok) throw new Error(`Settings read returned ${response.status}`);
        const envelope = await response.json();
        return JSON.parse(envelope.settings).power_user.neconyan_shell_style;
    });
}

async function expectStyle(page, style) {
    await expect(page.locator('html')).toHaveAttribute('data-sb-theme', style);
    if (style === 'calico') {
        await expect(page.locator('link[data-sb-shell-style]')).toHaveCount(0);
    } else {
        await page.waitForFunction(id => Boolean(document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet), style);
    }
    await openStylePicker(page);
    await expect(page.locator(`[data-sb-theme-option="${style}"]`)).toHaveAttribute('aria-pressed', 'true');
}

for (const { name, viewport, hasTouch } of [
    { name: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
    { name: 'phone', viewport: { width: 393, height: 852 }, hasTouch: true },
]) {
    test(`${name}: picker saves every style and reload restores it without the browser mirror`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        await prepare(page);
        await page.goto('/');
        await ready(page);
        for (const style of styles) {
            await openStylePicker(page);
            const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
                && response.request().postDataJSON()?.power_user?.neconyan_shell_style === style);
            await page.locator(`[data-sb-theme-option="${style}"]`).click();
            expect((await saved).ok()).toBe(true);
            await expect.poll(() => readSavedStyle(page)).toBe(style);
            await page.evaluate(() => localStorage.removeItem('sb-theme'));
            await page.reload();
            await ready(page);
            await expectStyle(page, style);
        }

        // A new browser context has no local mirror at all and uses the same account.
        const fresh = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const freshPage = await fresh.newPage();
        await prepare(freshPage);
        await freshPage.goto('/');
        await ready(freshPage);
        await expectStyle(freshPage, 'slate-flat');
        await fresh.close();
        await context.close();
    });
}

test('a selection made while account settings are loading wins and is saved', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    let releaseSettings;
    let settingsArrived;
    const gate = new Promise(resolve => { releaseSettings = resolve; });
    const arrived = new Promise(resolve => { settingsArrived = resolve; });
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response, json: data });
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settingsArrived();
        await gate;
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    try {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await arrived;
        await page.waitForFunction(() => typeof window.NeconyanShell?.applyTheme === 'function');
        const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
            && response.request().postDataJSON()?.power_user?.neconyan_shell_style === 'windows-aero');
        await page.evaluate(() => window.NeconyanShell.applyTheme('windows-aero'));
        releaseSettings();
        expect((await saved).ok()).toBe(true);
        await ready(page);
        await expectStyle(page, 'windows-aero');
        await expect.poll(() => readSavedStyle(page)).toBe('windows-aero');
    } finally {
        releaseSettings();
        await context.close();
    }
});

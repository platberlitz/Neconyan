/* global document, window */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);
// eslint-disable-next-line playwright/no-skipped-test -- These tests change the saved Mewmory configuration.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable Neconyan server.');

const NEW_CHATS = 'Turn on Mewmory in every new chat';
const AUTO_HIDE = 'Hide old messages automatically';

async function load(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
}

async function openSettings(page) {
    await load(page);
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
    const workspace = page.locator('#mewmory-workspace');
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    return workspace;
}

async function readConfig(page) {
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const response = await page.request.post('/api/mewmory/config/get', { headers, data: {} });
    expect(response.ok()).toBe(true);
    return { headers, config: (await response.json()).config };
}

async function resetSwitches(page) {
    const { headers, config } = await readConfig(page);
    const response = await page.request.post('/api/mewmory/config/save', {
        headers, data: { config: { ...config, enableNewChats: false, autoHide: false, autoHideTokens: 30000 } },
    });
    expect(response.ok(), await response.text()).toBe(true);
}

async function switchesSaveAndSurviveReload({ page }) {
    await load(page);
    await resetSwitches(page);
    let workspace = await openSettings(page);
    const status = workspace.locator('#mewmory-settings-status');
    await workspace.getByLabel('Hide messages beyond, tokens', { exact: true }).fill('45000');
    await expect(status).toContainText('Unsaved changes');

    for (const label of [NEW_CHATS, AUTO_HIDE]) {
        const saved = page.waitForResponse(response => response.url().endsWith('/api/mewmory/config/save'));
        await workspace.getByLabel(label, { exact: true }).check();
        expect((await saved).ok()).toBe(true);
    }
    await expect(workspace.getByLabel('Hide messages beyond, tokens', { exact: true })).toHaveValue('45000');
    await expect(status).toContainText('Unsaved changes');
    const { config } = await readConfig(page);
    expect(config).toMatchObject({ enableNewChats: true, autoHide: true, autoHideTokens: 30000 });

    workspace = await openSettings(page);
    await expect(workspace.getByLabel(NEW_CHATS, { exact: true })).toBeChecked();
    await expect(workspace.getByLabel(AUTO_HIDE, { exact: true })).toBeChecked();
    await expect(workspace.getByLabel('Hide messages beyond, tokens', { exact: true })).toHaveValue('30000');
    await expect(workspace.locator('#mewmory-settings-status')).toHaveText('Configuration saved.');
    await resetSwitches(page);
}

async function oldServerIsReported({ page }) {
    await load(page);
    await resetSwitches(page);
    await page.route('**/api/mewmory/config/save', async route => {
        const response = await route.fetch();
        const body = await response.json();
        delete body.config.enableNewChats;
        delete body.config.autoHide;
        await route.fulfill({ response, json: body });
    });
    const workspace = await openSettings(page);
    await workspace.getByLabel(AUTO_HIDE, { exact: true }).click();
    await expect(workspace.locator('#mewmory-settings-status')).toContainText('Restart Neconyan');
    await expect(workspace.locator('.mewmory-heading .mewmory-status')).toContainText('Restart Neconyan');
    await expect(workspace.getByLabel(AUTO_HIDE, { exact: true })).not.toBeChecked();
    await page.unroute('**/api/mewmory/config/save');
    await resetSwitches(page);
}

const SWITCHES_TITLE = 'automatic memory switches save as soon as they change and survive a reload';
const OLD_SERVER_TITLE = 'a server still running older code is reported instead of silently dropping a switch';

test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 900 } });
    test(SWITCHES_TITLE, switchesSaveAndSurviveReload);
    test(OLD_SERVER_TITLE, oldServerIsReported);
});

test.describe('touch phone', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
    test(SWITCHES_TITLE, switchesSaveAndSurviveReload);
    test(OLD_SERVER_TITLE, oldServerIsReported);
});

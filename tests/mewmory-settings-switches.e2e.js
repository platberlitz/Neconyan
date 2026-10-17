/* global document, window */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);
// eslint-disable-next-line playwright/no-skipped-test -- These tests change the saved Mewmory configuration.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable Neconyan server.');

const AUTO_HIDE = 'Hide old messages automatically';
const HIDE_THRESHOLD = 'Hide older messages when the visible chat reaches, tokens';

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

async function saveConfig(page, config) {
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const response = await page.request.post('/api/mewmory/config/save', { headers, data: { config } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).config;
}

async function resetSettings(page) {
    const { config } = await readConfig(page);
    const reset = {
        ...config,
        enableNewChats: false,
        autoHide: false,
        autoHideTokens: 30000,
        roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, { ...role, tokenizer: 'auto' }])),
    };
    return saveConfig(page, reset);
}

async function settingsSaveAutomatically({ page }) {
    await load(page);
    await resetSettings(page);
    let workspace = await openSettings(page);
    const status = workspace.locator('#mewmory-settings-status');
    const threshold = workspace.getByLabel(HIDE_THRESHOLD, { exact: true });

    await threshold.fill('45000');
    await expect(status).toHaveText('Configuration saved.', { timeout: 15000 });
    expect((await readConfig(page)).config.autoHideTokens).toBe(45000);

    await threshold.fill('4');
    await expect(status).toContainText('Not saved', { timeout: 15000 });
    await expect(status).toContainText('between 1024');
    expect((await readConfig(page)).config.autoHideTokens).toBe(45000);

    await threshold.fill('');
    await expect(status).toContainText('finish', { timeout: 15000 });
    await expect(threshold).toHaveValue('');
    await threshold.fill('46000');
    await expect(status).toHaveText('Configuration saved.', { timeout: 15000 });

    await workspace.locator('#mewmory-role-extractor').click();
    await workspace.getByLabel('Tokenizer for this role').selectOption('cl100k_base');
    await expect.poll(async () => (await readConfig(page)).config.roles.extractor.tokenizer, { timeout: 15000 }).toBe('cl100k_base');
    await expect(status).toHaveText('Configuration saved.', { timeout: 15000 });
    const saved = (await readConfig(page)).config;
    expect(saved.autoHideTokens).toBe(46000);
    expect(saved.roles.extractor.tokenizer).toBe('cl100k_base');

    workspace = await openSettings(page);
    await expect(workspace.getByLabel(HIDE_THRESHOLD, { exact: true })).toHaveValue('46000');
    await workspace.locator('#mewmory-role-extractor').click();
    await expect(workspace.getByLabel('Tokenizer for this role')).toHaveValue('cl100k_base');
    await resetSettings(page);
}

async function failedSaveKeepsDraftAndRetries({ page }) {
    await load(page);
    await resetSettings(page);
    const workspace = await openSettings(page);
    const status = workspace.locator('#mewmory-settings-status');
    const threshold = workspace.getByLabel(HIDE_THRESHOLD, { exact: true });
    let failOnce = true;
    await page.route('**/api/mewmory/config/save', async route => {
        if (!failOnce) return route.continue();
        failOnce = false;
        await route.fulfill({
            status: 500, contentType: 'application/json',
            body: JSON.stringify({ error: 'The server could not save the configuration.' }),
        });
    });

    await threshold.fill('47000');
    await expect(status).toContainText('Not saved: The server could not save the configuration.', { timeout: 15000 });
    await expect(threshold).toHaveValue('47000');
    expect((await readConfig(page)).config.autoHideTokens).toBe(30000);
    await workspace.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await expect(status).toHaveText('Configuration saved.', { timeout: 15000 });
    expect((await readConfig(page)).config.autoHideTokens).toBe(47000);
    await page.unroute('**/api/mewmory/config/save');
    await resetSettings(page);
}

async function revisionConflictKeepsLocalEdit({ page }) {
    await load(page);
    const baseline = await resetSettings(page);
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const workspace = await openSettings(page);
    const status = workspace.locator('#mewmory-settings-status');
    const threshold = workspace.getByLabel(HIDE_THRESHOLD, { exact: true });
    let first = true;
    await page.route('**/api/mewmory/config/save', async route => {
        if (!first) return route.continue();
        first = false;
        const response = await page.request.post('/api/mewmory/config/save', {
            headers, data: { config: { ...baseline, memoryTokens: baseline.memoryTokens + 1 } },
        });
        expect(response.ok(), await response.text()).toBe(true);
        await route.continue();
    });

    await threshold.fill('48000');
    await expect(status).toHaveText('Configuration saved.', { timeout: 20000 });
    const saved = (await readConfig(page)).config;
    expect(saved.autoHideTokens).toBe(48000);
    expect(saved.memoryTokens).toBe(baseline.memoryTokens + 1);
    await page.unroute('**/api/mewmory/config/save');
    await resetSettings(page);
}

async function rapidEditsSurviveNavigation({ page }) {
    await load(page);
    await resetSettings(page);
    const workspace = await openSettings(page);
    const status = workspace.locator('#mewmory-settings-status');
    const threshold = workspace.getByLabel(HIDE_THRESHOLD, { exact: true });
    let saves = 0;
    await page.route('**/api/mewmory/config/save', async route => {
        saves++;
        await new Promise(resolve => setTimeout(resolve, 350));
        await route.continue();
    });

    await threshold.evaluate(input => {
        for (const value of ['45000', '46000', '47000']) {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(threshold).toHaveValue('47000');
    await expect(status).toHaveText('Configuration saved.', { timeout: 20000 });
    expect(saves).toBe(1);
    expect((await readConfig(page)).config.autoHideTokens).toBe(47000);
    await page.unroute('**/api/mewmory/config/save');
    await resetSettings(page);
}

async function oldServerIsReported({ page }) {
    await load(page);
    await resetSettings(page);
    await page.route('**/api/mewmory/config/save', async route => {
        const response = await route.fetch();
        const body = await response.json();
        delete body.config.enableNewChats;
        delete body.config.autoHide;
        await route.fulfill({ response, json: body });
    });
    const workspace = await openSettings(page);
    const status = workspace.locator('#mewmory-settings-status');
    await workspace.getByLabel(AUTO_HIDE, { exact: true }).check();
    await expect(status).toContainText('Restart Neconyan', { timeout: 15000 });
    await expect(workspace.locator('.mewmory-heading .mewmory-status')).toContainText('Restart Neconyan');
    await expect(workspace.getByLabel(AUTO_HIDE, { exact: true })).toBeChecked();
    await expect(workspace.getByRole('button', { name: 'Retry saving', exact: true })).toBeVisible();
    await page.unroute('**/api/mewmory/config/save');
    await workspace.getByRole('button', { name: 'Retry saving', exact: true }).click();
    // The fixture saved on the real server before stripping the response fields,
    // so the retry can also explain that it merged a newer saved revision.
    await expect(status).toContainText('Configuration saved.', { timeout: 15000 });
    await expect(status).toHaveAttribute('data-error', 'false');
    expect((await readConfig(page)).config.autoHide).toBe(true);
    await resetSettings(page);
}

const AUTOSAVE_TITLE = 'every setting saves automatically, including token limits and model roles';
const RETRY_TITLE = 'a failed save keeps the draft and saves it when retried';
const CONFLICT_TITLE = 'a revision conflict keeps local edits and merges the newer server copy';
const RAPID_TITLE = 'rapid edits and panel navigation keep the newest draft and send one request';
const OLD_SERVER_TITLE = 'a server still running older code is reported instead of silently dropping a switch';

test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 900 } });
    test(AUTOSAVE_TITLE, settingsSaveAutomatically);
    test(RETRY_TITLE, failedSaveKeepsDraftAndRetries);
    test(CONFLICT_TITLE, revisionConflictKeepsLocalEdit);
    test(RAPID_TITLE, rapidEditsSurviveNavigation);
    test(OLD_SERVER_TITLE, oldServerIsReported);
});

test.describe('touch phone', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
    test(AUTOSAVE_TITLE, settingsSaveAutomatically);
    test(OLD_SERVER_TITLE, oldServerIsReported);
});

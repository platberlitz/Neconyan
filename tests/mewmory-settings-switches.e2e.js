/* global document, window */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);
// eslint-disable-next-line playwright/no-skipped-test -- These tests change the saved Mewmory configuration.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable Neconyan server.');

const AUTO_HIDE = 'Hide old messages automatically at a token threshold';
const HIDE_THRESHOLD = 'Hide older messages at this chat size, tokens';

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
        excludeHistory: true,
        historyMode: 'tokens',
        historyCatchUp: 'reply',
        recentMessages: 10,
        historyBatchMessages: 5,
        autoHideTokens: 30000,
        fallbackProfileIds: [],
        sharedProfileId: '',
        sharedModelOverride: '',
        roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, {
            ...role,
            tokenizer: 'auto',
            ...(name === 'embedding' ? {} : { useShared: false }),
            ...(role.profileId?.startsWith('e2e-fallback-') ? { profileId: '', modelOverride: '' } : {}),
        }])),
    };
    return saveConfig(page, reset);
}

async function messageWindowSettingsSave({ page }) {
    await load(page);
    await resetSettings(page);
    const workspace = await openSettings(page);
    const mode = workspace.getByLabel('Choose recent chat by', { exact: true });
    const catchUp = workspace.getByLabel('When memory is behind', { exact: true });
    const status = workspace.locator('#mewmory-settings-status');
    await expect(mode).toHaveValue('tokens');
    await expect(catchUp).toHaveValue('reply');
    await expect(catchUp).toBeEnabled();
    await expect(workspace.getByText('Keep any older messages Mewmory has not recorded yet, so the reply can start. They leave context after memory catches up.')).toBeVisible();
    await catchUp.selectOption('wait');
    await expect(workspace.getByText('Record the older messages before sending the reply. This can run memory updates even when automatic updates are off. Catch-up may continue after the reply starts. You can stop waiting.')).toBeVisible();
    await expect.poll(async () => (await readConfig(page)).config.historyCatchUp, { timeout: 15000 }).toBe('wait');
    await catchUp.selectOption('reply');
    await expect.poll(async () => (await readConfig(page)).config.historyCatchUp, { timeout: 15000 }).toBe('reply');
    await expect(workspace.getByLabel('Recent chat allowance, tokens', { exact: true })).toBeVisible();
    await expect(workspace.getByLabel('Keep at least this many recent messages', { exact: true })).toHaveCount(0);
    await mode.selectOption('messages');
    const recent = workspace.getByLabel('Keep at least this many recent messages', { exact: true });
    const group = workspace.getByLabel('Remove older chat in groups of', { exact: true });
    await expect(recent).toHaveValue('10');
    await expect(group).toHaveValue('5');
    await expect(workspace.locator('#mewmory-history-example')).toContainText('At 15, leave out the oldest 5');
    await expect.poll(async () => (await readConfig(page)).config.historyMode, { timeout: 15000 }).toBe('messages');
    await recent.fill('12');
    await group.fill('4');
    await expect(workspace.locator('#mewmory-history-example')).toContainText('At 16, leave out the oldest 4');
    await expect.poll(async () => {
        const saved = (await readConfig(page)).config;
        return [saved.recentMessages, saved.historyBatchMessages];
    }, { timeout: 15000 }).toEqual([12, 4]);
    await expect(status).toHaveText('Configuration saved.', { timeout: 15000 });
    expect((await readConfig(page)).config).toMatchObject({ historyMode: 'messages', recentMessages: 12, historyBatchMessages: 4 });
    await mode.selectOption('tokens');
    await expect.poll(async () => (await readConfig(page)).config.historyMode, { timeout: 15000 }).toBe('tokens');
    await mode.selectOption('messages');
    await expect(recent).toHaveValue('12');
    await expect(group).toHaveValue('4');
    await resetSettings(page);
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

const TEST_PROFILES = [
    { id: 'e2e-fallback-a', name: 'E2E fallback A', model: 'model-a' },
    { id: 'e2e-fallback-b', name: 'E2E fallback B', model: 'model-b' },
];

async function setTestProfiles(page, present) {
    await page.evaluate(({ profiles, present }) => {
        const context = window.SillyTavern.getContext();
        const manager = context.extensionSettings.connectionManager ??= { profiles: [] };
        const ids = new Set(profiles.map(profile => profile.id));
        manager.profiles = (manager.profiles || []).filter(profile => !ids.has(profile.id));
        if (present) manager.profiles.push(...profiles.map(profile => ({ ...profile, api: 'custom', mode: 'cc', 'api-url': 'http://127.0.0.1:9/v1' })));
        context.saveSettingsDebounced();
    }, { profiles: TEST_PROFILES, present });
    await expect.poll(async () => {
        const listed = new Set(((await readConfig(page)).config.profiles || []).map(profile => profile.id));
        return TEST_PROFILES.every(profile => listed.has(profile.id) === present);
    }, { timeout: 15000 }).toBe(true);
}

async function fallbackConnectionsSaveInOrder({ page }) {
    await load(page);
    await resetSettings(page);
    await setTestProfiles(page, true);
    try {
        const workspace = await openSettings(page);
        const status = workspace.locator('#mewmory-settings-status');
        const fallbacks = workspace.locator('#mewmory-fallbacks');
        const add = fallbacks.getByLabel('Add a fallback connection', { exact: true });
        const names = fallbacks.locator('.mewmory-fallback-name');
        const saved = async () => (await readConfig(page)).config.fallbackProfileIds;

        await fallbacks.scrollIntoViewIfNeeded();
        await expect(fallbacks.locator('.mewmory-fallback-count')).toHaveText('0 of 10');
        await add.selectOption('e2e-fallback-a');
        await expect.poll(saved, { timeout: 15000 }).toEqual(['e2e-fallback-a']);
        await add.selectOption('e2e-fallback-b');
        await expect.poll(saved, { timeout: 15000 }).toEqual(['e2e-fallback-a', 'e2e-fallback-b']);
        await expect(names).toHaveText(['E2E fallback A', 'E2E fallback B']);
        await expect(fallbacks.locator('.mewmory-fallback-count')).toHaveText('2 of 10');

        await fallbacks.getByRole('button', { name: 'Try earlier: E2E fallback B', exact: true }).click();
        await expect.poll(saved, { timeout: 15000 }).toEqual(['e2e-fallback-b', 'e2e-fallback-a']);
        await expect(names).toHaveText(['E2E fallback B', 'E2E fallback A']);
        await expect(fallbacks.getByRole('button', { name: 'Try earlier: E2E fallback B', exact: true })).toBeDisabled();
        await expect(fallbacks.getByRole('button', { name: 'Try later: E2E fallback B', exact: true })).toBeFocused();

        await fallbacks.getByRole('button', { name: 'Remove: E2E fallback B', exact: true }).click();
        await expect.poll(saved, { timeout: 15000 }).toEqual(['e2e-fallback-a']);
        await expect(status).toHaveText('Configuration saved.', { timeout: 15000 });

        const reopened = (await openSettings(page)).locator('#mewmory-fallbacks');
        await expect(reopened.locator('.mewmory-fallback-name')).toHaveText(['E2E fallback A']);
    } finally {
        await resetSettings(page);
        await setTestProfiles(page, false);
    }
}

async function sharedProfileDrivesEveryRole({ page }) {
    await load(page);
    await resetSettings(page);
    await setTestProfiles(page, true);
    const { config: original } = await readConfig(page);
    try {
        // Roles with a connection of their own keep it when the shared profile is chosen, so start from none.
        await saveConfig(page, {
            ...original,
            roles: Object.fromEntries(Object.entries(original.roles).map(([name, role]) => [name,
                name === 'embedding' ? role : { ...role, enabled: false, profileId: '', modelOverride: '', endpoint: '', model: '' }])),
        });
        let workspace = await openSettings(page);
        const saved = async () => (await readConfig(page)).config;
        const followers = async () => Object.entries((await saved()).roles)
            .filter(([name]) => name !== 'embedding').map(([name, role]) => [name, role.useShared, role.model]);

        await workspace.getByLabel('Connection profile for all roles', { exact: true }).selectOption('e2e-fallback-a');
        await expect.poll(async () => (await saved()).sharedProfileId, { timeout: 15000 }).toBe('e2e-fallback-a');
        await expect.poll(followers, { timeout: 15000 }).toEqual([
            ['extractor', true, 'model-a'], ['pawspective', true, 'model-a'], ['selector', true, 'model-a'], ['fallback', true, 'model-a'],
        ]);
        expect((await saved()).roles.embedding.useShared).toBeUndefined();
        const roleProfile = workspace.getByLabel('Connection profile', { exact: true });
        await expect(roleProfile).toHaveValue('mewmory:shared-profile');
        await expect(workspace.locator('.mewmory-role')).toContainText('Follows the profile for all roles: E2E fallback A · model-a');

        await roleProfile.selectOption('e2e-fallback-b');
        await expect.poll(async () => {
            const role = (await saved()).roles.extractor;
            return [role.useShared, role.profileId, role.model];
        }, { timeout: 15000 }).toEqual([false, 'e2e-fallback-b', 'model-b']);
        await expect(workspace.getByText('1 role still uses its own connection.', { exact: true })).toBeVisible();

        await workspace.getByRole('button', { name: 'Use for every role', exact: true }).click();
        await expect.poll(async () => (await saved()).roles.extractor.useShared, { timeout: 15000 }).toBe(true);
        await expect(workspace.getByRole('button', { name: 'Use for every role', exact: true })).toHaveCount(0);

        await workspace.getByLabel('Connection profile for all roles', { exact: true }).selectOption('e2e-fallback-b');
        await expect.poll(followers, { timeout: 15000 }).toEqual([
            ['extractor', true, 'model-b'], ['pawspective', true, 'model-b'], ['selector', true, 'model-b'], ['fallback', true, 'model-b'],
        ]);

        workspace = await openSettings(page);
        await expect(workspace.getByLabel('Connection profile for all roles', { exact: true })).toHaveValue('e2e-fallback-b');
        await expect(workspace.getByLabel('Connection profile', { exact: true })).toHaveValue('mewmory:shared-profile');
    } finally {
        const { config } = await readConfig(page);
        await saveConfig(page, { ...original, revision: config.revision });
        await resetSettings(page);
        await setTestProfiles(page, false);
    }
}

const SHARED_TITLE = 'a connection profile for all roles switches every following role together';
const AUTOSAVE_TITLE = 'every setting saves automatically, including token limits and model roles';
const FALLBACK_TITLE = 'fallback connections are added, reordered and removed, and save in order';
const RETRY_TITLE = 'a failed save keeps the draft and saves it when retried';
const CONFLICT_TITLE = 'a revision conflict keeps local edits and merges the newer server copy';
const RAPID_TITLE = 'rapid edits and panel navigation keep the newest draft and send one request';
const OLD_SERVER_TITLE = 'a server still running older code is reported instead of silently dropping a switch';
const WINDOW_TITLE = 'message mode saves its own recent window without changing token mode';

test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 900 } });
    test(AUTOSAVE_TITLE, settingsSaveAutomatically);
    test(RETRY_TITLE, failedSaveKeepsDraftAndRetries);
    test(CONFLICT_TITLE, revisionConflictKeepsLocalEdit);
    test(RAPID_TITLE, rapidEditsSurviveNavigation);
    test(OLD_SERVER_TITLE, oldServerIsReported);
    test(FALLBACK_TITLE, fallbackConnectionsSaveInOrder);
    test(SHARED_TITLE, sharedProfileDrivesEveryRole);
    test(WINDOW_TITLE, messageWindowSettingsSave);
});

test.describe('touch phone', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
    test(AUTOSAVE_TITLE, settingsSaveAutomatically);
    test(FALLBACK_TITLE, fallbackConnectionsSaveInOrder);
    test(SHARED_TITLE, sharedProfileDrivesEveryRole);
    test(OLD_SERVER_TITLE, oldServerIsReported);
    test(WINDOW_TITLE, messageWindowSettingsSave);
});

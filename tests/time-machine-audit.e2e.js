/* global document, globalThis */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const extension = '/scripts/extensions/third-party/Neconyan-Time-Machine';
const moduleName = 'NeconyanCardTimeMachine';
const screenshots = fileURLToPath(new URL('../screenshots/', import.meta.url));

test('character restore refuses a concurrent edit and succeeds after a fresh read', async ({ app }) => {
    const account = await app.account();
    const page = await account.open({ workspace: false });
    const original = await page.evaluate(async ({ extension, avatar }) => {
        const api = await import(extension + '/src/api.js');
        const state = await api.liveCharacterState(avatar);
        globalThis.timeMachineAuditState = state;
        return state.data;
    }, { extension, avatar: account.avatar });
    const edit = await account.context.request.post(`${app.url}/api/characters/merge-attributes`, {
        headers: account.headers,
        data: { avatar: account.avatar, description: 'New edit from another tab', data: { description: 'New edit from another tab' } },
    });
    expect(edit.status()).toBe(200);
    const conflict = await page.evaluate(async ({ extension, avatar }) => {
        const api = await import(extension + '/src/api.js');
        const state = globalThis.timeMachineAuditState;
        try {
            await api.restoreCharacter(avatar, state.data, state.data, state.tags);
            return null;
        } catch (error) {
            return { status: error.status, partial: !!error.partial };
        }
    }, { extension, avatar: account.avatar });
    expect(conflict).toEqual({ status: 409, partial: false });
    const restored = await page.evaluate(async ({ extension, avatar }) => {
        const api = await import(extension + '/src/api.js');
        const state = globalThis.timeMachineAuditState;
        const live = await api.liveCharacterState(avatar);
        const preserved = live.data.description;
        await api.restoreCharacter(avatar, state.data, live.data, state.tags);
        return { preserved, data: (await api.liveCharacterState(avatar)).data };
    }, { extension, avatar: account.avatar });
    expect(restored.preserved).toBe('New edit from another tab');
    expect(restored.data).toEqual(original);
});

for (const phone of [false, true]) {
    test(`Time Machine capture, settings and deleted preset restore on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        await account.post('/api/presets/save', { apiId: 'openai', name: 'Time Machine audit', preset: {} });
        const page = await account.open({ workspace: false });
        await page.evaluate(async extension => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = extension + '/style.css';
            document.head.append(link);
            const ui = await import(extension + '/src/ui.js');
            // Render the settings before capture, just as the extension does at startup.
            const drawer = document.createElement('div');
            drawer.id = 'time-machine-test-settings';
            drawer.hidden = true;
            ui.renderDrawer(drawer);
            document.body.append(drawer);
            void ui.openTimeMachine();
        }, extension);
        const capture = page.getByRole('button', { name: 'Snapshot everything now', exact: true });
        const status = page.locator('.sbctm-status');
        await capture.click();
        await expect(capture).toBeEnabled({ timeout: 90000 });
        await expect(status).toContainText('Stored');
        await page.getByRole('button', { name: /Time Machine audit \(openai\)/ }).click();
        await expect(page.locator('.sbctm-version')).toHaveCount(1);

        // A changed item must appear immediately in the selected timeline.
        await account.post('/api/presets/save', { apiId: 'openai', name: 'Time Machine audit', preset: { temperature: 0.5 } });
        await fs.writeFile(path.join(app.directory, 'data/default-user/worlds/audit-broken.json'), 'broken JSON');
        await capture.click();
        await expect(capture).toBeEnabled({ timeout: 90000 });
        await expect(status).toHaveText('Stored 1 snapshot; 1 failed.');
        await expect(page.locator('.sbctm-version')).toHaveCount(2);

        // Deleting the item must still allow restoring its original empty object.
        const deletion = await account.context.request.post(`${app.url}/api/presets/delete`, {
            headers: account.headers,
            data: { apiId: 'openai', name: 'Time Machine audit' },
        });
        expect(deletion.status()).toBe(200);
        await page.getByRole('button', { name: 'Compare', exact: true }).last().click();
        await expect(page.getByText('This no longer exists. Restoring will create it again.')).toBeVisible();
        const restore = page.getByRole('button', { name: 'Restore this version', exact: true });
        await expect(restore).toBeEnabled();
        await restore.scrollIntoViewIfNeeded();
        await expect(restore).toBeInViewport({ ratio: 1 });
        await fs.mkdir(screenshots, { recursive: true });
        const screenshot = path.join(screenshots, `time-machine-${phone ? 'phone' : 'desktop'}-after.png`);
        await page.screenshot({ path: screenshot });
        await info.attach('deleted preset comparison', { path: screenshot, contentType: 'image/png' });
        await restore.click();
        await page.getByRole('button', { name: 'Yes', exact: true }).click();
        await expect(status).toContainText('restored.', { timeout: 30000 });
        const preset = path.join(app.directory, 'data/default-user/OpenAI Settings/Time Machine audit.json');
        expect(JSON.parse(await fs.readFile(preset, 'utf8'))).toEqual({});

        // The drawer predates the server's replacement of its settings object.
        await page.evaluate(async extension => {
            await (await import(extension + '/src/ui.js')).closeTimeMachine();
            const context = globalThis.SillyTavern.getContext();
            const drawer = document.getElementById('time-machine-test-settings');
            drawer.hidden = false;
            void new context.Popup(drawer, context.POPUP_TYPE.TEXT).show();
        }, extension);
        const flag = page.getByLabel('Snapshot characters when they are edited', { exact: true });
        await flag.uncheck();
        await expect(flag).toBeEnabled({ timeout: 30000 });
        const versions = page.getByLabel('Versions kept per item', { exact: true });
        await versions.fill('7');
        await versions.press('Tab');
        await expect.poll(async () => {
            const saved = JSON.parse((await account.post('/api/settings/get')).settings);
            return [saved.extension_settings[moduleName].captureCharacters, saved.extension_settings[moduleName].keepPerTarget];
        }, { timeout: 30000 }).toEqual([false, 7]);
    });
}

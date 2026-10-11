/* global window, document */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

async function selectCharacter(page, avatar) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await (await import('/script.js')).selectCharacterById(context.characters.findIndex(character => character.avatar === avatar),
            { switchMenu: false });
    }, avatar);
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Macro Enhanced explains the server boundary`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            settings.power_user.experimental_macro_engine = true;
        } });
        const page = await account.open({ workspace: false });
        await page.waitForFunction(() => document.getElementById('me-settings-drawer'));
        expect(await page.evaluate(() => window.NeconyanShell.openIncludedTool('MacroEnhanced'))).toBe(true);
        const drawer = page.locator('#me-settings-drawer');
        await expect(drawer).toBeVisible();
        await page.evaluate(() => window.toastr?.remove());
        const notice = drawer.locator('[data-me-server-boundary]');
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('browser-only');
        const bounds = await notice.boundingBox();
        expect(bounds.width).toBeGreaterThan(180);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        const name = `macro-host-${phone ? 'phone' : 'desktop'}-after.png`;
        const directory = path.resolve('../screenshots');
        await fs.mkdir(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, name) });
        await info.attach(name, { path: path.join(directory, name), contentType: 'image/png' });
        await notice.getByRole('button', { name: 'Help: Server prompts and saved variables' }).click();
        await expect(page.locator('.me-workbench')).toBeVisible();
        await expect(page.locator('.me-workbench')).toContainText('Global variable reads are supported');
    });
}

test('Roleplay saves supported variables and reports browser-only prompt macros', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings: settings => {
        settings.power_user.experimental_macro_engine = true;
        settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content = '{{incvar::serverPromptCount}}';
        settings.extension_settings.note.default = '';
    } });
    const page = await account.open({ workspace: false });
    await selectCharacter(page, account.avatar);
    await page.locator('#send_textarea').fill('Test saved variables');
    await page.locator('#send_but').click();
    await expect(page.locator('#chat .mes').last()).toContainText('Durable first reply.', { timeout: 60000 });
    expect(app.provider.calls).toHaveLength(1);
    expect(app.provider.calls[0].messages.some(message => message.content === '1')).toBe(true);
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables.serverPromptCount)).toBe(1);
    // Force the preview refresh that can run after a reply or settings change.
    // It must not write a second increment over the server's accepted value.
    await page.evaluate(async () => {
        const { Generate } = await import('/script.js');
        await Generate('normal', {}, true);
    });
    expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables.serverPromptCount)).toBe(1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await selectCharacter(page, account.avatar);
    expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables.serverPromptCount)).toBe(1);
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        oai_settings.prompts.find(prompt => prompt.identifier === 'main').content = '{{getchatvar::n_yseult}}';
    });
    await acknowledgeActiveSettings(page);
    await page.evaluate(() => window.toastr?.remove());
    await page.locator('#send_textarea').fill('Test unsupported macro');
    await page.locator('#send_but').click();
    await expect(page.locator('#toast-container')).toContainText('browser-only', { timeout: 60000 });
    expect(app.provider.calls).toHaveLength(1);
    expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables.serverPromptCount)).toBe(1);
});

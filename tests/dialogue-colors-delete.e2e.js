/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';

async function openDialogueColours(app, phone = false) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, extension }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        core.chat[0].mes = '"Please let me leave," Durable Nova said.';
        await core.saveChatConditional();
        await core.reloadCurrentChat();
        const { settings } = await import(`${extension}/state.js`);
        Object.assign(settings, {
            coloringEngine: 'llm', keepCardCharacter: false, autoPersonaCharacter: false,
            llmAttributionCheck: false, disableToasts: true,
        });
        const { addCharacter } = await import(`${extension}/ui.js`);
        addCharacter('Kept Friend', '#ffbb88', { keep: true });
        window.NeconyanExtensions.focusUnit('Dialogue Colors');
    }, { avatar: account.avatar, extension });
    if (phone) await applyIOSOnlyCss(page);
    return page;
}

async function addUnkeptCharacter(page) {
    await page.evaluate(async extension => {
        const state = await import(`${extension}/state.js`);
        const { addCharacter, updateCharList } = await import(`${extension}/ui.js`);
        addCharacter('Durable Nova', '#88bbff');
        state.characterColors['durable nova'].keep = false;
        state.characterColors['durable nova'].locked = true;
        (await import(`${extension}/storage.js`)).saveData();
        updateCharList();
    }, extension);
}

for (const phone of [true, false]) {
    test(`background saves allow unkept dialogue colour deletion on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const page = await openDialogueColours(app, phone);
        const press = locator => phone ? locator.tap() : locator.click();
        const row = page.locator('#dc-char-list .dc-char[data-key="durable nova"]');
        for (const flow of ['row', 'bulk', 'clear']) {
            await addUnkeptCharacter(page);
            await expect(row).toBeVisible();
            await expect(row.locator('.dc-keep')).toHaveAttribute('aria-pressed', 'false');
            await expect(row.locator('.dc-status-chip-lock')).toHaveText('Locked');
            if (flow === 'row') {
                await press(row.locator('.dc-more'));
                await press(row.locator('.dc-del'));
            } else if (flow === 'bulk') {
                await press(page.locator('#dc-select-visible'));
                await page.locator('#dc-bulk-action-select').selectOption('delete');
                await press(page.locator('#dc-bulk-apply-action'));
            } else {
                await press(page.locator('#dc-clear'));
            }
            const confirm = page.locator('.dc-dialog [data-dialog-value="confirm"]');
            await expect(confirm).toBeVisible();
            const bounds = await confirm.boundingBox();
            expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            await page.evaluate(async extension => {
                const { characterColors } = await import(`${extension}/state.js`);
                characterColors['durable nova'].dialogueCount += 1;
                (await import(`${extension}/storage.js`)).saveData();
            }, extension);
            await press(confirm);
            await expect(page.locator('.dc-dialog')).toHaveCount(0);
            await page.evaluate(async extension => (await import(`${extension}/dom-engine.js`)).decorateAllMessages(), extension);
            await expect(row).toHaveCount(0);
            await expect(page.locator('#dc-char-list .dc-char[data-key="kept friend"]')).toHaveCount(1);
            await expect(page.locator('#user-settings-block')).toBeVisible();
            if (flow === 'row') {
                await page.screenshot({ path: `../screenshots/dialogue-delete-${phone ? 'phone' : 'desktop'}-after.png` });
                await page.evaluate(async extension => (await import(`${extension}/history.js`)).undo(), extension);
                await expect(row).toHaveCount(1);
                await page.evaluate(async extension => (await import(`${extension}/history.js`)).redo(), extension);
                await expect(row).toHaveCount(0);
            }
        }
        // Save to the disposable account and reload the browser, not just the list.
        expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
        const avatar = await page.evaluate(async () => {
            const core = await import('/script.js');
            return core.characters[core.this_chid].avatar;
        });
        await page.addInitScript(() => window.addEventListener('neconyan:ready', () => { window.dialogueDeleteReady = true; }));
        await page.reload();
        await page.waitForFunction(() => window.dialogueDeleteReady, undefined, { timeout: 60000 });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            window.NeconyanExtensions.focusUnit('Dialogue Colors');
        }, avatar);
        if (phone) await applyIOSOnlyCss(page);
        await expect(page.locator('#dc-char-list .dc-char[data-key="kept friend"]')).toBeVisible();
        await expect(row).toHaveCount(0);
    });
}

test('deletion still rejects changed characters, selections and storage scopes', async ({ app }) => {
    test.setTimeout(120000);
    const page = await openDialogueColours(app);
    const row = page.locator('#dc-char-list .dc-char[data-key="durable nova"]');
    for (const change of ['keep', 'colour', 'selection', 'scope', 'chat']) {
        await addUnkeptCharacter(page);
        if (change === 'selection') {
            await page.locator('#dc-select-visible').click();
            await page.locator('#dc-bulk-action-select').selectOption('delete');
            await page.locator('#dc-bulk-apply-action').click();
        } else {
            if (await row.locator('.dc-more').getAttribute('aria-expanded') !== 'true') await row.locator('.dc-more').click();
            await row.locator('.dc-del').click();
        }
        await expect(page.locator('.dc-dialog')).toBeVisible();
        await page.evaluate(async ({ extension, change }) => {
            const state = await import(`${extension}/state.js`);
            if (change === 'keep') state.characterColors['durable nova'].keep = true;
            if (change === 'colour') state.characterColors['durable nova'].baseColor = '#ff0088';
            if (change === 'selection') state.selectedCharacterKeys.clear();
            if (change === 'scope') state.settings.colorStorageScope = 'global';
            if (change === 'chat') {
                const core = await import('/script.js');
                core.characters[core.this_chid].chat = 'another-chat';
            }
        }, { extension, change });
        await page.locator('.dc-dialog [data-dialog-value="confirm"]').click();
        await expect(page.locator('.dc-dialog')).toHaveCount(0);
        await expect(row).toHaveCount(1);
        await page.evaluate(async extension => {
            const { settings } = await import(`${extension}/state.js`);
            settings.colorStorageScope = 'card';
        }, extension);
    }
});

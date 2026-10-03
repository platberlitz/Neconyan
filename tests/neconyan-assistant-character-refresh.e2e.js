/* global window, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.setTimeout(180000);

async function invoke(page, name, input = {}) {
    return page.evaluate(async ({ name, input }) => {
        const { ToolManager } = await import('/scripts/tool-calling.js');
        return JSON.parse(await ToolManager.invokeFunctionTool(`Neconyan_Assistant_${name}`, JSON.stringify(input)));
    }, { name, input });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Miso, Taro and Nori make new cards immediately available without a reload`, async ({ app }, info) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const assistants = [];
        for (const id of ['miso-male', 'taro-male', 'nori-neutral']) {
            assistants.push({ id, ...await account.post('/api/characters/assistants/install', { id }) });
        }
        const page = await account.open({ workspace: false });
        if (phone) await applyIOSOnlyCss(page);
        for (const assistant of assistants) {
            await page.evaluate(async avatar => {
                const context = window.SillyTavern.getContext();
                await context.selectCharacterById(context.characters.findIndex(card => card.avatar === avatar), { switchMenu: false });
                (await import('/scripts/neconyan-assistant-tools.js')).syncNeconyanAssistantTools();
            }, assistant.avatar);
            const input = { userConfirmed: true, character: { name: `${assistant.id} new friend`, description: 'Immediately readable', first_mes: 'Hello!' } };
            await page.evaluate(input => {
                window.characterCreation = import('/scripts/tool-calling.js').then(async ({ ToolManager }) =>
                    JSON.parse(await ToolManager.invokeFunctionTool('Neconyan_Assistant_CreateCharacter', JSON.stringify(input))));
            }, input);
            const review = page.locator('dialog.popup[open]').filter({ has: page.locator('.neconyan-assistant-review') });
            await expect(review).toBeVisible();
            const geometry = await review.evaluate(dialog => {
                const box = dialog.getBoundingClientRect();
                return { left: box.left, right: box.right, width: window.innerWidth, display: getComputedStyle(dialog).display };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            expect(geometry.display).not.toBe('none');
            await review.locator('.popup-button-ok').click();
            const created = await page.evaluate(() => window.characterCreation);
            expect(created).toMatchObject({ status: 'success', committed: true, refreshFailed: false });
            expect(await invoke(page, 'ListCharacters')).toMatchObject({ characters: expect.arrayContaining([{ avatar: created.avatar, name: input.character.name }]) });
            expect(await invoke(page, 'ReadCharacter', { avatar: created.avatar })).toMatchObject({ status: 'success', character: { description: 'Immediately readable' } });
            const state = await page.evaluate(avatar => {
                const context = window.SillyTavern.getContext();
                return { active: context.characters[context.characterId]?.avatar, copies: context.characters.filter(card => card.avatar === avatar).length,
                    index: context.characters.findIndex(card => card.avatar === avatar) };
            }, created.avatar);
            expect(state).toMatchObject({ active: assistant.avatar, copies: 1 });
            await expect(page.locator(`#rm_print_characters_block .character_select[data-chid="${state.index}"] .ch_name`)).toHaveText(input.character.name);
            await expect(page.locator('#toast-container .toast-error').filter({ hasText: 'not found in the list' })).toHaveCount(0);
        }
        await page.screenshot({ path: info.outputPath('new-characters-without-reload.png') });
    });
}

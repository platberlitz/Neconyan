/* global window */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(120000);

async function openAgentChat(page) {
    const storage = createMockRoleplayStore(() => page.evaluate(async () =>
        (await import('/scripts/roleplay-save-chain.js')).roleplayAccountStamp().account));
    await page.route('**/api/chats/get', route => storage.read(route));
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.route('**/api/chats/save', route => storage.save(route));
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const id = context.characters.length;
        context.characters.push({ name: 'UI Cat', avatar: 'none', chat: 'agent-ui-check', first_mes: '', mes_example: '', shallow: false, data: {} });
        await context.selectCharacterById(id, { switchMenu: false });
        context.chat.splice(0, context.chat.length, {
            name: 'UI Cat', is_user: false, is_system: false, mes: 'Changed reply', send_date: new Date().toISOString(),
            extra: { inChatAgentTransformHistory: [{ agentName: 'UI Agent', beforeText: 'Original reply', afterText: 'Changed reply' }] },
        });
        await context.printMessages();
        (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
    });
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'iPhone stand-in' : 'Desktop'} message actions`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
        test.beforeEach(async ({ context, page }) => {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            await openAgentChat(page);
            if (phone) await applyIOSOnlyCss(page);
        });

        test('keeps View agent changes compact before and after editing', async ({ page }, testInfo) => {
            const message = page.locator('#chat .mes[mesid="0"]');
            const action = message.locator('.mes_view_agent_changes');
            await message.locator('.extraMesButtonsHint').click();
            const checkSize = async () => {
                await expect(action).toBeVisible();
                await expect(action).toHaveCSS('aspect-ratio', 'auto');
                const bounds = await action.boundingBox();
                expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
                expect(bounds.height).toBeLessThanOrEqual(60);
                expect(bounds.width).toBeGreaterThan(bounds.height);
            };
            await checkSize();
            await message.locator('.mes_edit').click();
            await message.locator('.edit_textarea').fill('Edited reply');
            await message.locator('.mes_edit_done').click();
            await message.locator('.extraMesButtonsHint').click();
            await checkSize();
            await page.screenshot({ path: testInfo.outputPath('agent-action-size.png') });
            await action.click();
            await expect(page.locator('dialog[open]')).toContainText('UI Agent');
        });
    });
}

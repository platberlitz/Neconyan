import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad prompts can be viewed, saved, sent and reset`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        await open();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Assistant prompt', exact: true });
        await expect(editor).toHaveValue(/You are Miso/);
        await expect(editor).toHaveValue(/"action":"append"/);
        await editor.fill('You are Miso. Answer every question with a short numbered list. PROMPT-TEST');
        await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('Please compare these ideas.');
        app.provider.mode.streamReply = { first: 'First idea.', rest: ' Second idea.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('First idea.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        expect(app.provider.calls.at(-1).messages[0].content).toContain('PROMPT-TEST');
        const reply = page.locator('.scratchpad-message.is-assistant.is-done');
        const actions = reply.locator('.scratchpad-message-actions');
        await expect(actions).toBeHidden();
        const toggle = reply.locator('summary[aria-label="Message actions"]');
        await toggle.click();
        await expect(actions).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
        const bounds = await toggle.boundingBox();
        const card = await reply.boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThan(card.x + card.width / 2);
        await toggle.press('Escape');
        await expect(actions).toBeHidden();
        await toggle.click();
        await actions.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Edit message', exact: true })).toBeVisible();
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await page.evaluate(async avatar => {
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        }, account.avatar);
        await open();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        await expect(editor).toHaveValue(/PROMPT-TEST/);
        await page.getByRole('button', { name: 'Reset to default', exact: true }).click();
        await expect(editor).toHaveValue(/You are Miso/);
        await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        await expect(editor).not.toHaveValue(/PROMPT-TEST/);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    });
}

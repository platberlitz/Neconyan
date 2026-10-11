/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Helpers verify their own setup. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function openScratchpad(page, tab = 'chat') {
    await page.evaluate(async tab => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab }), tab);
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size} shares character sessions across Roleplay chats and Conversation branches without redirecting message changes`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        const original = await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await context.saveChat({ throwOnError: true });
            await (await import('/script.js')).reloadCurrentChat();
            return context.getCurrentChatId();
        }, account.avatar);
        const legacy = { kind: 'roleplay', key: `character:${account.avatar}:${original}`, label: original };
        const created = await account.post('/api/scratchpad/session/create', { source: legacy, name: 'Scene planning',
            settings: { picked: ['0'], assistantConnections: { miso: { kind: 'profile', profileId: 'durable' } } } });
        const sessionId = created.bucket.activeSessionId;
        await account.post('/api/scratchpad/session/import', { source: { ...legacy, key: `character:${account.avatar}:Earlier chat` },
            session: { name: 'Earlier ideas', messages: [{ role: 'user', text: 'Keep this older idea too.' }] } });
        const first = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        app.provider.mode.streamReply = { first: 'Planning continues', rest: ' in the shared session.\n```scratchpad-change\n{"type":"chat","action":"edit","message":0,"text":"Do not write this into another chat."}\n```' };
        await page.locator('.scratchpad-composer').fill('Keep planning while I open another chat.');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('Planning continues');
        const secondChat = await page.evaluate(async () => {
            const script = await import('/script.js');
            await script.doNewChat();
            await window.SillyTavern.getContext().saveChat({ throwOnError: true });
            await script.reloadCurrentChat();
            return window.SillyTavern.getContext().getCurrentChatId();
        });
        expect(secondChat).not.toBe(original);
        const second = await openScratchpad(page);
        expect(second.key).not.toBe(first.key);
        expect(second.scope).toEqual(first.scope);
        await expect(page.locator('.scratchpad-stream')).toContainText('Planning continues');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        await expect(page.locator('.scratchpad-reply')).toContainText('Planning continues in the shared session.');
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('#toast-container')).toContainText('Open the original chat');
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await page.locator('.scratchpad-message.is-assistant summary[aria-label="Message actions"]').click();
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await expect(page.locator('#toast-container')).toContainText('Open the original chat');
        expect(await page.evaluate(() => window.SillyTavern.getContext().chat[0].mes)).not.toBe('Do not write this into another chat.');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.locator('#scratchpad-panel-context')).toContainText('These picks belong to another chat.');
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        await expect(page.locator('.scratchpad-preview-text')).toContainText('## Picked messages (0 of');
        await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
        await expect(page.locator('.scratchpad-sessions .scratchpad-session')).toHaveCount(2);
        await expect(page.locator('.scratchpad-sessions')).toContainText('Scene planning');
        await expect(page.locator('.scratchpad-sessions')).toContainText('Earlier ideas');
        await page.screenshot({ path: `../screenshots/scratchpad-shared-${size}-after.png` });
        const geometry = await page.locator('#neconyan-scratchpad').evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, fontSize: getComputedStyle(element).fontSize, pageWidth: document.documentElement.scrollWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(geometry.pageWidth).toBe(phone ? 393 : 1280);
        expect(Number.parseFloat(geometry.fontSize)).toBeGreaterThan(0);
        const saved = (await account.post('/api/scratchpad/bucket', { source: second })).bucket;
        expect(saved.activeSessionId).toBe(sessionId);
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        const conversation = await openScratchpad(page, 'sessions');
        expect(conversation.kind).toBe('conversation');
        expect((await account.post('/api/scratchpad/bucket', { source: conversation })).bucket.activeSessionId).toBe(sessionId);
        await expect(page.locator('.scratchpad-sessions .scratchpad-session')).toHaveCount(2);
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/context.js')).createConversationBranchForAvatar(avatar, 'Another branch'), account.avatar);
        const branch = await openScratchpad(page, 'sessions');
        expect(branch.key).not.toBe(conversation.key);
        expect((await account.post('/api/scratchpad/bucket', { source: branch })).bucket.sessions.map(session => session.id)).toEqual(saved.sessions.map(session => session.id));
        await expect(page.locator('.scratchpad-sessions .scratchpad-session')).toHaveCount(2);
    });
}

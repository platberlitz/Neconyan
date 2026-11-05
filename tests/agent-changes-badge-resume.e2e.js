/* global window, document, HTMLElement, requestAnimationFrame */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

function setHidden(hidden) {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} keeps the agent changes badge when a background update settles on a replaced message`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.hold = ['post-held'];
        app.provider.mode.reply = body => ({ choices: [{ message: {
            content: body.model === 'post-held' ? 'The revised reply is ready.' : 'The browser reply is ready.' }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.connectionManager.profiles.push(
                { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-held', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false, connectionProfile: 'post' } };
        } });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'post.json'), JSON.stringify({ id: 'post', name: 'Post Gen', enabled: true, phase: 'post',
            prompt: 'Revise the reply.', connectionProfile: 'post', postProcess: { enabled: false, promptTransformEnabled: true } }));
        const page = await openChat(account);
        await page.locator('#send_textarea').fill('Tell me about the fountain.');
        await page.locator('#send_textarea').press('Enter');
        await expect.poll(() => app.provider.calls.some(call => call.model === 'post-held' && call.completedAt === null), { timeout: 30000 })
            .toBe(true);
        await app.release();
        const message = page.locator('#chat .mes[mesid]').last();
        await expect(message.locator('.mes_text')).toHaveText('The revised reply is ready.', { timeout: 30000 });
        await expect(message.locator('.agent-transform-badge')).toBeVisible();

        // Let earlier rows finish their own frame before the frame is held.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForTimeout(100);
        const messageId = await page.evaluate(async () => {
            const core = await import('/script.js');
            window.__heldFrames = [];
            window.__holdFrames = false;
            const original = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = callback => {
                if (window.__holdFrames) {
                    window.__heldFrames.push(callback);
                    return window.__heldFrames.length;
                }
                return original(callback);
            };
            window.__flushFrames = () => {
                for (const frame of window.__heldFrames.splice(0)) original(frame);
            };
            const live = core.chat.at(-1);
            const stale = structuredClone(live);
            stale.mes = 'The browser reply is ready.';
            delete stale.extra.inChatAgentTransformHistory;
            delete stale.swipe_info;
            window.__holdFrames = true;
            void core.updateMessageBlock(core.chat.length - 1, stale);
            return core.chat.length - 1;
        });
        await page.waitForTimeout(150);
        await expect.poll(() => page.evaluate(() => window.__heldFrames.length)).toBeGreaterThan(0);
        // A held frame has not settled yet, so the live row must still be shown.
        await expect(message.locator('.mes_text')).toHaveText('The revised reply is ready.');
        await page.evaluate(() => {
            window.__holdFrames = false;
            window.__flushFrames();
        });
        await expect(message.locator('.mes_text')).toHaveText('The revised reply is ready.');
        await expect(message.locator('.agent-transform-badge')).toBeVisible();
        await expect.poll(() => page.evaluate(id => (import('/script.js')).then(core => ({
            text: core.chat[id].mes,
            history: core.chat[id].extra?.inChatAgentTransformHistory?.length ?? 0,
        })), messageId)).toEqual({ text: 'The revised reply is ready.', history: 1 });

        // A row drawn before the history was written is repaired when the tab returns.
        await page.evaluate(setHidden, true);
        await page.evaluate(messageId => {
            document.querySelector(`#chat .mes[mesid="${messageId}"] .agent-transform-badge`)?.remove();
            const action = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_view_agent_changes`);
            if (action instanceof HTMLElement) action.style.display = 'none';
        }, messageId);
        await expect(message.locator('.agent-transform-badge')).toHaveCount(0);
        await page.evaluate(setHidden, false);
        await expect(message.locator('.agent-transform-badge')).toBeVisible();
        expect(await message.locator('.mes_view_agent_changes').evaluate(element => element.style.display)).not.toBe('none');
    });
}

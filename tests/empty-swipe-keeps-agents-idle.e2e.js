/* global document, window, MutationObserver */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const visibility = (page, state) => page.evaluate(state => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
}, state);

for (const stream of [false, true]) {
    test(`a swipe that comes back empty keeps the previous reply and leaves the Agents idle (${stream ? 'streaming' : 'not streaming'})`, async ({ app }) => {
        const reply = body => ({ choices: [{ message: { content: body.model === MODEL ? 'Main reply.'
            : body.model === 'post-model' ? 'Post Gen ran.' : 'The Companion note is ready.' }, finish_reason: 'stop' }] });
        app.provider.mode.reply = reply;
        if (stream) app.provider.mode.streamEvents = [{ choices: [{ delta: { content: 'Main reply.' } }] }];
        const account = await app.account({ activeConnection: true, configureSettings(saved) {
            saved.power_user.auto_swipe = false;
            saved.oai_settings.stream_openai = stream;
            saved.extension_settings.connectionManager.profiles.push(
                { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-model', 'api-url': app.provider.url },
                { id: 'companion', name: 'Companion fixture', api: 'custom', mode: 'cc', model: 'companion-model', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                trackerCompanionAutoLoopVersion: 4, connectionProfile: 'post', companionExecutionMode: 'parallel', companionConcurrentWithPostGen: false } };
        } });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(directory, { recursive: true });
        for (const agent of [
            { id: 'post', name: 'Post Gen', enabled: true, phase: 'post', prompt: 'Revise the reply.', connectionProfile: 'post',
                postProcess: { enabled: false, promptTransformEnabled: true } },
            { id: 'companion', name: 'Story Companion', enabled: true, category: 'companion', execution: 'companion',
                prompt: 'Write a note about the reply.', connectionProfile: 'companion', companion: { trigger: 'auto', displayMode: 'card' } },
        ]) await fs.writeFile(path.join(directory, `${agent.id}.json`), JSON.stringify(agent));
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            window.__toasts = [];
            new MutationObserver(records => {
                for (const record of records) for (const node of record.addedNodes) {
                    if (node.nodeType === 1 && node.closest?.('#toast-container')) window.__toasts.push(node.textContent.trim());
                }
            }).observe(document.body, { childList: true, subtree: true });
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const count = model => app.provider.calls.filter(call => call.model === model).length;
        const sendPressed = () => page.evaluate(async () => (await import('/script.js')).is_send_press);
        const last = page.locator('#chat .mes[mesid]').last();

        await page.locator('#send_textarea').fill('Tell me about the fountain.');
        await page.locator('#send_textarea').press('Enter');
        await expect(last).toContainText('Post Gen ran.', { timeout: 60000 });
        await expect(last).toContainText('The Companion note is ready.', { timeout: 60000 });
        await expect.poll(sendPressed, { timeout: 30000 }).toBe(false);
        await page.waitForTimeout(3000);
        const before = { main: count(MODEL), post: count('post-model'), companion: count('companion-model') };

        app.provider.mode.hold = MODEL;
        page.evaluate(async () => { await (await import('/script.js')).swipe_right(null, {}); }).catch(() => {});
        await expect.poll(() => count(MODEL), { timeout: 30000 }).toBe(before.main + 1);
        await visibility(page, 'hidden');
        app.provider.mode.reply = body => body.model === MODEL ? { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } : reply(body);
        app.provider.mode.streamEvents = stream ? [] : null;
        await app.release();
        await page.waitForTimeout(4000);
        await visibility(page, 'visible');
        await expect.poll(sendPressed, { timeout: 60000 }).toBe(false);
        await page.waitForTimeout(8000);

        expect({ post: count('post-model'), companion: count('companion-model') }).toEqual({ post: before.post, companion: before.companion });
        expect((await page.evaluate(() => window.__toasts)).join(' ')).toContain('The AI sent back an empty reply, so nothing was changed.');
        expect(await page.evaluate(async () => {
            const { mes, swipes, swipe_id } = (await import('/script.js')).chat.at(-1);
            return { mes, swipes, swipe_id };
        })).toEqual({ mes: 'Post Gen ran.', swipes: ['Post Gen ran.'], swipe_id: 0 });
        await expect(last).toContainText('Post Gen ran.');
        await expect(last).toContainText('The Companion note is ready.');
    });
}

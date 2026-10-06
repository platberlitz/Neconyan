/* global window */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} keeps old Scratchpad sessions and a pending reply through a chat rename`, async ({ app }) => {
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
        const created = await account.post('/api/scratchpad/session/create', { source: legacy, name: 'Kept planning', settings: { depth: 7, assistantConnections: { miso: { kind: 'profile', profileId: 'durable' } } } });
        const sessionId = created.bucket.activeSessionId;
        await account.post('/api/scratchpad/session/import', { source: legacy, session: { name: 'Earlier planning', messages: [{ role: 'user', text: 'A saved old idea.' }] } });
        await account.post('/api/scratchpad/session/activate', { source: legacy, sessionId });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        if (phone) await applyIOSOnlyCss(page);
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        app.provider.mode.streamReply = { first: 'Planning continues', rest: ' after the rename.' };
        await page.locator('.scratchpad-composer').fill('Keep this thought while I rename the chat.');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('Planning continues');
        const renamed = 'Renamed planning chat';
        await page.evaluate(async ({ original, renamed }) => {
            const script = await import('/script.js');
            await script.renameGroupOrCharacterChat({ characterId: script.this_chid, oldFileName: original, newFileName: renamed });
        }, { original, renamed });
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        const next = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        expect(next.key).toBe(source.key);
        expect(next.label).toContain(renamed);
        await expect(page.locator('.scratchpad-message.is-assistant')).toContainText('Planning continues after the rename.');
        const saved = (await account.post('/api/scratchpad/bucket', { source: next })).bucket;
        expect(saved.activeSessionId).toBe(sessionId);
        expect(saved.sessions.map(session => session.name).sort()).toEqual(['Earlier planning', 'Kept planning']);
        expect(saved.sessions.find(session => session.id === sessionId).settings.depth).toBe(7);
        await page.close();
        const reopened = await account.open({ workspace: false });
        await reopened.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' });
        }, account.avatar);
        await expect(reopened.locator('.scratchpad-sessions')).toContainText('Earlier planning');
        await expect(reopened.locator('.scratchpad-sessions')).toContainText('Kept planning');
    });
}

test('a group rename preserves legacy planning before Scratchpad is first opened', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const original = 'Group planning';
    const group = await account.post('/api/groups/create', { name: 'Planning group', members: [account.avatar], chat_id: original, chats: [original] });
    const read = await account.context.request.post('/api/chats/group/get', { headers: account.headers, data: { id: original, allow_create: true } });
    expect(read.ok()).toBe(true);
    const vacant = JSON.parse(read.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/group/save', { id: original,
        chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} }, { name: 'Durable Nova', is_user: false, mes: 'Group scene.', extra: {} }],
        roleplay: { account: vacant.account, vacancy: vacant.vacancy, operationKey: randomUUID() } });
    const page = await account.open({ workspace: false });
    await page.evaluate(async id => (await import('/scripts/group-chats.js')).openGroupById(id, { switchMenu: false }), group.id);
    const legacy = { kind: 'roleplay', key: `group:${group.id}:${original}`, label: original };
    const created = await account.post('/api/scratchpad/session/create', { source: legacy, name: 'Group ideas', settings: { depth: 9 } });
    const identity = await page.evaluate(async original => (await import('/scripts/roleplay-save-chain.js')).getRoleplaySourceId({ group: true, chat: original }), original);
    expect(identity).toMatch(/^[0-9a-f-]{36}$/);
    const renamed = 'Renamed group planning';
    await page.evaluate(async ({ groupId, original, renamed }) => (await import('/script.js')).renameGroupOrCharacterChat({ groupId, oldFileName: original, newFileName: renamed }),
        { groupId: group.id, original, renamed });
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' }));
    await expect(page.locator('.scratchpad-sessions')).toContainText('Group ideas');
    const source = await page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
    expect(source.key).toBe(`roleplay:${identity}:group:${group.id}`);
    expect(source.legacyKey).toBe(`group:${group.id}:${renamed}`);
    const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket;
    expect(saved.activeSessionId).toBe(created.bucket.activeSessionId);
    expect(saved.sessions[0].settings.depth).toBe(9);
});

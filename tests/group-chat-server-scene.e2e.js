import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

test.setTimeout(240000);

const promptText = call => call.messages.map(message => message.content).join('\n');
const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating), { timeout: 30000 }).toBe(false);
const lastMessage = page => async () => (await readSceneChat(page)).at(-1)?.mes;
const changeScene = (page, patch) => page.evaluate(async value => (await import('/scripts/group-chat-scene-ui.js')).changeGroupScene(value), patch);
const serverTurn = page => page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit') && response.status() === 202);

test('the server writes a whispered group turn for the member it is for', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const mira = group.members[1];
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await page.locator('#group_scene_open').click();
    await page.locator('#group_scene_whisper').selectOption(mira);
    app.provider.mode.reply = () => textReply('I will keep the violet key hidden.');
    const submitted = serverTurn(page);
    await page.locator('#send_textarea').fill('Kit must not hear that the key is violet.');
    await startNativeReply(page);
    await submitted;
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('I will keep the violet key hidden.');
    await settled(page);
    expect(app.provider.calls).toHaveLength(1);
    expect(promptText(app.provider.calls[0])).toContain('Other members cannot hear or react to it. Keep the reply private.]');
    const whispered = (await readSceneChat(page)).slice(-2);
    expect(whispered[1].name).toBe('Scene Mira');
    expect(whispered.map(message => message.extra.group_scene.whisper_to)).toEqual([[mira], [mira]]);
    await expect(page.locator('#chat .group-whisper-badge')).toHaveCount(2);
});

test('a server speaker who missed the line they answer hears it', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const [kit, mira] = group.members;
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await changeScene(page, { away: [mira] });
    app.provider.mode.reply = () => textReply('Kit nods at the door.');
    await sendSceneMessage(page, 'Kit, the secret code is marigold.');
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Kit nods at the door.');
    await settled(page);
    await changeScene(page, { away: [] });

    app.provider.mode.reply = () => textReply('Mira asks what she missed.');
    const calls = app.provider.calls.length;
    const submitted = serverTurn(page);
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        void core.Generate('normal', { force_chid: core.characters.findIndex(character => character.avatar === avatar), skipNativeRoleplay: false });
    }, mira);
    await submitted;
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Mira asks what she missed.');
    await settled(page);
    expect(app.provider.calls).toHaveLength(calls + 1);
    const answered = promptText(app.provider.calls.at(-1));
    expect(answered).toContain('Kit nods at the door.');
    expect(answered).not.toContain('marigold');
    const find = async text => (await readSceneChat(page)).find(message => message.mes === text);
    expect((await find('Kit nods at the door.')).extra.group_scene.present.sort()).toEqual([kit, mira].sort());
    expect((await find('Kit, the secret code is marigold.')).extra.group_scene.present).toEqual([kit]);
});

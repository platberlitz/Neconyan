import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(300000);

const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
const lastMessage = page => async () => (await readSceneChat(page)).at(-1)?.mes;
const LINES = ['The code is marigold.', 'Kit hums.', 'The vault is behind the painting.', 'Kit nods.'];
const heardBy = async page => {
    const messages = await readSceneChat(page);
    return LINES.map(text => [...(messages.find(message => message.mes === text)?.extra?.group_scene?.present || [])].sort());
};
const run = (page, command) => page.evaluate(async text => {
    const result = await (await import('/scripts/slash-commands.js')).executeSlashCommandsWithOptions(text);
    return result?.pipe ?? '';
}, command);
const macro = (page, text) => page.evaluate(async value => (await import('/script.js')).substituteParams(value), text);
const lineIndex = async (page, text) => (await readSceneChat(page)).findIndex(message => message.mes === text);

async function say(page, app, text, reply) {
    app.provider.mode.reply = () => textReply(reply);
    await sendSceneMessage(page, text);
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe(reply);
    await settled(page);
}

async function reopen(page, group) {
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true }))).toBe(true);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
}

test('scene commands and macros change and read who heard each line, and SillyTavern Presence chats keep their memory', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const [kit, mira] = group.members;
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);

    expect(await run(page, '/away Scene Mira')).toBe('Scene Mira');
    expect(await run(page, '/scene-location The lantern inn')).toBe('The lantern inn');
    expect(await macro(page, '{{groupPresent}}|{{groupAway}}|{{sceneLocation}}')).toBe('Scene Kit|Scene Mira|The lantern inn');
    await say(page, app, 'The code is marigold.', 'Kit hums.');
    await say(page, app, 'The vault is behind the painting.', 'Kit nods.');
    expect(await run(page, '/back Scene Mira')).toBe('Scene Mira');
    expect(await run(page, '/scene-location clear=true')).toBe('');
    expect(await macro(page, '{{groupAway}}|{{sceneLocation}}')).toBe('|');
    expect(await heardBy(page)).toEqual([[kit], [kit], [kit], [kit]]);

    const marigold = await lineIndex(page, LINES[0]);
    const painting = await lineIndex(page, LINES[2]);
    expect(await macro(page, `{{groupHeard::${marigold}}}`)).toBe('Scene Kit');
    expect(await run(page, `/heard-get ${marigold}`)).toBe('Scene Kit');

    expect(await run(page, `/heard-remember name="Scene Mira" ${marigold}`)).toBe('1');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit], [kit], [kit]]);
    expect(await run(page, `/heard-copy from=${marigold} to=${painting}`)).toBe('1');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit], [kit, mira].sort(), [kit]]);
    expect(await run(page, '/heard-forget Scene Kit')).not.toBe('0');
    expect((await heardBy(page)).every(list => !list.includes(kit))).toBe(true);
    expect(await run(page, `/heard-all ${marigold}-${painting}`)).not.toBe('0');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit, mira].sort(), [kit, mira].sort(), []]);
    expect(await run(page, `/heard-none ${painting}`)).toBe('1');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit, mira].sort(), [], []]);

    // SillyTavern's own command names reach the same tools.
    expect(await run(page, '/presenceRememberAll Scene Kit')).not.toBe('0');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit, mira].sort(), [kit], [kit]]);
    await expect(page.locator('#chat .mes .group-heard-badge').first()).toHaveText('Heard by 1 of 2');

    // A chat saved by the SillyTavern Presence extension: lists on each message and an all-seeing member.
    await page.evaluate(async ({ kitAvatar, miraAvatar }) => {
        const { chat, chat_metadata } = await import('/script.js');
        const { saveGroupChat, selected_group } = await import('/scripts/group-chats.js');
        for (const message of chat) {
            const present = message.mes === 'The vault is behind the painting.' ? [kitAvatar] : [kitAvatar, miraAvatar];
            delete message.extra?.group_scene;
            message.present = message.mes === 'Kit nods.' ? ['presence_universal_tracker'] : present;
        }
        delete chat_metadata.group_scene;
        chat_metadata.ignore_presence = [miraAvatar];
        await saveGroupChat(selected_group, false);
    }, { kitAvatar: kit, miraAvatar: mira });
    await reopen(page, group);
    const imported = await readSceneChat(page);
    expect(imported.find(message => message.mes === LINES[2]).extra.group_scene).toEqual({ present: [kit], whisper_to: [] });
    expect(imported.find(message => message.mes === LINES[3]).extra?.group_scene).toBeUndefined();
    expect(imported.find(message => message.mes === LINES[2]).present).toEqual([kit]);
    expect(await page.evaluate(async () => (await import('/script.js')).chat_metadata.group_scene?.sees_all)).toEqual([mira]);
});

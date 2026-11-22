import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(300000);

const promptText = call => call.messages.map(message => message.content).join('\n');
const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
const lastMessage = page => async () => (await readSceneChat(page)).at(-1)?.mes;
const changeScene = (page, patch) => page.evaluate(async value => (await import('/scripts/group-chat-scene-ui.js')).changeGroupScene(value), patch);
const scene = page => page.evaluate(async () => structuredClone((await import('/script.js')).chat_metadata.group_scene));
const openPopup = page => page.locator('dialog.popup[open]').last();

async function trigger(page, app, name, reply) {
    app.provider.mode.reply = () => textReply(reply);
    const calls = app.provider.calls.length;
    await page.evaluate(async command => (await import('/scripts/slash-commands.js')).executeSlashCommandsWithOptions(command), `/trigger "${name}"`);
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe(reply);
    await settled(page);
    expect(app.provider.calls.length).toBe(calls + 1);
    return promptText(app.provider.calls.at(-1));
}

test('a member who remembers only with the group forgets lines while nobody who heard them with her is in the scene', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const [kit, mira] = group.members;
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);

    app.provider.mode.reply = () => textReply('Kit hums.');
    await sendSceneMessage(page, 'The code is marigold.');
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Kit hums.');
    await settled(page);

    // The Memory choice in the member menu.
    await page.evaluate(async avatar => { (await import('/scripts/group-chat-speaker-menu.js')).openGroupSpeakerMenu(avatar); }, mira);
    const menu = openPopup(page);
    const option = mode => menu.locator(`.group_speaker_memory_option[data-memory="${mode}"]`);
    await expect(option('heard')).toHaveAttribute('aria-pressed', 'true');
    await option('group').click();
    await expect(option('group')).toHaveAttribute('aria-pressed', 'true');
    await expect(option('heard')).toHaveAttribute('aria-pressed', 'false');
    await expect(menu.locator('.group_speaker_memory_hint')).toHaveText('Remembers a line only while someone else who heard it is in the scene.');
    await expect.poll(() => scene(page)).toMatchObject({ sees_all: [], with_group: [mira] });
    await menu.locator('.popup-button-cancel').click();
    await expect(menu).toBeHidden();

    await page.locator('#group_scene_open').click();
    await expect(page.locator('#group_scene_members button').filter({ hasText: 'Scene Mira' })).toContainText('With the group');

    // With Kit away, nobody who heard the code with Mira is in the scene.
    await changeScene(page, { away: [kit] });
    let prompt = await trigger(page, app, 'Scene Mira', 'Mira looks around.');
    expect(prompt).not.toContain('marigold');

    // Kit comes back, and so does the memory.
    await changeScene(page, { away: [] });
    prompt = await trigger(page, app, 'Scene Mira', 'Mira remembers.');
    expect(prompt).toContain('marigold');

    // Everything and What they heard leave the mode again; only one mode holds at a time.
    await page.evaluate(async avatar => { (await import('/scripts/group-chat-speaker-menu.js')).openGroupSpeakerMenu(avatar); }, mira);
    await expect(option('group')).toHaveAttribute('aria-pressed', 'true');
    await option('all').click();
    await expect.poll(() => scene(page)).toMatchObject({ sees_all: [mira] });
    expect((await scene(page)).with_group).toBeUndefined();
    await option('heard').click();
    await expect.poll(() => scene(page)).toMatchObject({ sees_all: [] });
    expect((await scene(page)).with_group).toBeUndefined();
    await menu.locator('.popup-button-cancel').click();
});

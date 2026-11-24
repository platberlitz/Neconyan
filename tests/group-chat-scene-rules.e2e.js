/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(300000);

const promptText = call => call.messages.map(message => message.content).join('\n');
const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
const lastMessage = page => async () => (await readSceneChat(page)).at(-1)?.mes;
const changeScene = (page, patch) => page.evaluate(async value => (await import('/scripts/group-chat-scene-ui.js')).changeGroupScene(value), patch);
const findMessage = async (page, text) => (await readSceneChat(page)).find(message => message.mes === text);

async function triggerMira(page, app, reply) {
    app.provider.mode.reply = () => textReply(reply);
    const calls = app.provider.calls.length;
    await page.evaluate(async () => (await import('/scripts/slash-commands.js')).executeSlashCommandsWithOptions('/trigger "Scene Mira"'));
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe(reply);
    await settled(page);
    expect(app.provider.calls.length).toBe(calls + 1);
    return promptText(app.provider.calls.at(-1));
}

test('members hear the line they answer, the all-seeing member misses only whispers, and late members can catch up', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const [kit, mira] = group.members;
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);

    // Every message records who heard it, even before the Scene strip is used.
    app.provider.mode.reply = () => textReply('Kit waves at you both.');
    await sendSceneMessage(page, 'Hello, both of you.');
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Kit waves at you both.');
    await settled(page);
    for (const text of ['Hello, both of you.', 'Kit waves at you both.']) {
        expect((await findMessage(page, text)).extra.group_scene.present.sort()).toEqual([kit, mira].sort());
    }

    // Mira was away for the secret, but hears Kit's line that she answers.
    await changeScene(page, { away: [mira] });
    app.provider.mode.reply = () => textReply('Kit nods at the door.');
    await sendSceneMessage(page, 'Kit, the secret code is marigold.');
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Kit nods at the door.');
    await settled(page);
    await changeScene(page, { away: [] });
    const answered = await triggerMira(page, app, 'Mira asks what she missed.');
    expect(answered).toContain('Kit nods at the door.');
    expect(answered).not.toContain('marigold');
    expect((await findMessage(page, 'Kit nods at the door.')).extra.group_scene.present.sort()).toEqual([kit, mira].sort());
    expect((await findMessage(page, 'Kit, the secret code is marigold.')).extra.group_scene.present).toEqual([kit]);

    // With the setting off, she hears only what was said in front of her.
    await page.evaluate(async id => {
        const { groups } = await import('/scripts/group-chats.js');
        groups.find(item => item.id === id).hear_reply_target = false;
    }, group.id);
    await changeScene(page, { away: [mira] });
    app.provider.mode.reply = () => textReply('Kit whistles quietly.');
    await sendSceneMessage(page, 'The vault is behind the painting.');
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Kit whistles quietly.');
    await settled(page);
    await changeScene(page, { away: [] });
    const unanswered = await triggerMira(page, app, 'Mira looks around.');
    expect(unanswered).not.toContain('Kit whistles quietly.');
    expect(unanswered).not.toContain('painting');
    expect((await findMessage(page, 'Kit whistles quietly.')).extra.group_scene.present).toEqual([kit]);

    // A whisper to Kit stays private, even from a member who sees everything.
    await changeScene(page, { whisper_to: [kit] });
    app.provider.mode.reply = () => textReply('Kit winks back.');
    await sendSceneMessage(page, 'Only you may know: pineapple.');
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Kit winks back.');
    await settled(page);
    await changeScene(page, { whisper_to: [], sees_all: [mira] });
    await expect(page.locator('#group_scene_members button').filter({ hasText: 'Scene Mira' })).toContainText('Sees everything');
    const allSeeing = await triggerMira(page, app, 'Mira smiles knowingly.');
    expect(allSeeing).toContain('marigold');
    expect(allSeeing).toContain('painting');
    expect(allSeeing).not.toContain('pineapple');

    // Catching up adds her to every line except the whisper, and is offered when she is new.
    await changeScene(page, { sees_all: [] });
    const caughtUp = await page.evaluate(async ({ groupId, avatar }) => {
        const groups = await import('/scripts/group-chats.js');
        groups.noteLateGroupMember(groupId, avatar);
        const toast = document.querySelector('#toast-container')?.textContent || '';
        const count = await groups.catchUpGroupMember(avatar);
        return { toast, count };
    }, { groupId: group.id, avatar: mira });
    expect(caughtUp.toast).toContain('Scene Mira has not heard the earlier messages');
    expect(caughtUp.count).toBeGreaterThan(0);
    const saved = await readSceneChat(page);
    expect(saved.find(message => message.mes === 'The vault is behind the painting.').extra.group_scene.present).toContain(mira);
    expect(saved.find(message => message.mes === 'Only you may know: pineapple.').extra.group_scene.whisper_to).toEqual([kit]);
    const caughtUpPrompt = await triggerMira(page, app, 'Mira knows the code now.');
    expect(caughtUpPrompt).toContain('marigold');
    expect(caughtUpPrompt).not.toContain('pineapple');
});

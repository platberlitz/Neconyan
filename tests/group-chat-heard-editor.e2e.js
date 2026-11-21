import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(300000);

const promptText = call => call.messages.map(message => message.content).join('\n');
const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
const lastMessage = page => async () => (await readSceneChat(page)).at(-1)?.mes;
const changeScene = (page, patch) => page.evaluate(async value => (await import('/scripts/group-chat-scene-ui.js')).changeGroupScene(value), patch);
const LINES = ['The code is marigold.', 'Kit hums.', 'The vault is behind the painting.', 'Kit nods.'];
const heardBy = async page => {
    const messages = await readSceneChat(page);
    return LINES.map(text => [...(messages.find(message => message.mes === text)?.extra?.group_scene?.present || [])].sort());
};
const row = (page, text) => page.locator('#chat .mes').filter({ has: page.locator('.mes_text', { hasText: text }) });
const openPopup = page => page.locator('dialog.popup[open]').last();

async function say(page, app, text, reply) {
    app.provider.mode.reply = () => textReply(reply);
    await sendSceneMessage(page, text);
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe(reply);
    await settled(page);
}

async function saveEditor(page, avatarName, range) {
    const editor = openPopup(page);
    await expect(editor.locator('.group_heard_editor')).toBeVisible();
    await editor.locator('.group_heard_member').filter({ hasText: avatarName }).click();
    await editor.locator('.group_heard_range_option').filter({ hasText: range }).click();
    await editor.locator('.popup-button-ok').click();
    await expect(editor).toBeHidden();
}

test('people can see and change who heard each group message, for one line or from there on', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const [kit, mira] = group.members;
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await page.evaluate(async id => {
        const { groups } = await import('/scripts/group-chats.js');
        groups.find(item => item.id === id).hear_reply_target = false;
    }, group.id);

    await changeScene(page, { away: [mira] });
    await say(page, app, 'The code is marigold.', 'Kit hums.');
    await say(page, app, 'The vault is behind the painting.', 'Kit nods.');
    await changeScene(page, { away: [] });

    const badges = page.locator('#chat .mes .group-heard-badge');
    await expect(badges).toHaveCount(4);
    await expect(badges.first()).toHaveText('Heard by 1 of 2');

    // One line, from the message's More menu.
    const first = row(page, LINES[0]);
    await first.locator('.extraMesButtonsHint').click();
    await expect(first.locator('.mes_heard')).toBeVisible();
    await first.locator('.mes_heard').click();
    await expect(openPopup(page).locator('.group_heard_member').filter({ hasText: 'Scene Mira' })).toHaveAttribute('aria-pressed', 'false');
    await saveEditor(page, 'Scene Mira', 'This message');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit], [kit], [kit]]);
    await expect(first.locator('.group-heard-badge')).toHaveCount(0);
    await expect(badges).toHaveCount(3);

    // From here on, starting at the badge on the third line.
    await row(page, LINES[2]).locator('.group-heard-badge').click();
    await saveEditor(page, 'Scene Mira', 'From here on');
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit], [kit, mira].sort(), [kit, mira].sort()]);
    await expect(badges).toHaveCount(1);

    // The saved lists survive a reload and decide what Mira's prompt holds.
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true }))).toBe(true);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    expect(await heardBy(page)).toEqual([[kit, mira].sort(), [kit], [kit, mira].sort(), [kit, mira].sort()]);
    await page.evaluate(async id => {
        const { groups } = await import('/scripts/group-chats.js');
        groups.find(item => item.id === id).hear_reply_target = false;
    }, group.id);
    app.provider.mode.reply = () => textReply('Mira points at the painting.');
    const calls = app.provider.calls.length;
    await page.evaluate(async () => (await import('/scripts/slash-commands.js')).executeSlashCommandsWithOptions('/trigger "Scene Mira"'));
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe('Mira points at the painting.');
    await settled(page);
    expect(app.provider.calls.length).toBe(calls + 1);
    const prompt = promptText(app.provider.calls.at(-1));
    expect(prompt).toContain('marigold');
    expect(prompt).toContain('painting');
    expect(prompt).toContain('Kit nods.');
    expect(prompt).not.toContain('Kit hums.');

    // Forgetting everything so far takes her out of every line.
    await page.evaluate(async avatar => { (await import('/scripts/group-chat-speaker-menu.js')).openGroupSpeakerMenu(avatar); }, mira);
    await openPopup(page).getByRole('button', { name: 'Forget everything so far' }).click();
    const confirm = openPopup(page);
    await expect(confirm).toContainText('will no longer remember anything said in this chat so far');
    await confirm.locator('.popup-button-ok').click();
    await expect.poll(async () => (await heardBy(page)).every(list => !list.includes(mira))).toBe(true);
    await expect(badges).toHaveCount(6);
    await expect(badges.first()).toHaveText('Heard by 1 of 2');
});

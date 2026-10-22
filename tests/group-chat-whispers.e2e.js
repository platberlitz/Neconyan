import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(180000);

test('a mid-reply audience change cannot make a whisper public and an away recipient blocks sending', async ({ app }) => {
    const account = await groupAccount(app, true);
    const group = await createSceneGroup(account);
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await page.locator('#group_scene_open').click();
    await page.locator('#group_scene_whisper').selectOption(group.members[1]);
    app.provider.mode.streamReply = () => ({ first: 'Only Mira knows', rest: ' the answer.' });
    await sendSceneMessage(page, 'This is private.');
    await expect(page.locator('#chat .mes_text').last()).toContainText('Only Mira knows', { timeout: 30000 });
    await page.locator('#group_scene_whisper').selectOption('');
    app.provider.mode.finishStream();
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating), { timeout: 30000 }).toBe(false);
    expect((await readSceneChat(page)).at(-1).extra.group_scene.whisper_to).toEqual([group.members[1]]);
    await page.locator('#group_scene_whisper').selectOption(group.members[1]);
    await page.locator('.group_scene_member').filter({ hasText: 'Scene Mira' }).click();
    await sendSceneMessage(page, 'Do not send this publicly.');
    await expect(page.locator('.toast-warning')).toContainText('Your whisper recipient is unavailable');
    await expect(page.locator('#send_textarea')).toHaveValue('Do not send this publicly.');
    expect(app.provider.calls).toHaveLength(1);
});

test('a whisper and its reply stay with the recipient after switching back to public and reloading', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account, { activation_strategy: 4 });
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await page.locator('#group_scene_open').click();
    await page.locator('#group_scene_whisper').selectOption(group.members[1]);
    app.provider.mode.reply = () => textReply('I will keep the violet key hidden.');
    await sendSceneMessage(page, 'Kit must not hear that the key is violet.');
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('I will keep the violet key hidden.');
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating), { timeout: 30000 }).toBe(false);
    expect(app.provider.calls).toHaveLength(1);
    const privateMessages = (await readSceneChat(page)).slice(-2);
    expect(privateMessages[1].name).toBe('Scene Mira');
    expect(privateMessages.map(message => message.extra.group_scene.whisper_to)).toEqual([[group.members[1]], [group.members[1]]]);
    await expect(page.locator('#chat .group-whisper-badge')).toHaveCount(2);

    await page.locator('#group_scene_whisper').selectOption('');
    await page.locator('.group_speaker_avatar').filter({ hasText: 'Scene Kit' }).click();
    app.provider.mode.reply = () => textReply('Kit is still looking for the key.');
    await page.locator('#group_speaker_now').click();
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Kit is still looking for the key.');
    const prompt = app.provider.calls.at(-1).messages.map(message => message.content).join('\n');
    expect(prompt).not.toContain('violet');
    expect(prompt).not.toContain('must not hear');
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true }))).toBe(true);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    await expect(page.locator('#chat .group-whisper-badge')).toHaveCount(2);
    expect((await readSceneChat(page)).slice(-3, -1).map(message => message.extra.group_scene.whisper_to)).toEqual([[group.members[1]], [group.members[1]]]);
});

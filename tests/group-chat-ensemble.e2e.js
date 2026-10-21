import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(180000);

test('ensemble streams visibly, uses both cards and saves separate character replies from one request', async ({ app }) => {
    const account = await groupAccount(app, true);
    const group = await createSceneGroup(account, { ensemble_replies: true });
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    app.provider.mode.streamReply = { first: 'Scene Kit: The lock is open.', rest: '\nScene Mira: I will check the archive.' };

    await sendSceneMessage(page, 'Everyone, what next?');
    await expect(page.locator('#chat .mes').last()).toContainText('The lock is open.', { timeout: 30000 });
    expect(app.provider.calls).toHaveLength(1);
    expect(app.provider.calls[0].messages.map(message => message.content).join('\n')).toContain('A cheerful mechanic.');
    expect(app.provider.calls[0].messages.map(message => message.content).join('\n')).toContain('A quiet archivist.');
    await expect.poll(() => typeof app.provider.mode.finishStream).toBe('function');
    app.provider.mode.finishStream();
    await expect.poll(async () => (await readSceneChat(page)).slice(-2).map(message => message.name)).toEqual(['Scene Kit', 'Scene Mira']);
    expect((await readSceneChat(page)).slice(-2).map(message => message.mes)).toEqual(['The lock is open.', 'I will check the archive.']);
    expect((await readSceneChat(page)).slice(-2).map(message => message.original_avatar)).toEqual(group.members);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true }))).toBe(true);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    expect((await readSceneChat(page)).slice(-2).map(message => message.mes)).toEqual(['The lock is open.', 'I will check the archive.']);
    expect(app.provider.calls).toHaveLength(1);
});

test('an ambiguous ensemble is retained intact as a Narrator reply', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account, { ensemble_replies: true });
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    const reply = 'The room falls silent.\nScene Kit: A strange noise.\nScene Mira: Listen.';
    app.provider.mode.reply = () => textReply(reply);
    await sendSceneMessage(page, 'Everyone, what next?');
    await expect(page.locator('#chat .mes').last()).toContainText('The room falls silent.', { timeout: 30000 });
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating), { timeout: 30000 }).toBe(false);
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.extra?.group_ensemble).toBe(true);
    expect((await readSceneChat(page)).at(-1)).toMatchObject({ name: 'Narrator', mes: reply });
    expect(app.provider.calls).toHaveLength(1);
});

test('stopping a partial ensemble keeps its visible text as a saved Narrator reply', async ({ app }) => {
    const account = await groupAccount(app, true);
    const group = await createSceneGroup(account, { ensemble_replies: true });
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    const partial = 'Scene Kit: I have found the key.';
    app.provider.mode.streamReply = { first: partial, rest: '\nScene Mira: The archive awaits.' };
    await sendSceneMessage(page, 'Everyone, what next?');
    await expect(page.locator('#chat .mes').last()).toContainText('I have found the key.', { timeout: 30000 });
    await page.evaluate(async () => (await import('/script.js')).stopGeneration());
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.extra?.group_ensemble, { timeout: 10000 }).toBe(true);
    expect((await readSceneChat(page)).at(-1)).toMatchObject({ name: 'Narrator', mes: partial });
    app.provider.mode.finishStream();
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true }))).toBe(true);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    expect((await readSceneChat(page)).at(-1)).toMatchObject({ name: 'Narrator', mes: partial });
});

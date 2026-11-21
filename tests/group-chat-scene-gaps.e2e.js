/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(240000);

const promptText = call => call.messages.map(message => message.content).join('\n');
const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);

test('previews, swipes, commands and impersonation follow who heard each line', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const [kit, mira] = group.members;
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await page.locator('#group_scene_open').click();
    const sceneMember = name => page.locator('#group_scene_members button').filter({ hasText: name });
    await sceneMember('Scene Mira').click();
    await expect(sceneMember('Scene Mira')).toHaveAttribute('aria-pressed', 'false');
    app.provider.mode.reply = () => textReply('Only Kit heard the secret.');
    await sendSceneMessage(page, 'Everyone, the secret code is marigold.');
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Only Kit heard the secret.');
    await settled(page);

    // An away member who speaks through /sendas remembers their own line.
    await page.evaluate(async () => (await import('/scripts/slash-commands.js'))
        .executeSlashCommandsWithOptions('/sendas name="Scene Mira" Mira hums outside the door.'));
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes).toBe('Mira hums outside the door.');
    expect((await readSceneChat(page)).at(-1).extra.group_scene.present.sort()).toEqual([kit, mira].sort());

    await sceneMember('Scene Mira').click();
    await page.locator('.group_speaker_avatar').filter({ hasText: 'Scene Mira' }).click();

    const preview = await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const { eventSource, event_types } = await import('/scripts/events.js');
        const visibility = await import('/scripts/group-chat-visibility.js');
        const groups = await import('/scripts/group-chats.js');
        let captured = '';
        const listener = data => { if (data.dryRun) captured = data.chat.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n'); };
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, listener);
        try { await core.Generate('normal', {}, true); }
        finally { eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, listener); }
        return {
            captured,
            restored: visibility.getGroupPromptViewers(),
            purrks: groups.getGroupPurrksMessages(avatar).map(message => message.mes),
        };
    }, mira);
    expect(preview.captured).toContain('Mira hums outside the door.');
    expect(preview.captured).not.toContain('marigold');
    expect(preview.captured).not.toContain('Only Kit heard the secret.');
    expect(preview.restored).toBeNull();
    expect(preview.purrks).toContain('Mira hums outside the door.');
    expect(preview.purrks.join('\n')).not.toContain('marigold');

    app.provider.mode.reply = () => textReply('Mira is back.');
    await page.locator('#group_speaker_now').click();
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Mira is back.');
    await settled(page);
    expect(promptText(app.provider.calls.at(-1))).not.toContain('marigold');
    const marker = await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const { canGroupMemberSee } = await import('/scripts/group-chat-visibility.js');
        const expected = core.chat.findIndex(message => !message.is_system && canGroupMemberSee(message, avatar));
        return { expected, saved: core.chat_metadata.lastInContextMessageId, shown: document.querySelector('#chat .mes.lastInContext')?.getAttribute('mesid') };
    }, mira);
    expect(marker.saved).toBe(marker.expected);
    expect(marker.shown).toBe(String(marker.expected));

    // Choosing a swipe that has no audience of its own keeps the message's audience.
    const swiped = await page.evaluate(async () => {
        const core = await import('/script.js');
        const message = structuredClone(core.chat.find(item => item.mes === 'Only Kit heard the secret.'));
        message.swipes = [message.mes, 'Kit shrugs.'];
        message.swipe_info = [{ send_date: message.send_date, extra: structuredClone(message.extra) }, { send_date: message.send_date, extra: {} }];
        core.syncSwipeToMes(null, 1, message);
        return message.extra.group_scene?.present ?? null;
    });
    expect(swiped).toEqual([kit]);

    // Impersonation writes the user's own line, and the user heard everything.
    await sceneMember('Scene Kit').click();
    await expect(sceneMember('Scene Kit')).toHaveAttribute('aria-pressed', 'false');
    app.provider.mode.reply = () => textReply('I still remember the code.');
    const calls = app.provider.calls.length;
    await page.evaluate(async () => { await (await import('/script.js')).Generate('impersonate'); });
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(calls + 1);
    await settled(page);
    expect(promptText(app.provider.calls.at(-1))).toContain('marigold');
});

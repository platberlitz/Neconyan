import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, textReply } from './group-chat-fixture.js';

test.setTimeout(180000);

const blockedStream = text => [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] },
];

async function openGroup(app, settings = {}) {
    const account = await groupAccount(app, true);
    const group = await createSceneGroup(account, settings);
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    return { page, group };
}

test('a filtered partial ends let them talk without requesting another reply', async ({ app }) => {
    const { page } = await openGroup(app, { talk_burst: 3 });
    app.provider.mode.streamEvents = blockedStream('The scene pauses in the middle of');
    await page.evaluate(async () => { await (await import('/scripts/group-chats.js')).letGroupMembersTalk(); });
    expect(app.provider.calls).toHaveLength(1);
    expect((await readSceneChat(page)).at(-1)).toMatchObject({ mes: 'The scene pauses in the middle of',
        extra: { generation_outcome: { status: 'blocked' } } });
    await expect(page.locator('#group_let_them_talk')).toHaveAttribute('aria-pressed', 'false');
});

test('a failed stream keeps its partial and ends let them talk', async ({ app }) => {
    const { page } = await openGroup(app, { talk_burst: 3 });
    app.provider.mode.streamEvents = [
        { choices: [{ index: 0, delta: { content: 'The door starts to' } }] },
        { error: { message: 'The provider connection failed.', type: 'server_error' } },
    ];
    await page.evaluate(async () => { await (await import('/scripts/group-chats.js')).letGroupMembersTalk(); });
    expect(app.provider.calls).toHaveLength(1);
    expect((await readSceneChat(page)).at(-1)).toMatchObject({ mes: 'The door starts to',
        extra: { generation_outcome: { status: 'error' } } });
    await expect(page.locator('#group_let_them_talk')).toHaveAttribute('aria-pressed', 'false');
});

test('every split ensemble passage retains its filtered status after reopening', async ({ app }) => {
    const { page, group } = await openGroup(app, { ensemble_replies: true });
    app.provider.mode.streamEvents = blockedStream('Scene Kit: The door opens.\nScene Mira: I can see the');
    await page.locator('#send_textarea').fill('Everyone, look inside.');
    await page.evaluate(async () => { await (await import('/script.js')).Generate('normal'); });
    const replies = (await readSceneChat(page)).slice(-2);
    expect(replies.map(message => message.name)).toEqual(['Scene Kit', 'Scene Mira']);
    expect(replies.map(message => message.extra.generation_outcome?.status)).toEqual(['blocked', 'blocked']);
    expect(replies.map(message => message.swipe_info[0].extra.generation_outcome?.status)).toEqual(['blocked', 'blocked']);
    expect(app.provider.calls).toHaveLength(1);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    await expect(page.locator('#chat .generation_outcome')).toHaveCount(2);
});

test('a blocked alternate-speaker swipe restores matching saved text and identity', async ({ app }) => {
    const { page, group } = await openGroup(app);
    app.provider.mode.reply = () => textReply('Kit opens the door.');
    await page.evaluate(async () => { (await import('/scripts/openai.js')).oai_settings.stream_openai = false; });
    await page.locator('#send_textarea').fill('Scene Kit, open the door.');
    await page.evaluate(async () => { await (await import('/script.js')).Generate('normal'); });
    app.provider.mode.reply = () => textReply('Mira examines the lock.');
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.swipe(null, 'right', { forceSwipeId: 1, forceDuration: 0,
            generationOptions: { force_chid: core.characters.findIndex(character => character.avatar === avatar), skipNativeRoleplay: true } });
    }, group.members[1]);
    await page.evaluate(async () => { await (await import('/script.js')).swipe(null, 'left', { forceSwipeId: 0, forceDuration: 0 }); });
    app.provider.mode.reply = { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] };
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.swipe(null, 'right', { forceSwipeId: 2, forceDuration: 0,
            generationOptions: { force_chid: core.characters.findIndex(character => character.avatar === avatar), skipNativeRoleplay: true } });
    }, group.members[1]);
    const restored = (await readSceneChat(page)).at(-1);
    expect(restored.mes).toBe(restored.swipes[restored.swipe_id]);
    expect(restored.name).toBe(restored.extra.group_speaker.name);
    expect(restored.original_avatar).toBe(restored.extra.group_speaker.original_avatar);
    expect(restored.swipes).toEqual(['Kit opens the door.', 'Mira examines the lock.']);
    await expect(page.locator('#chat .mes').last().locator('.name_text').first()).toHaveText(restored.name);
});

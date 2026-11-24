import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(240000);

const promptText = call => call.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);

for (const generationMode of [1, 2]) test(`joined-cards mode ${generationMode} leaves an away member's card out of the prompt`, async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account, { generation_mode: generationMode });
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await page.locator('#group_scene_open').click();
    const sceneMember = name => page.locator('#group_scene_members button').filter({ hasText: name });

    const before = app.provider.calls.length;
    app.provider.mode.reply = () => textReply('Both cards were there.');
    await sendSceneMessage(page, 'Good morning, both of you.');
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Both cards were there.');
    await settled(page);
    const together = app.provider.calls.slice(before).map(promptText);
    expect(together.length).toBeGreaterThan(0);
    for (const prompt of together) {
        expect(prompt).toContain('A cheerful mechanic.');
        expect(prompt).toContain('A quiet archivist.');
    }

    await sceneMember('Scene Mira').click();
    await expect(sceneMember('Scene Mira')).toHaveAttribute('aria-pressed', 'false');
    const away = app.provider.calls.length;
    app.provider.mode.reply = () => textReply('Only Kit is here.');
    await sendSceneMessage(page, 'Mira has stepped out.');
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Only Kit is here.');
    await settled(page);
    const apart = app.provider.calls.slice(away).map(promptText);
    expect(apart).toHaveLength(1);
    expect(apart[0]).toContain('A cheerful mechanic.');
    expect(apart[0]).not.toContain('A quiet archivist.');
});

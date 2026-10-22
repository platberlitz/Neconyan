import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(180000);

test('away members are not chosen and cannot see what happened while they were away', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    await expect(page.locator('#group_scene_strip')).toBeHidden();
    await page.locator('#group_scene_open').click();
    await expect(page.locator('#group_scene_open')).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 393, height: 852 });
    await expect.poll(() => page.locator('#group_scene_panel').evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#group_scene_location').fill('The locked archive');
    await page.locator('#group_scene_location').press('Tab');
    const mira = page.locator('#group_scene_members button').filter({ hasText: 'Scene Mira' });
    await mira.click();
    await expect(mira).toHaveAttribute('aria-pressed', 'false');
    app.provider.mode.reply = () => textReply('Only Kit heard the secret.');
    await sendSceneMessage(page, 'Everyone, the secret code is marigold.');
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Only Kit heard the secret.');
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
    expect(app.provider.calls).toHaveLength(1);
    expect((await readSceneChat(page)).at(-1).name).toBe('Scene Kit');
    expect(app.provider.calls[0].messages.map(message => message.content).join('\n')).toContain('The locked archive');

    const privacy = await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const visibility = await import('/scripts/group-chat-visibility.js');
        const macros = await import('/scripts/extensions/in-chat-agents/agent-context-macros.js');
        const agents = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
        const memory = await import('/scripts/mewmory/index.js');
        const target = { name: 'Scene Mira', original_avatar: avatar, mes: 'Returned.' };
        macros.setPreparedMewmoryContext(core.getCurrentChatId(), { enabled: true, memoryText: 'marigold' });
        macros.setPreparedActiveLore(core.getCurrentChatId(), 'marigold');
        const background = agents.buildPromptDynamicMacros(target.mes, target, { prompt: '{{full-mewmory}} {{active-lore}}' });
        const restore = visibility.beginGroupPromptScope([avatar], core.chat);
        try {
            const expanded = core.substituteParams('{{lastMessage}}');
            const prepared = await memory.prepareMewmoryGeneration(visibility.filterGroupPromptMessages(core.chat));
            return { background, expanded, enabled: prepared.enabled, stale: macros.getPreparedMewmoryContext(core.getCurrentChatId()) };
        } finally { restore(); }
    }, group.members[1]);
    expect(privacy.background['full-mewmory']).toBe('');
    expect(privacy.background['active-lore']).toBe('');
    expect(privacy.expanded).not.toContain('Only Kit heard');
    expect(privacy.enabled).toBe(false);
    expect(privacy.stale).toBeNull();

    await mira.click();
    await page.locator('.group_speaker_avatar').filter({ hasText: 'Scene Mira' }).click();
    app.provider.mode.reply = () => textReply('Mira returns without that knowledge.');
    await page.locator('#group_speaker_now').click();
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('Mira returns without that knowledge.');
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true }))).toBe(true);
    const prompt = app.provider.calls.at(-1).messages.map(message => message.content).join('\n');
    expect(prompt).not.toContain('marigold');
    expect(prompt).not.toContain('Only Kit heard the secret.');
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    await expect(page.locator('#group_scene_summary')).toContainText('The locked archive');
    const secret = (await readSceneChat(page)).find(message => message.mes.includes('marigold'));
    expect(secret.extra.group_scene.present).toEqual([group.members[0]]);
});

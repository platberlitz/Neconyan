import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(180000);

test('any member can narrate, retains multi-character narration and advertises its role to the Director', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account, { activation_strategy: 4 });
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);
    expect(await page.evaluate(async () => {
        const core = await import('/script.js');
        return core.characters.some(character => character.name === 'Narrator' && character.data?.extensions?.neconyan_group_role === 'narrator');
    })).toBe(true);
    await page.locator('.group_speaker_avatar').filter({ hasText: 'Scene Mira' }).click({ button: 'right' });
    await page.getByRole('button', { name: 'Use as Narrator / GM', exact: true }).click();
    await page.locator('#group_scene_toggle').click();
    await expect(page.locator('.group_scene_member').filter({ hasText: 'Scene Mira' })).toContainText('Narrator / GM');
    await page.locator('#group_scene_toggle').click();
    app.provider.mode.reply = narratorReply;
    await sendSceneMessage(page, 'What happens next?');
    await expect.poll(async () => (await readSceneChat(page)).at(-1)?.mes, { timeout: 30000 }).toBe('The doors shake.\nScene Kit: A shadow crosses the wall.');
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating), { timeout: 30000 }).toBe(false);
    expect(app.provider.calls).toHaveLength(2);
    expect(JSON.stringify(app.provider.calls[0].messages)).toContain('narrator');
    expect(JSON.stringify(app.provider.calls[1].messages)).toContain('Narrator / GM: describe the setting');
    const role = await page.evaluate(async id => (await import('/scripts/group-chats.js')).groups.find(group => group.id === id).member_roles, group.id);
    expect(role).toEqual({ [group.members[1]]: 'narrator' });
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openSceneGroup(page, group);
    await page.locator('.group_speaker_avatar').filter({ hasText: 'Scene Mira' }).click({ button: 'right' });
    await expect(page.getByRole('button', { name: 'Use as character', exact: true })).toBeVisible();
});

function narratorReply(body) {
    return String(body?.messages?.[0]?.content ?? '').includes('You direct a group roleplay scene')
        ? textReply('{"speakers":["Scene Mira"],"reason":"An event is needed"}')
        : textReply('The doors shake.\nScene Kit: A shadow crosses the wall.');
}

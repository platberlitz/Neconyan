import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createSceneGroup, groupAccount, openSceneGroup, readSceneChat, sendSceneMessage, textReply } from './group-chat-fixture.js';

test.setTimeout(240000);

const settled = page => expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
const lastMessage = page => async () => (await readSceneChat(page)).at(-1)?.mes;
const run = (page, command) => page.evaluate(async text => {
    const result = await (await import('/scripts/slash-commands.js')).executeSlashCommandsWithOptions(text);
    return result?.pipe ?? '';
}, command);
const startPoint = page => page.evaluate(async () => (await import('/script.js')).chat_metadata.group_scene?.heard_from ?? 0);
const promptText = app => app.provider.calls.at(-1).messages.map(message => String(message.content)).join('\n');

async function say(page, app, text, reply) {
    app.provider.mode.reply = () => textReply(reply);
    await sendSceneMessage(page, text);
    await expect.poll(lastMessage(page), { timeout: 30000 }).toBe(reply);
    await settled(page);
}

test('a group chat remembers only from its memory starting point, set in the Scene panel or by command', async ({ app }) => {
    const account = await groupAccount(app);
    const group = await createSceneGroup(account);
    const page = await account.open({ workspace: false });
    await openSceneGroup(page, group);

    await say(page, app, 'The code is marigold.', 'Kit hums.');
    await say(page, app, 'The vault is behind the painting.', 'Kit nods.');
    const messages = await readSceneChat(page);
    const vault = messages.findIndex(message => message.mes === 'The vault is behind the painting.');
    expect(await run(page, '/heard-from')).toBe('0');

    // The Scene panel field sets the starting point.
    await page.locator('#group_scene_open').click();
    await expect(page.locator('#group_scene_start')).toBeVisible();
    await page.locator('#group_scene_start').fill(String(vault));
    await page.locator('#group_scene_start').dispatchEvent('change');
    await expect.poll(() => startPoint(page)).toBe(vault);
    expect(await run(page, '/heard-from')).toBe(String(vault));

    await say(page, app, 'Who remembers the code?', 'Kit shrugs.');
    const prompt = promptText(app);
    expect(prompt).toContain('The vault is behind the painting.');
    expect(prompt).not.toContain('The code is marigold.');
    expect(prompt).not.toContain('Kit hums.');
    // Lines before the start stay heard, so no badge appears on them.
    await expect(page.locator('#chat .mes .group-heard-badge')).toHaveCount(0);

    // The command and SillyTavern Presence's name move it, and 0 keeps the whole chat again.
    expect(await run(page, '/heard-from 0')).toBe('0');
    await expect.poll(() => startPoint(page)).toBe(0);
    await expect(page.locator('#group_scene_start')).toHaveValue('');
    expect(await run(page, `/presenceMinChatMessage ${vault}`)).toBe(String(vault));
    await expect(page.locator('#group_scene_start')).toHaveValue(String(vault));
    expect(await run(page, '/heard-from 0')).toBe('0');

    await say(page, app, 'And now?', 'Kit remembers marigold.');
    expect(promptText(app)).toContain('The code is marigold.');
});

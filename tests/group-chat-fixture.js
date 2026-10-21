import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';

export const textReply = content => ({ choices: [{ message: { role: 'assistant', content } }] });

export const groupAccount = (app, streaming = false) => app.account({ activeConnection: true, configureSettings(saved) {
    saved.power_user.auto_swipe = false;
    saved.power_user.auto_continue = { enabled: false };
    saved.oai_settings.stream_openai = streaming;
} });

export async function createSceneGroup(account, settings = {}) {
    const members = [];
    for (const [name, description] of [['Scene Kit', 'A cheerful mechanic.'], ['Scene Mira', 'A quiet archivist.']]) {
        const response = await account.context.request.post('/api/characters/create', { headers: account.headers,
            data: { ch_name: name, description, first_mes: `Hello from ${name}.` } });
        expect(response.ok()).toBe(true);
        members.push(await response.text());
    }
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Scene probe', allow_create: true } });
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    return account.post('/api/groups/create', { name: 'Scene group', members, activation_strategy: 1,
        ...settings, roleplay: { account: stamp, operationKey: randomUUID() } });
}

export async function openSceneGroup(page, group) {
    await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
    await acknowledgeActiveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true })), { timeout: 15000 }).toBe(true);
}

export const readSceneChat = page => page.evaluate(async () => (await import('/script.js')).chat);

export async function sendSceneMessage(page, text) {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
}

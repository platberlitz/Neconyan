/* global document, window, MutationObserver */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test, MODEL } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const DIRECTOR_MARK = 'You direct a group roleplay scene';
const isDirectorCall = body => String(body?.messages?.[0]?.content ?? '').includes(DIRECTOR_MARK);
const directorReply = { choices: [{ message: { role: 'assistant', content: '{"speakers": ["Durable Mira"], "reason": "Mira knows the archive"}' } }] };
const speakerReply = { choices: [{ message: { role: 'assistant', content: 'The records are in the east wing.' } }] };

const createDirectorAccount = app => app.account({ activeConnection: true, configureSettings(saved) {
    saved.power_user.auto_swipe = false;
    saved.power_user.auto_continue = { enabled: false };
} });

const createCharacter = async (account, name, description) => {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: name, description, first_mes: `Hello from ${name}.` } });
    expect(created.ok()).toBe(true);
    return created.text();
};

const createDirectedGroup = async (account, extra = {}) => {
    const kit = await createCharacter(account, 'Durable Kit', 'Kit is a cheerful mechanic.');
    const mira = await createCharacter(account, 'Durable Mira', 'Mira is a quiet archivist.');
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Director probe', allow_create: true } });
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    return account.post('/api/groups/create', { name: 'Directed scene', members: [account.avatar, kit, mira],
        activation_strategy: 4, ...extra, roleplay: { account: stamp, operationKey: randomUUID() } });
};

const openGroup = async (page, group) => {
    await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
    await acknowledgeActiveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true })), { timeout: 15000 }).toBe(true);
    await page.evaluate(() => {
        window.__indicator = [];
        const node = document.getElementById('group_typing_indicator');
        new MutationObserver(() => {
            const text = node.textContent.trim();
            if (text && window.__indicator.at(-1) !== text) window.__indicator.push(text);
        }).observe(node, { childList: true, characterData: true, subtree: true });
    });
};

const send = async (page, text) => {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
};

const lastReply = page => page.evaluate(async () => {
    const message = (await import('/script.js')).chat.at(-1);
    return message && !message.is_user ? { name: message.name, mes: message.mes } : null;
});

test('the scene director picks who answers and shows why', async ({ app }) => {
    app.provider.mode.reply = body => [speakerReply, directorReply][Number(isDirectorCall(body))];
    const account = await createDirectorAccount(app);
    const group = await createDirectedGroup(account, { activation_strategy: undefined });
    expect(group.activation_strategy).toBe(4);
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    const before = app.provider.calls.length;

    await send(page, 'Where do we keep the old records?');
    await expect.poll(() => lastReply(page), { timeout: 30000 }).toEqual({ name: 'Durable Mira', mes: 'The records are in the east wing.' });

    const calls = app.provider.calls.slice(before);
    expect(calls).toHaveLength(2);
    expect(isDirectorCall(calls[0])).toBe(true);
    expect(calls[0].model).toBe(MODEL);
    expect(calls[0].messages[1].content).toContain('- Durable Mira (character): Mira is a quiet archivist.');
    expect(calls[0].messages[1].content).toContain('Where do we keep the old records?');
    expect(isDirectorCall(calls[1])).toBe(false);
    const indicator = await page.evaluate(() => window.__indicator);
    expect(indicator).toContain('Choosing who speaks next...');
    expect(indicator).toContain('Durable Mira is typing... · Mira knows the archive');
    await expect(page.locator('#group_typing_indicator')).toBeHidden();
    await expect(page.locator('#group_scene_director_status')).toHaveText('Last turn: the Scene Director picked Durable Mira · Mira knows the archive');
});

test('a stuck director model falls back to the usual order within seconds', async ({ app }) => {
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Fallback reply.' } }] };
    const account = await createDirectorAccount(app);
    const group = await createDirectedGroup(account, { director_profile: 'durable' });
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    app.provider.mode.hold = 'unused-named-model';
    const before = app.provider.calls.length;
    await page.evaluate(() => {
        window.__toasts = [];
        new MutationObserver(records => {
            for (const node of records.flatMap(record => [...record.addedNodes])) {
                if (node instanceof window.Element && node.matches('.toast')) window.__toasts.push(node.textContent);
            }
        }).observe(document.body, { childList: true, subtree: true });
    });

    const started = Date.now();
    await send(page, 'Anyone around?');
    await expect.poll(() => lastReply(page), { timeout: 30000 }).toMatchObject({ mes: 'Fallback reply.' });
    const elapsed = Date.now() - started;
    await fetch(app.provider.url.replace(/\/v1$/, '/fixture/release'), { method: 'POST', body: '{}' });

    const calls = app.provider.calls.slice(before);
    expect(calls.map(call => call.model)).toEqual(['unused-named-model', MODEL]);
    expect(isDirectorCall(calls[0])).toBe(true);
    expect(elapsed).toBeLessThan(10000);
    const names = ['Durable Nova', 'Durable Kit', 'Durable Mira'];
    expect(names).toContain((await lastReply(page))?.name);
    await expect(page.locator('#group_scene_director_status')).toContainText('the Scene Director took longer than 3 seconds, so the usual order picked the speaker');
    const toasts = await page.evaluate(() => window.__toasts);
    expect(toasts.filter(text => text.includes('The Scene Director took longer than 3 seconds'))).toHaveLength(1);
});

test('the director can hand the scene back to the user without forcing another reply', async ({ app }) => {
    app.provider.mode.reply = { choices: [{ message: { content: '{"speakers":[],"reason":"Your choice comes next"}' } }] };
    const account = await createDirectorAccount(app);
    const group = await createDirectedGroup(account);
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    await send(page, 'Let me decide what to do next.');
    await expect(page.locator('#group_next_up')).toContainText('Waiting for you', { timeout: 30000 });
    expect(app.provider.calls).toHaveLength(1);
    expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1))).toMatchObject({ is_user: true, mes: 'Let me decide what to do next.' });
    await expect(page.locator('#group_typing_indicator')).toBeHidden();
    await expect(page.locator('#group_scene_director_status')).toContainText('the Scene Director handed the scene back to you');
});

import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test, MODEL } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const DIRECTOR_MARK = 'You direct a group roleplay scene';
const isDirectorCall = body => String(body?.messages?.[0]?.content ?? '').includes(DIRECTOR_MARK);
const textReply = content => ({ choices: [{ message: { role: 'assistant', content } }] });

const directorReplies = answers => {
    let lines = 0;
    return body => isDirectorCall(body)
        ? textReply(answers.shift() ?? '{"speakers": []}')
        : textReply(`Line ${++lines}.`);
};

const createTalkAccount = app => app.account({ activeConnection: true, configureSettings(saved) {
    saved.power_user.auto_swipe = false;
    saved.power_user.auto_continue = { enabled: false };
} });

const createCharacter = async (account, name, description) => {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: name, description, first_mes: `Hello from ${name}.` } });
    expect(created.ok()).toBe(true);
    return created.text();
};

const createTalkGroup = async (account, extra) => {
    const kit = await createCharacter(account, 'Durable Kit', 'Kit is a cheerful mechanic.');
    const mira = await createCharacter(account, 'Durable Mira', 'Mira is a quiet archivist.');
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Talk probe', allow_create: true } });
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    return account.post('/api/groups/create', { name: 'Talking scene', members: [account.avatar, kit, mira],
        ...extra, roleplay: { account: stamp, operationKey: randomUUID() } });
};

const openGroup = async (page, group) => {
    await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
    await acknowledgeActiveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true })), { timeout: 15000 }).toBe(true);
};

const chatState = page => page.evaluate(async () => (await import('/script.js')).chat
    .map(message => ({ name: message.name, user: Boolean(message.is_user), system: Boolean(message.is_system), mes: message.mes })));

const talkButton = page => page.locator('#group_let_them_talk');

test('let them talk writes the set number of replies in turn and leaves the draft alone', async ({ app }) => {
    let count = 0;
    app.provider.mode.reply = () => textReply(`Line ${++count}.`);
    const account = await createTalkAccount(app);
    const group = await createTalkGroup(account, { activation_strategy: 1, talk_burst: 4 });
    expect(group.talk_burst).toBe(4);
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    const before = (await chatState(page)).length;
    await page.locator('#send_textarea').fill('a draft I am still writing');

    await talkButton(page).click();
    await expect(talkButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await chatState(page)).length, { timeout: 60000 }).toBe(before + 4);
    await expect(talkButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(talkButton(page)).toContainText('Let them talk');

    const added = (await chatState(page)).slice(before);
    expect(added.map(message => message.mes)).toEqual(['Line 1.', 'Line 2.', 'Line 3.', 'Line 4.']);
    expect(added.every(message => !message.user && !message.system)).toBe(true);
    for (let index = 1; index < added.length; index++) {
        expect(added[index].name).not.toBe(added[index - 1].name);
    }
    await expect(page.locator('#send_textarea')).toHaveValue('a draft I am still writing');
    await page.waitForTimeout(1500);
    expect(count).toBe(4);
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await openGroup(page, group);
    expect((await chatState(page)).slice(-4).map(message => message.mes)).toEqual(['Line 1.', 'Line 2.', 'Line 3.', 'Line 4.']);
});

test('stop ends the conversation at once and keeps the replies already written', async ({ app }) => {
    let count = 0;
    app.provider.mode.reply = () => {
        app.provider.mode.hold = MODEL;
        return textReply(`Line ${++count}.`);
    };
    const account = await createTalkAccount(app);
    const group = await createTalkGroup(account, { activation_strategy: 1, talk_burst: 8 });
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    const before = (await chatState(page)).length;

    await talkButton(page).click();
    await expect.poll(async () => (await chatState(page)).length, { timeout: 60000 }).toBeGreaterThanOrEqual(before + 1);
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await expect(talkButton(page)).toContainText('Stop');

    await talkButton(page).click();
    await expect(talkButton(page)).toHaveAttribute('aria-pressed', 'false', { timeout: 5000 });
    app.provider.mode.hold = '';
    await fetch(app.provider.url.replace(/\/v1$/, '/fixture/release'), { method: 'POST', body: '{}' });
    const callsAfterStop = app.provider.calls.length;
    await page.waitForTimeout(2000);

    expect(app.provider.calls.length).toBe(callsAfterStop);
    const added = (await chatState(page)).slice(before).filter(message => !message.system);
    expect(added.map(message => message.mes)).toEqual(['Line 1.']);
});

test('with the scene director the burst shares out the replies and tells the director the user is listening', async ({ app }) => {
    const directorAnswers = [
        '{"speakers": ["Durable Mira", "Durable Kit"], "reason": "Mira asks Kit"}',
        '{"speakers": ["Durable Mira", "Durable Kit"], "reason": "Mira follows up"}',
    ];
    app.provider.mode.reply = directorReplies(directorAnswers);
    const account = await createTalkAccount(app);
    const group = await createTalkGroup(account, { activation_strategy: 4, talk_burst: 3 });
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    const before = (await chatState(page)).length;
    const callsBefore = app.provider.calls.length;

    await talkButton(page).click();
    await expect.poll(async () => (await chatState(page)).length, { timeout: 60000 }).toBe(before + 3);
    await expect(talkButton(page)).toHaveAttribute('aria-pressed', 'false');

    const added = (await chatState(page)).slice(before);
    expect(added.map(message => message.name)).toEqual(['Durable Mira', 'Durable Kit', 'Durable Mira']);
    const directorCalls = app.provider.calls.slice(callsBefore).filter(isDirectorCall);
    expect(directorCalls).toHaveLength(2);
    expect(directorCalls.every(call => call.messages[0].content.includes('only listening'))).toBe(true);
    expect(directorCalls[1].messages[0].content).toContain('Choose 0 to 1 members');
});

test('a user message cancels a held burst before another character is requested', async ({ app }) => {
    const account = await createTalkAccount(app);
    const group = await createTalkGroup(account, { activation_strategy: 1, talk_burst: 8 });
    const page = await account.open({ workspace: false });
    await openGroup(page, group);
    app.provider.mode.reply = () => textReply('This cancelled reply must not be added.');
    app.provider.mode.hold = MODEL;
    await talkButton(page).click();
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);

    await page.evaluate(async () => { await (await import('/script.js')).sendMessageAsUser('My turn.'); });
    await expect(talkButton(page)).toHaveAttribute('aria-pressed', 'false', { timeout: 5000 });
    await fetch(app.provider.url.replace(/\/v1$/, '/fixture/release'), { method: 'POST', body: '{}' });
    await expect.poll(() => app.provider.calls.every(call => call.completedAt !== null)).toBe(true);
    expect(app.provider.calls).toHaveLength(1);
    expect((await chatState(page)).at(-1)).toMatchObject({ user: true, mes: 'My turn.' });
});

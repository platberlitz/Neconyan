/* global window */
// A Roleplay chat save that cannot reach the server keeps resending the same save: a short restart or dropped
// connection costs nothing, a longer one shows one notice and unlocks once the server confirms that save, and a chat
// whose saved copy changed elsewhere in the meantime stays locked rather than being overwritten.
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const SAVE_ROUTE = /\/api\/chats\/(save|patch)$/;

function bodyOf(request) {
    const bytes = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8'));
}

async function openChat(account) {
    const page = await account.open({ workspace: false });
    const file = await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        return core.getCurrentChatId();
    }, account.avatar);
    expect(file).toBeTruthy();
    return { page, file };
}

// Every chat save the page sends, and a switch that makes the server unreachable for them.
async function watchSaves(page) {
    const state = { down: false, saves: [] };
    await page.route(SAVE_ROUTE, async route => {
        const request = route.request();
        const save = { key: bodyOf(request).roleplay?.operationKey, at: Date.now() };
        state.saves.push(save);
        if (state.down) {
            save.outcome = 'dropped';
            // Alternate a dropped connection with the answer a restarting server gives.
            if (state.saves.filter(entry => entry.outcome === 'dropped').length % 2) return route.abort('connectionreset');
            return route.fulfill({ status: 503, json: { error: 'roleplay_recovery_required', code: 'ELOCKED' } });
        }
        const response = await route.fetch();
        save.outcome = response.status();
        return route.fulfill({ response });
    });
    return state;
}

// The save-failure notices the page shows, and the failures it logs.
async function watchNotices(page) {
    const logged = [];
    page.on('console', message => {
        if (message.type() === 'error' && message.text().includes('The save could not be confirmed')) logged.push(message.text());
    });
    await page.evaluate(() => {
        window.saveNotices = [];
        const show = window.toastr.error;
        window.toastr.error = function (message, title, ...rest) {
            if (title === 'Chat could not be saved') window.saveNotices.push(String(message));
            return show.call(this, message, title, ...rest);
        };
    });
    return { logged, notices: () => page.evaluate(() => window.saveNotices) };
}

async function savedChat(account, file) {
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { avatar_url: account.avatar, file_name: file } });
    expect(response.ok(), await response.text()).toBe(true);
    return { records: await response.json(), evidence: JSON.parse(response.headers()['x-neconyan-roleplay']) };
}

const savedMessages = async (account, file) => (await savedChat(account, file)).records.slice(1).map(message => message.mes);

const locked = (page, account, file) => page.evaluate(async locator => (await import('/scripts/roleplay-save-chain.js')).getRoleplaySourceId(locator) === null,
    { group: false, avatar: account.avatar, chat: file });

const save = page => page.evaluate(async () => (await import('/script.js')).saveChatConditional());

async function reply(app, page, action, answer, text = '') {
    app.provider.mode.reply = { choices: [{ message: { content: answer } }] };
    if (text) await page.locator('#send_textarea').fill(text);
    // Started without waiting on it, so a long save retry cannot outlive the evaluate call.
    await page.evaluate(action => { void import('/script.js').then(core => core.Generate(action)); }, action);
    await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(answer, { timeout: 30000 });
}

// Edits the reply in memory and starts its save without waiting, as the message editor does.
async function editLastMessage(page, text) {
    await page.evaluate(async text => {
        const core = await import('/script.js');
        const last = core.chat.at(-1);
        last.mes = text;
        if (Array.isArray(last.swipes)) last.swipes[last.swipe_id ?? 0] = text;
        void core.saveChatConditional();
    }, text);
}

async function firstReply(app, account) {
    const { page, file } = await openChat(account);
    const notices = await watchNotices(page);
    const saves = await watchSaves(page);
    await reply(app, page, 'normal', 'First answer.', 'Hello, Nova.');
    await expect.poll(() => savedMessages(account, file), { timeout: 20000 }).toContain('First answer.');
    return { page, file, notices, saves };
}

test('a save cut off by a short outage after a regenerate lands with its own key and shows no notice', async ({ app }) => {
    const account = await app.account({ activeConnection: true });
    const { page, file, notices, saves } = await firstReply(app, account);
    saves.down = true;
    const restore = setTimeout(() => { saves.down = false; }, 3000);
    try {
        await reply(app, page, 'regenerate', 'Regenerated answer.');
        await expect.poll(() => savedMessages(account, file), { timeout: 30000 }).toContain('Regenerated answer.');
    } finally { clearTimeout(restore); }
    const dropped = saves.saves.filter(entry => entry.outcome === 'dropped');
    expect(dropped.length).toBeGreaterThan(1);
    expect(dropped.at(-1).at - dropped[0].at).toBeGreaterThan(750);
    for (const key of new Set(dropped.map(entry => entry.key))) {
        expect(saves.saves.some(entry => entry.key === key && entry.outcome === 200), key).toBe(true);
    }
    expect(await savedMessages(account, file)).not.toContain('First answer.');
    expect(await notices.notices()).toEqual([]);
    expect(await locked(page, account, file)).toBe(false);
    await reply(app, page, 'normal', 'Later answer.', 'And again.');
    await expect.poll(() => savedMessages(account, file), { timeout: 20000 }).toContain('Later answer.');
    expect(await notices.notices()).toEqual([]);
});

test('a save cut off past the retry window shows one notice, then unlocks once the server confirms that save', async ({ app }) => {
    const account = await app.account({ activeConnection: true });
    const { page, file, notices, saves } = await firstReply(app, account);
    saves.down = true;
    await editLastMessage(page, 'Local edit.');
    await expect.poll(() => notices.notices(), { timeout: 40000 }).toHaveLength(1);
    expect(await locked(page, account, file)).toBe(true);
    const blocker = saves.saves.find(entry => entry.outcome === 'dropped').key;
    for (let attempt = 0; attempt < 3; attempt++) expect(await save(page)).toBe(false);
    expect(await notices.notices()).toHaveLength(1);
    expect(notices.logged.length).toBeGreaterThanOrEqual(4);
    expect(await savedMessages(account, file)).toContain('First answer.');

    saves.down = false;
    expect(await save(page)).toBe(true);
    expect(saves.saves.some(entry => entry.key === blocker && entry.outcome === 200)).toBe(true);
    expect(await locked(page, account, file)).toBe(false);
    expect(await savedMessages(account, file)).toContain('Local edit.');
    await reply(app, page, 'regenerate', 'Regenerated answer.');
    await expect.poll(() => savedMessages(account, file), { timeout: 20000 }).toContain('Regenerated answer.');
    await reply(app, page, 'normal', 'Later answer.', 'And again.');
    await expect.poll(() => savedMessages(account, file), { timeout: 20000 }).toContain('Later answer.');
    expect(await notices.notices()).toHaveLength(1);
});

test('a chat whose saved copy changed during an outage stays locked with one notice and keeps that change', async ({ app }) => {
    const account = await app.account({ activeConnection: true });
    const { page, file, notices, saves } = await firstReply(app, account);
    saves.down = true;
    await editLastMessage(page, 'Local edit.');
    await expect.poll(() => notices.notices(), { timeout: 40000 }).toHaveLength(1);
    const blocker = saves.saves.find(entry => entry.outcome === 'dropped').key;

    const { records, evidence } = await savedChat(account, file);
    await account.post('/api/chats/save', { avatar_url: account.avatar, file_name: file,
        chat: [...records, { name: 'User', is_user: true, is_system: false, send_date: new Date().toISOString(), mes: 'Changed elsewhere.', extra: {} }],
        roleplay: { account: evidence.account, source: evidence.source, operationKey: randomUUID() } });
    saves.down = false;
    for (let attempt = 0; attempt < 2; attempt++) expect(await save(page)).toBe(false);
    expect(saves.saves.filter(entry => entry.key === blocker && entry.outcome === 400)).toHaveLength(2);
    expect(await locked(page, account, file)).toBe(true);
    expect(await notices.notices()).toHaveLength(1);

    // A regenerate on the locked chat is refused before it reaches the model, and adds no notice of its own.
    const calls = app.provider.calls.length;
    await page.evaluate(() => {
        window.regenerated = null;
        void import('/script.js').then(core => core.Generate('regenerate'))
            .then(() => { window.regenerated = 'finished'; }, () => { window.regenerated = 'refused'; });
    });
    await expect.poll(() => page.evaluate(() => window.regenerated), { timeout: 30000 }).not.toBeNull();
    expect(app.provider.calls.length).toBe(calls);
    expect(await locked(page, account, file)).toBe(true);
    expect(await notices.notices()).toHaveLength(1);
    expect(notices.logged.length).toBeGreaterThanOrEqual(3);
    const messages = await savedMessages(account, file);
    expect(messages).toContain('Changed elsewhere.');
    expect(messages).not.toContain('Local edit.');
});

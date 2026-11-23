/* global document, window */
// A chat that has grown large is saved by sending what changed: an appended message is a request of a few
// kilobytes to the patch route, an edit in the middle is the same, a save the server cannot patch is sent whole,
// and reloading shows exactly the chat that was saved each time.
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const MESSAGES = 70;
const PAD = 'The lantern flickered over wet cobblestones while she counted every quiet footstep behind them. '.repeat(90);

// A message as the page itself writes it, so loading changes nothing in it and every message is a saved line the page can keep.
const message = index => {
    const mes = `Seeded message ${index}. ${PAD}`;
    const sent = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    return { name: index % 2 ? 'Durable Nova' : 'User', is_user: index % 2 === 0, is_system: false, send_date: sent, mes, extra: {}, mewmory_id: crypto.randomUUID(),
        ...(index % 2 ? { swipe_id: 0, swipes: [mes], swipe_info: [{ send_date: sent, extra: {} }] } : {}), variables: [{ stat_data: { hp: [index, 'note'] } }] };
};

function bodyOf(request) {
    const bytes = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8'));
}

async function seed(account, name) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const source = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(source.ok(), await source.text()).toBe(true);
    const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { patch_e2e: true } },
        ...Array.from({ length: MESSAGES }, (_, index) => message(index))],
    roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
    return fields;
}

async function openChat(page, avatar, chat, expectedLength = MESSAGES) {
    const opened = await page.evaluate(async ({ avatar, chat }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        if (core.getCurrentChatId() !== chat) await core.openCharacterChat(chat);
        return { id: core.getCurrentChatId(), length: window.SillyTavern.getContext().chat.length };
    }, { avatar, chat });
    expect(opened).toEqual({ id: chat, length: expectedLength });
}

const savedChat = async (account, fields) => {
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: fields });
    expect(response.ok()).toBe(true);
    return (await response.json()).slice(1);
};

test('an appended message in a large chat is saved as a patch, an edit too, and reloading shows the same chat', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: false });
    const name = 'Patch save chat';
    const fields = await seed(account, name);
    const seeded = await savedChat(account, fields);
    expect(seeded).toHaveLength(MESSAGES);
    const page = await account.open({ workspace: false });
    const saves = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/chats\/(save|patch)$/.test(request.url())) saves.push(request); });
    await openChat(page, account.avatar, name);
    const wholeBytes = JSON.stringify(seeded).length;
    expect(wholeBytes).toBeGreaterThan(500000);

    // An appended message.
    const appended = { name: 'Durable Nova', is_user: false, is_system: false, send_date: new Date(Date.UTC(2026, 6, 1)).toISOString(), mes: 'An appended reply, saved as a patch.', extra: {}, swipe_id: 0,
        swipes: ['An appended reply, saved as a patch.'], swipe_info: [{ send_date: 'x', extra: {} }] };
    const appendDone = page.waitForResponse(response => response.url().endsWith('/api/chats/patch') && response.status() === 200);
    await page.evaluate(async message => {
        const context = window.SillyTavern.getContext();
        context.chat.push(message);
        await context.saveChat({ throwOnError: true });
    }, appended);
    const appendResponse = await appendDone;
    expect((await appendResponse.json()).roleplay).toMatchObject({ changed: true });
    expect(saves).toHaveLength(1);
    expect(new URL(saves[0].url()).pathname).toBe('/api/chats/patch');
    const appendRequest = bodyOf(saves[0]);
    expect(appendRequest.chat).toBeUndefined();
    expect(appendRequest.patch).toMatchObject({ prefix: MESSAGES, suffix: 0, baseCount: MESSAGES, count: MESSAGES + 1 });
    expect(appendRequest.patch.messages).toHaveLength(1);
    expect(saves[0].postDataBuffer().length).toBeLessThan(wholeBytes / 20);

    // An edit in the middle.
    const edited = 'An edit in the middle of the chat.';
    const editDone = page.waitForResponse(response => response.url().endsWith('/api/chats/patch') && response.status() === 200);
    await page.evaluate(async text => {
        const context = window.SillyTavern.getContext();
        context.chat[30].mes = text;
        await context.saveChat({ throwOnError: true });
    }, edited);
    await editDone;
    expect(saves).toHaveLength(2);
    expect(bodyOf(saves[1]).patch).toMatchObject({ prefix: 30, suffix: MESSAGES + 1 - 31, count: MESSAGES + 1 });
    expect(bodyOf(saves[1]).patch.messages).toHaveLength(1);
    expect(saves[1].postDataBuffer().length).toBeLessThan(wholeBytes / 20);

    // A save with nothing new in it is still a patch, with no messages.
    const unchangedDone = page.waitForResponse(response => response.url().endsWith('/api/chats/patch') && response.status() === 200);
    await page.evaluate(async () => { await window.SillyTavern.getContext().saveChat({ throwOnError: true }); });
    expect((await (await unchangedDone).json()).roleplay).toMatchObject({ changed: false });
    expect(bodyOf(saves[2]).patch.messages).toEqual([]);

    // The server holds what the page held, byte for byte as records.
    const expected = [...seeded, appended];
    expected[30] = { ...expected[30], mes: edited };
    const onServer = await savedChat(account, fields);
    expect(onServer).toHaveLength(MESSAGES + 1);
    expect(onServer[30].mes).toBe(edited);
    expect(onServer[MESSAGES]).toMatchObject({ mes: appended.mes });
    expect(onServer.map(record => record.mes)).toEqual(expected.map(record => record.mes));

    // A save the page cannot base on a known version is sent whole, and works.
    const wholeDone = page.waitForResponse(response => response.url().endsWith('/api/chats/save') && response.status() === 200);
    await page.evaluate(async () => {
        (await import('/scripts/chat-patch-save.js')).forgetChatPatchBases();
        const context = window.SillyTavern.getContext();
        context.chat[31].mes = 'Saved whole.';
        await context.saveChat({ throwOnError: true });
    });
    await wholeDone;
    expect(bodyOf(saves[3]).chat).toHaveLength(MESSAGES + 2);
    expect(saves[3].postDataBuffer().length).toBeGreaterThan(wholeBytes / 2);

    // And the next save builds on that one as a patch again.
    const againDone = page.waitForResponse(response => response.url().endsWith('/api/chats/patch') && response.status() === 200);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat[32].mes = 'Patched after a whole save.';
        await context.saveChat({ throwOnError: true });
    });
    await againDone;
    expect(bodyOf(saves[4]).patch).toMatchObject({ prefix: 32, suffix: MESSAGES + 1 - 33 });

    // Reloading shows exactly the chat that was saved.
    const before = await page.evaluate(() => JSON.stringify(window.SillyTavern.getContext().chat));
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 120000 });
    await openChat(page, account.avatar, name, MESSAGES + 1);
    const reloaded = await page.evaluate(() => JSON.stringify(window.SillyTavern.getContext().chat));
    expect(JSON.parse(reloaded)).toHaveLength(MESSAGES + 1);
    expect(JSON.parse(reloaded).map(record => record.mes)).toEqual(JSON.parse(before).map(record => record.mes));
    expect(JSON.parse(reloaded)[30].mes).toBe(edited);
    expect(JSON.parse(reloaded)[31].mes).toBe('Saved whole.');
    expect(JSON.parse(reloaded)[32].mes).toBe('Patched after a whole save.');
    expect(JSON.parse(reloaded)[MESSAGES]).toMatchObject({ mes: appended.mes });

    // A page that has just loaded a chat patches from what it loaded, and not only after it has saved.
    const afterLoad = page.waitForResponse(response => response.url().endsWith('/api/chats/patch') && response.status() === 200);
    saves.length = 0;
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat[40].mes = 'Edited right after loading.';
        await context.saveChat({ throwOnError: true });
    });
    await afterLoad;
    expect(saves).toHaveLength(1);
    expect(bodyOf(saves[0]).patch).toMatchObject({ prefix: 40, suffix: MESSAGES + 1 - 41 });
    expect(saves[0].postDataBuffer().length).toBeLessThan(wholeBytes / 20);
});

test('a server that has no patch route is sent the whole chat', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: false });
    const name = 'Older server chat';
    const fields = await seed(account, name);
    const page = await account.open({ workspace: false });
    const saves = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/chats\/(save|patch)$/.test(request.url())) saves.push(request); });
    // An older server answers an unknown route with an HTML page.
    await page.route('**/api/chats/patch', route => route.fulfill({ status: 404, contentType: 'text/html', body: '<html>Cannot POST /api/chats/patch</html>' }));
    await openChat(page, account.avatar, name);
    const wholeDone = page.waitForResponse(response => response.url().endsWith('/api/chats/save') && response.status() === 200);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat.push({ name: 'Durable Nova', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'Sent whole to an older server.', extra: {} });
        await context.saveChat({ throwOnError: true });
    });
    await wholeDone;
    expect(saves.map(request => new URL(request.url()).pathname)).toEqual(['/api/chats/patch', '/api/chats/save']);
    expect((await savedChat(account, fields)).at(-1).mes).toBe('Sent whole to an older server.');
    // It is not asked again until the page reloads.
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat.push({ name: 'User', is_user: true, is_system: false, send_date: new Date().toISOString(), mes: 'Second.', extra: {} });
        await context.saveChat({ throwOnError: true });
    });
    expect(saves.map(request => new URL(request.url()).pathname)).toEqual(['/api/chats/patch', '/api/chats/save', '/api/chats/save']);
});

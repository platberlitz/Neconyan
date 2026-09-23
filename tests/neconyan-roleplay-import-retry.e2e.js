/* global window, Storage, localStorage */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { readRoleplayAccount, roleplayStoreDirectory, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { acquireChatFileLock } = await import('../src/chat-file-lock.js');

const rows = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
    { name: 'User', is_user: true, mes: 'Import question.', extra: {} },
    { name: 'Durable Nova', is_user: false, mes: 'Import answer.', extra: {} }];
const bytes = Buffer.from(rows.map(JSON.stringify).join('\n'));
const upload = name => ({ name, mimeType: 'application/json', buffer: bytes });
const operationKey = request => request.postDataBuffer().toString().match(/"operationKey":"([^"]+)"/)?.[1];

async function select(page, avatar, groupId = null) {
    await page.evaluate(async ({ avatar, groupId }) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        if (groupId) await (await import('/scripts/group-chats.js')).openGroupById(groupId, { switchMenu: false });
        else await (await import('/script.js')).selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
    }, { avatar, groupId });
}

async function createGroup(account, name = 'Import group') {
    const initial = 'Import original';
    const group = await account.post('/api/groups/create', { name, members: [account.avatar], chat_id: initial, chats: [initial] });
    const read = await account.context.request.post('/api/chats/group/get', { headers: account.headers,
        data: { id: initial, allow_create: true } });
    const vacancy = JSON.parse(read.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/group/save', { id: initial, chat: rows,
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
    return group;
}

async function showBackup(page, name) {
    await page.locator('#option_select_chat').evaluate(element => element.click());
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
    await page.locator('[aria-controls="chat_backups_list"]').click();
    const row = page.locator('.chatBackupsListItem').filter({ hasText: name });
    await expect(row).toBeVisible();
    return row;
}

function ageDeadRoleplayLocks(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const filename = path.join(directory, entry.name);
        if (entry.name.endsWith('.lock')) {
            const stale = new Date(Date.now() - 600000);
            fs.utimesSync(filename, stale, stale);
        } else ageDeadRoleplayLocks(filename);
    }
}

test('separate files selected together each use the preceding acknowledged group link', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const group = await createGroup(account);
    const page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    const attempts = [];
    await page.route('**/api/chats/group/import', async item => {
        const response = await item.fetch();
        attempts.push({ key: operationKey(item.request()), status: response.status(), result: await response.json() });
        await item.fulfill({ response });
    });
    await page.locator('#chat_import_file').setInputFiles([upload('First selected.jsonl'), upload('Second selected.jsonl')]);
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(attempts.map(attempt => attempt.status)).toEqual([200, 200]);
    expect(attempts[1].key).not.toBe(attempts[0].key);
    const groupFile = path.join(app.directory, 'data', 'default-user', 'groups', group.id + '.json');
    expect(JSON.parse(fs.readFileSync(groupFile, 'utf8')).chats.slice(-2)).toEqual(attempts.flatMap(attempt => attempt.result.fileNames));
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('chooser and Backup Restore replay their saved key after an uncertain response and page reopening', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    let page = await account.open({ workspace: false });
    await select(page, account.avatar);
    const route = '**/api/chats/import';
    const first = [];
    await page.route(route, async item => {
        const response = await item.fetch();
        first.push({ key: operationKey(item.request()), result: await response.json() });
        await item.abort('failed');
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Uncertain chooser.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(first).toHaveLength(2);
    expect(first[1]).toEqual(first[0]);
    await page.close();

    page = await account.open({ workspace: false });
    await select(page, account.avatar);
    const chooserRetry = [];
    await page.route(route, async item => {
        const response = await item.fetch();
        chooserRetry.push({ key: operationKey(item.request()), result: await response.json() });
        await item.fulfill({ response });
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Uncertain chooser.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(chooserRetry).toEqual([first[0]]);
    await page.unroute(route);

    const backupName = 'chat_uncertain_restore.jsonl';
    fs.writeFileSync(path.join(app.directory, 'data', 'default-user', 'backups', backupName), bytes);
    const restoreFirst = [];
    await page.route(route, async item => {
        const response = await item.fetch();
        restoreFirst.push({ key: operationKey(item.request()), result: await response.json() });
        await item.abort('failed');
    });
    await (await showBackup(page, backupName)).locator('.fa-rotate-left').click();
    await expect.poll(() => restoreFirst.length).toBe(2);
    await expect(page.locator('#toast-container')).toContainText('Failed to fetch');
    expect(restoreFirst[1]).toEqual(restoreFirst[0]);
    await page.close();

    page = await account.open({ workspace: false });
    await select(page, account.avatar);
    const restoreRetry = [];
    await page.route(route, async item => {
        const response = await item.fetch();
        restoreRetry.push({ key: operationKey(item.request()), result: await response.json() });
        await item.fulfill({ response });
    });
    await (await showBackup(page, backupName)).locator('.fa-rotate-left').click();
    await expect.poll(() => restoreRetry.length).toBe(1);
    expect(restoreRetry).toEqual([restoreFirst[0]]);
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('a reopened group upload reuses its captured pre-link source and does not link twice', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const group = await createGroup(account, 'Uncertain group import');
    let page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    const route = '**/api/chats/group/import';
    const first = [];
    await page.route(route, async item => {
        const response = await item.fetch();
        first.push({ key: operationKey(item.request()), result: await response.json() });
        await item.abort('failed');
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Uncertain group story.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(first).toHaveLength(2);
    expect(first[1]).toEqual(first[0]);
    await page.close();
    page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    const replay = [];
    await page.route(route, async item => {
        const response = await item.fetch();
        replay.push({ key: operationKey(item.request()), result: await response.json() });
        await item.fulfill({ response });
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Uncertain group story.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(replay).toEqual([first[0]]);
    const filename = path.join(app.directory, 'data', 'default-user', 'groups', group.id + '.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    expect(saved.chats.filter(name => name === first[0].result.fileNames[0])).toHaveLength(1);
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('an upload refuses before transfer when durable retry storage is unavailable', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    await account.context.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (String(key).startsWith('neconyan.pending.chat-import.v1.')) throw new Error('Storage unavailable');
            return original.call(this, key, value);
        };
    });
    const page = await account.open({ workspace: false });
    await select(page, account.avatar);
    let uploads = 0;
    await page.route('**/api/chats/import', async item => { uploads++; await item.continue(); });
    await page.locator('#chat_import_file').setInputFiles(upload('Cannot retain identity.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(uploads).toBe(0);
    await expect(page.locator('#toast-container')).toContainText('retry identity');
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('a proven unaccepted group refusal releases its old key for a fresh source', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const group = await createGroup(account, 'Refused group import');
    let page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    const listed = (await account.post('/api/groups/all')).find(item => item.id === group.id);
    const evidence = listed.__roleplay;
    delete listed.__roleplay;
    let edited = false;
    const attempts = [];
    const route = '**/api/chats/group/import';
    const record = async item => {
        if (!edited) {
            await account.post('/api/groups/edit', { ...listed, name: 'Independent edit',
                roleplay: { account: evidence.account, source: evidence.source, operationKey: crypto.randomUUID() } });
            edited = true;
        }
        const response = await item.fetch();
        attempts.push({ key: operationKey(item.request()), status: response.status(),
            unaccepted: response.headers()['x-neconyan-import-unaccepted'] });
        await item.fulfill({ response });
    };
    await page.route(route, record);
    await page.locator('#chat_import_file').setInputFiles(upload('Refused stale story.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(409);
    expect(attempts[0].unaccepted).toBe('1');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('neconyan.pending.chat-import.v1.')))).toHaveLength(0);
    await page.close();
    page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    await page.route(route, record);
    await page.locator('#chat_import_file').setInputFiles(upload('Refused stale story.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(attempts.map(item => item.status)).toEqual([409, 200]);
    expect(attempts[1].key).not.toBe(attempts[0].key);
    const filename = path.join(app.directory, 'data', 'default-user', 'groups', group.id + '.json');
    expect(JSON.parse(fs.readFileSync(filename, 'utf8')).chats).toHaveLength(2);
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('a delayed older acknowledgement cannot clear a newer retry entry for the same file', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await select(page, account.avatar);
    let releaseHeld;
    let signalReached;
    const held = new Promise(resolve => { releaseHeld = resolve; });
    const reached = new Promise(resolve => { signalReached = resolve; });
    await page.route('**/api/chats/import', async item => {
        const response = await item.fetch();
        signalReached();
        await held;
        await item.fulfill({ response });
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Interleaved retry.jsonl'));
    await reached;
    const newer = await page.evaluate(() => {
        const key = Object.keys(localStorage).find(item => item.startsWith('neconyan.pending.chat-import.v1.'));
        const old = JSON.parse(localStorage.getItem(key));
        const next = { ...old, operationKey: window.crypto.randomUUID() };
        localStorage.setItem(key, JSON.stringify(next));
        return { key, next };
    });
    releaseHeld();
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), newer.key)).toEqual(newer.next);
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('initial and replayed post-pending failures retain the same durable import identity', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const group = await createGroup(account, 'Pending retry group');
    const page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    const root = path.join(app.directory, 'data', 'default-user');
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'),
        characters: path.join(root, 'characters'), groups: path.join(root, 'groups'), backups: path.join(root, 'backups') };
    const base = { owner: 'default-user', directories };
    const scope = withRoleplayAccount(base, null, (_lease, stamp) => ({ ...base, ...stamp }));
    const stateFile = path.join(roleplayStoreDirectory(scope), 'state.json');
    const groupFile = path.join(directories.groups, group.id + '.json');
    const attempts = [];
    await page.route('**/api/chats/group/import', async item => {
        const response = await item.fetch();
        attempts.push({ key: operationKey(item.request()), status: response.status(),
            unaccepted: response.headers()['x-neconyan-import-unaccepted'] });
        await item.fulfill({ response });
    });
    let release = acquireChatFileLock(groupFile);
    try {
        await page.locator('#chat_import_file').setInputFiles(upload('Pending retry.jsonl'));
        await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).state.pending?.phase, { timeout: 4000 }).toBe('linking');
        await expect(page.locator('#chat_import_file')).toHaveValue('', { timeout: 15000 });
        expect(attempts).toHaveLength(1);
        expect(attempts[0].status).toBe(503);
        expect(attempts[0].unaccepted).toBeUndefined();
        const pending = JSON.parse(fs.readFileSync(stateFile, 'utf8')).state.pending;
        const outputFile = path.join(directories.groupChats, pending.outputs[0].locator.chat + '.jsonl');
        expect(fs.existsSync(outputFile)).toBe(true);
        release();
        release = null;
        fs.appendFileSync(outputFile, '\n{"foreign":"third state"}');
        const before = await page.evaluate(() => {
            const key = Object.keys(localStorage).find(item => item.startsWith('neconyan.pending.chat-import.v1.'));
            return { key, value: localStorage.getItem(key) };
        });
        await page.locator('#chat_import_file').setInputFiles(upload('Pending retry.jsonl'));
        await expect(page.locator('#chat_import_file')).toHaveValue('');
        expect(attempts).toHaveLength(2);
        expect(attempts[1].status).toBe(409);
        expect(attempts[1].key).toBe(attempts[0].key);
        expect(attempts[1].unaccepted).toBeUndefined();
        expect(await page.evaluate(key => localStorage.getItem(key), before.key)).toBe(before.value);
        expect(readRoleplayAccount(scope).pending?.kind).toBe('chat-import');
        expect(app.provider.calls).toHaveLength(0);
        await page.close();
        expect(account.context.pages()).toHaveLength(0);
    } finally {
        if (release) release();
    }
});

test('a late history response cannot replace another character’s chat list', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Other history target', description: 'Independent history.', first_mes: 'Hello.' } });
    expect(created.ok()).toBe(true);
    const otherAvatar = await created.text();
    const page = await account.open({ workspace: false });
    await select(page, account.avatar);
    let releaseHeld;
    let signalReached;
    const held = new Promise(resolve => { releaseHeld = resolve; });
    const reached = new Promise(resolve => { signalReached = resolve; });
    await page.route('**/api/chats/search', async item => {
        if (item.request().postDataJSON().avatar_url !== account.avatar) return item.continue();
        const response = await item.fetch();
        signalReached();
        await held;
        await item.fulfill({ response });
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Late history.jsonl'));
    await reached;
    await select(page, otherAvatar);
    await page.locator('#option_select_chat').evaluate(element => element.click());
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
    const owner = JSON.stringify(['character', otherAvatar]);
    releaseHeld();
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(await page.locator('#select_chat_div .select_chat_block_wrapper').evaluateAll(elements =>
        elements.map(element => element.dataset.neconyanChatOwner))).toEqual(expect.arrayContaining([owner]));
    expect(await page.locator('#select_chat_div .select_chat_block_wrapper').evaluateAll((elements, expected) =>
        elements.every(element => element.dataset.neconyanChatOwner === expected), owner)).toBe(true);
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('history search follows the captured avatar after its library index changes', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await select(page, account.avatar);
    await page.locator('#chat_import_file').setInputFiles(upload('Indexed history.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    await page.locator('#option_select_chat').evaluate(element => element.click());
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
    const before = await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        return { index: context.characterId, avatar: context.characters[context.characterId].avatar };
    });
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'AAA shifted index', description: 'Reorders the library.', first_mes: 'Hello.' } });
    expect(created.ok()).toBe(true);
    await page.evaluate(() => window.SillyTavern.getContext().getCharacters());
    const after = await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        return { index: context.characterId, avatar: context.characters[context.characterId].avatar };
    });
    expect(after.avatar).toBe(before.avatar);
    expect(after.index).not.toBe(before.index);
    const queries = [];
    await page.route('**/api/chats/search', async item => {
        queries.push(item.request().postDataJSON());
        await item.continue();
    });
    await page.locator('#select_chat_search').fill('imported');
    await expect.poll(() => queries.length).toBe(1);
    expect(queries[0].avatar_url).toBe(account.avatar);
    const owner = JSON.stringify(['character', account.avatar]);
    await expect(page.locator('#select_chat_div .select_chat_block_wrapper')).not.toHaveCount(0);
    expect(await page.locator('#select_chat_div .select_chat_block_wrapper').evaluateAll((elements, expected) =>
        elements.every(item => item.dataset.neconyanChatOwner === expected), owner)).toBe(true);
    expect(app.provider.calls).toHaveLength(0);
    await page.close();
    expect(account.context.pages()).toHaveLength(0);
});

test('an accepted import finishes after every page closes and a real serving-process death', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const group = await createGroup(account, 'Interrupted import group');
    const page = await account.open({ workspace: false });
    await select(page, account.avatar, group.id);
    const root = path.join(app.directory, 'data', 'default-user');
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'),
        characters: path.join(root, 'characters'), groups: path.join(root, 'groups'), backups: path.join(root, 'backups') };
    const base = { owner: 'default-user', directories };
    const scope = withRoleplayAccount(base, null, (_lease, stamp) => ({ ...base, ...stamp }));
    const stateFile = path.join(roleplayStoreDirectory(scope), 'state.json');
    const groupFile = path.join(directories.groups, group.id + '.json');
    let release = acquireChatFileLock(groupFile);
    try {
        await page.locator('#chat_import_file').setInputFiles(upload('Interrupted accepted import.jsonl'));
        await expect.poll(() => {
            const pending = JSON.parse(fs.readFileSync(stateFile, 'utf8')).state.pending;
            return pending?.kind === 'chat-import' && pending.phase === 'linking' ? pending.outputs[0].locator.chat : null;
        }, { timeout: 4000 }).not.toBeNull();
        const pending = JSON.parse(fs.readFileSync(stateFile, 'utf8')).state.pending;
        expect(pending.kind).toBe('chat-import');
        expect(pending.phase).toBe('linking');
        const name = pending.outputs[0].locator.chat;
        expect(fs.existsSync(path.join(directories.groupChats, name + '.jsonl'))).toBe(true);
        await page.close();
        expect(account.context.pages()).toHaveLength(0);
        await app.stop('SIGKILL');
        expect(app.processes.at(-1).signal).toBe('SIGKILL');
        expect(readRoleplayAccount(scope).pending?.kind).toBe('chat-import');
        release();
        release = null;
        ageDeadRoleplayLocks(path.join(app.directory, 'data', '_roleplay'));
        await app.start();
        expect(readRoleplayAccount(scope).pending).toBeNull();
        expect(JSON.parse(fs.readFileSync(groupFile, 'utf8')).chats).toContain(name);
        const reopened = await account.open({ workspace: false });
        await select(reopened, account.avatar, group.id);
        await reopened.evaluate(async ({ id, chat }) => (await import('/scripts/group-chats.js')).openGroupChat(id, chat),
            { id: group.id, chat: name });
        await expect(reopened.locator('#chat .mes_text').last()).toHaveText('Import answer.');
        expect(app.provider.calls).toHaveLength(0);
        await reopened.close();
        expect(account.context.pages()).toHaveLength(0);
    } finally {
        if (release) release();
    }
});

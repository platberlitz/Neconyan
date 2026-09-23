/* global document, window, getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { createCharacterChatTarget, createGroupChatTarget, readChatJsonlStrict } = await import('../src/chat-recovery.js');
const { captureRoleplayStorageSource } = await import('../src/generation/roleplay-source.js');
const { commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
const { readRoleplayAccount, withRoleplayAccount } = await import('../src/roleplay-store.js');

function saveBody(request) {
    const bytes = request.postDataBuffer();
    return (request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8');
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

for (const phone of [false, true]) {
    for (const group of [false, true]) {
        test(`${phone ? 'phone' : 'desktop'} ${group ? 'group' : 'solo'} chooser and backup Restore publish protected imported chats`, async ({ app }) => {
            test.setTimeout(180000);
            const account = await app.account({ phone });
            const initial = 'Import starting chat';
            const groupData = group ? await account.post('/api/groups/create', { name: 'Imported group', members: [account.avatar],
                chat_id: initial, chats: [initial] }) : null;
            const otherInitial = 'Other starting chat';
            const otherGroup = group ? await account.post('/api/groups/create', { name: 'Other group', members: [account.avatar],
                chat_id: otherInitial, chats: [otherInitial] }) : null;
            const otherAvatar = !group ? await (async () => {
                const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
                    data: { ch_name: 'Other character', description: 'Another import target.', first_mes: 'Hello.' } });
                expect(created.ok()).toBe(true);
                return created.text();
            })() : null;
            if (group) {
                const read = await account.context.request.post('/api/chats/group/get', { headers: account.headers,
                    data: { id: initial, allow_create: true } });
                const vacancy = JSON.parse(read.headers()['x-neconyan-roleplay']);
                await account.post('/api/chats/group/save', { id: initial,
                    chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
                        { name: 'Durable Nova', is_user: false, mes: 'Starting chat.', extra: {} }],
                    roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
                const otherRead = await account.context.request.post('/api/chats/group/get', { headers: account.headers,
                    data: { id: otherInitial, allow_create: true } });
                const otherVacancy = JSON.parse(otherRead.headers()['x-neconyan-roleplay']);
                await account.post('/api/chats/group/save', { id: otherInitial,
                    chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
                        { name: 'Durable Nova', is_user: false, mes: 'Other group chat.', extra: {} }],
                    roleplay: { account: otherVacancy.account, vacancy: otherVacancy.vacancy, operationKey: crypto.randomUUID() } });
            }
            const page = await account.open({ workspace: false });
            await page.evaluate(async ({ avatar, groupId }) => {
                const context = window.SillyTavern.getContext();
                await context.getCharacters();
                if (groupId) await (await import('/scripts/group-chats.js')).openGroupById(groupId, { switchMenu: false });
                else await (await import('/script.js')).selectCharacterById(context.characters.findIndex(char => char.avatar === avatar), { switchMenu: false });
            }, { avatar: account.avatar, groupId: groupData?.id });
            const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { imported_meta: true } },
                { name: 'User', is_user: true, mes: 'Imported question.', extra: { file: 'note.txt' } },
                { name: 'Durable Nova', is_user: false, mes: 'Imported answer.', swipes: ['Imported answer.', 'Another answer.'],
                    swipe_id: 0, extra: { reasoning: 'Saved reasoning.' } }];
            const contents = Buffer.from(records.map(JSON.stringify).join('\n'));
            const route = group ? '/api/chats/group/import' : '/api/chats/import';
            const attempts = [];
            await page.route('**' + route, async intercepted => {
                const body = intercepted.request().postDataBuffer();
                const response = await intercepted.fetch();
                attempts.push({ key: body.toString().match(/"operationKey":"([^"]+)"/)?.[1],
                    hasContents: body.includes(Buffer.from('Imported answer.')), result: await response.json() });
                if (attempts.length === 1) await intercepted.abort('failed');
                else await intercepted.fulfill({ response });
            });
            const chooserResponse = page.waitForResponse(response => response.url().endsWith(route) && response.status() === 200);
            await page.locator('#chat_import_file').setInputFiles({ name: 'Fixture story.jsonl', mimeType: 'application/json', buffer: contents });
            const first = await (await chooserResponse).json();
            await page.unroute('**' + route);
            expect(attempts).toHaveLength(2);
            expect(attempts[0].key).toBeTruthy();
            expect(attempts.map(attempt => attempt.key)).toEqual([attempts[0].key, attempts[0].key]);
            expect(attempts.map(attempt => attempt.hasContents)).toEqual([true, true]);
            expect(attempts[1].result).toEqual(attempts[0].result);
            expect(first.fileNames).toHaveLength(1);
            const root = path.join(app.directory, 'data', 'default-user');
            const importedPath = name => path.join(root, group ? 'group chats' : path.join('chats', account.avatar.replace('.png', '')), name + '.jsonl');
            expect(fs.existsSync(importedPath(first.fileNames[0]))).toBe(true);
            await page.evaluate(async ({ groupId, name }) => {
                if (groupId) await (await import('/scripts/group-chats.js')).openGroupChat(groupId, name);
                else await (await import('/script.js')).openCharacterChat(name);
            }, { groupId: groupData?.id, name: first.fileNames[0] });
            await expect(page.locator('#chat .mes_text').last()).toHaveText('Imported answer.');
            const backupName = 'chat_fixture_restore.jsonl';
            fs.writeFileSync(path.join(root, 'backups', backupName), contents);
            await page.locator('#option_select_chat').evaluate(element => element.click());
            await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
            await page.locator('[aria-controls="chat_backups_list"]').click();
            const backup = page.locator('.chatBackupsListItem').filter({ hasText: backupName });
            await expect(backup).toBeVisible();
            const downloadHeaders = [];
            await page.route('**/api/backups/chat/download', async intercepted => {
                downloadHeaders.push(intercepted.request().headers()['x-neconyan-account']);
                if (downloadHeaders.length === 1) await intercepted.fulfill({ status: 403, body: 'Invalid CSRF token' });
                else await intercepted.continue();
            });
            const restoreAttempts = [];
            await page.route('**' + route, async intercepted => {
                restoreAttempts.push(intercepted.request().postDataBuffer().toString().match(/"operationKey":"([^"]+)"/)?.[1]);
                if (restoreAttempts.length === 1) await intercepted.fulfill({ status: 403, body: 'Invalid CSRF token' });
                else await intercepted.continue();
            });
            const restoreResponse = page.waitForResponse(response => response.url().endsWith(route) && response.status() === 200);
            await backup.locator('.fa-rotate-left').click();
            const restored = await (await restoreResponse).json();
            await page.unroute('**/api/backups/chat/download');
            await page.unroute('**' + route);
            expect(downloadHeaders).toEqual(['default-user', 'default-user']);
            expect(restoreAttempts).toEqual([restoreAttempts[0], restoreAttempts[0]]);
            expect(restored.fileNames).toHaveLength(1);
            expect(restored.fileNames[0]).not.toBe(first.fileNames[0]);
            expect(fs.existsSync(importedPath(restored.fileNames[0]))).toBe(true);
            if (group) {
                const saved = JSON.parse(fs.readFileSync(path.join(root, 'groups', groupData.id + '.json'), 'utf8'));
                expect(saved.chats.slice(-2)).toEqual([first.fileNames[0], restored.fileNames[0]]);
            }
            let releaseLate;
            let reachedLate;
            const held = new Promise(resolve => { releaseLate = resolve; });
            const reached = new Promise(resolve => { reachedLate = resolve; });
            await page.route('**' + route, async intercepted => {
                const response = await intercepted.fetch();
                reachedLate();
                await held;
                await intercepted.fulfill({ response });
            });
            const lateResponse = page.waitForResponse(response => response.url().endsWith(route) && response.status() === 200);
            await page.locator('#chat_import_file').setInputFiles({ name: 'Held story.jsonl', mimeType: 'application/json', buffer: contents });
            await reached;
            await page.evaluate(async ({ avatar, groupId }) => {
                const context = window.SillyTavern.getContext();
                await context.getCharacters();
                if (groupId) await (await import('/scripts/group-chats.js')).openGroupById(groupId, { switchMenu: false });
                else await (await import('/script.js')).selectCharacterById(context.characters.findIndex(char => char.avatar === avatar), { switchMenu: false });
            }, { avatar: otherAvatar, groupId: otherGroup?.id });
            releaseLate();
            const late = await (await lateResponse).json();
            await page.unroute('**' + route);
            await expect(page.locator('#chat_import_file')).toHaveValue('');
            expect(fs.existsSync(importedPath(late.fileNames[0]))).toBe(true);
            if (group) {
                const other = JSON.parse(fs.readFileSync(path.join(root, 'groups', otherGroup.id + '.json'), 'utf8'));
                expect(other.chats).not.toContain(late.fileNames[0]);
            } else {
                expect(fs.existsSync(path.join(root, 'chats', otherAvatar.replace('.png', ''), late.fileNames[0] + '.jsonl'))).toBe(false);
            }
            if (!phone) {
                let releaseAccount;
                let reachedAccount;
                const accountHeld = new Promise(resolve => { releaseAccount = resolve; });
                const accountReached = new Promise(resolve => { reachedAccount = resolve; });
                await page.route('**' + route, async intercepted => {
                    const response = await intercepted.fetch();
                    reachedAccount();
                    await accountHeld;
                    await intercepted.fulfill({ response });
                });
                const accountResponse = page.waitForResponse(response => response.url().endsWith(route) && response.status() === 200);
                await page.locator('#chat_import_file').setInputFiles({ name: 'Held account story.jsonl', mimeType: 'application/json', buffer: contents });
                await accountReached;
                await page.evaluate(accountId => import('/scripts/roleplay-save-chain.js').then(chain =>
                    chain.bindRoleplayAccount('other-user', { accountId, dataEpoch: 1 })), crypto.randomUUID());
                releaseAccount();
                const wrongAccount = await (await accountResponse).json();
                await page.unroute('**' + route);
                await expect(page.locator('#chat_import_file')).toHaveValue('');
                const destination = group ? path.join(root, 'group chats', wrongAccount.fileNames[0] + '.jsonl')
                    : path.join(root, 'chats', otherAvatar.replace('.png', ''), wrongAccount.fileNames[0] + '.jsonl');
                expect(fs.existsSync(destination)).toBe(true);
                if (group) {
                    expect(await page.evaluate(id => import('/scripts/group-chats.js').then(groups =>
                        groups.groups.find(item => item.id === id).chats), otherGroup.id)).not.toContain(wrongAccount.fileNames[0]);
                }
            }
            await page.close();
            expect(account.context.pages()).toHaveLength(0);
            await app.stop('SIGKILL');
            ageDeadRoleplayLocks(path.join(app.directory, 'data', '_roleplay'));
            await app.start();
            const reopened = await account.open({ workspace: false });
            await reopened.evaluate(async ({ avatar, groupId, name }) => {
                const context = window.SillyTavern.getContext();
                await context.getCharacters();
                if (groupId) {
                    const groups = await import('/scripts/group-chats.js');
                    await groups.openGroupById(groupId, { switchMenu: false });
                    await groups.openGroupChat(groupId, name);
                } else {
                    const core = await import('/script.js');
                    await core.selectCharacterById(context.characters.findIndex(char => char.avatar === avatar), { switchMenu: false });
                    await core.openCharacterChat(name);
                }
            }, { avatar: account.avatar, groupId: groupData?.id, name: restored.fileNames[0] });
            await expect(reopened.locator('#chat .mes_text').last()).toHaveText('Imported answer.');
            expect(app.provider.calls).toHaveLength(0);
            await reopened.close();
            expect(account.context.pages()).toHaveLength(0);
        });
    }

    for (const group of [false, true]) {
        test(`${phone ? 'phone' : 'desktop'} ${group ? 'group' : 'solo'} edit, branch and reopen a native storage mutation`, async ({ app }, info) => {
            test.setTimeout(180000);
            const account = await app.account({ phone });
            const chatName = 'Storage source';
            const groupData = group ? await account.post('/api/groups/create', { name: 'Storage group', members: [account.avatar],
                chat_id: chatName, chats: [chatName] }) : null;
            const seed = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
                { name: 'User', is_user: true, mes: 'Keep this question.', send_date: '2026-09-22T12:00:00.000Z', extra: {} },
                { name: 'Durable Nova', is_user: false, mes: 'Original answer.', send_date: '2026-09-22T12:00:01.000Z',
                    original_avatar: account.avatar, swipes: ['Original answer.', 'Keep this alternative.'], swipe_id: 0,
                    swipe_info: [{ extra: { reasoning: 'Keep this thought.' } }, { extra: { retained: true } }],
                    extra: { reasoning: 'Keep this thought.' } }];
            const fields = group ? { id: chatName } : { avatar_url: account.avatar, file_name: chatName };
            const vacancyResponse = await account.context.request.post(group ? '/api/chats/group/get' : '/api/chats/get', {
                headers: account.headers, data: { ...fields, allow_create: true },
            });
            expect(vacancyResponse.ok(), await vacancyResponse.text()).toBe(true);
            const vacancy = JSON.parse(vacancyResponse.headers()['x-neconyan-roleplay']);
            expect(vacancy.vacancy).toBe(0);
            await account.post(group ? '/api/chats/group/save' : '/api/chats/save', { ...fields, chat: seed,
                roleplay: { account: vacancy.account, operationKey: crypto.randomUUID(), vacancy: vacancy.vacancy } });
            const open = async name => {
                const page = await account.open({ workspace: false });
                await page.evaluate(async ({ avatar, groupId, name }) => {
                    const context = window.SillyTavern.getContext();
                    await context.getCharacters();
                    if (groupId) {
                        const groups = await import('/scripts/group-chats.js');
                        await groups.openGroupById(groupId, { switchMenu: false });
                        await groups.openGroupChat(groupId, name);
                    } else {
                        const core = await import('/script.js');
                        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
                        await core.openCharacterChat(name);
                    }
                }, { avatar: account.avatar, groupId: groupData?.id, name });
                await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toBeVisible();
                return page;
            };
            const root = path.join(app.directory, 'data', 'default-user');
            const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'), backups: path.join(root, 'backups') };
            const target = name => group
                ? createGroupChatTarget({ groupChatsDirectory: directories.groupChats, backupDirectory: directories.backups, filename: name + '.jsonl' })
                : createCharacterChatTarget({ chatsDirectory: directories.chats, backupDirectory: directories.backups,
                    owner: account.avatar.replace('.png', ''), filename: name + '.jsonl' });
            const read = target => readChatJsonlStrict(target.activePath, { recover: false });
            const sourceTarget = target(chatName);
            let page = await open(chatName);
            let message = page.locator('#chat .mes[mesid="1"]');
            const savePath = group ? '/api/chats/group/save' : '/api/chats/save';
            const savePattern = '**' + savePath;
            const retryAttempts = [];
            await page.route(savePattern, async route => {
                const body = saveBody(route.request());
                if (JSON.parse(body).chat[2]?.mes !== 'Edited in the real interface.') return route.continue();
                const response = await route.fetch();
                retryAttempts.push({ body, result: await response.json(), status: response.status() });
                if (retryAttempts.length === 1) await route.abort('failed');
                else await route.fulfill({ response });
            });
            const acknowledgedRetry = page.waitForResponse(response => response.url().endsWith(savePath) && response.status() === 200);
            await message.locator('.mes_edit').click();
            await page.locator('#curEditTextarea').fill('Edited in the real interface.');
            await message.locator('.mes_edit_done').click();
            const retryResult = await (await acknowledgedRetry).json();
            await page.unroute(savePattern);
            expect(await page.evaluate(async () => (await import('/script.js')).flushPendingChatSavesForNavigation())).toBe(true);
            expect(retryAttempts).toHaveLength(2);
            expect(retryAttempts.map(attempt => attempt.status)).toEqual([200, 200]);
            expect(retryAttempts[1].body).toBe(retryAttempts[0].body);
            expect(retryAttempts[1].result).toEqual(retryAttempts[0].result);
            expect(retryResult).toEqual(retryAttempts[0].result);
            await expect.poll(() => read(sourceTarget).records?.[2]?.mes).toBe('Edited in the real interface.');

            const stalePage = await open(chatName);
            const staleMessage = stalePage.locator('#chat .mes[mesid="1"]');
            const confirmedText = 'Explicitly confirmed stale-tab edit.';
            await staleMessage.locator('.mes_edit').click();
            await stalePage.locator('#curEditTextarea').fill(confirmedText);
            const newerResponse = page.waitForResponse(response => response.url().endsWith(savePath) && response.status() === 200);
            await message.locator('.mes_edit').click();
            await page.locator('#curEditTextarea').fill('Newer edit from the first tab.');
            await message.locator('.mes_edit_done').click();
            const newer = await (await newerResponse).json();
            expect(await page.evaluate(async () => (await import('/script.js')).flushPendingChatSavesForNavigation())).toBe(true);
            const staleAttempts = [];
            await stalePage.route(savePattern, async route => {
                staleAttempts.push(JSON.parse(saveBody(route.request())));
                await route.continue();
            });
            const refusedResponse = stalePage.waitForResponse(response => response.url().endsWith(savePath) && response.status() === 400);
            await staleMessage.locator('.mes_edit_done').click();
            const refusal = await (await refusedResponse).json();
            expect(refusal.error).toBe('integrity');
            expect(refusal.roleplay.source).toEqual(newer.roleplay.source);
            expect(staleAttempts).toHaveLength(1);
            expect(staleAttempts[0].roleplay.source).toEqual(retryResult.roleplay.source);
            expect(read(sourceTarget).records[2].mes).toBe('Newer edit from the first tab.');
            const popup = stalePage.locator('dialog[open]').filter({ has: stalePage.locator('.popup-input') });
            await expect(popup).toBeVisible();
            await info.attach('stale-save-confirmation', { body: await stalePage.screenshot(), contentType: 'image/png' });
            await popup.locator('.popup-input').fill('OVERWRITE');
            const forcedResponse = stalePage.waitForResponse(response => response.url().endsWith(savePath) && response.status() === 200);
            await popup.locator('.popup-button-ok').click();
            const forced = await (await forcedResponse).json();
            await stalePage.unroute(savePattern);
            expect(await stalePage.evaluate(async () => (await import('/script.js')).flushPendingChatSavesForNavigation())).toBe(true);
            expect(staleAttempts).toHaveLength(2);
            expect(staleAttempts[1].force).toBe(true);
            expect(staleAttempts[1].roleplay.source).toEqual(refusal.roleplay.source);
            expect(staleAttempts[1].roleplay.operationKey).not.toBe(staleAttempts[0].roleplay.operationKey);
            expect(forced.roleplay.operationKey).toBe(staleAttempts[1].roleplay.operationKey);
            expect(read(sourceTarget).records[2].mes).toBe(confirmedText);
            await page.close();
            page = stalePage;
            message = staleMessage;
            await message.locator('.extraMesButtonsHint').click();
            await message.locator('.mes_create_branch').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId())).not.toBe(chatName);
            const branchName = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
            const branchTarget = target(branchName);
            await expect.poll(() => read(branchTarget).records?.[2]?.mes).toBe(confirmedText);
            await page.close();
            expect(account.context.pages()).toHaveLength(0);
            const before = read(branchTarget).records;
            const base = { owner: 'default-user', directories };
            const scope = withRoleplayAccount(base, null, (_lease, stamp) => ({ ...base, ...stamp }));
            const locator = group ? { group: true, chat: branchName } : { group: false, avatar: account.avatar, chat: branchName };
            const records = structuredClone(before);
            records[0].chat_metadata.native_storage_test = true;
            records.push({ name: 'Durable Nova', is_user: false, mes: 'Native storage result.', extra: {}, original_avatar: account.avatar });
            const mutation = { operationKey: crypto.randomUUID(), mode: 'update', sourceKind: 'storage',
                source: captureRoleplayStorageSource(scope, locator), records };
            const result = commitSingleChatWrite(scope, mutation, roleplayNativeHost);
            expect(read(branchTarget).records.slice(1, -1)).toEqual(before.slice(1));
            expect(readRoleplayAccount(scope).resources[result.instanceId].head.rawHash).toBe(result.rawHash);
            expect(read(sourceTarget).records[2].mes).toBe(confirmedText);
            await app.restart();
            const committedBytes = fs.readFileSync(branchTarget.activePath);
            const committedMtime = fs.statSync(branchTarget.activePath, { bigint: true }).mtimeNs;
            expect(commitSingleChatWrite(scope, mutation, roleplayNativeHost)).toEqual(result);
            expect(fs.readFileSync(branchTarget.activePath)).toEqual(committedBytes);
            expect(fs.statSync(branchTarget.activePath, { bigint: true }).mtimeNs).toBe(committedMtime);
            page = await open(branchName);
            await expect(page.locator('#chat .mes_text').last()).toHaveText('Native storage result.');
            const loaded = await page.evaluate(() => {
                const context = window.SillyTavern.getContext();
                return { messages: context.chat, metadata: context.chatMetadata };
            });
            expect(loaded.messages[1].swipes).toContain('Keep this alternative.');
            expect(loaded.metadata.native_storage_test).toBe(true);
            expect(loaded.messages[1].extra.reasoning).toBe('Keep this thought.');
            const geometry = await page.locator('#chat').evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { x: rect.x, right: rect.right, width: rect.width, display: getComputedStyle(element).display };
            });
            expect(geometry.width).toBeGreaterThan(0);
            expect(geometry.x).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(phone ? 393 : 1280);
            expect(geometry.display).not.toBe('none');
            await info.attach('storage-reopen', { body: await page.screenshot(), contentType: 'image/png' });
            await info.attach('chat-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
            expect(app.provider.calls).toHaveLength(0);
        });
    }
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} late group load cannot replace another chat or its save authority`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const names = ['Held group chat', 'Current group chat'];
        const groups = [];
        const seeds = [];
        for (const [index, name] of names.entries()) {
            groups.push(await account.post('/api/groups/create', { name: `Race group ${index}`, members: [account.avatar], chat_id: name, chats: [name] }));
            const read = await account.context.request.post('/api/chats/group/get', { headers: account.headers, data: { id: name, allow_create: true } });
            const vacancy = JSON.parse(read.headers()['x-neconyan-roleplay']);
            const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { tainted: true, tag: `group-${index}` } },
                { name: 'User', is_user: true, mes: `Question ${index}.`, extra: {} },
                { name: 'Durable Nova', is_user: false, mes: `Answer ${index}.`, extra: {} },
                ...(index === 0 ? Array.from({ length: 15 }, (_, id) => ({ name: 'Durable Nova', is_user: false, mes: `Held ${id}.`, extra: {} })) : [])];
            seeds.push(records);
            await account.post('/api/chats/group/save', { id: name, chat: records,
                roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
        }
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.SillyTavern.getContext().getCharacters());
        await page.evaluate(chatId => {
            const context = window.SillyTavern.getContext();
            window.heldPromptReached = false;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            window.releaseHeldPrompt = release;
            const listener = async event => {
                if (event.chatId !== chatId) return;
                context.eventSource.removeListener(context.eventTypes.ITEMIZED_PROMPTS_LOADED, listener);
                window.heldPromptReached = true;
                await gate;
            };
            context.eventSource.on(context.eventTypes.ITEMIZED_PROMPTS_LOADED, listener);
        }, names[0]);
        const loadingFirst = page.evaluate(async id => (await import('/scripts/group-chats.js')).openGroupById(id, { switchMenu: false }), groups[0].id);
        await expect.poll(() => page.evaluate(() => window.heldPromptReached)).toBe(true);
        await page.evaluate(async id => (await import('/scripts/group-chats.js')).openGroupById(id, { switchMenu: false }), groups[1].id);
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toHaveText('Answer 1.');
        const before = await page.evaluate(() => ({ text: window.SillyTavern.getContext().chat[1].mes,
            integrity: window.SillyTavern.getContext().chatMetadata.integrity }));
        await page.evaluate(() => window.releaseHeldPrompt());
        await loadingFirst;
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toHaveText('Answer 1.');
        expect(await page.evaluate(() => ({ text: window.SillyTavern.getContext().chat[1].mes,
            integrity: window.SillyTavern.getContext().chatMetadata.integrity }))).toEqual(before);

        if (phone) {
            await page.evaluate(() => {
                const original = window.requestAnimationFrame;
                const schedule = original.bind(window);
                let held;
                window.heldGroupRender = {
                    reached: false,
                    release() { if (held) schedule(held); },
                    restore() { window.requestAnimationFrame = original; },
                };
                window.requestAnimationFrame = callback => {
                    const rendered = [...document.querySelectorAll('#chat .mes')];
                    if (!window.heldGroupRender.reached && rendered.length === 8 && rendered[0]?.textContent.includes('Question 0.')) {
                        window.heldGroupRender.reached = true;
                        held = callback;
                        return 0;
                    }
                    return schedule(callback);
                };
            });
            const renderingFirst = page.evaluate(async id => (await import('/scripts/group-chats.js')).openGroupById(id, { switchMenu: false }), groups[0].id);
            await expect.poll(() => page.evaluate(() => window.heldGroupRender.reached)).toBe(true);
            await page.evaluate(async id => (await import('/scripts/group-chats.js')).openGroupById(id, { switchMenu: false }), groups[1].id);
            await page.evaluate(() => { window.heldGroupRender.release(); window.heldGroupRender.restore(); });
            await renderingFirst;
            const rendered = await page.locator('#chat .mes').evaluateAll(elements => elements.map(element => ({
                id: element.getAttribute('mesid'), text: element.textContent,
            })));
            expect(rendered).toHaveLength(2);
            expect(rendered.every(row => !row.text.includes('Held '))).toBe(true);
            expect(new Set(rendered.map(row => row.id)).size).toBe(rendered.length);
        }

        const currentPath = path.join(app.directory, 'data', 'default-user', 'group chats', names[1] + '.jsonl');
        const current = () => fs.readFileSync(currentPath, 'utf8').split('\n').map(JSON.parse);
        const message = page.locator('#chat .mes[mesid="1"]');
        await message.locator('.mes_edit').click();
        await page.locator('#curEditTextarea').fill('Current group editor text.');
        await message.locator('.mes_edit_done').click();
        expect(await page.evaluate(async () => (await import('/script.js')).flushPendingChatSavesForNavigation())).toBe(true);
        expect(current()[1].mes).toBe(seeds[1][1].mes);
        expect(current()[2].mes).toBe('Current group editor text.');

        const backgroundSource = await page.evaluate(async chatId => {
            const core = await import('/script.js');
            const chain = await import('/scripts/roleplay-save-chain.js');
            const locator = { group: true, chat: chatId };
            const loaded = await core.loadRoleplayChat(locator);
            const background = structuredClone(loaded.records);
            background[1].mes = 'Background-only group edit.';
            const token = chain.beginRoleplaySave(locator, { operationKey: window.crypto.randomUUID(), evidence: loaded.evidence });
            try {
                const result = await core.saveRoleplayChatRequest(token, { id: chatId, chat: background });
                if (!result.ok) throw new Error('Explicit background save failed');
                return loaded.evidence.source;
            } finally { await chain.finishRoleplaySave(token); }
        }, names[1]);
        let staleSource;
        await page.route('**/api/chats/group/save', async route => {
            staleSource = JSON.parse(saveBody(route.request())).roleplay.source;
            await route.continue();
        });
        const refusal = page.waitForResponse(response => response.url().endsWith('/api/chats/group/save') && response.status() === 400);
        await message.locator('.mes_edit').click();
        await page.locator('#curEditTextarea').fill('Stale editor text.');
        await message.locator('.mes_edit_done').click();
        expect((await (await refusal).json()).error).toBe('integrity');
        expect(staleSource.revision).toBe(backgroundSource.revision);
        expect(current()[1].mes).toBe('Background-only group edit.');
        await page.close();
        expect(account.context.pages()).toHaveLength(0);
        expect(app.provider.calls).toHaveLength(0);
    });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} group editor records a durable existing-group update`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const created = await account.post('/api/groups/create', { name: 'Before group edit', members: [account.avatar], chat_id: '', chats: [] });
        expect(created.__roleplay?.source?.revision).toBe(1);
        const filename = path.join(app.directory, 'data', 'default-user', 'groups', created.id + '.json');
        let page = await account.open({ workspace: false });
        const openEditor = async () => {
            if (phone) await page.locator('#sb-hamburger').click();
            await page.getByRole('button', { name: 'Characters', exact: true }).click();
            await page.getByRole('tab', { name: 'Groups', exact: true }).click();
            await page.evaluate(async id => (await import('/scripts/group-chats.js')).select_group_chats(id, false), created.id);
        };
        await openEditor();
        const control = phone ? page.locator('#group_favorite_button') : page.locator('#rm_button_selected_ch h2');
        await expect(control).toBeVisible();
        await control.click();
        if (!phone) {
            const rename = page.locator('dialog.popup:visible');
            await rename.locator('.popup-input').fill('Saved from the group editor');
            await rename.locator('.popup-button-ok').click();
        }
        await expect.poll(() => {
            const group = JSON.parse(fs.readFileSync(filename, 'utf8'));
            return phone ? group.fav : group.name;
        }).toBe(phone ? true : 'Saved from the group editor');
        const saved = fs.readFileSync(filename);
        const geometry = await control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, right: rect.right, width: rect.width };
        });
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.close();
        expect(account.context.pages()).toHaveLength(0);
        await app.restart();
        expect(app.processes[0].signal).toBe('SIGKILL');
        page = await account.open({ workspace: false });
        await openEditor();
        if (phone) await expect(page.locator('#group_favorite_button')).toHaveClass(/fav_on/);
        else await expect(page.locator('#rm_button_selected_ch h2')).toHaveText('Saved from the group editor');
        expect(fs.readFileSync(filename)).toEqual(saved);
        await page.close();
        expect(account.context.pages()).toHaveLength(0);
        expect(app.provider.calls).toHaveLength(0);
    });
}

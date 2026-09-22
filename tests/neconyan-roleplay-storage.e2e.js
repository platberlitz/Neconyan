/* global window, getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { mutateChat } = await import('../src/endpoints/chats.js');
const { createCharacterChatTarget, createGroupChatTarget, readChatJsonlStrict } = await import('../src/chat-recovery.js');

for (const phone of [false, true]) {
    for (const group of [false, true]) {
        test(`${phone ? 'phone' : 'desktop'} ${group ? 'group' : 'solo'} edit, branch and reopen a native storage mutation`, async ({ app }, info) => {
            test.setTimeout(120000);
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
            await account.post(group ? '/api/chats/group/save' : '/api/chats/save', group
                ? { id: chatName, chat: seed } : { avatar_url: account.avatar, file_name: chatName, chat: seed });
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
                    owner: account.avatar.replace(/\.png$/, ''), filename: name + '.jsonl' });
            const sourceTarget = target(chatName);
            let page = await open(chatName);
            const message = page.locator('#chat .mes[mesid="1"]');
            await message.locator('.mes_edit').click();
            await page.locator('#curEditTextarea').fill('Edited in the real interface.');
            await message.locator('.mes_edit_done').click();
            await expect.poll(() => readChatJsonlStrict(sourceTarget.activePath).records?.[2]?.mes).toBe('Edited in the real interface.');
            await message.locator('.extraMesButtonsHint').click();
            await message.locator('.mes_create_branch').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId())).not.toBe(chatName);
            const branchName = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
            const branchTarget = target(branchName);
            await expect.poll(() => readChatJsonlStrict(branchTarget.activePath).records?.[2]?.mes).toBe('Edited in the real interface.');
            await page.close();
            expect(account.context.pages()).toHaveLength(0);
            const before = readChatJsonlStrict(branchTarget.activePath).records;
            const result = mutateChat({ filePath: branchTarget.activePath,
                expectedHash: crypto.createHash('sha256').update(fs.readFileSync(branchTarget.activePath)).digest('hex'),
                handle: 'default-user', cardName: 'Storage branch', backupDirectory: directories.backups, recoveryTarget: branchTarget,
                mewmory: { directories, locator: { group, avatar: account.avatar, chat: branchName } } }, records => {
                records[0].chat_metadata.native_storage_test = true;
                records.push({ name: 'Durable Nova', is_user: false, mes: 'Native storage result.', extra: {}, original_avatar: account.avatar });
                return records;
            });
            expect(result.records.slice(1, -1)).toEqual(before.slice(1));
            expect(readChatJsonlStrict(sourceTarget.activePath).records[2].mes).toBe('Edited in the real interface.');
            await app.restart();
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

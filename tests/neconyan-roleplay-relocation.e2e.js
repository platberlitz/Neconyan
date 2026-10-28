/* global document, window */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const ctimePreload = fileURLToPath(new URL('./termux-ctime-fixture.js', import.meta.url));

for (const termux of [false, true]) for (const phone of [false, true]) test(`a complete stopped folder copy opens and saves on ${termux ? 'Termux ' : ''}${phone ? 'phone' : 'desktop'} without repair`, async ({ app, initialServerOptions }, info) => {
    test.setTimeout(180000);
    const account = await app.account({ phone });
    const chats = [];
    for (const group of [false, true]) {
        const name = group ? 'Portable group' : 'Portable solo';
        const groupData = group ? await account.post('/api/groups/create', { name, members: [account.avatar], chat_id: name, chats: [name] }) : null;
        const fields = group ? { id: name } : { avatar_url: account.avatar, file_name: name };
        const route = group ? '/api/chats/group/' : '/api/chats/';
        const vacancyResponse = await account.context.request.post(route + 'get', { headers: account.headers, data: { ...fields, allow_create: true } });
        expect(vacancyResponse.ok()).toBe(true);
        const vacancy = JSON.parse(vacancyResponse.headers()['x-neconyan-roleplay']);
        const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { portable: true } },
            { name: 'User', is_user: true, mes: 'Keep this across devices.', extra: {} },
            { name: 'Durable Nova', is_user: false, mes: name + ' answer.', original_avatar: account.avatar,
                swipes: [name + ' answer.', 'Keep the other swipe.'], swipe_id: 0, extra: { reasoning: 'Keep the saved thought.' } }];
        await account.post(route + 'save', { ...fields, chat: records,
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
        const read = await account.context.request.post(route + 'get', { headers: account.headers, data: fields });
        expect(read.ok()).toBe(true);
        const evidence = JSON.parse(read.headers()['x-neconyan-roleplay']);
        const relative = path.join('default-user', group ? 'group chats' : path.join('chats', account.avatar.replace('.png', '')), name + '.jsonl');
        chats.push({ name, groupId: groupData?.id, fields, route, evidence, relative, bytes: fs.readFileSync(path.join(app.dataRoot, relative)) });
    }

    await app.stop();
    const original = path.join(app.directory, 'original-data');
    fs.renameSync(app.dataRoot, original);
    // The stopped-transfer instructions leave device-local ownership on the source.
    const sourceOwner = path.join(original, '.neconyan-root-owner');
    expect(fs.existsSync(sourceOwner)).toBe(true);
    fs.cpSync(original, app.dataRoot, { recursive: true, verbatimSymlinks: true, filter: source => source !== sourceOwner });
    expect(fs.existsSync(sourceOwner)).toBe(true);
    expect(fs.existsSync(path.join(app.dataRoot, '.neconyan-root-owner'))).toBe(false);
    const destinationOptions = termux ? { env: { NODE_OPTIONS: `--import=${ctimePreload}`, NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE: '' } } : initialServerOptions;
    await app.start(destinationOptions);
    if (termux) {
        expect(JSON.parse(fs.readFileSync(path.join(app.dataRoot, '_termux-file-identity.json'), 'utf8'))).toEqual({ version: 1, birthtime: 'zero' });
        expect(app.serverOutput).toContain('Termux file identity compatibility is active');
    }

    for (const chat of chats) {
        const response = await account.context.request.post(chat.route + 'get', { headers: account.headers, data: chat.fields });
        expect(response.ok(), await response.text()).toBe(true);
        const evidence = JSON.parse(response.headers()['x-neconyan-roleplay']);
        expect(evidence.account).toEqual(chat.evidence.account);
        expect(evidence.source).toEqual(chat.evidence.source);
        expect(fs.readFileSync(path.join(app.dataRoot, chat.relative))).toEqual(chat.bytes);
        expect(fs.statSync(path.join(app.dataRoot, chat.relative)).ino).not.toBe(fs.statSync(path.join(original, chat.relative)).ino);
    }

    const page = await account.open({ workspace: false });
    for (const chat of chats) {
        await page.evaluate(async ({ avatar, name, groupId }) => {
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
        }, { avatar: account.avatar, name: chat.name, groupId: chat.groupId });
        const message = page.locator('#chat .mes[mesid="1"]');
        await expect(message.locator('.mes_text')).toHaveText(chat.name + ' answer.');
        await message.locator('.mes_edit').click();
        await page.locator('#curEditTextarea').fill(chat.name + ' edited after moving.');
        await message.locator('.mes_edit_done').click();
        expect(await page.evaluate(async () => (await import('/script.js')).flushPendingChatSavesForNavigation())).toBe(true);
        await expect.poll(() => fs.readFileSync(path.join(app.dataRoot, chat.relative), 'utf8')).toContain(chat.name + ' edited after moving.');
    }
    const geometry = await page.locator('#chat').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, left: rect.left, right: rect.right,
            viewport: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    expect(geometry.width).toBeGreaterThan(100);
    expect(geometry.height).toBeGreaterThan(100);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.overflow).toBe(false);
    await info.attach('moved-chat-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    await info.attach('moved-chat', { body: await page.screenshot(), contentType: 'image/png' });
    await page.close();
    await app.stop();
    await app.start(destinationOptions);
    for (const chat of chats) {
        const records = await account.post(chat.route + 'get', chat.fields);
        expect(records[2].mes).toBe(chat.name + ' edited after moving.');
        expect(records[2].swipes).toContain('Keep the other swipe.');
        expect(records[2].extra.reasoning).toBe('Keep the saved thought.');
        expect(fs.readFileSync(path.join(original, chat.relative))).toEqual(chat.bytes);
    }
    expect(fs.existsSync(path.join(app.dataRoot, '_roleplay-recovery'))).toBe(false);
    expect(app.provider.calls).toHaveLength(0);
});

/* global document, window, getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { getCookieSessionName } = await import('../src/users.js');

for (const phone of [false, true]) test(`${phone ? 'phone orphaned' : 'desktop copied'} chats recover through Settings and remain editable after restart`, async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account({ phone });
    const root = path.join(app.directory, 'data', 'default-user');
    const chats = [];
    for (const group of [false, true]) {
        const name = group ? 'Transferred group' : 'Transferred solo';
        const groupData = group ? await account.post('/api/groups/create', { name, members: [account.avatar], chat_id: name, chats: [name] }) : null;
        const fields = group ? { id: name } : { avatar_url: account.avatar, file_name: name };
        const route = group ? '/api/chats/group/' : '/api/chats/';
        const vacancyResponse = await account.context.request.post(route + 'get', { headers: account.headers, data: { ...fields, allow_create: true } });
        expect(vacancyResponse.ok()).toBe(true);
        const vacancy = JSON.parse(vacancyResponse.headers()['x-neconyan-roleplay']);
        const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { retained: true } },
            { name: 'User', is_user: true, mes: 'Transferred question.', extra: {} },
            { name: 'Durable Nova', is_user: false, mes: name + ' answer.', original_avatar: account.avatar,
                swipes: [name + ' answer.', 'Keep this alternative.'], swipe_id: 0, extra: { reasoning: 'Keep this thought.' } }];
        await account.post(route + 'save', { ...fields, chat: records,
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: crypto.randomUUID() } });
        const read = await account.context.request.post(route + 'get', { headers: account.headers, data: fields });
        const evidence = JSON.parse(read.headers()['x-neconyan-roleplay']);
        const relative = path.join(group ? 'group chats' : path.join('chats', account.avatar.replace('.png', '')), name + '.jsonl');
        chats.push({ group, groupId: groupData?.id, name, fields, route, records, evidence, relative, bytes: fs.readFileSync(path.join(root, relative)) });
    }
    await app.stop();
    if (phone) fs.renameSync(path.join(app.directory, 'data', '_roleplay'), path.join(app.directory, 'original-tracking'));
    else for (const relative of [...chats.map(chat => chat.relative), path.join('characters', account.avatar), path.join('groups', chats[1].groupId + '.json')]) {
        const filename = path.join(root, relative);
        fs.copyFileSync(filename, filename + '.copy'); fs.renameSync(filename + '.copy', filename);
    }
    await app.start();
    for (const chat of chats) {
        const refused = await account.context.request.post(chat.route + 'get', { headers: account.headers, data: chat.fields });
        expect(refused.status()).toBe(409);
        expect((await refused.json()).code).toBe(phone ? 'ROLEPLAY_FOREIGN_SOURCE' : 'ROLEPLAY_SOURCE_CHANGED');
    }
    let page = await account.open({ workspace: false });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.getByRole('button', { name: 'System & Device', exact: true }).click();
    await page.locator('#SillyTavernImportSection > .inline-drawer-toggle').click();
    const card = page.locator('#sb-roleplay-recovery');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Back up and repair', exact: true })).toBeHidden();
    await expect(card.getByRole('button', { name: 'Reload repaired account', exact: true })).toBeHidden();
    await card.getByRole('button', { name: 'Check transferred data', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('2 chats');
    const repair = card.getByRole('button', { name: 'Back up and repair', exact: true });
    await expect(repair).toBeVisible();
    await repair.scrollIntoViewIfNeeded();
    const geometry = await repair.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right,
            viewport: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth,
            display: getComputedStyle(element).display };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(44);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.overflow).toBe(false);
    await info.attach('repair-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    const repaired = page.waitForResponse(response => response.url().endsWith('/api/roleplay/recovery/repair'));
    await repair.click();
    const response = await repaired;
    expect(response.ok(), await response.text()).toBe(true);
    const receipt = await response.json();
    await expect(card.getByRole('status')).toContainText('Repair complete.');
    await info.attach('repair-settings', { body: await card.screenshot(), contentType: 'image/png' });
    for (const chat of chats) {
        expect(fs.readFileSync(path.join(root, chat.relative))).toEqual(chat.bytes);
        const backupPath = path.join(receipt.backup, chat.group ? 'groupChats/' + chat.name + '.jsonl' : chat.relative);
        expect(fs.readFileSync(backupPath)).toEqual(chat.bytes);
        expect(fs.statSync(backupPath).ino).not.toBe(fs.statSync(path.join(root, chat.relative)).ino);
        const stale = await account.context.request.post(chat.route + 'save', { headers: account.headers, data: {
            ...chat.fields, chat: chat.records, roleplay: { account: chat.evidence.account, source: chat.evidence.source, operationKey: crypto.randomUUID() },
        } });
        expect(stale.ok()).toBe(false);
        expect((await stale.json()).code).toBe('ROLEPLAY_ACCOUNT_CHANGED');
    }
    await card.getByRole('button', { name: 'Reload repaired account', exact: true }).click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
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
        await page.locator('#curEditTextarea').fill(chat.name + ' edited after recovery.');
        await message.locator('.mes_edit_done').click();
        expect(await page.evaluate(async () => (await import('/script.js')).flushPendingChatSavesForNavigation())).toBe(true);
        await expect.poll(() => fs.readFileSync(path.join(root, chat.relative), 'utf8')).toContain(chat.name + ' edited after recovery.');
    }
    await page.close();
    await app.stop(); await app.start();
    page = await account.open({ workspace: false });
    for (const chat of chats) {
        const loaded = await account.context.request.post(chat.route + 'get', { headers: account.headers, data: chat.fields });
        expect(loaded.ok(), await loaded.text()).toBe(true);
        const records = await loaded.json();
        expect(records[2].mes).toBe(chat.name + ' edited after recovery.');
        expect(records[2].swipes).toContain('Keep this alternative.');
        expect(records[2].extra.reasoning).toBe('Keep this thought.');
        expect(fs.readFileSync(path.join(receipt.backup, chat.group ? 'groupChats/' + chat.name + '.jsonl' : chat.relative))).toEqual(chat.bytes);
    }
    expect((await account.post('/api/groups/all')).some(group => group.id === chats[1].groupId)).toBe(true);
    await page.close();
});

test('two installations keep independent browser sessions on the same hostname', async ({ browser }) => {
    const servers = [];
    const context = await browser.newContext();
    try {
        for (const id of ['first', 'second']) {
            const app = express();
            app.use(cookieSession({ name: getCookieSessionName('/disposable/' + id, 8000), secret: 'same-copied-secret', httpOnly: true, sameSite: 'lax' }));
            const csrf = csrfSync({ getTokenFromState: req => req.session.csrfToken,
                storeTokenInState: (req, token) => { req.session.csrfToken = token; }, getTokenFromRequest: req => req.headers['x-csrf-token'] });
            app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
            app.use(csrf.csrfSynchronisedProtection);
            app.get('/', (_req, res) => res.send('<!doctype html><title>Disposable session</title>'));
            app.post('/probe', (_req, res) => res.json({ id }));
            const server = app.listen(0, '127.0.0.1'); servers.push(server);
            await once(server, 'listening');
        }
        const pages = [];
        for (const server of servers) {
            const page = await context.newPage();
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            const token = await page.evaluate(async () => (await (await fetch('/csrf-token')).json()).token);
            pages.push({ page, token });
        }
        for (const [index, { page, token }] of pages.entries()) {
            const result = await page.evaluate(async token => {
                const response = await fetch('/probe', { method: 'POST', headers: { 'X-CSRF-Token': token } });
                return { status: response.status, data: await response.json() };
            }, token);
            expect(result).toEqual({ status: 200, data: { id: index === 0 ? 'first' : 'second' } });
        }
    } finally {
        await context.close();
        for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
});

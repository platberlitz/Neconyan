/* global window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const INTRO = 'These lorebooks are linked here but no longer exist, so nothing is loaded from them. Nothing has been changed.';
const SHOTS = process.env.NECONYAN_LOREBOOK_SHOTS ? '../screenshots/lorebook-link-warning' : '';

const notices = page => page.locator('.toast-warning').filter({ hasText: 'Missing lorebook links' });

async function shot(page, name, device) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${process.env.NECONYAN_LOREBOOK_SHOTS}-${name}-${device}.png` });
}

const book = (account, name) => account.post('/api/worldinfo/edit', { name, data: { entries: {} } });

async function card(account, name, world = '') {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: name, description: name + ' lives here.', first_mes: 'Hello from ' + name + '.', world } });
    expect(created.ok(), await created.text()).toBe(true);
    return created.text();
}

async function merge(account, avatar, extensions) {
    const response = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar, data: { extensions } } });
    expect(response.ok(), await response.text()).toBe(true);
}

const noticeText = async locator => (await locator.innerText()).replace(/^×\s*/, '').replace(/\s+/g, ' ');

async function select(page, avatar) {
    await page.evaluate(async target => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        const id = context.characters.findIndex(character => character.avatar === target);
        if (id === -1) throw new Error('Character not found: ' + target);
        await context.selectCharacterById(id);
    }, avatar);
}

async function onDisk(account, avatar, chatId) {
    const character = await account.post('/api/characters/get', { avatar_url: avatar });
    const settings = JSON.parse((await account.post('/api/settings/get')).settings);
    const lore = settings.world_info_settings?.world_info?.charLore?.find(item => item.name === avatar.replace(/\.[^.]+$/, ''));
    const chat = chatId ? await account.post('/api/chats/get', { avatar_url: avatar, file_name: chatId }) : [];
    return { main: character.data?.extensions?.world ?? '', extras: lore?.extraBooks ?? [], chatBook: chat[0]?.chat_metadata?.world_info ?? '' };
}

async function chatId(page) {
    return page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
}

async function dialogText(page) {
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    return (await dialog.innerText()).replace(/\s+/g, ' ');
}

for (const device of ['desktop', 'phone']) {
    const phone = device === 'phone';

    test.describe(`on ${device}`, () => {
        test.describe.configure({ mode: 'default' });

        test(`names each dead link once and removes them only after confirming (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            await book(account, 'Real Book');
            const pip = await card(account, 'Probe Pip', 'Real Book');
            const first = await account.open({ workspace: false });
            await select(first, pip);
            await first.evaluate(async avatar => {
                const world = await import('/scripts/world-info.js');
                const core = await import('/script.js');
                world.charSetAuxWorlds(avatar.replace(/\.[^.]+$/, ''), ['Gone Extra', 'Real Book']);
                const context = window.SillyTavern.getContext();
                context.chatMetadata.world_info = 'Gone Chat';
                await context.saveMetadata();
                if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Settings save failed');
            }, pip);
            const id = await chatId(first);
            await first.waitForTimeout(2000);
            await expect(notices(first)).toHaveCount(0);
            await merge(account, pip, { world: 'Gone Main' });
            const before = await onDisk(account, pip, id);
            expect(before).toEqual({ main: 'Gone Main', extras: ['Gone Extra', 'Real Book'], chatBook: 'Gone Chat' });
            await first.close();

            const page = await account.open({ workspace: false });
            await select(page, pip);
            const notice = notices(page);
            await expect(notice).toHaveCount(1, { timeout: 20000 });
            const text = await noticeText(notice);
            expect(text).toBe(`Missing lorebook links ${INTRO} 'Gone Main' is the main lorebook of Probe Pip. 'Gone Extra' is an extra lorebook of Probe Pip. 'Gone Chat' is this chat's lorebook. Review links`);
            await shot(page, 'notice', device);
            await page.waitForTimeout(3000);
            await expect(notice).toHaveCount(1);
            expect(await onDisk(account, pip, id)).toEqual(before);

            const reviewButton = notice.getByRole('button', { name: 'Review links', exact: true });
            const box = await reviewButton.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
            await reviewButton.click();
            await expect(notices(page)).toHaveCount(0);
            const asked = await dialogText(page);
            expect(asked).toContain('Remove missing lorebook links?');
            expect(asked).toContain('Only the links are removed. No lorebook is deleted.');
            expect(asked).toContain('To link another lorebook to a card, open its editor and choose \'Link to Lorebook\' in the \'More...\' menu.');
            expect(asked).toContain('To link another lorebook to this chat, Shift-click or long-press the chat lorebook button in the character or group editor.');
            expect(asked).not.toContain('Conversation');
            await shot(page, 'review', device);
            await page.locator('dialog[open] .popup-button-cancel').click();
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await page.waitForTimeout(2500);
            expect(await onDisk(account, pip, id)).toEqual(before);
            await expect(notices(page)).toHaveCount(0);
            await page.evaluate(() => window.SillyTavern.getContext().reloadCurrentChat());
            await page.waitForTimeout(2500);
            await expect(notices(page)).toHaveCount(0);

            const other = await card(account, 'Other Olive');
            await select(page, other);
            await page.waitForTimeout(1500);
            await expect(notices(page)).toHaveCount(0);
            await select(page, pip);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });

            await notices(page).getByRole('button', { name: 'Review links', exact: true }).click();
            await dialogText(page);
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('.toast-success').filter({ hasText: 'Removed 3 missing lorebook link(s).' })).toBeVisible();
            await expect.poll(() => onDisk(account, pip, id)).toEqual({ main: '', extras: ['Real Book'], chatBook: '' });
            await shot(page, 'removed', device);
        });

        test(`names a dead override on the Conversation and removes it on request (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            await account.changeStore(store => { store.characters[account.threadKey].settings.lorebook_override = 'Gone Conversation'; });
            const page = await account.open({ workspace: true });
            const notice = notices(page);
            await expect(notice).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notice)).toBe(`Missing lorebook links ${INTRO} 'Gone Conversation' is this Conversation's lorebook override. Review links`);
            await shot(page, 'conversation-notice', device);
            await page.waitForTimeout(3000);
            await expect(notice).toHaveCount(1);
            expect((await account.store()).characters[account.threadKey].settings.lorebook_override).toBe('Gone Conversation');

            await notice.getByRole('button', { name: 'Review links', exact: true }).click();
            const asked = await dialogText(page);
            await shot(page, 'conversation-review', device);
            expect(asked).toContain('To pick another lorebook for this Conversation, open its settings, go to Prompt & context and change \'Lorebook Override\'.');
            await page.locator('dialog[open] .popup-button-cancel').click();
            await expect(notices(page)).toHaveCount(0);
            await page.locator('[data-sb-conversation-action="open-settings"]').click();
            await page.locator('[data-sb-conversation-settings-section="prompt-context"]').click();
            await expect(page.getByText('Lorebook Override', { exact: true })).toBeVisible();
            await expect(page.locator('#sb_conv_lorebook_override')).toBeVisible();
            expect((await account.store()).characters[account.threadKey].settings.lorebook_override).toBe('Gone Conversation');

            await page.close();
            const again = await account.open({ workspace: true });
            await expect(notices(again)).toHaveCount(1, { timeout: 30000 });
            await notices(again).getByRole('button', { name: 'Review links', exact: true }).click();
            await dialogText(again);
            await again.locator('dialog[open] .popup-button-ok').click();
            await expect(again.locator('.toast-success').filter({ hasText: 'Removed 1 missing lorebook link(s).' })).toBeVisible();
            await expect.poll(async () => (await account.store()).characters[account.threadKey].settings.lorebook_override ?? '').toBe('');
        });

        test(`names the member card in a group chat (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const kit = await card(account, 'Durable Kit', 'Gone Kit Book');
            const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
                data: { avatar_url: account.avatar, file_name: 'Lorebook group probe', allow_create: true } });
            const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
            const group = await account.post('/api/groups/create', { name: 'Two speakers', members: [account.avatar, kit],
                activation_strategy: 1, roleplay: { account: stamp, operationKey: randomUUID() } });
            const page = await account.open({ workspace: false });
            await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
            const notice = notices(page);
            await expect(notice).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notice)).toBe(`Missing lorebook links ${INTRO} 'Gone Kit Book' is the main lorebook of Durable Kit. Review links`);
            await page.waitForTimeout(3000);
            await expect(notice).toHaveCount(1);
        });

        test(`waits for a slow lorebook list and says nothing when it fails (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            await book(account, 'Real Book');
            const pip = await card(account, 'Probe Pip', 'Gone Main');
            const other = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            const worldsList = request => request.method() === 'POST' && /\/api\/settings\/get$/.test(request.url())
                && JSON.stringify(JSON.parse(request.postData() || '{}').sections) === '["worlds"]';
            let mode = 'slow';
            let asked = 0;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            await page.route('**/api/settings/get', async route => {
                if (!worldsList(route.request())) return route.fallback();
                asked++;
                if (mode === 'slow') await gate;
                if (mode === 'error') return route.fulfill({ status: 500, json: { error: 'down' } });
                if (mode === 'abort') return route.abort();
                return route.fallback();
            });
            await select(page, pip);
            await expect.poll(() => asked).toBe(1);
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);
            release();
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            await notices(page).locator('.toast-close-button').click();

            for (const failure of ['error', 'abort']) {
                mode = failure;
                const before = asked;
                await select(page, other);
                await select(page, pip);
                await expect.poll(() => asked).toBeGreaterThan(before);
                await page.waitForTimeout(2500);
                await expect(notices(page)).toHaveCount(0);
            }
            mode = 'ok';
            await select(page, other);
            await select(page, pip);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
        });

        test(`never warns for a lorebook that exists (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const names = ['Café ☕ [v2] (draft)', '名前の本', 'O\'Brien & Sons 100%', 'Real Book', 'Spaced'];
            for (const name of names) await book(account, name);
            const fine = await card(account, 'Fine Fern', 'Café ☕ [v2] (draft)');
            const odd = await card(account, 'Odd Otto', 'Late Book');
            const page = await account.open({ workspace: false });
            await page.evaluate(async ([avatar, books]) => {
                const world = await import('/scripts/world-info.js');
                const core = await import('/script.js');
                world.charSetAuxWorlds(avatar.replace(/\.[^.]+$/, ''), books);
                await core.saveSettings(0, { returnResult: true });
            }, [fine, ['名前の本', 'O\'Brien & Sons 100%', 'Spaced ', 'Odd: <Name>?']]);
            await book(account, 'Odd Name');

            const loads = await page.evaluate(async list => {
                const world = await import('/scripts/world-info.js');
                const result = {};
                for (const name of list) result[name] = Boolean(await world.loadWorldInfo(name));
                return result;
            }, ['Café ☕ [v2] (draft)', '名前の本', 'O\'Brien & Sons 100%', 'Spaced ', 'Odd: <Name>?', 'real book', ' Real Book']);
            expect(loads).toEqual({ 'Café ☕ [v2] (draft)': true, '名前の本': true, 'O\'Brien & Sons 100%': true, 'Spaced ': true, 'Odd: <Name>?': true,
                'real book': process.platform !== 'linux' ? loads['real book'] : false, ' Real Book': false });

            await select(page, fine);
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);

            const stale = await page.evaluate(async () => (await import('/scripts/world-info.js')).world_names.includes('Late Book'));
            expect(stale).toBe(false);
            await book(account, 'Late Book');
            await select(page, odd);
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);

            await merge(account, odd, { world: ' Real Book' });
            await select(page, fine);
            await select(page, odd);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notices(page))).toContain('\' Real Book\' is the main lorebook of Odd Otto.');
        });
    });
}

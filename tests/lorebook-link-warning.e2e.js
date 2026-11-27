/* global window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const INTRO = 'These lorebooks are linked here but could not be found, so nothing is loaded from them. Nothing has been changed.';
const SHOTS = process.env.NECONYAN_LOREBOOK_SHOTS ? '../screenshots/lorebook-link-warning' : '';

const notices = page => page.locator('.toast-warning').filter({ hasText: 'Missing lorebook links' });

async function shot(page, name, device) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${process.env.NECONYAN_LOREBOOK_SHOTS}-${name}-${device}.png` });
}

const book = (account, name) => account.post('/api/worldinfo/edit', { name, data: { entries: {} } });

/** A plain card. The link is set afterwards, because creating a card with an existing lorebook embeds a copy of it. */
async function card(account, name, world = '', { embed = false } = {}) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: name, description: name + ' lives here.', first_mes: 'Hello from ' + name + '.', world: embed ? world : '' } });
    expect(created.ok(), await created.text()).toBe(true);
    const avatar = await created.text();
    if (world && !embed) await merge(account, avatar, { world });
    return avatar;
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

const EMBEDDED_LINE = '\'Embedded Lore\' is the main lorebook of Embed Eve. The card has a lorebook embedded; choose \'Import Card Lore\' in the \'More...\' menu of the character editor to import it.';

/** A card that carries its own copy of its lorebook, whose lorebook is gone from this machine (deleted, or never imported). */
async function embeddedCard(account, name = 'Embed Eve') {
    const entry = { uid: 0, key: ['ember'], keysecondary: [], comment: 'Ember', content: 'EMBER-LORE the ember glows.', constant: false, selective: false, order: 100, position: 0, disable: false };
    await account.post('/api/worldinfo/edit', { name: 'Embedded Lore', data: { entries: { 0: entry } } });
    const avatar = await card(account, name, 'Embedded Lore', { embed: true });
    const removed = await account.context.request.post('/api/worldinfo/delete', { headers: account.headers, data: { name: 'Embedded Lore' } });
    expect(removed.ok(), await removed.text()).toBe(true);
    const saved = await account.post('/api/characters/get', { avatar_url: avatar });
    expect(saved.data.extensions.world).toBe('Embedded Lore');
    expect(saved.data.character_book.name).toBe('Embedded Lore');
    return avatar;
}

async function setExtras(page, avatar, books) {
    await page.evaluate(async ([target, list]) => {
        const world = await import('/scripts/world-info.js');
        const core = await import('/script.js');
        world.charSetAuxWorlds(target.replace(/\.[^.]+$/, ''), list);
        if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Settings save failed');
    }, [avatar, books]);
}

const lorebookState = (page, name) => page.evaluate(async lorebook => {
    const world = await import('/scripts/world-info.js');
    const data = await world.loadWorldInfo(lorebook);
    return data ? Object.keys(data.entries ?? {}).length : null;
}, name);

async function openEditor(page, name) {
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
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
            await first.waitForTimeout(2500);
            await expect(notices(first)).toHaveCount(0);
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
            await page.evaluate(() => window.SillyTavern.getContext().reloadCurrentChat());
            await page.waitForTimeout(2500);
            await expect(notice).toHaveCount(1);

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
            expect(asked).not.toContain('Import Card Lore');
            await shot(page, 'review', device);
            await page.locator('dialog[open] .popup-button-cancel').click();
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await page.waitForTimeout(2500);
            expect(await onDisk(account, pip, id)).toEqual(before);

            const other = await card(account, 'Other Olive');
            await select(page, other);
            await select(page, pip);
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);
            expect(await onDisk(account, pip, id)).toEqual(before);
            await page.close();

            const again = await account.open({ workspace: false });
            await select(again, pip);
            await expect(notices(again)).toHaveCount(1, { timeout: 20000 });
            await notices(again).getByRole('button', { name: 'Review links', exact: true }).click();
            await dialogText(again);
            await again.locator('dialog[open] .popup-button-ok').click();
            await expect(again.locator('.toast-success').filter({ hasText: 'Removed 3 missing lorebook link(s).' })).toBeVisible();
            await expect.poll(() => onDisk(account, pip, id)).toEqual({ main: '', extras: ['Real Book'], chatBook: '' });
            await shot(again, 'removed', device);
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

        test(`shows no notice while the embedded-lorebook offer is open, then names the way back (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const eve = await embeddedCard(account);
            const olive = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            await setExtras(page, eve, ['Gone Extra']);
            await select(page, eve);
            await expect(page.locator('dialog[open]')).toContainText('This character has an embedded World/Lorebook.');
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);
            await shot(page, 'embedded-offer', device);
            await page.locator('dialog[open] .popup-button-cancel').click();
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await page.waitForTimeout(2500);
            await expect(notices(page)).toHaveCount(0);

            await select(page, olive);
            await expect(notices(page)).toHaveCount(0);
            await select(page, eve);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            expect(await noticeText(notices(page))).toBe(`Missing lorebook links ${INTRO} ${EMBEDDED_LINE} 'Gone Extra' is an extra lorebook of Embed Eve. Review links`);
            await shot(page, 'embedded-notice', device);
            await notices(page).getByRole('button', { name: 'Review links', exact: true }).click();
            const asked = await dialogText(page);
            expect(asked).toContain(EMBEDDED_LINE);
            expect(asked).not.toContain('no longer exist');
            await shot(page, 'embedded-review', device);
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('.toast-success').filter({ hasText: 'Removed 2 missing lorebook link(s).' })).toBeVisible();
            await expect.poll(async () => (await onDisk(account, eve)).main).toBe('');
            const kept = await account.post('/api/characters/get', { avatar_url: eve });
            expect(kept.data.character_book.name).toBe('Embedded Lore');
            expect(Object.keys(kept.data.character_book.entries)).toHaveLength(1);
            expect((await account.context.request.post('/api/worldinfo/get', { headers: account.headers, data: { name: 'Embedded Lore' } })).status()).toBe(404);
        });

        test(`Import Card Lore brings the embedded lorebook back and the link works again (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const eve = await embeddedCard(account);
            const olive = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            await select(page, eve);
            await expect(page.locator('dialog[open]')).toContainText('This character has an embedded World/Lorebook.');
            await page.locator('dialog[open] .popup-button-cancel').click();
            await select(page, olive);
            await select(page, eve);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            expect(await lorebookState(page, 'Embedded Lore')).toBeNull();

            await openEditor(page, 'Embed Eve');
            const menu = page.locator('#char-management-dropdown');
            await expect(menu.locator('option', { hasText: 'Import Card Lore' })).toHaveCount(1);
            await menu.selectOption({ label: 'Import Card Lore' });
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('.toast-success').filter({ hasText: 'has been imported and linked to the character' })).toBeVisible();
            expect(await lorebookState(page, 'Embedded Lore')).toBe(1);
            await expect.poll(async () => (await onDisk(account, eve)).main).toBe('Embedded Lore');

            await select(page, olive);
            await select(page, eve);
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);
            expect(await lorebookState(page, 'Embedded Lore')).toBe(1);
        });

        test(`answering Yes to the embedded-lorebook offer leaves nothing to warn about (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const eve = await embeddedCard(account);
            const page = await account.open({ workspace: false });
            await select(page, eve);
            await expect(page.locator('dialog[open]')).toContainText('This character has an embedded World/Lorebook.');
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('.toast-success').filter({ hasText: 'has been imported and linked to the character' })).toBeVisible();
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);
            expect(await lorebookState(page, 'Embedded Lore')).toBe(1);
        });

        test(`keeps the notice away from the embedded-lorebook info toast too (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone, configureSettings(saved) { saved.power_user.world_import_dialog = false; } });
            const eve = await embeddedCard(account);
            const olive = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            await select(page, eve);
            await expect(page.locator('.toast-info').filter({ hasText: 'Embed Eve has an embedded World/Lorebook' })).toBeVisible();
            await page.waitForTimeout(3000);
            await expect(notices(page)).toHaveCount(0);
            await expect(page.locator('.toast-info').filter({ hasText: 'Embed Eve has an embedded World/Lorebook' })).toHaveCount(0, { timeout: 20000 });
            await select(page, olive);
            await select(page, eve);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notices(page))).toBe(`Missing lorebook links ${INTRO} ${EMBEDDED_LINE} Review links`);
        });

        test(`waits for a slow-loading card before naming its embedded lorebook (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone, configureSettings(saved) { saved.power_user.world_import_dialog = false; } });
            const eve = await embeddedCard(account);
            const olive = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            await select(page, eve);
            await expect(page.locator('.toast-info').filter({ hasText: 'Embed Eve has an embedded World/Lorebook' })).toHaveCount(0, { timeout: 20000 });
            // Eve's full card arrives late, as on a slow connection, and Eve opens straight after Olive, so the check
            // Olive's open scheduled runs while Eve is only half open.
            let held = 0;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            await page.route('**/api/characters/get', async route => {
                if (route.request().postDataJSON()?.avatar_url !== eve) return route.continue();
                held += 1;
                await gate;
                await route.continue();
            });
            await page.evaluate(async ([first, second]) => {
                const context = window.SillyTavern.getContext();
                const id = avatar => context.characters.findIndex(character => character.avatar === avatar);
                await context.selectCharacterById(id(first));
                await context.getCharacters();
                window.lorebookTestOpening = context.selectCharacterById(id(second)).then(() => 'opened', error => String(error));
            }, [olive, eve]);
            await expect.poll(() => held).toBe(1);
            await page.waitForTimeout(1000);
            await expect(notices(page)).toHaveCount(0);
            // A check that Eve's own half-open state schedules waits for the full card too.
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:conversation-workspace-state-changed', { detail: { open: false } })));
            await page.waitForTimeout(1000);
            await expect(notices(page)).toHaveCount(0);
            release();
            expect(await page.evaluate(() => window.lorebookTestOpening)).toBe('opened');
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notices(page))).toBe(`Missing lorebook links ${INTRO} ${EMBEDDED_LINE} Review links`);
        });

        test(`takes the notice away when another chat opens (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const pip = await card(account, 'Probe Pip', 'Gone Main');
            const olive = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            await select(page, pip);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            await select(page, olive);
            await expect(notices(page)).toHaveCount(0);
            await page.waitForTimeout(4000);
            await expect(notices(page)).toHaveCount(0);
            await select(page, pip);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notices(page))).toContain('\'Gone Main\' is the main lorebook of Probe Pip.');

            await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                await context.executeSlashCommandsWithOptions('/newchat', { handleParserErrors: false });
            });
            await expect(notices(page)).toHaveCount(0, { timeout: 20000 });
        });

        test(`takes the Conversation notice away when the workspace closes (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            await account.changeStore(store => { store.characters[account.threadKey].settings.lorebook_override = 'Gone Conversation'; });
            const page = await account.open({ workspace: true });
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace')));
            await expect(notices(page)).toHaveCount(0, { timeout: 20000 });
        });

        test(`stays quiet about links the person said no to until the page reloads (${device})`, async ({ app }) => {
            test.setTimeout(300000);
            const account = await app.account({ phone });
            const pip = await card(account, 'Probe Pip', 'Gone Main');
            const olive = await card(account, 'Other Olive');
            const page = await account.open({ workspace: false });
            await select(page, pip);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            await notices(page).locator('.toast-close-button').click();
            await expect(notices(page)).toHaveCount(0);
            await select(page, olive);
            await select(page, pip);
            await page.waitForTimeout(3500);
            await expect(notices(page)).toHaveCount(0);

            await setExtras(page, pip, ['Gone Extra']);
            await select(page, olive);
            await select(page, pip);
            await expect(notices(page)).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notices(page))).toBe(`Missing lorebook links ${INTRO} 'Gone Extra' is an extra lorebook of Probe Pip. Review links`);
            await notices(page).getByRole('button', { name: 'Review links', exact: true }).click();
            await dialogText(page);
            await page.locator('dialog[open] .popup-button-cancel').click();
            await select(page, olive);
            await select(page, pip);
            await page.waitForTimeout(3500);
            await expect(notices(page)).toHaveCount(0);
            await page.close();

            const reloaded = await account.open({ workspace: false });
            await select(reloaded, pip);
            await expect(notices(reloaded)).toHaveCount(1, { timeout: 20000 });
            expect(await noticeText(notices(reloaded))).toContain('\'Gone Main\' is the main lorebook of Probe Pip. \'Gone Extra\' is an extra lorebook of Probe Pip.');
        });
    });
}

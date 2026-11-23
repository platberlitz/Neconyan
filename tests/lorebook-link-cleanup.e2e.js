/* global window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { test } from './neconyan-conversation-durable-fixture.js';

const TARGET = 'Target Book';
const RENAMED = 'Renamed Book';
const SHOTS = process.env.NECONYAN_LOREBOOK_SHOTS ? '../screenshots/lorebook-link-cleanup' : '';
const OBS = process.env.NECONYAN_LOREBOOK_OBS || '';

const notices = page => page.locator('.toast-warning').filter({ hasText: 'Missing lorebook links' });

async function shot(page, name, device) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${process.env.NECONYAN_LOREBOOK_SHOTS}-${name}-${device}.png` });
}

function record(label, value) {
    const text = JSON.stringify(value, null, 2);
    console.log(`OBS ${label} ${text}`);
    if (OBS) {
        fs.mkdirSync(OBS, { recursive: true });
        fs.writeFileSync(path.join(OBS, label.replace(/[^\w.-]+/g, '_') + '.json'), text + '\n');
    }
}

const entry = text => ({ uid: 0, key: ['target'], keysecondary: [], comment: 'Target', content: text, constant: false, selective: false, order: 100, position: 0, disable: false });

const book = (account, name, entries = {}) => account.post('/api/worldinfo/edit', { name, data: { entries } });

async function card(account, name, world = '', { embed = false } = {}) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: name, description: name + ' lives here.', first_mes: 'Hello from ' + name + '.', world: embed ? world : '' } });
    expect(created.ok(), await created.text()).toBe(true);
    const avatar = await created.text();
    if (world && !embed) await merge(account, avatar, { world });
    return avatar;
}

function pngChunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
}

/** A card image with its own pixels plus an ancillary text chunk that must survive a link change. */
function photo() {
    const image = new PNG({ width: 40, height: 60 });
    for (let index = 0; index < image.data.length; index += 4) {
        image.data[index] = (index / 4) % 251;
        image.data[index + 1] = 90;
        image.data[index + 2] = 200;
        image.data[index + 3] = 255;
    }
    const written = PNG.sync.write(image);
    const idat = written.indexOf(Buffer.from('IDAT', 'latin1')) - 4;
    return Buffer.concat([written.subarray(0, idat), pngChunk('tEXt', Buffer.from('Comment\0kept as it was', 'latin1')), written.subarray(idat)]);
}

async function photoCard(account, name, world) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers, multipart: {
        ch_name: name, description: name + ' lives here.', first_mes: 'Hello from ' + name + '.',
        avatar: { name: 'photo.png', mimeType: 'image/png', buffer: photo() },
    } });
    expect(created.ok(), await created.text()).toBe(true);
    const avatar = await created.text();
    await merge(account, avatar, { world });
    return avatar;
}

async function merge(account, avatar, extensions) {
    const response = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar, data: { extensions } } });
    expect(response.ok(), await response.text()).toBe(true);
}

async function select(page, avatar) {
    await page.evaluate(async target => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        const id = context.characters.findIndex(character => character.avatar === target);
        if (id === -1) throw new Error('Character not found: ' + target);
        await context.selectCharacterById(id);
    }, avatar);
}

async function setChatBook(page, name) {
    await page.evaluate(async value => {
        const context = window.SillyTavern.getContext();
        context.chatMetadata.world_info = value;
        await context.saveMetadata();
    }, name);
}

async function openGroup(page, id) {
    await page.evaluate(async groupId => {
        const groups = await import('/scripts/group-chats.js');
        await groups.getGroups();
        if (!await groups.openGroupById(groupId)) throw new Error('The group did not open: ' + groupId);
    }, id);
}

const chatId = page => page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());

async function setExtras(page, avatar, books) {
    await page.evaluate(async ([target, list]) => {
        const world = await import('/scripts/world-info.js');
        const core = await import('/script.js');
        world.charSetAuxWorlds(target.replace(/\.[^.]+$/, ''), list);
        await core.saveSettings(0, { returnResult: true });
    }, [avatar, books]);
}

async function threadFor(account, body) {
    const current = await account.post('/api/neconyan-conversation/store/get');
    return account.post('/api/neconyan-conversation/thread/save', { personaId: account.personaId, version: current.version,
        messages: [{ id: 'seed-' + randomUUID(), role: 'user', name: 'User', mes: 'Hello there.', timestamp: 1700000000000 }], ...body });
}

async function setOverrides(account, overrides) {
    await account.changeStore(store => {
        for (const [key, value] of Object.entries(overrides)) store.characters[key].settings.lorebook_override = value;
    });
}

/** Everything the notice reads, straight from disk. */
async function readDisk(account, ids) {
    const mains = {};
    const embedded = {};
    for (const [key, avatar] of Object.entries(ids.cards)) {
        const character = await account.post('/api/characters/get', { avatar_url: avatar });
        mains[key] = character.data?.extensions?.world ?? '';
        embedded[key] = character.data?.character_book ?? null;
    }
    const settings = JSON.parse((await account.post('/api/settings/get')).settings);
    const extras = {};
    for (const item of settings.world_info_settings?.world_info?.charLore ?? []) extras[item.name] = item.extraBooks;
    const chats = {};
    for (const [key, locator] of Object.entries(ids.chats)) {
        const records = locator.group
            ? await account.post('/api/chats/group/get', { id: locator.chat })
            : await account.post('/api/chats/get', { avatar_url: locator.avatar, file_name: locator.chat });
        chats[key] = records[0]?.chat_metadata?.world_info ?? '';
    }
    const store = await account.store();
    const overrides = {};
    for (const [key, slot] of Object.entries(store.characters)) if (slot.settings?.lorebook_override) overrides[key] = slot.settings.lorebook_override;
    return { mains, extras, chats, overrides, embedded };
}

/** Opens each place in a fresh page and reports which of them show the missing-lorebook notice. */
async function readNotices(account, ids, device, label) {
    const found = {};
    const offer = page => page.locator('dialog[open]').filter({ hasText: 'This character has an embedded World/Lorebook.' });
    const watch = async (page, key) => {
        await page.waitForTimeout(3000);
        if (await offer(page).count()) {
            found[`${key}-offer`] = ['This character has an embedded World/Lorebook.'];
            await offer(page).locator('.popup-button-cancel').click();
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await select(page, ids.cards.kai);
            await page.waitForTimeout(500);
            await select(page, ids.cards[key]);
            await page.waitForTimeout(3000);
            if (await offer(page).count()) await offer(page).locator('.popup-button-cancel').click();
        }
        const list = [];
        for (const toast of await notices(page).all()) list.push((await toast.innerText()).replace(/^×\s*/, '').replace(/\s+/g, ' '));
        found[key] = list;
        if (['mia', 'conversation-group'].includes(key)) await shot(page, `${label}-${key}`, device);
        await page.evaluate(() => window.toastr?.clear());
    };
    const roleplay = await account.open({ workspace: false });
    for (const key of ['oona', 'mia', 'ed', 'cleo', 'eve', 'kai', 'pat']) {
        await select(roleplay, ids.cards[key]);
        await watch(roleplay, key);
    }
    await openGroup(roleplay, ids.groupId);
    await watch(roleplay, 'group');
    await roleplay.close();
    const conversation = await account.open({ workspace: true });
    await watch(conversation, 'conversation-nova');
    await conversation.evaluate(async ([avatar, groupId]) => {
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar, { groupId });
    }, [account.avatar, ids.conversationGroupId]);
    await watch(conversation, 'conversation-group');
    await shot(conversation, label, device);
    await conversation.close();
    return found;
}

async function openBook(page, name) {
    await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), 'world-info');
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'world-info');
    const back = page.locator('.neconyan-lorebook-back');
    if (await back.isVisible()) await back.click();
    await page.locator('.neconyan-lorebook-book-open').filter({ has: page.getByText(name, { exact: true }) }).click();
    await expect(page.locator('#world_editor_select')).toHaveValue(/.+/);
}

async function openTools(page) {
    const summary = page.locator('#neconyan-lorebook-library .world_popup_action_group--library > summary');
    if (await summary.isVisible()) await summary.click();
}

async function answerRenamedPrompt(page) {
    const confirm = page.locator('dialog.popup[open]').filter({ hasText: 'World/Lorebook renamed!' });
    const shown = await confirm.first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
    if (shown) await confirm.locator('.popup-button-ok').click();
    return shown;
}

async function removeBook(page) {
    await openTools(page);
    await page.locator('#world_popup_delete').click();
    await page.locator('dialog.popup[open] .popup-button-ok').last().click();
}

async function renameBook(page, name) {
    await openTools(page);
    await page.locator('#world_popup_name_button').click();
    const dialog = page.locator('dialog.popup[open]').last();
    await dialog.getByRole('textbox').fill(name);
    await dialog.locator('.popup-button-ok').click();
    return answerRenamedPrompt(page);
}

function chunks(buffer) {
    const list = [];
    let offset = 8;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        list.push({ type, bytes: buffer.subarray(offset, offset + 12 + length), data: buffer.subarray(offset + 8, offset + 8 + length) });
        offset += 12 + length;
    }
    return list;
}

function cardJson(chunk) {
    const text = chunk.data.toString('latin1');
    return JSON.parse(Buffer.from(text.slice(text.indexOf('\0') + 1), 'base64').toString('utf8'));
}

const isCardChunk = chunk => chunk.type === 'tEXt' && /^(chara|ccv3)\0/.test(chunk.data.toString('latin1'));

function differences(before, after, at = '') {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [at];
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => differences(before[key], after[key], at ? at + '.' + key : key));
}

/** Compares two copies of a card file: every PNG chunk except the card data must match byte for byte, and the card data may differ only in the link. */
function compareCard(before, after) {
    const left = chunks(before);
    const right = chunks(after);
    const result = { chunkTypes: left.map(chunk => chunk.type), identicalChunks: 0, changedChunks: [], changedFields: [] };
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        if (left[index] && right[index] && left[index].bytes.equals(right[index].bytes)) result.identicalChunks++;
        else result.changedChunks.push(left[index]?.type ?? 'missing');
    }
    const cardLeft = left.filter(isCardChunk);
    const cardRight = right.filter(isCardChunk);
    for (let index = 0; index < cardLeft.length; index++) result.changedFields.push(...differences(cardJson(cardLeft[index]), cardJson(cardRight[index])).map(field => `${cardLeft[index].data.toString('latin1', 0, 5)}:${field}`));
    return result;
}

for (const device of ['desktop', 'phone']) {
    const phone = device === 'phone';
    test.describe(`on ${device}`, () => {
        test.describe.configure({ mode: 'default' });
        for (const operation of ['delete', 'rename']) {
            test(`${operation} of a lorebook cleans up every link to it (${device})`, async ({ app }) => {
                test.setTimeout(480000);
                const account = await app.account({ phone });
                const page = await account.open({ workspace: false });
                const rename = operation === 'rename';
                const after = rename ? RENAMED : '';
                const cardsDir = path.join(app.dataRoot, 'default-user', 'characters');

                await book(account, TARGET, { 0: entry('Target lore.') });
                await book(account, 'target book', { 0: entry('Lower case lore.') });
                await book(account, 'Target Book Two', { 0: entry('Two lore.') });
                await book(account, 'Target', { 0: entry('Prefix lore.') });
                await book(account, 'Other Book', { 0: entry('Other lore.') });

                const cards = {
                    oona: await card(account, 'Open Oona', TARGET),
                    mia: await card(account, 'Main Mia', TARGET),
                    ed: await card(account, 'Extra Ed'),
                    cleo: await card(account, 'Chat Cleo'),
                    eve: await card(account, 'Embed Eve', TARGET, { embed: true }),
                    kai: await card(account, 'Keep Kai', 'target book'),
                    pat: await photoCard(account, 'Photo Pat', TARGET),
                };
                const embedded = (await account.post('/api/characters/get', { avatar_url: cards.eve })).data.character_book;
                expect(embedded?.entries?.length, 'the embedded copy exists before the change').toBeGreaterThan(0);
                await setExtras(page, cards.ed, ['Other Book', TARGET, 'Target Book Two']);
                await setExtras(page, cards.kai, ['Target Book Two', 'Target']);

                const chats = {};
                await select(page, cards.cleo);
                await setChatBook(page, TARGET);
                chats.cleo = { group: false, avatar: cards.cleo, chat: await chatId(page) };
                await select(page, cards.kai);
                await setChatBook(page, 'Target Book Two');
                chats.kai = { group: false, avatar: cards.kai, chat: await chatId(page) };

                const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
                    data: { avatar_url: account.avatar, file_name: 'Lorebook cleanup probe', allow_create: true } });
                const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
                const group = await account.post('/api/groups/create', { name: 'Lorebook trio', members: [cards.mia, cards.kai], activation_strategy: 1,
                    roleplay: { account: stamp, operationKey: randomUUID() } });
                await openGroup(page, group.id);
                await setChatBook(page, TARGET);
                chats.group = { group: true, chat: await chatId(page) };

                const kaiThread = await threadFor(account, { avatar: cards.kai });
                const groupStore = await account.post('/api/neconyan-conversation/store/get');
                const conversationGroup = await account.post('/api/neconyan-conversation/group/create', { name: 'Conversation trio', members: [account.avatar, cards.kai],
                    personaId: account.personaId, version: groupStore.version });
                const groupThread = await threadFor(account, { avatar: account.avatar, groupId: conversationGroup.group.id });
                await setOverrides(account, { [account.threadKey]: TARGET, [kaiThread.threadKey]: 'Target Book Two', [groupThread.threadKey]: TARGET });

                await select(page, cards.oona);
                await setChatBook(page, TARGET);
                chats.oona = { group: false, avatar: cards.oona, chat: await chatId(page) };
                await page.waitForTimeout(2500);

                const ids = { cards, chats, groupId: group.id, conversationGroupId: conversationGroup.group.id };
                const seeded = await readDisk(account, ids);
                record(`${operation}-${device}-0-setup-disk`, seeded);
                expect(seeded.mains).toMatchObject({ oona: TARGET, mia: TARGET, eve: TARGET, pat: TARGET, kai: 'target book' });
                expect(seeded.chats).toEqual({ oona: TARGET, cleo: TARGET, kai: 'Target Book Two', group: TARGET });
                expect(Object.keys(seeded.overrides).length, 'three Conversation overrides are stored').toBe(3);
                expect(await readNotices(account, ids, device, 'seeded')).toEqual(Object.fromEntries(
                    ['oona', 'mia', 'ed', 'cleo', 'eve', 'kai', 'pat', 'group', 'conversation-nova', 'conversation-group'].map(key => [key, []])));

                const files = Object.fromEntries(['mia', 'eve', 'pat'].map(key => [key, fs.readFileSync(path.join(cardsDir, cards[key]))]));

                await page.close();
                const reopened = await account.open({ workspace: false });
                await select(reopened, cards.oona);
                await openBook(reopened, TARGET);
                await shot(reopened, 'before-' + operation, device);
                let asked = false;
                if (rename) asked = await renameBook(reopened, RENAMED);
                else await removeBook(reopened);
                record(`${operation}-${device}-1-confirm-prompt-shown`, { asked });
                await reopened.waitForTimeout(4000);
                await shot(reopened, 'after-' + operation, device);
                await reopened.close();

                const changed = await readDisk(account, ids);
                record(`${operation}-${device}-2-after-disk`, changed);
                const bytes = {};
                for (const key of Object.keys(files)) bytes[key] = compareCard(files[key], fs.readFileSync(path.join(cardsDir, cards[key])));
                record(`${operation}-${device}-3-card-bytes`, bytes);
                const found = await readNotices(account, ids, device, 'after-' + operation);
                record(`${operation}-${device}-4-after-notices`, found);

                expect.soft(changed.mains).toEqual({ oona: after, mia: after, ed: '', cleo: '', eve: after, kai: 'target book', pat: after });
                expect.soft(changed.embedded.eve, 'the embedded copy is untouched').toEqual(embedded);
                expect.soft(changed.extras[cards.ed.replace(/\.[^.]+$/, '')]).toEqual(rename ? ['Other Book', RENAMED, 'Target Book Two'] : ['Other Book', 'Target Book Two']);
                expect.soft(changed.extras[cards.kai.replace(/\.[^.]+$/, '')]).toEqual(['Target Book Two', 'Target']);
                expect.soft(changed.chats).toEqual({ oona: after, cleo: after, kai: 'Target Book Two', group: after });
                expect.soft(changed.overrides).toEqual(rename
                    ? { [account.threadKey]: RENAMED, [kaiThread.threadKey]: 'Target Book Two', [groupThread.threadKey]: RENAMED }
                    : { [kaiThread.threadKey]: 'Target Book Two' });
                for (const key of ['mia', 'eve', 'pat']) {
                    expect.soft(bytes[key].changedChunks, `${key}: only the two card data chunks are rewritten`).toEqual(['tEXt', 'tEXt']);
                    expect.soft(bytes[key].changedFields, `${key}: only the link differs`).toEqual(['chara:data.extensions.world', 'ccv3\u0000:data.extensions.world']);
                }
                expect.soft(Object.fromEntries(Object.entries(found).filter(([key]) => !key.endsWith('-offer')).map(([key, texts]) => [key, texts.length]))).toEqual(Object.fromEntries(['oona', 'mia', 'ed', 'cleo', 'eve', 'kai', 'pat', 'group', 'conversation-nova', 'conversation-group'].map(key => [key, 0])));
                expect.soft(asked, 'no question is asked: every link is moved').toBe(false);
            });
        }
    });
}

for (const device of ['desktop', 'phone']) {
    const phone = device === 'phone';
    test.describe(`failure on ${device}`, () => {
        test.describe.configure({ mode: 'default' });
        test(`a card that cannot be saved is reported and the rest still finish (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            let page = await account.open({ workspace: false });
            await book(account, TARGET, { 0: entry('Target lore.') });
            const cards = {
                mia: await card(account, 'Main Mia', TARGET),
                pat: await card(account, 'Plain Pat', TARGET),
                cleo: await card(account, 'Chat Cleo'),
                oona: await card(account, 'Open Oona'),
            };
            await select(page, cards.cleo);
            await setChatBook(page, TARGET);
            const chats = { cleo: { group: false, avatar: cards.cleo, chat: await chatId(page) } };
            await setOverrides(account, { [account.threadKey]: TARGET });
            await select(page, cards.oona);
            await page.waitForTimeout(2500);
            await page.close();
            page = await account.open({ workspace: false });
            await select(page, cards.oona);

            await page.route('**/api/characters/merge-attributes', async route => {
                if (route.request().postData()?.includes(cards.mia)) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The disk is full.' }) });
                else await route.continue();
            });
            await openBook(page, TARGET);
            await removeBook(page);
            const failure = page.locator('.toast-error').filter({ hasText: 'Lorebook links not fully updated' });
            await expect(failure).toHaveCount(1, { timeout: 30000 });
            await shot(page, 'failure', device);
            await expect(failure).toContainText('Main Mia: The disk is full.');
            await expect(failure).not.toContainText('Plain Pat');
            await expect(failure).not.toContainText('Chat Cleo');
            await page.waitForTimeout(1500);

            const disk = await readDisk(account, { cards, chats });
            record(`failure-${device}-disk`, disk);
            expect(disk.mains, 'the card that failed keeps its link, the others are cleared').toEqual({ mia: TARGET, pat: '', cleo: '', oona: '' });
            expect(disk.chats, 'the closed chat was still updated').toEqual({ cleo: '' });
            expect(disk.overrides, 'the Conversation override was still removed').toEqual({});
            await page.close();

            const reopened = await account.open({ workspace: false });
            await select(reopened, cards.mia);
            await expect(notices(reopened)).toHaveCount(1, { timeout: 20000 });
            await expect(notices(reopened)).toContainText('\'Target Book\' is the main lorebook of Main Mia.');
        });

        test(`a failed open card, open chat or extra-lorebook save keeps its link and reports once (${device})`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            let page = await account.open({ workspace: false });
            await book(account, TARGET, { 0: entry('Target lore.') });
            const cards = {
                mia: await card(account, 'Main Mia', TARGET),
                ed: await card(account, 'Extra Ed'),
                pat: await card(account, 'Plain Pat', TARGET),
            };
            await select(page, cards.mia);
            await setChatBook(page, TARGET);
            const chats = { mia: { group: false, avatar: cards.mia, chat: await chatId(page) } };
            await setExtras(page, cards.ed, [TARGET]);
            await page.waitForTimeout(2500);
            await page.close();
            page = await account.open({ workspace: false });
            await select(page, cards.mia);

            await page.route('**/api/characters/merge-attributes', async route => {
                if (route.request().postData()?.includes(cards.mia)) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The disk is full.' }) });
                else await route.continue();
            });
            await page.route(/\/api\/chats\/(save|patch)$/, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chat disk full.' }) }));
            await page.route('**/api/settings/save', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Settings disk full.' }) }));

            await openBook(page, TARGET);
            await removeBook(page);
            const failure = page.locator('.toast-error').filter({ hasText: 'Lorebook links not fully updated' });
            await expect(failure).toHaveCount(1, { timeout: 30000 });
            await expect(failure.locator('li')).toHaveCount(3);
            await expect(failure).toContainText('this chat: The chat could not be saved.');
            await expect(failure).toContainText('extra lorebooks of characters: Settings could not be saved.');
            await expect(failure).toContainText('Main Mia: The disk is full.');
            await expect(failure).not.toContainText('Plain Pat');

            const memory = await page.evaluate(async edKey => {
                const world = await import('/scripts/world-info.js');
                const context = window.SillyTavern.getContext();
                return {
                    openCardField: window.document.getElementById('character_world')?.value ?? '',
                    openChatBook: context.chatMetadata?.world_info ?? '',
                    edExtras: world.world_info.charLore?.find(item => item.name === edKey)?.extraBooks ?? [],
                };
            }, cards.ed.replace(/\.[^.]+$/, ''));
            expect(memory.openCardField, 'the open card editor keeps its link when the card save failed').toBe(TARGET);
            expect(memory.openChatBook, 'the open chat restores its link when the chat save failed').toBe(TARGET);
            expect(memory.edExtras, 'extra lorebooks restore their links when settings save failed').toEqual([TARGET]);

            const disk = await readDisk(account, { cards, chats });
            expect(disk.mains, 'other cards still finish while the failed one stays linked').toEqual({ mia: TARGET, ed: '', pat: '' });
            expect(disk.chats, 'the failed open chat stays linked on disk').toEqual({ mia: TARGET });
            expect(disk.extras[cards.ed.replace(/\.[^.]+$/, '')], 'the failed extra lorebooks stay linked on disk').toEqual([TARGET]);
        });
    });
}

/* global document, window, MutationObserver, getComputedStyle */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
// Editing the members of a group DM in place: the group keeps its history, a removed pal keeps their own DM, and every open page follows.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'serial' });
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires the disposable fixture.');
test.setTimeout(420000);

const CONFIG = '/api/neconyan-conversation';
const SAVE = '[data-sb-conversation-action="save-conversation-group-members"]';
const FORK = '[data-sb-conversation-action="create-conversation-group"]';
const CANCEL = '[data-sb-conversation-action="cancel-conversation-group"]';
const HEADER_ADD = '.sb-conversation-header-add-member[data-sb-conversation-action="open-add-member"]';
const DRAWER = '#sb_conversation_settings_drawer';
const TOO_FEW = 'A group DM needs at least two pals. To end this one, use its bin button in Pals.';
const REGENERATE_NOTICE = name => `This message cannot be regenerated because ${name} is no longer in this group DM. Add them back with Edit members to regenerate it.`;
const groupConfirm = name => `Delete the group DM '${name}'? The group, its settings, and every member's messages and memory summaries in it will be removed, and its members will stop chatting in it. Each member's own DM is kept. This cannot be undone.`;

// ---------- fixture helpers (the shapes M76's e2e uses) ----------
async function addCard(account, name) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
        ch_name: name, description: `${name} is a test pal.`, first_mes: 'Hello.', mes_example: `${name}: Hello.` } });
    expect(created.ok(), `creating the card named ${name}`).toBe(true);
    return { avatar: await created.text(), name };
}

/** A pal with a card and a solo DM of one message (so it has a solo record). */
async function addPal(account, name, { solo = true } = {}) {
    const pal = await addCard(account, name);
    if (!solo) return { ...pal, threadKey: null };
    const current = await account.post(`${CONFIG}/store/get`);
    const thread = await account.post(`${CONFIG}/thread/save`, { avatar: pal.avatar, personaId: account.personaId, version: current.version,
        messages: [{ id: `seed-${pal.avatar.replace(/[^A-Za-z0-9]/g, '')}`, role: 'user', name: 'User', mes: `Original question for ${name}.`, timestamp: 1700000000000 }] });
    await account.changeStore(store => {
        Object.assign(store.characters[thread.threadKey].settings, { enabled: true, availability: 'online', reply_delay_multiplier: 0,
            connection_profile: 'durable', auto_message: false, proactive_messaging: false, auto_character_chat: false,
            roleplay_reactions: false, multi_char: false, image_gen_enabled: false });
    });
    return { ...pal, threadKey: thread.threadKey };
}

/** The five pals every case uses: A (the account's own, with a solo DM), B, C, D with solo DMs, E with a card and no solo record. */
async function addPals(account) {
    const A = { avatar: account.avatar, threadKey: account.threadKey, name: 'Durable Nova' };
    const B = await addPal(account, 'Scratch Kit');
    const C = await addPal(account, 'Scratch Mochi');
    const D = await addPal(account, 'Scratch Dot');
    const E = await addPal(account, 'Scratch Echo', { solo: false });
    return { A, B, C, D, E };
}

const plainReply = app => { app.provider.mode.reply = { choices: [{ message: { content: 'Plain reply.' } }] }; };

async function serverMode(account) {
    const current = await account.post(`${CONFIG}/store/get`);
    await account.post(`${CONFIG}/automation/configure`, { mode: 'server', timeZone: 'UTC', version: current.version });
}

async function openRecorded(account, avatar, groupId = null, { newPage = null } = {}) {
    const page = newPage || await account.context.newPage();
    await page.route('**/api/server-admin/status', route => route.fulfill({ status: 403, json: { error: 'outside fixture' } }));
    page.setDefaultTimeout(20000);
    await page.addInitScript(() => {
        window.__toasts = [];
        const start = () => new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
                if (node.nodeType === 1 && node.matches?.('.toast, .toast-message')) window.__toasts.push({ text: node.innerText || node.textContent, html: node.innerHTML, cls: String(node.className || '') });
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
        if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    if (avatar) await openWorkspace(page, avatar, groupId);
    return page;
}

async function openWorkspace(page, avatar, groupId = null) {
    await page.evaluate(async ({ avatar, groupId }) => {
        await window.SillyTavern.getContext().getCharacters();
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar, groupId ? { groupId } : undefined);
    }, { avatar, groupId });
    await expect(page.locator('#sb_conversation_input')).toBeVisible();
}

async function reloadToWorkspace(page, avatar, groupId = null) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    if (avatar) await openWorkspace(page, avatar, groupId);
    await delay(1000);
}

const railRows = page => page.evaluate(() => [...document.querySelectorAll('.sb-conversation-pal')].map(row => ({ avatar: row.dataset.avatar, groupId: row.dataset.groupId || '' })));

async function openRail(page) {
    if (!await page.locator('.sb-conversation-pal').first().isVisible()) await page.locator('[data-sb-conversation-action="toggle-pals"]').click();
    await expect(page.locator('.sb-conversation-pal').first()).toBeVisible();
}

const savedVersion = page => page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).getConversationSavedVersion());

async function waitPageSynced(account, page, timeout = 30000) {
    await expect.poll(async () => await savedVersion(page) === (await account.post(`${CONFIG}/store/get`)).version, { timeout, intervals: [500] }).toBe(true);
}

const pageStore = page => page.evaluate(async () => structuredClone((await import('/scripts/neconyan-conversation/context.js')).getConversationStore()));
const toastsOf = page => page.evaluate(() => window.__toasts || []);
const clearToasts = page => page.evaluate(() => { window.__toasts = []; });
const selectedGroup = page => page.evaluate(async () => (await import('/scripts/neconyan-conversation/state.js')).conversationState.conversationSelectedGroupId);

async function editControl(page, controlKey) {
    return page.evaluate(async ({ controlKey }) => {
        const context = await import('/scripts/neconyan-conversation/context.js');
        const sync = await import('/scripts/neconyan-conversation/store-sync.js');
        context.getConversationStore().characters[controlKey].settings.authors_note = `probe ${Date.now()}`;
        context.persistConversationStore();
        return sync.flushConversationStore();
    }, { controlKey });
}

const jobsList = async account => (await (await account.context.request.get('/api/jobs/list', { headers: account.headers })).json()).jobs;

// ---------- group helpers ----------
const prefixOf = (store, groupId) => Object.keys(store.characters).filter(key => key.includes(`group:${groupId}:`));
const avatarOfKey = (key, groupId) => key.slice(key.indexOf(`group:${groupId}:`) + `group:${groupId}:`.length);
const messageIds = (store, groupId) => prefixOf(store, groupId).flatMap(key => Object.values(store.characters[key].branches || {}).flatMap(branch => (branch.messages || []).map(message => message.id))).sort();
const groupOf = (store, groupId) => store.groups.find(group => group.id === groupId);

/** The one server key under the group's prefix: the holder's. */
async function holderOf(account, groupId) {
    const store = await account.store();
    const keys = prefixOf(store, groupId);
    expect(keys.length, `one key under the group prefix: ${keys.join(', ')}`).toBe(1);
    return { key: keys[0], avatar: avatarOfKey(keys[0], groupId), thread: store.characters[keys[0]] };
}

async function pickMembers(page, members) {
    await openRail(page);
    await page.locator('[data-sb-conversation-action="open-new-group-chat"]').click();
    const picker = page.locator('#sb_conversation_add_dm_picker');
    await expect(picker).toBeVisible();
    for (const avatar of members) {
        const checkbox = picker.locator(`input.sb-conversation-group-member-checkbox[value="${avatar}"]`);
        if (!await checkbox.isChecked()) await checkbox.check();
    }
    await picker.locator(FORK).click();
}

async function sendInGroup(account, page, text) {
    await page.locator('#sb_conversation_input').fill(text);
    const response = page.waitForResponse(item => item.url().endsWith('/reply/submit'));
    await page.locator('#sb_conversation_send').click();
    const accepted = await response;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const { job } = await accepted.json();
    await account.settled(job.id);
}

/** A group made through the rail picker and messaged once (it then has a thread with history at one key). */
async function makeGroup(account, page, members) {
    const before = (await account.store()).groups.map(group => group.id);
    await pickMembers(page, members);
    let group;
    await expect.poll(async () => {
        group = (await account.store()).groups.find(item => !before.includes(item.id) && members.every(member => item.members.includes(member)));
        return Boolean(group);
    }, { timeout: 30000, intervals: [500] }).toBe(true);
    await expect.poll(() => selectedGroup(page), { timeout: 15000 }).toBe(group.id);
    await sendInGroup(account, page, `Hello ${group.name}.`);
    // Each member's reply is its own job, and the later speakers follow up to half a minute after the first: the group is ready when every member has replied and no
    // job is open, so no reply lands after a case has recorded its message ids.
    let steady = 0;
    let lastIds = '';
    await expect.poll(async () => {
        const open = (await jobsList(account)).filter(job => !['completed', 'failed', 'cancelled'].includes(job.state)).length;
        const store = await account.store();
        const ids = JSON.stringify(messageIds(store, group.id));
        const replies = prefixOf(store, group.id).flatMap(key => Object.values(store.characters[key].branches || {}).flatMap(branch => branch.messages || [])).filter(message => message.role !== 'user').length;
        steady = open === 0 && ids === lastIds ? steady + 1 : 0;
        lastIds = ids;
        return replies >= members.length && steady >= 2;
    }, { timeout: 120000, intervals: [1000] }).toBe(true);
    await waitPageSynced(account, page, 40000);
    return group;
}

async function closePals(page) {
    if (await page.locator('#sb_conversation_pals_rail[data-open="true"]').count()) await page.locator('[data-sb-conversation-action="close-pals"]').click();
}

async function openEditorFromHeader(page) {
    await closePals(page);
    await page.locator(HEADER_ADD).click();
    await expect(page.locator('#sb_conversation_pals_rail[data-open="true"]')).toBeVisible();
    await expect(page.locator('#sb_conversation_add_dm_picker')).toBeVisible();
}

async function openDrawer(page) {
    await closePals(page);
    await page.locator('#sb_conversation_header [data-sb-conversation-action="open-settings"], .sb-conversation-header-settings').first().click();
    await expect(page.locator(DRAWER)).toBeVisible();
    await page.locator('[data-sb-conversation-settings-section="prompt-context"]').click();
}

const tick = (page, avatar, on = true) => page.locator(`#sb_conversation_add_dm_picker input.sb-conversation-group-member-checkbox[value="${avatar}"]`).setChecked(on);

function soloRecord(store, key) {
    const record = store.characters[key];
    // Opening a drawer can materialise these defaults on a legacy record.
    // Missing fields and their defaults represent the same saved memory.
    return record ? { memorySummary: '', memoryMessageCount: 0, memoryUpdatedAt: 0, ...structuredClone(record) } : null;
}

/** The avatar's solo record on the server and in each page copy. */
async function captureSolo(account, pages, avatar) {
    for (const [index, page] of pages.entries()) {
        expect(await page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).flushConversationStore()), `page ${index}: the store flushes`).toBe(true);
    }
    const key = account.personaId ? `persona:${account.personaId}:${avatar}` : avatar;
    const find = store => soloRecord(store, key);
    return { key, server: find(await account.store()), pages: await Promise.all(pages.map(async page => find(await pageStore(page)))) };
}

/** A removed pal is gone from the group everywhere, and their solo record is exactly as it was. */
async function expectMemberGoneEverywhere(account, pages, { groupId, avatar, soloBefore, control }) {
    for (const [index, page] of pages.entries()) {
        expect(await editControl(page, control), `page ${index}: the control edit saves`).toBe(true);
    }
    const gone = (store, where, soloExpected) => {
        expect(prefixOf(store, groupId).some(key => avatarOfKey(key, groupId) === avatar), `${where}: no key parses to ${avatar} in the group`).toBe(false);
        expect(prefixOf(store, groupId).length, `${where}: exactly one key under the group prefix`).toBe(1);
        expect(groupOf(store, groupId), `${where}: the group record`).toBeTruthy();
        expect(groupOf(store, groupId).members.includes(avatar), `${where}: the group lacks ${avatar}`).toBe(false);
        expect(soloRecord(store, soloBefore.key), `${where}: the solo record is as it was`).toEqual(soloExpected);
    };
    gone(await account.store(), 'server', soloBefore.server);
    for (const [index, page] of pages.entries()) gone(await pageStore(page), `page ${index}`, soloBefore.pages[index]);
}

const requestsTo = (page, path) => {
    const seen = [];
    page.on('request', request => { if (request.url().includes(path)) seen.push(request.url()); });
    return seen;
};

// ---------- the cases ----------
test('E1 adding a pal keeps the group and its history', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    const before = await account.store();
    const idsBefore = messageIds(before, G.id);
    const groupsBefore = before.groups.length;
    await openEditorFromHeader(page);
    await tick(page, D.avatar);
    const save = page.locator(`#sb_conversation_add_dm_picker ${SAVE}`);
    await (await save.count() ? save : page.locator(`#sb_conversation_add_dm_picker ${FORK}`)).click();
    await expect.poll(async () => (await account.store()).groups.length > groupsBefore || (groupOf(await account.store(), G.id)?.members || []).includes(D.avatar), { timeout: 30000 }).toBe(true);
    const after = await account.store();
    expect(after.groups.length, 'no second group').toBe(groupsBefore);
    expect(groupOf(after, G.id).members).toContain(D.avatar);
    expect(messageIds(after, G.id)).toEqual(idsBefore);
    await page.close();
});

test('E1b removing a pal who does not hold the thread', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    const holder = await holderOf(account, G.id);
    // The one that is not the holder: remove a member who is not it.
    const leaving = [A, B, C].find(pal => pal.avatar !== holder.avatar);
    const stay = [A, B, C].filter(pal => pal.avatar !== leaving.avatar);
    const idsBefore = messageIds(await account.store(), G.id);
    const soloBefore = await captureSolo(account, [page], leaving.avatar);
    await openEditorFromHeader(page);
    await tick(page, leaving.avatar, false);
    await tick(page, D.avatar);
    await page.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    const names = [...stay, D].map(pal => pal.name);
    await expect.poll(async () => groupOf(await account.store(), G.id).members.includes(leaving.avatar), { timeout: 30000 }).toBe(false);
    const stored = groupOf(await account.store(), G.id);
    expect(stored.members).toEqual([...stay.map(pal => pal.avatar), D.avatar]);
    expect(stored.name, 'an automatic name follows the members').toBe(`Group: ${names.join(', ')}`);
    expect(messageIds(await account.store(), G.id)).toEqual(idsBefore);
    await expect.poll(async () => (await holderOf(account, G.id)).avatar, { timeout: 15000 }).toBe(holder.avatar);
    const portraitFiles = () => page.evaluate(() => [...document.querySelectorAll('.sb-conversation-message')].map(item => item.querySelector('[data-avatar-file]')?.dataset.avatarFile || ''));
    expect(await portraitFiles(), 'the removed pal\'s turns keep their portrait').toContain(leaving.avatar);
    await expectMemberGoneEverywhere(account, [page], { groupId: G.id, avatar: leaving.avatar, soloBefore, control: D.threadKey });
    await reloadToWorkspace(page, holder.avatar, G.id);
    expect(messageIds(await pageStore(page), G.id)).toEqual(idsBefore);
    expect((await railRows(page)).filter(row => row.groupId === G.id).length, 'one rail row').toBe(1);
    const reloaded = groupOf(await account.store(), G.id);
    expect(reloaded.members, 'after the reload the members are the same').toEqual([...stay.map(pal => pal.avatar), D.avatar]);
    expect(reloaded.name, 'after the reload the name is the same').toBe(`Group: ${names.join(', ')}`);
    const inPage = groupOf(await pageStore(page), G.id);
    expect(inPage.members, 'the reloaded page holds the same members').toEqual(reloaded.members);
    expect(inPage.name, 'the reloaded page holds the same name').toBe(reloaded.name);
    await expect.poll(portraitFiles, { timeout: 15000 }).toContain(leaving.avatar);
    await page.close();
});

test('E2 from DM settings, removing the holder keeps the open group', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    const holder = await holderOf(account, G.id);
    const idsBefore = messageIds(await account.store(), G.id);
    const soloBefore = await captureSolo(account, [page], holder.avatar);
    await openDrawer(page);
    await page.locator('#sb_conv_auto_chat_cooldown').fill('7');
    await page.locator(`${DRAWER} [data-sb-conversation-action="open-add-member"]`).click();
    await expect(page.locator(DRAWER)).toBeHidden();
    await expect(page.locator('#sb_conversation_pals_rail[data-open="true"]')).toBeVisible();
    await expect(page.locator(`#sb_conversation_add_dm_picker ${SAVE}`)).toBeVisible();
    await expect.poll(async () => (await account.store()).characters[holder.key].settings.auto_chat_cooldown, { timeout: 10000 }).toBe(7);
    await tick(page, holder.avatar, false);
    await page.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    await expect.poll(async () => groupOf(await account.store(), G.id).members.includes(holder.avatar), { timeout: 30000 }).toBe(false);
    const now = await holderOf(account, G.id);
    expect(now.avatar).not.toBe(holder.avatar);
    expect(now.thread.settings.auto_chat_cooldown, 'the drawer value moved with the thread').toBe(7);
    expect(await selectedGroup(page)).toBe(G.id);
    expect(messageIds(await account.store(), G.id)).toEqual(idsBefore);
    const portraits = await page.evaluate(() => [...document.querySelectorAll('.sb-conversation-message')].map(item => ({ id: item.dataset.messageId, file: item.querySelector('[data-avatar-file]')?.dataset.avatarFile || '' })));
    expect(portraits.some(item => item.file === holder.avatar), 'the removed pal still has a portrait on their old messages').toBe(true);
    const stack = await page.evaluate(() => document.querySelector('#sb_conversation_header [data-sb-conversation-participants]')?.innerHTML || '');
    expect(stack.includes(encodeURIComponent(holder.avatar)), 'the header stack lacks the removed pal').toBe(false);
    await expectMemberGoneEverywhere(account, [page], { groupId: G.id, avatar: holder.avatar, soloBefore, control: D.threadKey });
    await reloadToWorkspace(page, now.avatar, G.id);
    expect(messageIds(await pageStore(page), G.id)).toEqual(idsBefore);
    await expectMemberGoneEverywhere(account, [page], { groupId: G.id, avatar: holder.avatar, soloBefore, control: D.threadKey });
    await page.close();
});

test('E2b another tab with DM settings open on the removed holder follows the group', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const first = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, first, [A.avatar, B.avatar, C.avatar]);
    const holder = await holderOf(account, G.id);
    const second = await openRecorded(account, holder.avatar, G.id);
    await waitPageSynced(account, second, 40000);
    const soloBefore = await captureSolo(account, [first, second], holder.avatar);
    await openDrawer(second);
    await second.locator('#sb_conv_auto_chat_cooldown').fill('9');
    await openEditorFromHeader(first);
    await tick(first, holder.avatar, false);
    const idsBefore = messageIds(await account.store(), G.id);
    await first.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    await expect(second.locator(DRAWER), 'the second drawer closes').toBeHidden({ timeout: 30000 });
    await expect.poll(() => selectedGroup(second), { timeout: 30000 }).toBe(G.id);
    await expect.poll(async () => messageIds(await pageStore(second), G.id), { timeout: 30000 }).toEqual(idsBefore);
    await expect.poll(async () => (await holderOf(account, G.id)).thread.settings.auto_chat_cooldown, { timeout: 30000 }).toBe(9);
    await expectMemberGoneEverywhere(account, [first, second], { groupId: G.id, avatar: holder.avatar, soloBefore, control: D.threadKey });
    await delay(45000);
    expect(prefixOf(await account.store(), G.id).some(key => avatarOfKey(key, G.id) === holder.avatar), 'no key for the removed pal 45 s later').toBe(false);
    await first.close();
    await second.close();
});

test('E3 the others carry on and the removed member is silent', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    await account.changeStore(store => {
        Object.assign(groupOf(store, G.id).conversation_settings, { auto_character_chat: true, auto_chat_cooldown: 1 });
        for (const key of prefixOf(store, G.id)) Object.assign(store.characters[key].settings, { auto_character_chat: true, auto_chat_cooldown: 1, multi_char: true });
    });
    const holder = await holderOf(account, G.id);
    const gonePal = [A, B, C].find(pal => pal.avatar === holder.avatar);
    const soloBefore = await captureSolo(account, [page], gonePal.avatar);
    const startedAt = Date.now();
    await openEditorFromHeader(page);
    await tick(page, gonePal.avatar, false);
    await page.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    await expect.poll(async () => groupOf(await account.store(), G.id).members.includes(gonePal.avatar), { timeout: 30000 }).toBe(false);
    const countAuto = store => prefixOf(store, G.id).flatMap(key => Object.values(store.characters[key].branches || {}).flatMap(branch => branch.messages || []))
        .filter(message => message.extra?.conversation_mode_auto_chat);
    const editedAt = Date.now();
    const baseline = countAuto(await account.store()).length;
    await delay(170000);
    const store = await account.store();
    const fresh = countAuto(store).slice(baseline);
    expect(fresh.length, 'at least one new automatic message').toBeGreaterThanOrEqual(1);
    const late = prefixOf(store, G.id).flatMap(key => Object.values(store.characters[key].branches || {}).flatMap(branch => branch.messages || []))
        .filter(message => (message.created_at || 0) >= editedAt - 1000);
    expect(late.filter(message => message.extra?.partner_avatar === gonePal.avatar || (message.role === 'character' && message.name === gonePal.name)), 'nothing from the removed pal').toEqual([]);
    const open = (await jobsList(account)).filter(job => job.target?.id === holder.key && !['completed', 'failed', 'cancelled'].includes(job.state));
    expect(open, 'no open job on the old key').toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThan(170000);
    await expectMemberGoneEverywhere(account, [page], { groupId: G.id, avatar: gonePal.avatar, soloBefore, control: D.threadKey });
    await page.close();
});

test('E4 Start a new group instead leaves the group as it is', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    const before = await account.store();
    const snapshot = { members: groupOf(before, G.id).members, name: groupOf(before, G.id).name, ids: messageIds(before, G.id), keys: prefixOf(before, G.id) };
    const requests = requestsTo(page, '/group/members');
    await openEditorFromHeader(page);
    await tick(page, D.avatar);
    await page.locator(`#sb_conversation_add_dm_picker ${FORK}`).click();
    await expect.poll(async () => (await account.store()).groups.length, { timeout: 30000 }).toBe(before.groups.length + 1);
    const after = await account.store();
    const created = after.groups.find(group => !before.groups.some(item => item.id === group.id));
    expect([...created.members].sort()).toEqual([A.avatar, B.avatar, C.avatar, D.avatar].sort());
    expect(messageIds(after, created.id)).toEqual([]);
    await expect.poll(() => selectedGroup(page), { timeout: 15000 }).toBe(created.id);
    for (const store of [after, await pageStore(page)]) {
        expect(groupOf(store, G.id).members).toEqual(snapshot.members);
        expect(groupOf(store, G.id).name).toBe(snapshot.name);
        expect(messageIds(store, G.id)).toEqual(snapshot.ids);
        expect(prefixOf(store, G.id)).toEqual(snapshot.keys);
    }
    expect(requests, 'no /group/members request').toEqual([]);
    await page.close();
});

test('E5 another tab follows, with its drawer and Games open', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { B, C, E } = await addPals(account);
    const first = await openRecorded(account, B.avatar);
    const G2 = await makeGroup(account, first, [E.avatar, B.avatar, C.avatar]);
    const holder = await holderOf(account, G2.id);
    // E has no solo record, so its group key is the only thread it has: E is the group's holder.
    expect(holder.avatar, 'E holds the group').toBe(E.avatar);
    const second = await openRecorded(account, holder.avatar, G2.id);
    await waitPageSynced(account, second, 40000);
    // Games opened the way conversation-games-group-dm.e2e.js opens it (the button sits behind 'Chat tools' until that is clicked), so its listener is live, then closed with its own control.
    const gamesButton = second.locator('.sb-conversation-quick-actions [data-sb-conversation-action="games"]');
    if (!await gamesButton.isVisible()) await second.locator('#sb_conversation_toggle_tools').click();
    await gamesButton.click();
    await expect(second.locator('#neconyan-conversation-games')).toBeVisible();
    await second.locator('#neconyan-conversation-games button[aria-label="Close games"]').click();
    await expect(second.locator('#neconyan-conversation-games')).toBeHidden();
    const leaving = holder.avatar;
    const soloBefore = await captureSolo(account, [first, second], leaving);
    const idsBefore = messageIds(await account.store(), G2.id);
    await openDrawer(second);
    await second.locator('#sb_conv_auto_chat_cooldown').fill('9');
    await openEditorFromHeader(first);
    await tick(first, leaving, false);
    await first.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    await expect(second.locator(DRAWER)).toBeHidden({ timeout: 30000 });
    await expect.poll(() => selectedGroup(second), { timeout: 30000 }).toBe(G2.id);
    await expect.poll(async () => messageIds(await pageStore(second), G2.id), { timeout: 30000 }).toEqual(idsBefore);
    await expect.poll(async () => (await holderOf(account, G2.id)).thread.settings.auto_chat_cooldown, { timeout: 30000 }).toBe(9);
    await expectMemberGoneEverywhere(account, [first, second], { groupId: G2.id, avatar: leaving, soloBefore, control: C.threadKey });
    await delay(45000);
    expect(prefixOf(await account.store(), G2.id).some(key => avatarOfKey(key, G2.id) === leaving)).toBe(false);
    await first.close();
    await second.close();
});

test('E6 a group cannot drop below two', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar]);
    const before = await account.store();
    const requests = requestsTo(page, '/group/members');
    await openEditorFromHeader(page);
    await tick(page, A.avatar, false);
    await expect(page.locator('#sb_conversation_group_selected_count')).toHaveText(TOO_FEW);
    await expect(page.locator(`#sb_conversation_add_dm_picker ${SAVE}`)).toBeDisabled();
    await expect(page.locator(`#sb_conversation_add_dm_picker ${FORK}`)).toBeDisabled();
    await page.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click({ force: true });
    await page.locator(`#sb_conversation_add_dm_picker ${FORK}`).click({ force: true });
    await page.locator(`#sb_conversation_add_dm_picker ${CANCEL}`).click();
    await expect(page.locator('#sb_conversation_add_dm_picker')).toBeHidden();
    const after = await account.store();
    expect(groupOf(after, G.id).members).toEqual(groupOf(before, G.id).members);
    expect(groupOf(after, G.id).name).toBe(groupOf(before, G.id).name);
    expect(messageIds(after, G.id)).toEqual(messageIds(before, G.id));
    expect(requests, 'no /group/members request').toEqual([]);
    await page.close();
});

test('E7 a removed pal\'s old messages', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    const holder = await holderOf(account, G.id);
    const gonePal = [A, B, C].find(pal => pal.avatar === holder.avatar);
    const oldMessage = holder.thread.branches.main.messages.find(message => message.role === 'character');
    expect(oldMessage, 'the holder spoke in the group').toBeTruthy();
    const soloBefore = await captureSolo(account, [page], gonePal.avatar);
    await openEditorFromHeader(page);
    await tick(page, gonePal.avatar, false);
    await page.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    await expect.poll(async () => groupOf(await account.store(), G.id).members.includes(gonePal.avatar), { timeout: 30000 }).toBe(false);
    await closePals(page);
    const rewrites = requestsTo(page, '/rewrite/submit');
    await clearToasts(page);
    const row = page.locator(`article.sb-conversation-message[data-message-id="${oldMessage.id}"]`);
    await row.locator('.sb-conversation-more-actions').click();
    await page.locator(`[data-sb-conversation-action="regenerate-message"][data-message-id="${oldMessage.id}"]`).click();
    await expect.poll(async () => (await toastsOf(page)).map(toast => toast.text).some(text => text.includes(REGENERATE_NOTICE(oldMessage.name))), { timeout: 10000 }).toBe(true);
    expect(rewrites, 'nothing was sent to regenerate').toEqual([]);
    await row.locator('.sb-conversation-more-actions').click();
    await page.locator(`[data-sb-conversation-action="reply-message"][data-message-id="${oldMessage.id}"]`).click();
    await page.locator('#sb_conversation_input').fill('Still there?');
    await clearToasts(page);
    const sent = page.waitForResponse(item => item.url().endsWith('/reply/submit'));
    await page.locator('#sb_conversation_send').click();
    const accepted = await sent;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const { job } = await accepted.json();
    await account.settled(job.id);
    expect((await toastsOf(page)).filter(toast => /toast-error/.test(toast.cls || '')).map(toast => toast.text), 'no error toast when the reply is sent').toEqual([]);
    const store = await account.store();
    const thread = store.characters[(await holderOf(account, G.id)).key];
    const mine = thread.branches.main.messages.find(message => message.role === 'user' && message.mes === 'Still there?');
    expect(mine?.extra?.conversation_reply_to?.messageId, 'the reply names the old message').toBe(oldMessage.id);
    await expect.poll(async () => {
        const latest = (await account.store()).characters[(await holderOf(account, G.id)).key].branches.main.messages;
        const after = latest.slice(latest.findIndex(message => message.id === mine.id) + 1);
        return after.filter(message => message.role !== 'user' && message.extra?.partner_avatar !== gonePal.avatar && !(message.role === 'character' && message.name === gonePal.name)).length;
    }, { timeout: 60000, intervals: [1000] }).toBeGreaterThan(0);
    await expectMemberGoneEverywhere(account, [page], { groupId: G.id, avatar: gonePal.avatar, soloBefore, control: D.threadKey });
    await page.close();
});

// ---------- Home rows drawn before a member change ----------
/** G(A, B, C) created through the API with one message as A, a second chat on A's solo DM, then Home open and the row in the page. */
async function staleHomeSetup(account, app, { name, members }) {
    plainReply(app);
    const { A, B, C } = await addPals(account);
    const current = await account.post(`${CONFIG}/store/get`);
    const { group } = await account.post(`${CONFIG}/group/create`, { version: current.version, personaId: account.personaId, members: members(A, B, C), name,
        settings: { enabled: true, availability: 'online' } });
    const latest = await account.post(`${CONFIG}/store/get`);
    await account.post(`${CONFIG}/message/append`, { avatar: A.avatar, groupId: group.id, personaId: account.personaId, version: latest.version, text: `Hello ${name}.` });
    await account.changeStore(store => {
        const solo = store.characters[A.threadKey];
        solo.branches.second = { ...JSON.parse(JSON.stringify(solo.branches.main)), id: 'second', name: 'Second chat', createdAt: Date.now() };
        delete solo.branches.second.navigationId;
    });
    const page = await openRecorded(account, B.avatar);
    await page.locator('[data-sb-conversation-action="close-pals"]').click({ timeout: 3000 }).catch(() => {});
    await page.locator('[data-neconyan-route="home"]:visible').first().click();
    await page.waitForFunction(() => !document.querySelector('.neconyan-home-booting'));
    const row = page.locator(`article.recentChat[data-recent-chat-type="conversation"][data-avatar="${A.avatar}"][data-group="${group.id}"]`);
    await page.evaluate(() => document.querySelector('.welcomeRecentShell')?.scrollIntoView());
    for (let click = 0; click < 6 && !await row.count(); click++) {
        if (!await page.evaluate(() => { const more = document.querySelector('.showMoreChats'); more?.click(); return Boolean(more); })) break;
        await delay(300);
    }
    await expect(row).toBeVisible();
    return { A, B, C, group, page, row };
}

/** The change the route leaves, made from the API only: A leaves, G's key moves from A to B. */
async function memberChangeBehindHome(account, { A, B, group, mute = [] }) {
    await account.changeStore(store => {
        const target = store.groups.find(item => item.id === group.id);
        target.members = target.members.filter(member => member !== A.avatar);
        target.disabled_members = mute;
        const prefix = Object.keys(store.characters).find(key => key.includes(`group:${group.id}:${A.avatar}`));
        if (prefix) {
            const moved = store.characters[prefix];
            delete store.characters[prefix];
            moved.threadAvatar = B.avatar;
            store.characters[prefix.replace(`group:${group.id}:${A.avatar}`, `group:${group.id}:${B.avatar}`)] = moved;
        }
    });
}

async function staleHomeSync(account, page, row, A, group) {
    await page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).refreshConversationStore());
    await waitPageSynced(account, page, 40000);
    // Precondition: Home did not redraw, so the row still carries the removed pal.
    expect(await page.locator(`article.recentChat[data-avatar="${A.avatar}"][data-group="${group.id}"]`).count(), 'the stale row is still in the page').toBeGreaterThan(0);
    return row;
}

test('E8 a Home row drawn before a member change deletes and renames in the group, never in the removed pal\'s DM', async ({ app }) => {
    const account = await app.account();
    const { A, B, group, page, row } = await staleHomeSetup(account, app, { name: 'Stale Crew', members: (a, b, c) => [a.avatar, b.avatar, c.avatar] });
    await memberChangeBehindHome(account, { A, B, group });
    await staleHomeSync(account, page, row, A, group);
    const soloA = structuredClone((await account.store()).characters[A.threadKey]);
    const ids = messageIds(await account.store(), group.id);
    // (1) Delete: the popup is the group's confirm, never 'Delete the Chat File?'.
    await row.locator('.deleteChat').evaluate(button => button.click());
    const popup = page.locator('dialog.popup[open]');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.popup-content'), 'the popup names the group').toHaveText(groupConfirm('Stale Crew'));
    await popup.locator('.popup-button-cancel').click();
    // (2) Rename: the group's chat is renamed and A's own chats keep their names.
    await page.locator(`article.recentChat[data-avatar="${A.avatar}"][data-group="${group.id}"] .renameChat`).first().evaluate(button => button.click());
    const rename = page.locator('dialog.popup[open]');
    await expect(rename).toBeVisible();
    await rename.locator('input, textarea').first().fill('Renamed chat');
    await rename.locator('.popup-button-ok').click();
    await expect.poll(async () => {
        const store = await account.store();
        const key = prefixOf(store, group.id)[0];
        return store.characters[key].branches.main.name;
    }, { timeout: 15000 }).toBe('Renamed chat');
    const after = await account.store();
    expect(after.characters[A.threadKey], 'A\'s solo record is untouched').toEqual(soloA);
    expect(messageIds(after, group.id)).toEqual(ids);
    await page.close();
});

test('E8b a Home row drawn before a member change opens the group', async ({ app }) => {
    const account = await app.account();
    const { A, B, group, page, row } = await staleHomeSetup(account, app, { name: 'Open Crew', members: (a, b, c) => [a.avatar, b.avatar, c.avatar] });
    await memberChangeBehindHome(account, { A, B, group });
    await staleHomeSync(account, page, row, A, group);
    await row.locator('.recentChatOpen').first().evaluate(button => button.click());
    await expect.poll(() => selectedGroup(page), { timeout: 15000 }).toBe(group.id);
    expect(Object.keys(await pageStore(page).then(store => store.characters)).some(key => key.includes(`group:${group.id}:${A.avatar}`)), 'no key for the removed pal in the page copy').toBe(false);
    await page.close();
});

test('E8c a Home row whose group has no member left to hold it shows the action\'s warning and changes nothing', async ({ app }) => {
    const account = await app.account();
    const { A, B, C, group, page, row } = await staleHomeSetup(account, app, { name: 'Empty Crew', members: (a, b, c) => [a.avatar, b.avatar, c.avatar] });
    await memberChangeBehindHome(account, { A, B, group, mute: [B.avatar, C.avatar] });
    await staleHomeSync(account, page, row, A, group);
    const soloA = structuredClone((await account.store()).characters[A.threadKey]);
    const ids = messageIds(await account.store(), group.id);
    await clearToasts(page);
    await row.locator('.deleteChat').evaluate(button => button.click());
    await delay(2000);
    const dialogs = page.locator('dialog.popup[open]');
    expect(await dialogs.count() ? await dialogs.locator('.popup-content').innerText() : '', 'no confirm popup').toBe('');
    await expect.poll(async () => (await toastsOf(page)).map(toast => toast.text).some(text => text.includes('Could not delete Conversation chat.')), { timeout: 10000 }).toBe(true);
    const after = await account.store();
    expect(after.characters[A.threadKey]).toEqual(soloA);
    expect(messageIds(after, group.id)).toEqual(ids);
    await page.close();
});

// ---------- reach on short phones ----------
/** Everything the reach check reads, taking no script scroll: boxes, hit tests and scroll positions. */
const readEditorReach = page => page.evaluate(() => {
    const box = element => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    const rail = document.getElementById('sb_conversation_pals_rail');
    const sheld = document.getElementById('sheld');
    const inside = (rect, outer) => Boolean(rect && outer && rect.top >= outer.top - 0.5 && rect.bottom <= outer.bottom + 0.5);
    const pickerBox = box(picker);
    const view = { top: 0, bottom: window.innerHeight };
    const control = selector => {
        const element = picker.querySelector(selector);
        const rect = box(element);
        const hit = rect ? document.elementFromPoint(rect.x, rect.y) : null;
        return { rect, disabled: Boolean(element?.disabled), inPicker: inside(rect, pickerBox), inView: inside(rect, view), hit: Boolean(hit && (hit === element || element.contains(hit))) };
    };
    return {
        innerHeight: window.innerHeight, sheldScrollTop: sheld.scrollTop, pageScrollTop: document.scrollingElement.scrollTop, railScrollTop: rail.scrollTop,
        picker: pickerBox, rail: box(rail), scrollTop: picker.scrollTop, scrollHeight: picker.scrollHeight, clientHeight: picker.clientHeight,
        search: control('#sb_conversation_group_search'), cancel: control('[data-sb-conversation-action="cancel-conversation-group"]'),
        save: control('[data-sb-conversation-action="save-conversation-group-members"]'), fork: control('[data-sb-conversation-action="create-conversation-group"]'),
        description: box(picker.querySelector('.sb-conversation-add-dm-description')),
    };
});

/** A swipe of real touch events through CDP: touchStart on `at`, 20 touchMoves of 10px upward about 16ms apart, touchEnd. */
async function touchSwipe(cdp, at) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    for (let step = 1; step <= 20; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y - step * 10 }] });
        await delay(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function reachScene(account, page, { size, scale, state, pals, reopen = null }) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    // Each scene starts from a fresh page, so each reading is a first opening (E9b covers closing Pals and reopening the editor with no reload).
    if (reopen) await reopen();
    await page.evaluate(value => document.documentElement.style.setProperty('--fontScale', value), String(scale));
    await openEditorFromHeader(page);
    // Ticks are made by a script click: a locator's setChecked scrolls the picker (and #sheld) to bring the box into view, which the reading must not do.
    const domTick = (avatar, on) => page.evaluate(({ avatar, on }) => {
        const box = document.querySelector(`#sb_conversation_add_dm_picker input.sb-conversation-group-member-checkbox[value="${avatar}"]`);
        if (box.checked !== on) box.click();
    }, { avatar, on });
    if (state === 'changed') await domTick(pals.extra.avatar, true);
    if (state === 'too-few') for (const member of pals.members.slice(1)) await domTick(member, false);
    await delay(300);
    const failures = [];
    const check = (condition, text) => { if (!condition) failures.push(`${size.join('x')} @${scale} ${state}: ${text}`); };
    const first = await readEditorReach(page);
    check(first.sheldScrollTop === 0 && first.pageScrollTop === 0 && first.railScrollTop === 0 && first.scrollTop === 0, 'nothing scrolled before the reading');
    // The search field first (it is above the picker's box once the picker is scrolled to its end).
    check(first.search.inPicker && first.search.inView && first.search.hit, 'search is in the picker, in view and hit');
    await page.touchscreen.tap(first.search.rect.x, first.search.rect.y);
    check(await page.evaluate(() => document.activeElement?.id === 'sb_conversation_group_search'), 'a tap focuses the search field');
    await page.evaluate(() => document.activeElement?.blur());
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
        window.__moves = [];
        window.__moveHandler = event => window.__moves.push(event.defaultPrevented);
        window.addEventListener('touchmove', window.__moveHandler, { capture: true, passive: true });
    });
    let reading = first;
    for (let swipe = 0; swipe < 6 && reading.scrollHeight - reading.clientHeight > 1 && reading.scrollTop < reading.scrollHeight - reading.clientHeight - 1; swipe++) {
        const start = reading.description && reading.description.top >= reading.picker.top && reading.description.bottom <= reading.picker.bottom ? reading.description
            : await page.evaluate(() => { const rect = document.querySelector('#sb_conversation_add_dm_picker .sb-conversation-group-picker-actions .sb-conversation-group-selected-count').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
        await touchSwipe(cdp, start);
        await delay(250);
        reading = await readEditorReach(page);
    }
    if (first.scrollHeight - first.clientHeight > 1) check(reading.scrollTop >= reading.scrollHeight - reading.clientHeight - 1, 'the touch scroll reached the end');
    check(!(await page.evaluate(() => window.__moves)).some(Boolean), 'no touchmove was prevented');
    await page.evaluate(() => window.removeEventListener('touchmove', window.__moveHandler, { capture: true }));
    const clicks = [];
    await page.evaluate(() => {
        window.__taps = [];
        window.__tapHandler = event => { window.__taps.push(event.target.closest('[data-sb-conversation-action]')?.dataset.sbConversationAction || ''); event.stopImmediatePropagation(); event.preventDefault(); };
        window.addEventListener('click', window.__tapHandler, { capture: true });
    });
    for (const [name, action] of [['cancel', 'cancel-conversation-group'], ['save', 'save-conversation-group-members'], ['fork', 'create-conversation-group']]) {
        const control = reading[name];
        check(control.inPicker && control.inView, `${name} lies in the picker and in view`);
        if (control.disabled) continue;
        check(control.hit, `${name} is hit at its centre`);
        await page.touchscreen.tap(control.rect.x, control.rect.y);
        clicks.push(action);
    }
    const taps = await page.evaluate(() => { window.removeEventListener('click', window.__tapHandler, { capture: true }); return window.__taps; });
    check(JSON.stringify(taps) === JSON.stringify(clicks), `taps reach their controls (${JSON.stringify(taps)} vs ${JSON.stringify(clicks)})`);
    check(reading.picker.bottom <= reading.rail.bottom + 0.5 && reading.picker.bottom <= reading.innerHeight + 0.5, 'the picker ends at or above the rail and the screen');
    check(reading.sheldScrollTop === 0, '#sheld never scrolled');
    return { size, scale, state, failures, picker: reading.picker, rail: reading.rail, range: reading.scrollHeight - reading.clientHeight, fresh: { range: first.scrollHeight - first.clientHeight } };
}

test('E9 every control of the editor can be reached with a finger on a short phone', async ({ app }, info) => {
    const account = await app.account({ phone: true });
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D, E } = await addPals(account);
    const extras = [];
    for (const name of ['Scratch Fig', 'Scratch Gus', 'Scratch Hal']) extras.push(await addPal(account, name, { solo: false }));
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    const pals = { members: [A.avatar, B.avatar, C.avatar], extra: D, all: [D, E, ...extras] };
    const sizes = [[375, 667], [393, 659], [393, 745], [393, 852], [667, 375]];
    const holder = await holderOf(account, G.id);
    const reopen = () => reloadToWorkspace(page, holder.avatar, G.id);
    const results = [];
    for (const size of sizes) for (const scale of [1, 1.2, 1.5]) for (const state of ['fresh', 'changed', 'too-few']) {
        await closePals(page);
        results.push(await reachScene(account, page, { size, scale, state, pals, reopen }));
    }
    await info.attach('reach-readings', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    const failures = results.filter(result => result.size[0] !== 667).flatMap(result => result.failures);
    expect(failures, 'controls not reached').toEqual([]);
    // Controls: the plain picker and the desktop editor are not capped.
    await page.setViewportSize({ width: 375, height: 667 });
    await closePals(page);
    await openRail(page);
    await page.locator('[data-sb-conversation-action="open-new-group-chat"]').click();
    const plain = await page.evaluate(() => { const style = getComputedStyle(document.getElementById('sb_conversation_add_dm_picker')); return { max: style.maxBlockSize, overflow: style.overflowY }; });
    expect(plain).toEqual({ max: 'none', overflow: 'visible' });
    for (const state of ['fresh', 'changed']) {
        const reading = results.find(result => result.size[0] === 393 && result.size[1] === 852 && result.scale === 1 && result.state === state);
        expect(reading.fresh.range, `no scroll at 393x852, Font scale 1, in the ${state} state`).toBeLessThanOrEqual(1);
    }
    // Control: on a desktop width the editor is not capped (the phone sheet is not linked).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => document.documentElement.style.setProperty('--fontScale', '1'));
    await closePals(page);
    await openEditorFromHeader(page);
    const desktop = await page.evaluate(() => getComputedStyle(document.getElementById('sb_conversation_add_dm_picker')).maxBlockSize);
    expect(desktop, 'the editor at 1280x900 has no max-block-size').toBe('none');
    await expect(account.store().then(store => groupOf(store, G.id).members)).resolves.toEqual([A.avatar, B.avatar, C.avatar]);
    await page.close();
});

/** Swipes the editor's picker to its end with real touch events (the description first, then the count line once the description has scrolled away). */
async function swipeEditorToEnd(page) {
    const cdp = await page.context().newCDPSession(page);
    let reading = await readEditorReach(page);
    for (let swipe = 0; swipe < 6 && reading.scrollHeight - reading.clientHeight > 1 && reading.scrollTop < reading.scrollHeight - reading.clientHeight - 1; swipe++) {
        const start = reading.description && reading.description.top >= reading.picker.top && reading.description.bottom <= reading.picker.bottom ? reading.description
            : await page.evaluate(() => { const rect = document.querySelector('#sb_conversation_add_dm_picker .sb-conversation-group-picker-actions .sb-conversation-group-selected-count').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
        await touchSwipe(cdp, start);
        await delay(250);
        reading = await readEditorReach(page);
    }
    await cdp.detach();
    return reading;
}

test('E9b the editor opens at its top after Pals is closed and reopened, with no reload', async ({ app }) => {
    const account = await app.account({ phone: true });
    plainReply(app);
    await serverMode(account);
    const { A, B, C } = await addPals(account);
    for (const name of ['Scratch Fig', 'Scratch Gus', 'Scratch Hal']) await addPal(account, name, { solo: false });
    const page = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, page, [A.avatar, B.avatar, C.avatar]);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => document.documentElement.style.setProperty('--fontScale', '1.5'));
    const fromDrawer = async () => {
        await openDrawer(page);
        await page.locator(`${DRAWER} [data-sb-conversation-action="open-add-member"]`).click();
        await expect(page.locator(DRAWER)).toBeHidden();
        await expect(page.locator('#sb_conversation_pals_rail[data-open="true"]')).toBeVisible();
        await expect(page.locator('#sb_conversation_add_dm_picker')).toBeVisible();
    };
    for (const [entry, open] of [['the header', () => openEditorFromHeader(page)], ['the drawer', fromDrawer]]) {
        await closePals(page);
        await open();
        const opened = await swipeEditorToEnd(page);
        expect(opened.scrollHeight - opened.clientHeight, `${entry}: the editor can scroll at this size`).toBeGreaterThan(1);
        expect(opened.scrollTop, `${entry}: the swipe scrolled the editor`).toBeGreaterThan(0);
        await closePals(page);
        await open();
        const again = await readEditorReach(page);
        expect(again.scrollTop, `${entry}: the editor opens at its top, not where it was left`).toBe(0);
        expect(again.search.inPicker && again.search.inView, `${entry}: the search field lies in the picker and in view`).toBe(true);
        expect(again.search.hit, `${entry}: the search field is what a touch at its centre reaches`).toBe(true);
        await page.touchscreen.tap(again.search.rect.x, again.search.rect.y);
        expect(await page.evaluate(() => document.activeElement?.id), `${entry}: a tap focuses the search field`).toBe('sb_conversation_group_search');
        await expect(page.locator('#sb_conversation_add_dm_picker .sb-conversation-add-dm-title'), `${entry}: still the member editor`).toHaveText('Edit group DM members');
        await page.evaluate(() => document.activeElement?.blur());
    }
    await expect(account.store().then(store => groupOf(store, G.id).members)).resolves.toEqual([A.avatar, B.avatar, C.avatar]);
    await page.close();
});

test('E10 the header member button\'s title and aria-label are translated', async ({ app }) => {
    const locale = JSON.parse(readFileSync(new URL('../public/locales/neconyan/de-de.json', import.meta.url), 'utf8'));
    const soloKey = 'Add member to this DM';
    const groupKey = 'Edit group DM members';
    const expected = { solo: locale[soloKey], group: locale[groupKey] };
    expect(expected.solo, 'de-de has a value for the solo title').toEqual(expect.any(String));
    expect(expected.solo, 'the solo value differs from its English key').not.toBe(soloKey);
    expect(expected.group, 'de-de has a value for the group title').toEqual(expect.any(String));
    expect(expected.group, 'the group value differs from its English key').not.toBe(groupKey);
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C } = await addPals(account);
    await account.context.addInitScript(() => window.localStorage.setItem('language', 'de-de'));
    const page = await openRecorded(account, A.avatar);
    // The page really runs in German: the lookup the button's title is built from returns the German value.
    await expect.poll(() => page.evaluate(async key => (await import('/scripts/i18n.js')).translate(key), soloKey), { timeout: 30000 }).toBe(expected.solo);
    const button = page.locator(HEADER_ADD);
    const expectLabel = async (value, where) => {
        await expect(button, `${where}: title`).toHaveAttribute('title', value);
        await expect(button, `${where}: aria-label`).toHaveAttribute('aria-label', value);
    };
    await expectLabel(expected.solo, 'a solo DM');
    const before = (await account.store()).groups.map(group => group.id);
    await pickMembers(page, [A.avatar, B.avatar, C.avatar]);
    let group;
    await expect.poll(async () => {
        group = (await account.store()).groups.find(item => !before.includes(item.id));
        return Boolean(group);
    }, { timeout: 30000, intervals: [500] }).toBe(true);
    await expect.poll(() => selectedGroup(page), { timeout: 15000 }).toBe(group.id);
    await expectLabel(expected.group, 'the owned group DM, with no reload');
    await openWorkspace(page, A.avatar);
    await expect.poll(() => selectedGroup(page), { timeout: 15000 }).toBe(null);
    await expectLabel(expected.solo, 'back on the solo DM');
    await page.close();
});

// ---------- a stale tab that changed the group's settings ----------
test('E11 a stale tab that changed the group\'s DM settings does not bring back a removed pal', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    await serverMode(account);
    const { A, B, C, D } = await addPals(account);
    const first = await openRecorded(account, A.avatar);
    const G = await makeGroup(account, first, [A.avatar, B.avatar, C.avatar]);
    const holder = await holderOf(account, G.id);
    const leaving = [A, B, C].find(pal => pal.avatar !== holder.avatar);
    const second = await openRecorded(account, holder.avatar, G.id);
    await waitPageSynced(account, first, 40000);
    await waitPageSynced(account, second, 40000);
    const soloBefore = await captureSolo(account, [first, second], leaving.avatar);

    // The second tab cannot refresh, so it still lists the pal when the first tab removes them.
    const saveStatuses = [];
    second.on('response', response => { if (response.url().endsWith('/store/save')) saveStatuses.push(response.status()); });
    await second.route('**/api/neconyan-conversation/store/get', route => route.abort());
    await openEditorFromHeader(first);
    await tick(first, leaving.avatar, false);
    await first.locator(`#sb_conversation_add_dm_picker ${SAVE}`).click();
    await expect.poll(async () => groupOf(await account.store(), G.id).members.includes(leaving.avatar), { timeout: 30000, intervals: [500] }).toBe(false);

    // The stale tab changes the group's setting (a group key) and the cooldown (a thread key) through the drawer's own save.
    await openDrawer(second);
    await expect(second.locator('#sb_conv_auto_character_chat'), 'the group starts with Allow characters to talk to each other ticked').toBeChecked();
    await second.locator('#sb_conv_auto_character_chat').uncheck();
    await second.locator('#sb_conv_auto_chat_cooldown').fill('9');
    await second.locator('#sb_conv_auto_chat_cooldown').press('Tab');
    await delay(1500);

    // Preconditions, so the case cannot pass without reaching its point.
    const stale = await pageStore(second);
    expect(groupOf(stale, G.id).members.includes(leaving.avatar), 'the stale tab still lists the removed pal').toBe(true);
    expect(groupOf(stale, G.id).conversation_settings.auto_character_chat, 'the stale tab holds the changed group setting').toBe(false);
    expect(stale.characters[holder.key].settings.auto_chat_cooldown, 'the stale tab holds the changed cooldown').toBe(9);
    expect(saveStatuses, 'the stale tab\'s save met a version conflict').toContain(409);
    expect(await savedVersion(second), 'the stale tab has not learned of the member change').not.toBe((await account.post(`${CONFIG}/store/get`)).version);

    await second.unroute('**/api/neconyan-conversation/store/get');
    await second.evaluate(async () => { await (await import('/scripts/neconyan-conversation/store-sync.js')).refreshConversationStore(); });
    const caughtUp = await pageStore(second);
    expect(groupOf(caughtUp, G.id).members.includes(leaving.avatar), 'the stale tab takes the server\'s member change when it catches up').toBe(false);
    expect(groupOf(caughtUp, G.id).conversation_settings.auto_character_chat, 'the stale tab keeps its group setting').toBe(false);
    expect(caughtUp.characters[holder.key].settings.auto_chat_cooldown, 'the stale tab keeps its cooldown').toBe(9);

    await waitPageSynced(account, first, 40000);
    await waitPageSynced(account, second, 40000);
    await expectMemberGoneEverywhere(account, [first, second], { groupId: G.id, avatar: leaving.avatar, soloBefore, control: D.threadKey });
    const server = await account.store();
    expect(groupOf(server, G.id).members.includes(leaving.avatar), 'the server group lacks the removed pal').toBe(false);
    expect(groupOf(server, G.id).conversation_settings.auto_character_chat, 'the page\'s other edit to the group still wins on the server').toBe(false);
    expect((await holderOf(account, G.id)).thread.settings.auto_chat_cooldown, 'the cooldown is on the holder\'s thread').toBe(9);
    await reloadToWorkspace(second, holder.avatar, G.id);
    expect(groupOf(await pageStore(second), G.id).members.includes(leaving.avatar), 'after a reload the page copy lacks the removed pal').toBe(false);
    await first.close();
    await second.close();
});

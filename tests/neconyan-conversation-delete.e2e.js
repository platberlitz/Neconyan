/* global document, window, MutationObserver */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
// Deleting a Conversation DM (solo or group) must stick: on the server, in every open page, after a reload, and for automation.
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { test, MODEL, waitForAgentsFirstStart } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'serial' });
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires the disposable fixture.');
test.setTimeout(420000);

const CONFIG = '/api/neconyan-conversation';
const SCHEDULE = { generatedAt: 5, days: Array.from({ length: 7 }, () => [{ time: '00:00-23:59', status: 'busy', activity: 'baking bread' }]) };

// The delete flow's own words (the copy of the change).
const soloConfirm = name => `Delete your DM with ${name}? Its messages, branches, memory summary and settings, including Manual Scheduling, will be removed, and ${name} will stop messaging you here. Group DMs with ${name} are kept. This cannot be undone.`;
const groupConfirm = name => `Delete the group DM '${name}'? The group, its settings, and every member's messages and memory summaries in it will be removed, and its members will stop chatting in it. Each member's own DM is kept. This cannot be undone.`;
const soloSuccess = name => `Deleted your DM with ${name}.`;
const groupSuccess = name => `Deleted the group DM '${name}'.`;
const DELETE_FAILED = 'Could not delete that DM. Check your connection and try again.';

/** The test's own copy of the rule for a kept record: a schedule, no settings, no memory, no messages. */
const isScheduleOnly = record => Boolean(record?.schedule && typeof record.schedule === 'object')
    && (!record.settings || !Object.keys(record.settings).length)
    && !record.memorySummary
    && Object.values(record.branches || {}).every(branch => !branch.memorySummary && !(branch.messages || []).length);

// ---------- fixture helpers ----------
async function addPal(account, name) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
        ch_name: name, description: `${name} is a test pal.`, first_mes: 'Hello.', mes_example: `${name}: Hello.` } });
    expect(created.ok(), `creating the card named ${name}`).toBe(true);
    const avatar = await created.text();
    const current = await account.post(`${CONFIG}/store/get`);
    const thread = await account.post(`${CONFIG}/thread/save`, { avatar, personaId: account.personaId, version: current.version,
        messages: [{ id: `seed-${avatar.replace(/[^A-Za-z0-9]/g, '')}`, role: 'user', name: 'User', mes: `Original question for ${name}.`, timestamp: 1700000000000 }] });
    await account.changeStore(store => {
        Object.assign(store.characters[thread.threadKey].settings, { enabled: true, availability: 'online', reply_delay_multiplier: 0,
            connection_profile: 'durable', auto_message: false, proactive_messaging: false, auto_character_chat: false,
            roleplay_reactions: false, multi_char: false, image_gen_enabled: false });
    });
    return { avatar, threadKey: thread.threadKey, name };
}

/** A Conversation group with one user message in each member's thread, so it is a listed DM with history. */
async function addGroup(account, name, members) {
    const current = await account.post(`${CONFIG}/store/get`);
    const { group } = await account.post(`${CONFIG}/group/create`, { version: current.version, personaId: account.personaId, members, name,
        settings: { enabled: true, availability: 'online' } });
    for (const avatar of members) {
        const latest = await account.post(`${CONFIG}/store/get`);
        await account.post(`${CONFIG}/message/append`, { avatar, groupId: group.id, personaId: account.personaId, version: latest.version, text: `Hello ${name}.` });
    }
    return group;
}

async function serverMode(account) {
    const current = await account.post(`${CONFIG}/store/get`);
    await account.post(`${CONFIG}/automation/configure`, { mode: 'server', timeZone: 'UTC', version: current.version });
}

const plainReply = app => { app.provider.mode.reply = { choices: [{ message: { content: 'Plain reply.' } }] }; };

/** Open the app and record every toast (text and markup) the page shows. */
async function openRecorded(account, avatar, groupId = null) {
    const page = await account.context.newPage();
    await page.route('**/api/server-admin/status', route => route.fulfill({ status: 403, json: { error: 'outside fixture' } }));
    page.setDefaultTimeout(20000);
    await page.addInitScript(() => {
        window.__toasts = [];
        const start = () => new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
                if (node.nodeType === 1 && node.matches?.('.toast, .toast-message')) window.__toasts.push({ text: node.innerText || node.textContent, html: node.innerHTML });
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

async function reloadToWorkspace(page, avatar) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    if (avatar) await openWorkspace(page, avatar);
    await delay(1000);
}

const railRows = page => page.evaluate(() => [...document.querySelectorAll('.sb-conversation-pal')].map(row => ({
    avatar: row.dataset.avatar, groupId: row.dataset.groupId || '' })));
const hasRailRow = async (page, avatar, groupId = '') => (await railRows(page)).some(row => row.avatar === avatar && row.groupId === groupId);

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

/** The page's Conversation edit of one setting on a control pal (or a global one), flushed to the server. */
async function editControl(page, controlKey, { global = false } = {}) {
    return page.evaluate(async ({ controlKey, global }) => {
        const context = await import('/scripts/neconyan-conversation/context.js');
        const sync = await import('/scripts/neconyan-conversation/store-sync.js');
        const store = context.getConversationStore();
        if (global) store.settings.idle_followup = !store.settings.idle_followup;
        else store.characters[controlKey].settings.authors_note = `probe ${Date.now()}`;
        context.persistConversationStore();
        return sync.flushConversationStore();
    }, { controlKey, global });
}

/** In each open page: edit a control setting (it must save), then the deleted target is gone from that page and from the server. */
async function expectDeletedEverywhere(account, pages, { control = '', key = '', groupId = '', keepSchedule = false }) {
    const gone = (store, where) => {
        if (groupId) {
            expect(Object.keys(store.characters).filter(item => item.includes(groupId)), `${where}: no thread key holds the group id`).toEqual([]);
            expect((store.groups || []).filter(group => group.id === groupId), `${where}: the group record`).toEqual([]);
        } else if (keepSchedule) {
            expect(isScheduleOnly(store.characters[key]), `${where}: the solo record keeps only its schedule`).toBe(true);
        } else {
            expect(Object.hasOwn(store.characters, key), `${where}: the solo key`).toBe(false);
        }
    };
    for (const [index, page] of pages.entries()) {
        expect(await editControl(page, control, { global: !control }), `page ${index}: the control edit saves`).toBe(true);
        gone(await pageStore(page), `page ${index}`);
    }
    gone(await account.store(), 'server');
}

/** A real native write: a due reminder makes the server worker append to B's thread. */
async function provokeNativeWrite(account, B) {
    const before = (await account.store()).characters[B.threadKey].branches.main.messages.filter(message => message.role !== 'user').length;
    await account.changeStore(store => store.reminders.push({ id: `native-${Date.now()}`, avatar: B.avatar, personaId: account.personaId, groupId: '',
        branchId: 'main', triggerAt: Date.now() - 1, text: 'Native ping', fired: false }));
    await expect.poll(async () => (await account.store()).characters[B.threadKey].branches.main.messages.filter(message => message.role !== 'user').length,
        { timeout: 90000, intervals: [500] }).toBeGreaterThan(before);
}

/** The delete click on the Pals rail; the native confirm text is recorded and accepted. */
async function uiDeleteRail(page, avatar, groupId = '', { accept = true } = {}) {
    await openRail(page);
    const record = { confirm: null };
    const button = page.locator(`.sb-conversation-pal-delete[data-avatar="${avatar}"][data-group-id="${groupId}"]`);
    expect.soft(await button.count(), `the Pals row for ${avatar} ${groupId} has a delete button`).toBeGreaterThan(0);
    if (await button.count() === 0) return record;
    page.once('dialog', dialog => { record.confirm = dialog.message(); void (accept ? dialog.accept() : dialog.dismiss()); });
    await button.click({ force: true });
    await expect.poll(() => record.confirm, { timeout: 10000 }).not.toBeNull();
    return record;
}

/** Home's Recent chats Delete on a Conversation row; the popup's content text is recorded and confirmed. */
async function uiDeleteHome(page, selector) {
    await page.locator('[data-sb-conversation-action="close-pals"]').click({ timeout: 3000 }).catch(() => {});
    await page.locator('[data-neconyan-route="home"]:visible').first().click();
    const item = page.locator(`article.recentChat[data-recent-chat-type="conversation"]${selector}`);
    // Home re-renders while it settles, so the scroll and the clicks run inside the page, in one step each.
    await page.waitForFunction(() => !document.querySelector('.neconyan-home-booting'));
    await page.evaluate(() => document.querySelector('.welcomeRecentShell')?.scrollIntoView());
    for (let click = 0; click < 6 && !await item.isVisible(); click++) {
        if (!await page.evaluate(() => { const more = document.querySelector('.showMoreChats'); more?.click(); return Boolean(more); })) break;
        await delay(300);
    }
    await expect(item).toBeVisible();
    await item.locator('.deleteChat').evaluate(button => button.click());
    const popup = page.locator('dialog.popup[open]');
    await expect(popup).toBeVisible();
    const record = {
        text: await popup.locator('.popup-content').innerText(),
        markup: await popup.locator('.popup-content').evaluate(content => ({ img: content.querySelectorAll('img').length, b: content.querySelectorAll('b').length })),
    };
    await popup.locator('.popup-button-ok').click();
    return record;
}

const homeRow = (page, selector) => page.locator(`article.recentChat[data-recent-chat-type="conversation"]${selector}`);
const homeSelector = (avatar, groupId = '') => `[data-avatar="${avatar}"][data-group="${groupId}"]`;

for (const opened of [false, true]) {
    test(`Home keeps a deleted DM absent after Games ${opened ? 'opened' : 'was never opened'}`, async ({ app }) => {
        const account = await app.account();
        const { avatar, threadKey } = account;
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, avatar);
        await openWorkspace(page, avatar);
        const openGames = () => page.evaluate(async () => (await import('/scripts/neconyan-conversation/games/index.js')).openGames());
        const games = page.locator('#neconyan-conversation-games');
        if (opened) {
            expect(await openGames()).toBe(true);
            await expect(games).toBeVisible();
        }
        const original = (await pageStore(page)).characters[threadKey].branches.main;
        expect(original.messages.length).toBeGreaterThan(0);
        await page.evaluate(key => {
            window.addEventListener('neconyan:conversation-store-refreshed', function refreshed(event) {
                if (!event.detail?.threadKeys?.includes(key)) return;
                window.__deletedGameThread = key;
                window.removeEventListener('neconyan:conversation-store-refreshed', refreshed);
            });
        }, threadKey);
        const deleted = page.waitForResponse(response => response.url().endsWith('/thread/delete'));
        await uiDeleteHome(page, homeSelector(avatar));
        const response = await deleted;
        expect(response.ok()).toBe(true);
        expect((await response.json()).store.characters[threadKey]).toBeUndefined();
        await expect.poll(() => page.evaluate(() => window.__deletedGameThread)).toBe(threadKey);
        await expect(homeRow(page, homeSelector(avatar))).toBeHidden();
        expect(await page.evaluate(async () => ({
            open: (await import('/scripts/neconyan-conversation/state.js')).conversationState.conversationWorkspaceOpen,
            current: (await import('/scripts/neconyan-conversation/context.js')).getCurrentCharAvatar(),
        }))).toEqual({ open: false, current: avatar });
        expect.soft((await pageStore(page)).characters[threadKey], 'live browser after the delete notification').toBeUndefined();
        expect((await account.store()).characters[threadKey], 'server before an unrelated save').toBeUndefined();
        expect(await editControl(page, '', { global: true }), 'the unrelated settings save was acknowledged').toBe(true);
        expect.soft((await account.store()).characters[threadKey], 'server after the unrelated save').toBeUndefined();
        await expect(homeRow(page, homeSelector(avatar))).toBeHidden();
        if (opened) {
            expect(await openGames()).toBe(true);
            await expect(games).toBeVisible();
            const fresh = (await pageStore(page)).characters[threadKey].branches.main;
            expect(fresh.lifetimeSeed).toBeTruthy();
            expect(fresh.lifetimeSeed).not.toBe(original.lifetimeSeed);
            expect(fresh.messages).toEqual([]);
        }
    });
}

/** Make the page stale: its refresh is blocked and a second client writes. */
async function makeStale(account, page, B) {
    await page.route('**/api/neconyan-conversation/store/get', route => route.abort());
    await provokeNativeWrite(account, B);
    expect(await savedVersion(page), 'the page is stale at the click').not.toBe((await account.post(`${CONFIG}/store/get`)).version);
}

const autoChatMessages = (store, groupId) => Object.entries(store.characters).filter(([key]) => key.includes(groupId))
    .reduce((count, [, thread]) => count + Object.values(thread.branches || {})
        .reduce((sum, branch) => sum + (branch.messages || []).filter(message => message.extra?.conversation_mode_auto_chat).length, 0), 0);

async function createGroupViaUi(page, members) {
    await openRail(page);
    await page.locator('[data-sb-conversation-action="open-new-group-chat"]').click();
    const picker = page.locator('#sb_conversation_add_dm_picker');
    await expect(picker).toBeVisible();
    for (const avatar of members) {
        const checkbox = picker.locator(`input.sb-conversation-group-member-checkbox[value="${avatar}"]`);
        if (!await checkbox.isChecked()) await checkbox.check();
    }
    await picker.locator('[data-sb-conversation-action="create-conversation-group"]').click();
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

async function setGroupCooldown(page, groupId, members, minutes = 1) {
    await page.evaluate(async ({ groupId, members, minutes }) => {
        const context = await import('/scripts/neconyan-conversation/context.js');
        for (const member of members) context.getConversationThreadStore(member, { groupId, create: true }).settings.auto_chat_cooldown = minutes;
        if (!await (await import('/scripts/neconyan-conversation/store-sync.js')).flushConversationStore()) throw new Error('cooldown save failed');
    }, { groupId, members, minutes });
}

const jobsList = async account => (await (await account.context.request.get('/api/jobs/list', { headers: account.headers })).json()).jobs;

// ---------- the cases ----------
test('a schedule-only solo record is listed in neither Pals nor Home and stays schedule-only', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey };
    const B = await addPal(account, 'Scratch Kit');
    // No memory fields on A, so the ordinary save path has nothing to restore.
    await account.changeStore(store => {
        const record = store.characters[A.threadKey];
        store.characters[A.threadKey] = { settings: {}, schedule: SCHEDULE, activeBranchId: 'main',
            branches: { main: { id: 'main', name: record.branches.main.name || 'Main', messages: [], preview: '', unread: 0, lastActivity: 1, followupCount: 0, createdAt: Date.now() } } };
    });
    const page = await openRecorded(account, B.avatar);
    const listed = () => page.evaluate(async avatar => {
        const rail = (await import('/scripts/neconyan-conversation/pals-rail.js')).getConversationRailItems();
        const home = (await import('/scripts/neconyan-conversation/settings-store.js')).getConversationWelcomeChats();
        return { rail: rail.filter(item => item.character?.avatar === avatar && !item.groupId).length, home: home.filter(item => item.avatar === avatar && !item.group).length };
    }, A.avatar);
    expect(await listed()).toEqual({ rail: 0, home: 0 });
    await reloadToWorkspace(page, B.avatar);
    expect(await listed()).toEqual({ rail: 0, home: 0 });
    expect(await editControl(page, B.threadKey)).toBe(true);
    expect(isScheduleOnly((await account.store()).characters[A.threadKey])).toBe(true);
    await page.close();
});

test('R1 rail delete of a solo DM sticks on a stale page after a real native write', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey, name: 'Durable Nova' };
    const B = await addPal(account, 'Scratch Kit');
    const C = await addPal(account, 'Scratch Mochi');
    await serverMode(account);
    const page = await openRecorded(account, B.avatar);
    await openRail(page);
    await waitPageSynced(account, page, 40000);
    await page.evaluate(async ({ avatar, schedule }) => {
        await (await import('/scripts/neconyan-conversation/schedule.js')).saveEditedCharacterSchedule(avatar, schedule);
    }, { avatar: A.avatar, schedule: SCHEDULE });
    await waitPageSynced(account, page, 40000);
    const savedSchedule = (await account.store()).characters[A.threadKey].schedule;
    expect(savedSchedule, 'A has a Character Schedule').toBeTruthy();
    await makeStale(account, page, B);

    // A failed delete says so and leaves the row.
    await page.route('**/api/neconyan-conversation/thread/delete', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await clearToasts(page);
    await uiDeleteRail(page, C.avatar);
    await delay(2500);
    const failedToasts = (await toastsOf(page)).map(toast => toast.text);
    expect.soft(failedToasts.some(text => text.includes(DELETE_FAILED)), `failure toast in ${JSON.stringify(failedToasts)}`).toBe(true);
    expect.soft(failedToasts.some(text => text.includes(soloSuccess(C.name))), 'no success toast after a failed delete').toBe(false);
    expect.soft(await hasRailRow(page, C.avatar), 'the row stays after a failed delete').toBe(true);
    await page.unroute('**/api/neconyan-conversation/thread/delete');

    await clearToasts(page);
    const record = await uiDeleteRail(page, A.avatar);
    expect.soft(record.confirm).toBe(soloConfirm(A.name));
    await delay(3500);
    expect.soft((await toastsOf(page)).map(toast => toast.text).some(text => text.includes(soloSuccess(A.name))), 'success toast').toBe(true);
    await page.unroute('**/api/neconyan-conversation/store/get');

    const server = await account.store();
    expect(isScheduleOnly(server.characters[A.threadKey]), 'A keeps only its schedule on the server').toBe(true);
    expect(server.characters[A.threadKey]?.schedule).toEqual(savedSchedule);
    expect(await hasRailRow(page, A.avatar), 'the rail lacks A').toBe(false);
    await reloadToWorkspace(page, B.avatar);
    await openRail(page);
    expect(await hasRailRow(page, A.avatar), 'the rail lacks A after a reload').toBe(false);
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, key: A.threadKey, keepSchedule: true });
    await page.close();
});

test('R1b stale rail delete of a solo DM without a schedule removes the key', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const B = await addPal(account, 'Scratch Kit');
    const C = await addPal(account, 'Scratch Mochi');
    await serverMode(account);
    const page = await openRecorded(account, B.avatar);
    await openRail(page);
    await waitPageSynced(account, page, 40000);
    await makeStale(account, page, B);
    await clearToasts(page);
    const record = await uiDeleteRail(page, C.avatar);
    expect.soft(record.confirm).toBe(soloConfirm(C.name));
    await delay(3500);
    await page.unroute('**/api/neconyan-conversation/store/get');
    expect(Object.hasOwn((await account.store()).characters, C.threadKey), 'C is gone on the server').toBe(false);
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, key: C.threadKey });
    await reloadToWorkspace(page, B.avatar);
    await openRail(page);
    expect(await hasRailRow(page, C.avatar), 'the rail lacks C after a reload').toBe(false);
    await page.close();
});

test('R2 Home Delete on a DM\'s only chat deletes the DM, also on a stale page', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey, name: 'Durable Nova' };
    const B = await addPal(account, 'Scratch Kit');
    const markupPal = 'Zed <img src=x onerror=window.__nameInjected=1> & Co';
    const Z = await addPal(account, 'Zed');
    // /api/characters/create sanitises names; edit-attribute stores the name raw.
    const renamed = await account.context.request.post('/api/characters/edit-attribute', { headers: account.headers, data: {
        avatar_url: Z.avatar, ch_name: 'Zed', field: 'name', value: markupPal } });
    expect(renamed.ok(), `setting the raw name: ${renamed.status()} ${await renamed.text()}`).toBe(true);
    Z.name = markupPal;
    const duo = await addGroup(account, 'Duo', [A.avatar, B.avatar]);
    const markupGroupName = 'Crew <b>one</b> & "two"';
    const crew = await addGroup(account, 'Crew', [B.avatar, Z.avatar]);
    await account.changeStore(store => { store.groups.find(group => group.id === crew.id).name = markupGroupName; });
    await serverMode(account);
    const page = await openRecorded(account, B.avatar);
    await reloadToWorkspace(page, B.avatar);
    // r4b fallback: the page does not hold the raw markup name, so compare against the name as stored.
    const storedName = await page.evaluate(avatar => window.SillyTavern.getContext().characters.find(character => character?.avatar === avatar)?.name, Z.avatar);
    expect(storedName, 'the page keeps the markup name as stored').toContain('<img');
    Z.name = storedName;
    await openRail(page);
    await waitPageSynced(account, page, 40000);
    await makeStale(account, page, B);

    // Solo, on a stale page.
    await clearToasts(page);
    const solo = await uiDeleteHome(page, homeSelector(A.avatar));
    expect.soft(solo.text).toBe(soloConfirm(A.name));
    await delay(3500);
    expect.soft((await toastsOf(page)).map(toast => toast.text).some(text => text.includes(soloSuccess(A.name))), 'success toast').toBe(true);
    await page.unroute('**/api/neconyan-conversation/store/get');
    await expect.soft(page.locator('#welcome-recent-chat-list'), 'Home is still showing').toBeVisible();
    expect(await homeRow(page, homeSelector(A.avatar)).count(), 'Home lacks A').toBe(0);
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, key: A.threadKey });

    // A group row.
    await clearToasts(page);
    const group = await uiDeleteHome(page, `[data-group="${duo.id}"]`);
    expect.soft(group.text).toBe(groupConfirm('Duo'));
    await delay(3500);
    expect.soft((await toastsOf(page)).map(toast => toast.text).some(text => text.includes(groupSuccess('Duo'))), 'group success toast').toBe(true);
    expect(await homeRow(page, `[data-group="${duo.id}"]`).count(), 'Home lacks the group').toBe(0);
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, groupId: duo.id });

    // A DM with two chats: Delete removes only the chat shown.
    await account.changeStore(store => {
        const thread = store.characters[B.threadKey];
        thread.branches.side = { ...structuredClone(thread.branches.main), id: 'side', name: 'Side chat', createdAt: Date.now() };
        delete thread.branches.side.navigationId;
        thread.activeBranchId = 'side'; // Home lists a DM by its active chat
    });
    await reloadToWorkspace(page, B.avatar);
    const control = await uiDeleteHome(page, `${homeSelector(B.avatar)}[data-conversation-branch-id="side"]`);
    expect(control.text).toBe('Delete the Chat File?');
    await expect.poll(async () => Object.keys((await account.store()).characters[B.threadKey].branches), { timeout: 15000 }).toEqual(['main']);
    expect(await homeRow(page, homeSelector(B.avatar)).count(), 'the DM row stays').toBeGreaterThan(0);

    // Names that contain markup are text, never elements, and the raw name is in the Pals confirm and the Home popup alike.
    await openWorkspace(page, B.avatar);
    await openRail(page);
    const palsSolo = await uiDeleteRail(page, Z.avatar, '', { accept: false });
    await clearToasts(page);
    const markupSolo = await uiDeleteHome(page, homeSelector(Z.avatar));
    expect.soft(markupSolo.text).toBe(palsSolo.confirm);
    expect.soft(markupSolo.text).toBe(soloConfirm(Z.name));
    expect.soft(markupSolo.markup, 'the popup holds no element from the name').toEqual({ img: 0, b: 0 });
    await delay(3500);
    const soloToast = (await toastsOf(page)).find(toast => toast.text.includes('Deleted your DM with'));
    expect.soft(soloToast?.text).toBe(soloSuccess(Z.name));
    expect.soft(soloToast?.html.includes('<img'), 'the toast holds no element from the name').toBe(false);
    expect(await page.evaluate(() => window.__nameInjected), 'the pal name ran no code').toBeUndefined();

    await openWorkspace(page, B.avatar);
    await openRail(page);
    const palsGroup = await uiDeleteRail(page, B.avatar, crew.id, { accept: false });
    await clearToasts(page);
    const markupGroup = await uiDeleteHome(page, `[data-group="${crew.id}"]`);
    expect.soft(markupGroup.text).toBe(palsGroup.confirm);
    expect.soft(markupGroup.text).toBe(groupConfirm(markupGroupName));
    expect.soft(markupGroup.markup, 'the popup holds no element from the group name').toEqual({ img: 0, b: 0 });
    await delay(3500);
    const groupToast = (await toastsOf(page)).find(toast => toast.text.includes('Deleted the group DM'));
    expect.soft(groupToast?.text).toBe(groupSuccess(markupGroupName));
    expect.soft(groupToast?.html.includes('<b>'), 'the group toast holds no element from the name').toBe(false);
    expect(await page.evaluate(() => window.__nameInjected), 'the group name ran no code').toBeUndefined();
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, key: Z.threadKey });
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, groupId: crew.id });

    await reloadToWorkspace(page, B.avatar);
    await openRail(page);
    expect(await hasRailRow(page, A.avatar), 'the rail lacks A after a reload').toBe(false);
    expect(await homeRow(page, homeSelector(A.avatar)).count(), 'Home lacks A after a reload').toBe(0);
    await page.close();
});

test('R3 rail delete of a group DM removes it and stops its automatic chat', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey };
    const B = await addPal(account, 'Scratch Kit');
    const C = await addPal(account, 'Scratch Mochi');
    await serverMode(account);
    const page = await openRecorded(account, A.avatar);
    await waitPageSynced(account, page, 40000);
    const groupIds = [];
    for (const members of [[A.avatar, B.avatar], [B.avatar, C.avatar]]) {
        const count = ((await account.store()).groups || []).length;
        await createGroupViaUi(page, members);
        await expect.poll(async () => ((await account.store()).groups || []).length, { timeout: 15000 }).toBe(count + 1);
        await delay(2000);
        groupIds.push((await account.store()).groups.at(-1).id);
        await sendInGroup(account, page, `Hello group ${groupIds.length}.`);
        await delay(1500);
    }
    const [gDel, gKeep] = groupIds;
    let store = await account.store();
    for (const id of groupIds) await setGroupCooldown(page, id, store.groups.find(group => group.id === id).members, 1);
    await waitPageSynced(account, page, 40000);
    await openRail(page);
    const row = (await railRows(page)).find(item => item.groupId === gDel);
    expect(row, 'the group row is listed').toBeTruthy();
    const autoBefore = autoChatMessages(await account.store(), gKeep);
    const deletedAt = Date.now();
    await clearToasts(page);
    await uiDeleteRail(page, row.avatar, gDel);
    await delay(3500);
    expect.soft(await hasRailRow(page, row.avatar, gDel), 'the row is gone at once').toBe(false);
    store = await account.store();
    expect.soft((store.groups || []).some(group => group.id === gDel), 'store.groups lacks the group').toBe(false);
    expect.soft(Object.keys(store.characters).filter(key => key.includes(gDel)), 'no key holds the group id').toEqual([]);
    await reloadToWorkspace(page, C.avatar);
    await openRail(page);
    expect.soft(await hasRailRow(page, row.avatar, gDel), 'the row is gone after a reload').toBe(false);
    await expectDeletedEverywhere(account, [page], { control: C.threadKey, groupId: gDel });

    // The other group keeps chatting by itself; nothing is ever started for the deleted one.
    const started = Date.now();
    let gained = false;
    while (Date.now() - started < 170000) {
        gained = autoChatMessages(await account.store(), gKeep) > autoBefore;
        const stray = (await jobsList(account)).filter(job => (job.createdAt ?? 0) >= deletedAt
            && (JSON.stringify(job.target ?? {}).includes(gDel) || JSON.stringify(job.intent?.target ?? {}).includes(gDel)));
        expect(stray.map(job => ({ type: job.type, state: job.state })), 'no job for the deleted group').toEqual([]);
        if (gained) break;
        await delay(5000);
    }
    expect(gained, 'the kept group gained an automatic character message').toBe(true);
    await page.close();
});

test('a reply held at the provider when the DM is deleted is cancelled and does not return', async ({ app }) => {
    const account = await app.account();
    const A = { avatar: account.avatar, threadKey: account.threadKey, name: 'Durable Nova' };
    const B = await addPal(account, 'Scratch Kit');
    await serverMode(account);
    const fixtureUrl = app.provider.url.replace(/\/v1$/, '');
    const page = await openRecorded(account, A.avatar);
    await waitPageSynced(account, page, 40000);
    await page.request.post(`${fixtureUrl}/fixture/hold`, { data: { model: MODEL } });
    let jobId;
    try {
        await page.locator('#sb_conversation_input').fill('A question that will be held.');
        const accepted = page.waitForResponse(item => item.url().endsWith('/reply/submit'));
        await page.locator('#sb_conversation_send').click();
        jobId = (await (await accepted).json()).job.id;
        await expect.poll(async () => (await page.request.get(`${fixtureUrl}/fixture/calls`)).json()
            .then(calls => calls.some(call => call.model === MODEL && call.completedAt === null)), { timeout: 30000 }).toBe(true);
        const record = await uiDeleteRail(page, A.avatar);
        expect.soft(record.confirm).toBe(soloConfirm(A.name));
        await expect.poll(async () => (await account.job(jobId)).state, { timeout: 30000 }).toBe('cancelled');
    } finally {
        await app.release();
    }
    await delay(3000);
    expect((await account.job(jobId)).state).toBe('cancelled');
    expect(Object.hasOwn((await account.store()).characters, A.threadKey), 'A is gone once the job is terminal').toBe(false);
    await reloadToWorkspace(page, B.avatar);
    await expectDeletedEverywhere(account, [page], { control: B.threadKey, key: A.threadKey });
    await page.close();
});

test('another tab drops the deleted DM and does not recreate it', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey };
    const B = await addPal(account, 'Scratch Kit');
    await serverMode(account);
    const first = await openRecorded(account, B.avatar);
    const second = await openRecorded(account, A.avatar);
    await openRail(first);
    await waitPageSynced(account, first, 40000);
    await waitPageSynced(account, second, 40000);
    await uiDeleteRail(first, A.avatar);
    await expect.poll(async () => !(await hasRailRow(second, A.avatar)), { timeout: 30000, intervals: [500] }).toBe(true);
    await expect.poll(() => second.evaluate(async () => (await import('/scripts/neconyan-conversation/notifications.js')).getActiveConversationThreadKey()), { timeout: 30000 }).not.toBe(A.threadKey);
    await expectDeletedEverywhere(account, [first, second], { control: B.threadKey, key: A.threadKey });
    await delay(45000);
    expect(Object.hasOwn((await account.store()).characters, A.threadKey), 'A is still gone 45 s later').toBe(false);
    await first.close();
    await second.close();
});

test('a settings drawer open in another tab for the deleted DM closes without writing it back', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey };
    const B = await addPal(account, 'Scratch Kit');
    const C = await addPal(account, 'Scratch Mochi');
    const gDel = await addGroup(account, 'Doomed', [A.avatar, C.avatar]);
    await serverMode(account);
    const first = await openRecorded(account, B.avatar);
    // Settle the new account's startup saves before the other tab reads its settings revision.
    await waitForAgentsFirstStart(first);
    const drawer = page => page.locator('#sb_conversation_settings_drawer');

    // Solo: the drawer in the second tab is open for A.
    const second = await openRecorded(account, A.avatar);
    await second.locator('[data-sb-conversation-action="open-settings"]').click();
    await expect(drawer(second)).toBeVisible();
    await waitPageSynced(account, first, 40000);
    await uiDeleteRail(first, A.avatar);
    await expect(drawer(second), 'the drawer closes').toBeHidden({ timeout: 30000 });
    await expectDeletedEverywhere(account, [first, second], { control: B.threadKey, key: A.threadKey });
    await second.close();

    // Group: the drawer in a third tab is open for the group, and the anchor's solo settings are not touched.
    const anchorBefore = (await account.store()).characters[C.threadKey].settings;
    const third = await openRecorded(account, C.avatar, gDel.id);
    await third.locator('[data-sb-conversation-action="open-settings"]').click();
    await expect(drawer(third)).toBeVisible();
    await openRail(first);
    const groupRow = (await railRows(first)).find(row => row.groupId === gDel.id);
    expect(groupRow, 'the group row is listed').toBeTruthy();
    await uiDeleteRail(first, groupRow.avatar, gDel.id);
    await expect(drawer(third), 'the group drawer closes').toBeHidden({ timeout: 30000 });
    await expectDeletedEverywhere(account, [first, third], { control: B.threadKey, groupId: gDel.id });
    expect((await account.store()).characters[C.threadKey].settings, 'the anchor pal\'s solo settings are unchanged').toEqual(anchorBefore);
    await first.close();
    await third.close();
});

test('deleting the open DM when it is the last one closes the workspace', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey, name: 'Durable Nova' };
    await serverMode(account);
    const page = await openRecorded(account, A.avatar);
    await waitPageSynced(account, page, 40000);
    const record = await uiDeleteRail(page, A.avatar);
    expect.soft(record.confirm).toBe(soloConfirm(A.name));
    await expect(page.locator('#sb_conversation_input'), 'the workspace closes').toBeHidden({ timeout: 15000 });
    await expectDeletedEverywhere(account, [page], { key: A.threadKey });

    // The closed workspace can defer drawing the rail. Check what the person sees after reopening it.
    await openWorkspace(page, null);
    const empty = page.locator('#sb_conversation_pals_list > .sb-conversation-empty');
    if (!await empty.isVisible()) await page.locator('[data-sb-conversation-action="toggle-pals"]').click();
    await expect(empty, 'the reopened rail shows its empty state').toBeVisible();
    await reloadToWorkspace(page, null);
    expect(Object.hasOwn((await account.store()).characters, A.threadKey), 'A is gone after a reload').toBe(false);
    await page.close();
});

test('a stale tab that changed a deleted group\'s settings does not bring it back', async ({ app }) => {
    const account = await app.account();
    plainReply(app);
    const A = { avatar: account.avatar, threadKey: account.threadKey };
    const B = await addPal(account, 'Scratch Kit');
    const C = await addPal(account, 'Scratch Mochi');
    const gDel = await addGroup(account, 'Doomed', [A.avatar, C.avatar]);
    await serverMode(account);
    const first = await openRecorded(account, B.avatar);
    const second = await openRecorded(account, C.avatar, gDel.id);
    await waitPageSynced(account, first, 40000);
    await waitPageSynced(account, second, 40000);

    // The second tab cannot refresh, so it still holds the group when the first tab deletes it.
    await second.route('**/api/neconyan-conversation/store/get', route => route.abort());
    await openRail(first);
    const groupRow = (await railRows(first)).find(row => row.groupId === gDel.id);
    expect(groupRow, 'the group row is listed').toBeTruthy();
    await uiDeleteRail(first, groupRow.avatar, gDel.id);
    await expect.poll(async () => ((await account.store()).groups || []).some(group => group.id === gDel.id), { timeout: 30000, intervals: [500] }).toBe(false);

    // The stale tab changes the deleted group's settings through the settings drawer's own save.
    const flipped = await second.evaluate(async groupId => {
        const context = await import('/scripts/neconyan-conversation/context.js');
        const settings = context.getGroupConversationSettings(groupId);
        const next = !settings.auto_character_chat;
        context.saveGroupConversationSettings(groupId, { ...settings, auto_character_chat: next });
        return next;
    }, gDel.id);
    const staleGroup = ((await pageStore(second)).groups || []).find(group => group.id === gDel.id);
    expect(staleGroup, 'the stale tab still holds the deleted group').toBeTruthy();
    expect(staleGroup.conversation_settings.auto_character_chat, 'the stale tab holds the changed setting').toBe(flipped);
    await delay(1500);
    expect(await savedVersion(second), 'the stale tab has not learned of the delete').not.toBe((await account.post(`${CONFIG}/store/get`)).version);
    await second.unroute('**/api/neconyan-conversation/store/get');
    // The stale tab learns of the delete once, through its own refresh: its copy must lose the group, although it changed it.
    await second.evaluate(async () => { await (await import('/scripts/neconyan-conversation/store-sync.js')).refreshConversationStore(); });
    expect(((await pageStore(second)).groups || []).some(group => group.id === gDel.id), 'the stale tab drops the deleted group when it catches up').toBe(false);
    expect(Object.keys((await pageStore(second)).characters).filter(key => key.includes(gDel.id)), 'the stale tab drops the deleted group keys when it catches up').toEqual([]);
    // Leaving the deleted group opens another pal, whose first open writes a chat link ID (/api/chat-navigation/establish). Let both tabs catch up with that write.
    await expect.poll(() => second.evaluate(async () => (await import('/scripts/neconyan-conversation/notifications.js')).getActiveConversationThreadKey()), { timeout: 30000 }).not.toContain(gDel.id);
    await waitPageSynced(account, second, 40000);
    await waitPageSynced(account, first, 40000);

    await expectDeletedEverywhere(account, [first, second], { control: B.threadKey, groupId: gDel.id });
    await reloadToWorkspace(second, B.avatar);
    await openRail(second);
    expect(await hasRailRow(second, groupRow.avatar, gDel.id), 'the group row is gone after a reload').toBe(false);
    expect(((await account.store()).groups || []).some(group => group.id === gDel.id), 'the server still lacks the group').toBe(false);
    await first.close();
    await second.close();
});

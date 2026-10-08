/* global document, window, getComputedStyle, IDBObjectStore, innerWidth */
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';

const outputDir = fileURLToPath(new URL('../output/playwright/neconyan-audit/undo-reviewed', import.meta.url));
mkdirSync(outputDir, { recursive: true });
const lightTheme = JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico.json', import.meta.url), 'utf8'));
const avatarImage = fileURLToPath(new URL('../public/img/neconyan-character.png', import.meta.url));
test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
test.setTimeout(120000);
let diagnostics;
test.beforeEach(({ page }) => {
    page.setDefaultTimeout(15000);
    diagnostics = { pageErrors: [], assetErrors: [], modelRequests: [], unexpected: [] };
    page.on('pageerror', error => diagnostics.pageErrors.push(error.stack || error.message));
    page.on('response', response => {
        if (response.url().includes('/frontend-assets/') && response.status() >= 400) diagnostics.assetErrors.push(response.url());
    });
});
test.afterEach(() => {
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.assetErrors).toEqual([]);
    expect(diagnostics.modelRequests).toEqual([]);
    expect(diagnostics.unexpected).toEqual([]);
});

function requestJson(request) {
    let body = request.postDataBuffer();
    if (request.headers()['content-encoding'] === 'gzip') body = gunzipSync(body);
    return JSON.parse(body?.toString() || '{}');
}

async function openUndoFixture(page, { light = false, group = false } = {}) {
    const state = { ...diagnostics, saveRequests: [], nextSave: null, tokenDelay: 0 };
    const characters = ['Undo Cat', 'Other Cat'].map((name, index) => ({
        name, avatar: `undo-cat-${index}.png`, chat: `undo-chat-${index}`, first_mes: '', mes_example: '',
        shallow: false, tags: [], data: { name, first_mes: '', description: '', extensions: {} },
    }));
    const groups = [{ id: 'undo-group', name: 'Undo Group', members: characters.map(c => c.avatar), disabled_members: [], chat_id: 'undo-group-chat', chats: ['undo-group-chat'], chat_metadata: {}, generation_mode: 0, activation_strategy: 0, allow_self_responses: false }];
    let envelopePromise, settings;
    const storage = createMockRoleplayStore(async () => (await envelopePromise).roleplayAccount);
    await page.route('**/api/settings/get', async route => {
        const envelope = await (envelopePromise ??= route.fetch().then(r => r.json()));
        if (!settings) {
            settings = JSON.parse(envelope.settings);
            settings.active_character = '';
            settings.active_group = '';
            // Use the built-in read-only prompts, not inherited presets that initialise chat variables.
            Object.assign(settings.oai_settings, { prompts: [], prompt_order: [] });
            // Automatic filesystem snapshots are outside this mocked chat fixture.
            settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
            if (light) {
                const { name, ...theme } = lightTheme;
                Object.assign(settings.power_user, theme, { theme: name });
            }
        }
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        const payload = requestJson(route.request());
        settings = { ...payload, _version: Math.max(Date.now(), Number(payload._version || 0) + 1), _settingsRevision: Number(payload._settingsRevision || 0) + 1 };
        await route.fulfill({ json: { result: 'ok', version: settings._version, settingsRevision: settings._settingsRevision } });
    });
    await page.route('**/api/characters/all', route => route.fulfill({ json: characters }));
    await page.route('**/api/characters/chats', route => {
        const character = characters.find(item => item.avatar === requestJson(route.request()).avatar_url);
        return route.fulfill({ json: character ? [{ file_name: character.chat, last_mes: Date.now(), message_count: 0 }] : [] });
    });
    await page.route('**/api/characters/edit-attribute', route => route.fulfill({ json: {} }));
    await page.route('**/api/groups/all', route => storage.readGroups(route, group ? groups : []));
    await page.route('**/api/groups/edit', route => storage.saveGroup(route));
    await page.route('**/api/chats/get', route => storage.read(route));
    await page.route('**/api/chats/group/get', route => storage.read(route, [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }]));
    await page.route('**/api/chats/group/info', route => route.fulfill({ json: { file_name: 'undo-group-chat', message_count: 0 } }));
    await page.route(/\/thumbnail\?/, async route => {
        if (new URL(route.request().url()).searchParams.get('type') === 'avatar') await route.fulfill({ path: avatarImage });
        else await route.continue();
    });
    for (const endpoint of ['**/api/chats/save', '**/api/chats/group/save']) {
        await page.route(endpoint, async route => {
            const request = { endpoint: new URL(route.request().url()).pathname, ...requestJson(route.request()) };
            state.saveRequests.push(request);
            const behavior = state.nextSave;
            state.nextSave = null;
            if (behavior?.delay) await new Promise(resolve => setTimeout(resolve, behavior.delay));
            if (behavior?.status) await route.fulfill({ status: behavior.status, json: { error: 'Test save unavailable' } });
            else await storage.save(route);
        });
    }
    await page.route('**/api/server-admin/**', route => route.fulfill({ status: 403, json: { error: 'Server administration is disabled in Undo tests.' } }));
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, async route => {
        state.modelRequests.push(route.request().url());
        await route.fulfill({ status: 503, json: { error: 'No model requests in Undo tests.' } });
    });
    for (const pattern of ['**/api/users/reset*', '**/api/users/backup*', '**/api/chats/delete', '**/api/chats/group/delete', '**/api/characters/delete', '**/api/groups/delete', '**/api/presets/delete', '**/api/worldinfo/delete', '**/api/files/delete']) {
        await page.route(pattern, async route => {
            state.unexpected.push(new URL(route.request().url()).pathname);
            await route.fulfill({ status: 403, json: { error: 'Unrelated destructive request blocked.' } });
        });
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext && !document.getElementById('preloader'), undefined, { timeout: 60000 });
    await page.waitForFunction(() => window.SillyTavern.getContext().characters.some(character => character.avatar === 'undo-cat-0.png'));
    await page.evaluate(async useGroup => {
        const context = window.SillyTavern.getContext();
        if (useGroup) {
            const module = await import('/scripts/group-chats.js');
            await module.getGroups();
            if (!await module.openGroupById('undo-group', { switchMenu: false })) throw new Error('Could not open fixture group');
        } else {
            if (!await context.selectCharacterById(0, { switchMenu: false })) throw new Error('Could not select the fixture character');
        }
        context.powerUserSettings.chat_truncation = 20;
        context.powerUserSettings.auto_save_msg_edits = false;
        context.powerUserSettings.confirm_message_delete = true;
    }, group);
    await expect(page.locator('#send_textarea')).toBeVisible();
    await page.waitForFunction(() => Boolean(window.SillyTavern.getContext().chatId));
    return state;
}

async function seedMessages(page, { swipes = false, count = 4, visible = 20 } = {}) {
    await page.evaluate(async ({ swipes, count, visible }) => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        core.cancelDebouncedChatSave();
        context.powerUserSettings.chat_truncation = visible;
        context.powerUserSettings.aggressive_dom_unload = visible < 20;
        context.powerUserSettings.aggressive_dom_window_size = visible;
        const messages = count === 4 ? [
            { name: 'Undo Cat', is_user: false, is_system: false, mes: 'first', send_date: '2024-01-01T00:00:00.000Z', extra: { unknown: 'first' } },
            { name: 'User', is_user: true, is_system: false, mes: 'remove me', send_date: '2024-01-01T00:01:00.000Z', extra: { unknown: { keep: true } } },
            { name: 'Undo Cat', is_user: false, is_system: false, mes: 'survivor', send_date: '2024-01-01T00:02:00.000Z', extra: { unknown: 'survivor' } },
            { name: 'User', is_user: true, is_system: false, mes: 'later', send_date: '2024-01-01T00:03:00.000Z', extra: { unknown: 'later' } },
        ] : Array.from({ length: count }, (_, index) => ({ name: 'Undo Cat', is_user: index % 2 === 0, is_system: false, mes: `message ${index}`, send_date: '2024-01-01T00:00:00.000Z', extra: { originalIndex: index } }));
        if (swipes) {
            const last = messages.at(-1);
            Object.assign(last, { is_user: false, name: 'Undo Cat', mes: 'second version', swipe_id: 1, swipes: ['first version', 'second version', 'third version'], swipe_info: [0, 1, 2].map(index => ({ send_date: `2024-01-0${index + 1}T00:00:00.000Z`, gen_started: index + 10, gen_finished: index + 20, extra: { token_count: 3, unknown: { version: index } } })) });
            Object.assign(last, { send_date: last.swipe_info[1].send_date, gen_started: 11, gen_finished: 21, extra: structuredClone(last.swipe_info[1].extra) });
        }
        context.chat.splice(0, context.chat.length, ...messages);
        core.itemizedPrompts.length = 0;
        core.itemizedPrompts.push({ mesId: 1, rawPrompt: 'removed prompt', custom: { keep: true } }, { mesId: 3, rawPrompt: 'later prompt', custom: { later: true } });
        await context.printMessages();
        await core.saveChatConditional({ throwOnError: true });
        window.__undoEvents = [];
        for (const type of [context.eventTypes.MESSAGE_DELETED, context.eventTypes.MESSAGE_SWIPE_DELETED, context.eventTypes.MESSAGE_UPDATED, context.eventTypes.MESSAGE_RECEIVED]) {
            context.eventSource.on(type, (...args) => window.__undoEvents.push({ type, args }));
        }
    }, { swipes, count, visible });
}

async function deleteSingle(page, id = 1) {
    await page.locator(`#chat .mes[mesid="${id}"] .mes_delete`).click();
    await page.locator('dialog.popup:visible').getByRole('button', { name: 'Delete Message', exact: true }).click();
    await expect(page.locator('.neconyan-undo-action')).toBeVisible();
}
async function settleDeletion(page) {
    await page.evaluate(async () => (await import('/script.js')).saveChatConditional({ allowShrink: true, throwOnError: true }));
}
async function messages(page) { return page.evaluate(() => window.SillyTavern.getContext().chat.map(m => ({ mes: m.mes, extra: m.extra }))); }
async function appendMessage(page, text = 'appended after delete') {
    await page.evaluate(text => {
        const context = window.SillyTavern.getContext();
        const message = { name: 'User', is_user: true, is_system: false, mes: text, send_date: '2024-01-01T00:05:00.000Z', extra: { appended: true } };
        context.chat.push(message); context.addOneMessage(message, { scroll: false });
    }, text);
}
async function enterRange(page, id = 1) {
    await page.getByRole('button', { name: 'Chat tools', exact: true }).click();
    await page.locator('#option_delete_mes').click();
    await expect(page.locator('#dialogue_del_mes')).toBeVisible();
    await page.locator(`#chat .mes[mesid="${id}"] .del_checkbox`).click();
}
async function openPicker(page) {
    const last = page.locator('#chat .mes').last();
    await last.locator('.extraMesButtonsHint').click();
    await last.locator('.mes_swipe_picker').click();
    const popup = page.locator('dialog.popup:visible').filter({ has: page.locator('.swipe_picker_div') });
    await expect(popup).toBeVisible();
    await expect(popup.locator('.swipe_picker_block')).toHaveCount(3);
    return popup;
}

test('native message Undo restores exact content, later edits, prompts, editor, and draft once', async ({ page }) => {
    const { pageErrors, modelRequests, saveRequests } = await openUndoFixture(page);
    await seedMessages(page);
    await page.locator('#send_textarea').fill('keep this unsent draft');

    await page.locator('.mes[mesid="2"] .mes_edit').click();
    await expect(page.locator('#curEditTextarea')).toHaveValue('survivor');
    await page.locator('#curEditTextarea').fill('survivor editor draft');

    await page.locator('.mes[mesid="1"] .mes_delete').click();
    const confirmation = page.locator('dialog.popup:visible');
    await expect(confirmation).toContainText('Are you sure you want to delete this message?');
    await confirmation.getByRole('button', { name: 'Delete Message', exact: true }).click();
    await expect(page.locator('#chat .mes[mesid]')).toHaveCount(3);
    await settleDeletion(page);

    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const prompts = await import('/script.js');
        context.chat[1].extra.editedAfterDelete = true;
        const appended = { name: 'Undo Fixture', is_user: false, is_system: false, mes: 'appended after delete', send_date: '2024-01-01T00:04:00.000Z', extra: { appended: true } };
        context.chat.push(appended);
        const laterPrompt = prompts.itemizedPrompts.find(prompt => Number(prompt.mesId) === 2);
        laterPrompt.rawPrompt = 'edited later prompt';
        prompts.itemizedPrompts.push({ mesId: 3, rawPrompt: 'new later prompt', custom: { added: true } });
        context.addOneMessage(appended, { scroll: false });
    });

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    const saveCountBeforeUndo = saveRequests.length;
    await undo.evaluate(button => {
        button.click();
        button.click();
    });
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await expect(page.locator('#chat .mes[mesid="1"]')).toContainText('remove me');
    await expect(page.locator('#curEditTextarea')).toHaveValue('survivor editor draft');
    await expect(page.locator('#send_textarea')).toHaveValue('keep this unsent draft');

    const state = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const prompts = await import('/script.js');
        return {
            messages: context.chat.map(message => ({ mes: message.mes, extra: message.extra })),
            prompts: prompts.itemizedPrompts.map(prompt => ({ mesId: prompt.mesId, rawPrompt: prompt.rawPrompt, custom: prompt.custom })),
        };
    });
    expect(state.messages.map(message => message.mes)).toEqual(['first', 'remove me', 'survivor', 'later', 'appended after delete']);
    expect(state.messages[1].extra).toEqual({ unknown: { keep: true } });
    expect(state.messages[2].extra).toMatchObject({ unknown: 'survivor', editedAfterDelete: true });
    expect(state.prompts).toEqual([
        { mesId: 1, rawPrompt: 'removed prompt', custom: { keep: true } },
        { mesId: 3, rawPrompt: 'edited later prompt', custom: { later: true } },
        { mesId: 4, rawPrompt: 'new later prompt', custom: { added: true } },
    ]);
    expect(saveRequests.length - saveCountBeforeUndo).toBe(1);
    expect(pageErrors).toEqual([]);
    expect(modelRequests).toEqual([]);
});


test('slow failed restore stays available and Retry saves without reinserting', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await deleteSingle(page);
    await settleDeletion(page);
    state.saveRequests.length = 0;
    // A definitive refusal permits a new save; transport errors retry the same operation automatically.
    state.nextSave = { status: 422, delay: 9500 };
    const action = page.locator('.neconyan-undo-action');
    await action.click();
    await expect(action).toBeDisabled();
    await page.locator('#send_textarea').fill('draft changed while saving');
    await page.waitForTimeout(8500);
    await expect(action).toBeVisible();
    await expect(action).toHaveText('Retry save', { timeout: 5000 });
    await page.waitForTimeout(8500);
    await expect(action).toBeVisible();
    expect((await messages(page)).map(m => m.mes)).toEqual(['first', 'remove me', 'survivor', 'later']);
    await action.evaluate(button => { button.click(); button.click(); });
    await expect(action).toHaveCount(0);
    expect(state.saveRequests).toHaveLength(2);
    expect(state.saveRequests.every(request => request.avatar_url === 'undo-cat-0.png' && request.file_name === 'undo-chat-0')).toBe(true);
    await expect(page.locator('#send_textarea')).toHaveValue('draft changed while saving');
});

test('prompt storage failure is reported and Retry retains restored prompt edits', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await deleteSingle(page);
    await settleDeletion(page);
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        window.__failUndoPrompt = true;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.transaction.db.name === 'SillyTavern_Prompts' && window.__failUndoPrompt) {
                window.__failUndoPrompt = false;
                throw new DOMException('Test prompt storage full', 'QuotaExceededError');
            }
            return original.apply(this, args);
        };
    });
    state.saveRequests.length = 0;
    await page.locator('.neconyan-undo-action').click();
    await expect(page.locator('.neconyan-undo-action')).toHaveText('Retry save');
    await page.locator('.neconyan-undo-action').click();
    await expect(page.locator('.neconyan-undo-action')).toHaveCount(0);
    expect(state.saveRequests).toHaveLength(2);
    expect(await page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        return (await localforage.createInstance({ name: 'SillyTavern_Prompts' }).getItem('undo-chat-0')).find(p => p.mesId === 1).rawPrompt;
    })).toBe('removed prompt');
});

test('cancelled deletion retains the prior Undo and expiry does not steal editor focus', async ({ page }) => {
    await openUndoFixture(page);
    await seedMessages(page);
    await deleteSingle(page);
    await page.locator('#chat .mes[mesid="2"] .mes_delete').click();
    await page.locator('dialog.popup:visible').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.neconyan-undo-action')).toBeVisible();
    await page.locator('#chat .mes[mesid="1"] .mes_edit').click();
    await page.locator('#curEditTextarea').fill('keep my editing focus');
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0, { timeout: 13500 });
    await expect(page.locator('#curEditTextarea')).toBeFocused();
    await expect(page.locator('#curEditTextarea')).toHaveValue('keep my editing focus');
});

test('target edits and chat changes during confirmation refuse deletion', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await page.locator('#chat .mes[mesid="1"] .mes_delete').click();
    await page.evaluate(() => { window.SillyTavern.getContext().chat[1].mes = 'edited during confirmation'; });
    await page.locator('dialog.popup:visible').getByRole('button', { name: 'Delete Message', exact: true }).click();
    expect((await messages(page))[1].mes).toBe('edited during confirmation');
    expect(await messages(page)).toHaveLength(4);
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    await page.locator('#chat .mes[mesid="1"] .mes_delete').click();
    await page.evaluate(async () => window.SillyTavern.getContext().selectCharacterById(1, { switchMenu: false }));
    const newMessages = await messages(page);
    const saves = state.saveRequests.length;
    await page.locator('dialog.popup:visible').getByRole('button', { name: 'Delete Message', exact: true }).click();
    expect(await messages(page)).toEqual(newMessages);
    expect(state.saveRequests).toHaveLength(saves);
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
});

test('a changed insertion boundary refuses Undo without saving', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await deleteSingle(page);
    await settleDeletion(page);
    await page.evaluate(() => { const context = window.SillyTavern.getContext(); context.chat[0] = structuredClone(context.chat[0]); });
    const before = await messages(page);
    const saves = state.saveRequests.length;
    await page.locator('.neconyan-undo-action').click();
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    expect(await messages(page)).toEqual(before);
    expect(state.saveRequests).toHaveLength(saves);
});

for (const group of [false, true]) {
    test(`${group ? 'group' : 'character'} range Undo preserves new messages and save ownership`, async ({ page }) => {
        const state = await openUndoFixture(page, { group });
        await seedMessages(page);
        await page.locator('#send_textarea').fill('range draft');
        await enterRange(page, 1);
        await page.evaluate(async () => { const core = await import('/script.js'); core.itemizedPrompts.find(p => p.mesId === 1).rawPrompt = 'changed before deletion'; });
        await page.locator('#dialogue_del_mes_ok').click();
        await expect.poll(async () => (await messages(page)).length).toBe(1);
        await settleDeletion(page);
        await appendMessage(page);
        state.saveRequests.length = 0;
        await page.locator('.neconyan-undo-action').click();
        await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
        expect((await messages(page)).map(m => m.mes)).toEqual(['first', 'remove me', 'survivor', 'later', 'appended after delete']);
        expect(await page.evaluate(async () => (await import('/script.js')).itemizedPrompts.find(p => p.mesId === 1).rawPrompt)).toBe('changed before deletion');
        expect(state.saveRequests).toHaveLength(1);
        if (group) {
            expect(state.saveRequests[0]).toMatchObject({ endpoint: '/api/chats/group/save', id: 'undo-group-chat' });
            expect(await page.evaluate(() => window.SillyTavern.getContext().groupId)).toBe('undo-group');
        } else expect(state.saveRequests[0]).toMatchObject({ avatar_url: 'undo-cat-0.png', file_name: 'undo-chat-0' });
        await expect(page.locator('#send_textarea')).toHaveValue('range draft');
    });
}

test('range selection rejects newly appended content before Delete', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await enterRange(page, 1);
    await appendMessage(page, 'arrived during selection');
    // Settle metadata saved by rendering the appended message before counting Delete's writes.
    await page.evaluate(async () => (await import('/script.js')).saveChatConditional({ throwOnError: true }));
    const before = await messages(page), saves = state.saveRequests.length;
    await page.locator('#dialogue_del_mes_ok').click();
    expect(await messages(page)).toEqual(before);
    expect(state.saveRequests).toHaveLength(saves);
    await expect(page.locator('#send_textarea')).toBeVisible();
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
});

test('message dialog swipe Undo restores exact metadata and emits no receive event', async ({ page }) => {
    await openUndoFixture(page);
    await seedMessages(page, { swipes: true });
    const before = await page.evaluate(() => structuredClone(window.SillyTavern.getContext().chat.at(-1)));
    await page.locator('#chat .mes').last().locator('.mes_delete').click();
    await page.locator('dialog.popup:visible').getByRole('button', { name: 'Delete Swipe', exact: true }).click();
    await expect(page.locator('.neconyan-undo-action')).toBeVisible();
    await page.locator('.neconyan-undo-action').click();
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    const after = await page.evaluate(() => structuredClone(window.SillyTavern.getContext().chat.at(-1)));
    expect(after.swipes).toEqual(before.swipes);
    expect(after.swipe_info[1]).toEqual(before.swipe_info[1]);
    expect(after.swipe_id).toBe(1);
    expect(after.extra).toEqual(before.extra);
    const events = await page.evaluate(() => ({ events: window.__undoEvents, types: window.SillyTavern.getContext().eventTypes }));
    expect(events.events.filter(e => e.type === events.types.MESSAGE_SWIPE_DELETED)).toHaveLength(1);
    expect(events.events.filter(e => e.type === events.types.MESSAGE_RECEIVED)).toHaveLength(0);
});

for (const swipeId of [0, 1]) {
    test(`picker deletion ${swipeId} rerenders and restores while retaining edited and appended swipes`, async ({ page }) => {
        await openUndoFixture(page);
        await seedMessages(page, { swipes: true });
        const picker = await openPicker(page);
        await picker.locator(`.swipe_picker_block[data-swipe-id="${swipeId}"] .swipe_picker_delete`).click();
        const confirm = page.locator('dialog.popup:visible').filter({ hasText: `Are you sure you want to delete swipe #${swipeId + 1}?` });
        await confirm.getByRole('button', { name: 'Delete Swipe', exact: true }).click();
        await expect(picker.locator('.swipe_picker_block')).toHaveCount(2);
        await page.evaluate(async () => {
            const core = await import('/script.js'), message = core.chat.at(-1);
            const current = message.swipe_id;
            message.mes = 'edited surviving version'; core.syncMesToSwipe(core.chat.length - 1);
            message.swipes.push('new appended version'); message.swipe_info.push({ send_date: '2024-01-04T00:00:00.000Z', extra: { token_count: 4, appended: true } });
            message.swipe_id = message.swipes.length - 1; core.syncSwipeToMes(core.chat.length - 1);
            window.__editedSurvivor = message.swipe_info[current];
        });
        await page.locator('.neconyan-undo-action').click();
        await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
        await expect(picker.locator('.swipe_picker_block')).toHaveCount(4);
        const restored = await page.evaluate(() => { const message = window.SillyTavern.getContext().chat.at(-1); return { swipes: message.swipes, selected: message.swipe_id, mes: message.mes, editedRefRetained: message.swipe_info.includes(window.__editedSurvivor) }; });
        expect(restored.swipes[swipeId]).toBe(swipeId ? 'second version' : 'first version');
        expect(restored.swipes).toContain('edited surviving version');
        expect(restored.mes).toBe('new appended version');
        expect(restored.selected).toBe(3);
        expect(restored.editedRefRetained).toBe(true);
    });
}

test('a stale picker refuses delete before the click and edits during confirmation', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page, { swipes: true });
    let picker = await openPicker(page);
    await picker.locator('.swipe_picker_block[data-swipe-id="1"] .swipe_picker_delete').click();
    await page.evaluate(() => { window.SillyTavern.getContext().chat.at(-1).mes = 'edited while confirming'; });
    await page.locator('dialog.popup:visible').filter({ hasText: 'Are you sure you want to delete swipe #2?' }).getByRole('button', { name: 'Delete Swipe', exact: true }).click();
    expect(await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).swipes.length)).toBe(3);
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    await page.evaluate(async () => window.SillyTavern.getContext().selectCharacterById(1, { switchMenu: false }));
    const before = await messages(page), saves = state.saveRequests.length;
    picker = page.locator('dialog.popup:visible').filter({ has: page.locator('.swipe_picker_div') });
    await picker.locator('.swipe_picker_block[data-swipe-id="0"] .swipe_picker_delete').click();
    expect(await messages(page)).toEqual(before);
    expect(state.saveRequests).toHaveLength(saves);
    await expect(picker).toHaveCount(0);
});

test('historical range Undo preserves the newer rendered window and message IDs', async ({ page }) => {
    await openUndoFixture(page);
    await seedMessages(page, { count: 30, visible: 5 });
    for (let i = 0; i < 2; i++) await page.locator('#show_more_messages').click();
    const first = Number(await page.locator('#chat .mes').first().getAttribute('mesid'));
    expect(30 - first - 1).toBeGreaterThan(await page.locator('#chat .mes').count());
    await enterRange(page, first + 1);
    await page.locator('#dialogue_del_mes_ok').click();
    await settleDeletion(page);
    for (let i = 0; i < 8; i++) await appendMessage(page, `new ${i}`);
    await page.evaluate(async () => window.SillyTavern.getContext().printMessages());
    const before = await page.locator('#chat .mes_text').allTextContents();
    await page.locator('.neconyan-undo-action').click();
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    const mismatches = await page.evaluate(() => [...document.querySelectorAll('#chat .mes[mesid]')].filter(node => node.querySelector('.mes_text').textContent.trim() !== window.SillyTavern.getContext().chat[Number(node.getAttribute('mesid'))]?.mes).map(node => ({ id: node.getAttribute('mesid'), text: node.querySelector('.mes_text').textContent.trim() })));
    expect(mismatches).toEqual([]);
    expect(await page.locator('#chat .mes_text').allTextContents()).toEqual(before);
});

async function assertReadable(page, foregroundSelector, backgroundSelector) {
    const contrast = await page.evaluate(({ foregroundSelector, backgroundSelector }) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const luminance = bytes => [...bytes].slice(0, 3).map(channel => channel / 255)
            .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        context.fillStyle = getComputedStyle(document.querySelector(backgroundSelector)).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const background = luminance(context.getImageData(0, 0, 1, 1).data);
        context.fillStyle = getComputedStyle(document.querySelector(foregroundSelector)).color;
        context.fillRect(0, 0, 1, 1);
        const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    }, { foregroundSelector, backgroundSelector });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
}

async function assertUndoGeometry(page, coarse) {
    const result = await page.locator('.neconyan-undo-toast').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, viewport: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, controls: [...element.querySelectorAll('button')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) };
    });
    expect(result.left).toBeGreaterThanOrEqual(-1);
    expect(result.right).toBeLessThanOrEqual(result.viewport + 1);
    expect(result.overflow).toBeLessThanOrEqual(1);
    for (const control of result.controls) {
        expect(control.width).toBeGreaterThanOrEqual(43.5);
        expect(control.height).toBeGreaterThanOrEqual(coarse ? 43.5 : 35.5);
    }
}

for (const width of [1280, 390, 320]) {
    for (const tone of ['dark', 'light']) {
        test.describe(`${tone} Undo ${width}px`, () => {
            test.use({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
            test('keeps Undo readable and operable with keyboard or touch', async ({ page }) => {
                await openUndoFixture(page, { light: tone === 'light' });
                await seedMessages(page);
                await deleteSingle(page);
                await expect(page.locator('.neconyan-undo-action')).toBeFocused();
                await assertUndoGeometry(page, width < 768);
                await expect(page.locator('.neconyan-undo-toast')).toHaveCSS('background-image', 'none');
                await assertReadable(page, '.neconyan-undo-action', '.neconyan-undo-action');
                await page.locator('.neconyan-undo-dismiss').focus();
                await page.mouse.move(0, 0);
                await assertReadable(page, '.neconyan-undo-action', '.neconyan-undo-action');
                await assertReadable(page, '.neconyan-undo-message', '.neconyan-undo-toast');
                await page.locator('.neconyan-undo-action').focus();
                await expect(page.locator('#toast-container .toast:not(.neconyan-undo-toast)')).toHaveCount(0);
                await page.screenshot({ path: `${outputDir}/${tone}-${width}-undo.png` });
                if (width < 768) await page.locator('.neconyan-undo-action').tap();
                else await page.locator('.neconyan-undo-action').press('Space');
                await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
                expect(await messages(page)).toHaveLength(4);
            });
        });
    }
}

test('app and OS reduced motion remove Undo immediately without clearing another notice', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openUndoFixture(page);
    await seedMessages(page);
    await page.evaluate(() => document.body.classList.add('reduced-motion'));
    await deleteSingle(page);
    await page.evaluate(() => window.toastr.info('Keep this separate notice', '', { timeOut: 0, extendedTimeOut: 0 }));
    await page.locator('.neconyan-undo-dismiss').evaluate(button => button.click());
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0, { timeout: 100 });
    await expect(page.locator('#toast-container')).toContainText('Keep this separate notice');
});


test('quick range Undo preserves deletion event order and user scroll', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page, { count: 20 });
    await enterRange(page, 10);
    state.saveRequests.length = 0;
    state.nextSave = { delay: 1500 };
    await page.locator('#dialogue_del_mes_ok').click();
    await expect.poll(() => state.saveRequests.length).toBe(1);
    await page.locator('.neconyan-undo-action').click();
    await page.locator('#chat').hover();
    await page.mouse.wheel(0, -5000);
    await expect.poll(() => page.locator('#chat').evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    expect(await messages(page)).toHaveLength(20);
    expect(await page.locator('#chat').evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
    const events = await page.evaluate(() => ({ events: window.__undoEvents, types: window.SillyTavern.getContext().eventTypes }));
    expect(events.events.filter(event => event.type === events.types.MESSAGE_DELETED)).toEqual([{ type: events.types.MESSAGE_DELETED, args: [10] }]);
    expect(events.events[0].type).toBe(events.types.MESSAGE_DELETED);
    const savedMessageCounts = state.saveRequests.map(request => request.chat.length - 1);
    // Native deletion listeners can save metadata; the restored content is still saved once.
    expect(savedMessageCounts[0]).toBe(10);
    expect(savedMessageCounts.filter(count => count === 20), JSON.stringify(savedMessageCounts)).toHaveLength(1);
    expect(savedMessageCounts.at(-1)).toBe(20);
    expect(savedMessageCounts.every(count => count === 10 || count === 20)).toBe(true);
});

test('a chat switch during restore refresh stops the remaining events', async ({ page }) => {
    await openUndoFixture(page);
    await seedMessages(page);
    await enterRange(page, 1);
    await page.locator('#dialogue_del_mes_ok').click();
    await settleDeletion(page);
    await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        window.__undoEvents.length = 0;
        const changeChat = async () => {
            context.eventSource.removeListener(context.eventTypes.MESSAGE_UPDATED, changeChat);
            await context.selectCharacterById(1, { switchMenu: false });
        };
        context.eventSource.on(context.eventTypes.MESSAGE_UPDATED, changeChat);
    });
    await page.locator('.neconyan-undo-action').click();
    await page.waitForFunction(() => String(window.SillyTavern.getContext().characterId) === '1');
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    expect(await page.evaluate(() => window.__undoEvents.filter(event => event.type === window.SillyTavern.getContext().eventTypes.MESSAGE_UPDATED).length)).toBe(1);
    expect((await messages(page)).some(message => message.mes === 'remove me')).toBe(false);
});

test('a chat switch during swipe deletion never adopts the new owner', async ({ page }) => {
    await openUndoFixture(page);
    await seedMessages(page, { swipes: true });
    await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        window.__deletedSwipeMessage = context.chat.at(-1);
        const changeChat = async () => {
            context.eventSource.removeListener(context.eventTypes.MESSAGE_SWIPE_DELETED, changeChat);
            await context.selectCharacterById(1, { switchMenu: false });
        };
        context.eventSource.on(context.eventTypes.MESSAGE_SWIPE_DELETED, changeChat);
    });
    await page.locator('#chat .mes').last().locator('.mes_delete').click();
    await page.locator('dialog.popup:visible').getByRole('button', { name: 'Delete Swipe', exact: true }).click();
    await page.waitForFunction(() => String(window.SillyTavern.getContext().characterId) === '1');
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    expect(await page.evaluate(() => window.__deletedSwipeMessage.swipes.length)).toBe(2);
    expect((await messages(page)).some(message => message.mes === 'second version')).toBe(false);
});

test('a blocked Undo keeps keyboard focus and remains available', async ({ page }) => {
    await openUndoFixture(page);
    await seedMessages(page);
    await deleteSingle(page);
    await settleDeletion(page);
    await page.mouse.move(0, 0);
    await page.evaluate(() => { document.body.dataset.swiping = 'true'; });
    await page.locator('.neconyan-undo-action').press('Space');
    await expect(page.locator('.neconyan-undo-action')).toBeFocused();
    await page.waitForTimeout(8500);
    await expect(page.locator('.neconyan-undo-action')).toBeVisible();
    expect(await messages(page)).toHaveLength(3);
    await page.evaluate(() => { delete document.body.dataset.swiping; });
    await page.locator('.neconyan-undo-action').press('Space');
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    expect(await messages(page)).toHaveLength(4);
});

test('invalid API deletes retain Undo but an actual slash deletion clears it before saving', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await deleteSingle(page);
    await settleDeletion(page);
    await page.evaluate(async () => {
        const core = await import('/script.js');
        await core.deleteMessage(99, null, false);
        const slash = await import('/scripts/slash-commands.js');
        await slash.executeSlashCommandsWithOptions('/delname Missing Cat');
    });
    await expect(page.locator('.neconyan-undo-action')).toBeVisible();
    state.nextSave = { delay: 1500 };
    await page.evaluate(async () => {
        const slash = await import('/scripts/slash-commands.js');
        window.__slashDeletion = slash.executeSlashCommandsWithOptions('/delname Undo Cat');
    });
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0, { timeout: 1000 });
    await page.evaluate(async () => window.__slashDeletion);
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
});


test('dismissing a range Undo preserves its pending deletion event', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page);
    await enterRange(page, 1);
    state.nextSave = { delay: 1200 };
    await page.locator('#dialogue_del_mes_ok').click();
    await page.locator('.neconyan-undo-dismiss').click();
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__undoEvents.filter(event => event.type === window.SillyTavern.getContext().eventTypes.MESSAGE_DELETED))).toEqual([{ type: 'message_deleted', args: [1] }]);
    expect(await messages(page)).toHaveLength(1);
});

test('early picker Undo keeps restored selection and rows during a delayed deletion save', async ({ page }) => {
    const state = await openUndoFixture(page);
    await seedMessages(page, { swipes: true });
    const picker = await openPicker(page);
    await picker.locator('.swipe_picker_block[data-swipe-id="1"] .swipe_picker_delete').click();
    state.nextSave = { delay: 2000 };
    await page.locator('dialog.popup:visible').filter({ hasText: 'Are you sure you want to delete swipe #2?' }).getByRole('button', { name: 'Delete Swipe', exact: true }).click();
    await page.locator('.neconyan-undo-action').click();
    await expect(page.locator('.neconyan-undo-toast')).toHaveCount(0);
    await expect(picker.locator('.swipe_picker_block')).toHaveCount(3);
    await expect(picker.locator('.swipe_picker_block[highlight="true"]')).toHaveAttribute('data-swipe-id', '1');
    await expect(picker.locator('.swipe_picker_block[data-swipe-id="1"]')).toBeFocused();
    expect(await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).mes)).toBe('second version');
});

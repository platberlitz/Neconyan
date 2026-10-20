/* global document, window */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test, MODEL } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.setTimeout(180000);

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} ordinary regenerate and guided response/swipe stay in the browser`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true });
        const page = await openChat(account);
        const requests = [];
        page.on('request', request => {
            if (/\/api\/(backends\/chat-completions\/generate|roleplay\/workflow\/submit)$/.test(request.url())) requests.push(request.url());
        });
        for (const [index, action] of ['normal', 'regenerate', 'guidedResponse', 'guidedSwipe'].entries()) {
            const answer = `Browser answer ${index}.`;
            app.provider.mode.reply = { choices: [{ message: { content: answer } }] };
            await page.locator('#send_textarea').fill(action === 'normal' ? 'Hello, Nova.' : action.startsWith('guided') ? `Direction ${index}: mention the fountain.` : '');
            await page.evaluate(async action => {
                if (action.startsWith('guided')) {
                    const module = await import(`/scripts/extensions/guided-generations/scripts/${action}.js`);
                    await module[action]();
                } else {
                    await (await import('/script.js')).Generate(action);
                }
            }, action);
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(answer);
            if (action.startsWith('guided')) {
                await expect(page.locator('#send_textarea')).toHaveValue(`Direction ${index}: mention the fountain.`);
                expect(JSON.stringify(app.provider.calls[index].messages)).toContain(`Direction ${index}: mention the fountain.`);
            }
        }
        expect(requests).toHaveLength(4);
        expect(requests.every(url => url.endsWith('/api/backends/chat-completions/generate'))).toBe(true);
        expect(app.provider.calls).toHaveLength(4);
        const chat = await page.evaluate(async () => (await import('/script.js')).chat);
        expect(chat.filter(message => message.is_user).map(message => message.mes)).toEqual(['Hello, Nova.']);
        expect(chat.at(-1).swipes).toEqual(['Browser answer 2.', 'Browser answer 3.']);
    });

    test(`${viewport} browser reply remains visible while Post Gen and Companion run`, async ({ app }) => {
        app.provider.mode.hold = ['post-held', 'companion-held'];
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === MODEL ? 'The browser reply is ready.'
            : body.model === 'post-held' ? 'The revised browser reply is ready.' : 'The Companion note is ready.' }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.connectionManager.profiles.push(
                { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-held', 'api-url': app.provider.url },
                { id: 'companion', name: 'Companion fixture', api: 'custom', mode: 'cc', model: 'companion-held', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                trackerCompanionAutoLoopVersion: 4, connectionProfile: 'post', companionExecutionMode: 'parallel', companionConcurrentWithPostGen: false } };
        } });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(directory, { recursive: true });
        for (const agent of [
            { id: 'post', name: 'Post Gen', enabled: true, phase: 'post', prompt: 'Revise the reply.', connectionProfile: 'post',
                postProcess: { enabled: false, promptTransformEnabled: true } },
            { id: 'companion', name: 'Story Companion', enabled: true, category: 'companion', execution: 'companion',
                prompt: 'Write a note about the reply.', connectionProfile: 'companion', companion: { trigger: 'auto', displayMode: 'card' } },
        ]) await fs.writeFile(path.join(directory, `${agent.id}.json`), JSON.stringify(agent));
        const page = await openChat(account);
        const submissions = [];
        page.on('request', request => { if (request.url().endsWith('/api/roleplay/workflow/submit')) submissions.push(request.url()); });
        await page.locator('#send_textarea').fill('Let the Agents help with this reply.');
        await page.locator('#send_textarea').press('Enter');
        try {
            await expect.poll(() => app.provider.calls.some(call => call.model === 'post-held'), { timeout: 30000 }).toBe(true);
            await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The browser reply is ready.');
            expect(app.provider.calls.find(call => call.model === 'post-held').completedAt).toBeNull();
        } finally {
            await app.release();
        }
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The revised browser reply is ready.', { timeout: 30000 });
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The Companion note is ready.', { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
        expect(submissions).toEqual([]);
        expect(app.provider.calls).toHaveLength(3);
        await page.close();
        const reopened = await openChat(account);
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText('The revised browser reply is ready.');
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText('The Companion note is ready.');
        expect(app.provider.calls).toHaveLength(3);
    });
}

test('scoped Notebook context selects the server only while the note is enabled', async ({ app }) => {
    const account = await app.account({ activeConnection: true });
    const page = await openChat(account);
    const chatId = await page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
    const { notebook } = await account.post('/api/notebooks/create', { operationId: 'routing:notebook', name: 'Reply context' });
    const { noteId } = await account.post('/api/notebooks/notes/create', { operationId: 'routing:note', notebookId: notebook.id,
        title: 'Selected context', text: 'The selected note says the fountain is purple.' });
    await account.post('/api/notebooks/policies/update', { notebookId: notebook.id, patch: {
        notes: { [noteId]: { context: { mode: 'pinned', scopes: [{ kind: 'chat', id: `${account.avatar}:${chatId}` }] } } },
    } });
    const native = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit'));
    await page.locator('#send_textarea').fill('Describe the fountain.');
    await page.locator('#send_textarea').press('Enter');
    const response = await native;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).jobId);
    expect(JSON.stringify(app.provider.calls[0].messages)).toContain('The selected note says the fountain is purple.');
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
    await account.post('/api/notebooks/policies/update', { notebookId: notebook.id, patch: {
        notes: { [noteId]: { context: { mode: 'off' } } },
    } });
    const browser = page.waitForRequest(request => request.url().endsWith('/api/backends/chat-completions/generate'));
    await page.locator('#send_textarea').fill('Continue without the note.');
    await page.locator('#send_textarea').press('Enter');
    await browser;
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
    expect(app.provider.calls).toHaveLength(2);
    expect(JSON.stringify(app.provider.calls[1].messages)).not.toContain('The selected note says the fountain is purple.');
});

// A browser image refusal shows its one notice, leaves Send usable, and raises no uncaught error. The tests share one describe so
// they run one after another, and each title names the behaviour it checks.
const FIXTURE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const TOO_MANY_IMAGES_TEXT = 'A message would send more than four images. Set some to Show only, or show them as a gallery so only one is sent.';
const STALE_CHOICE_TEXT = 'An image changed after its choice was saved. Choose again for it in Review chat images.';
const NOTICE_TITLE = 'Review needed before replying';
const NOTICE_ACTION = 'Open Review chat images to choose what the model receives.';
const PROVIDER_FAILURE_TEXT = 'Fixture provider failure.';
// On unchanged staging this provider-failure control produced one page error ('Got response status 500') and the generic
// Chat Completion API toast.
const PROVIDER_FAILURE_PAGE_ERRORS = 1;
const PROVIDER_FAILURE_GENERIC_TOAST = true;
// The server group route saves, acknowledges settings and submits before it answers; its refusal event can arrive well after a browser refusal.
const REFUSAL_EVENT_TIMEOUT_MS = 30000;

const createRefusalAccount = async (app, phone) => {
    const account = await app.account({ phone, activeConnection: true,
        contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
        configureSettings(saved) {
            saved.power_user.auto_swipe = false;
            saved.power_user.auto_continue = { enabled: false };
        } });
    if (phone) await installIPhoneSafari(account.context);
    return account;
};

const watchRefusals = context => context.addInitScript(() => {
    window.__refusals = [];
    window.__failures = [];
    window.addEventListener('neconyan:image-input-refused', event => { window.__refusals.push(structuredClone(event.detail)); });
    window.addEventListener('error', event => { window.__failures.push({ type: 'error', message: String(event.message) }); });
    window.addEventListener('unhandledrejection', event => { window.__failures.push({ type: 'unhandledrejection', message: String(event.reason?.message ?? event.reason) }); });
});

// Every page error from before the document loads, so the pre-Send snapshot has a listener that was there all along.
const collectPageErrors = context => {
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(String(error?.message ?? error))));
    return errors;
};

const openRefusalPage = async (account, phone) => {
    const page = await account.open({ workspace: false });
    if (phone) await applyIOSOnlyCss(page);
    return page;
};

const openSolo = async (account, phone) => {
    const pageErrors = collectPageErrors(account.context);
    const page = await account.open({ workspace: false });
    if (phone) await applyIOSOnlyCss(page);
    const chatId = await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        return core.getCurrentChatId();
    }, account.avatar);
    if (!chatId) throw new Error('The fixture chat has no chat id.');
    return { page, pageErrors, chatId: String(chatId).replace(/\.jsonl$/, '') };
};

const seedImages = (page, media, mes) => page.evaluate(async ({ data, media, mes }) => {
    const core = await import('/script.js');
    const url = `data:image/png;base64,${data}`;
    core.chat.push({ name: 'User', is_user: true, is_system: false, mes,
        extra: { media: media.map((item, index) => ({ type: 'image', url, title: `Picture ${index + 1}`, ...item })), media_display: 'list' } });
    if (!await core.saveChatConditional()) throw new Error('Fixture chat was not saved.');
}, { data: FIXTURE_PNG, media, mes });

const settleChat = async page => {
    // Outlast the Prompt Manager's 1000 ms render debounce, its dry run and the prompt build before taking the pre-Send error snapshot.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(2500);
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
};

const sendWithButton = async (page, phone, text) => {
    await page.locator('#send_textarea').fill(text);
    if (phone) await page.locator('#send_but').tap();
    else await page.locator('#send_but').click();
};

// 'Exactly one' is counted after a further 1500 ms, so a second event inside that window still fails the count.
const allowRefusal = async page => {
    try { await expect.poll(() => page.evaluate(() => window.__refusals.length), { timeout: REFUSAL_EVENT_TIMEOUT_MS }).toBeGreaterThanOrEqual(1); }
    catch { /* the count assertion at the call site reports the received number */ }
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(1500);
    return page.evaluate(() => window.__refusals);
};

const noticeToast = page => page.locator('#toast-container .toast-warning').filter({ hasText: NOTICE_TITLE });

const openNoticeReview = async (page, phone, locator) => {
    await expect(noticeToast(page)).toHaveCount(1);
    await expect(noticeToast(page)).toBeVisible();
    await expect(noticeToast(page).locator('.toast-title')).toHaveText(NOTICE_TITLE);
    const scan = page.waitForRequest(request => request.url().endsWith('/api/roleplay/images/scan'));
    if (phone) await noticeToast(page).tap(); else await noticeToast(page).click();
    expect((await scan).postDataJSON().locator).toEqual(locator);
    await expect(page.locator('#prompt-media-review')).toBeVisible();
};

const closeNoticeReview = async page => {
    await page.locator('dialog.popup:has(#prompt-media-review) .popup-button-ok').click();
    await expect(page.locator('#prompt-media-review')).toHaveCount(0);
};

const stateOf = async (page, { pageErrors, providerCalls, extra = {} }) => {
    const state = await page.evaluate(async () => {
        const core = await import('/script.js');
        const last = core.chat.at(-1) ?? null;
        const lastNode = [...document.querySelectorAll('#chat > .mes[mesid]')].at(-1) ?? null;
        const visible = node => Boolean(node && node.getClientRects().length);
        return { refusals: window.__refusals, failures: window.__failures, lastChatRow: last,
            composer: document.getElementById('send_textarea')?.value ?? null, is_send_press: core.is_send_press,
            sendButtonVisible: visible(document.getElementById('send_but')), lastSwipeRightVisible: visible(lastNode?.querySelector('.swipe_right')) };
    });
    return { ...state, pageErrors, providerCalls, ...extra };
};

const saveState = async (info, name, state) => {
    const body = JSON.stringify(state, null, 2);
    await info.attach(`refusal-state-${name}`, { body, contentType: 'application/json' });
    if (process.env.REFUSAL_STATE_DIR) {
        await fs.mkdir(process.env.REFUSAL_STATE_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.REFUSAL_STATE_DIR, `refusal-${name}.json`), body);
    }
};

// Mewmory's prepare guard refuses a turn while the chat has a pending save. Flush it exactly as the guard does before the first group send.
const settleGroupChatSave = async page => {
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves({ silent: true })), { timeout: 15000 }).toBe(true);
};

// A stalled no-image group control is not a refusal, so save what the page and server knew before rethrowing the same error.
const captureControlStall = async (info, name, page, app, pageErrors, check) => {
    try {
        await check();
    } catch (error) {
        try {
            const state = await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length });
            const drafts = await page.evaluate(() => window.__drafts ?? []);
            state.draftCount = drafts.length;
            state.draftTimes = drafts;
            state.providerCallDetails = app.provider.calls.map(call => ({ model: call.model, startedAt: call.startedAt, completedAt: call.completedAt }));
            state.generationFlags = await page.evaluate(async () => {
                const core = await import('/script.js');
                const group = await import('/scripts/group-chats.js');
                return { is_send_press: core.is_send_press, is_group_generating: group.is_group_generating };
            });
            state.lastChatRows = await page.evaluate(async () => (await import('/script.js')).chat.slice(-5).map(row => ({
                name: row.name, is_user: row.is_user, mes: String(row.mes ?? '').slice(0, 60) })));
            state.toasts = await page.evaluate(() => [...document.querySelectorAll('#toast-container > div')]
                .filter(node => node.getClientRects().length).map(node => node.textContent.trim()).filter(Boolean));
            state.serverOutputTail = String(app.serverOutput ?? '').split(/\r?\n/).slice(-40).join('\n');
            await saveState(info, name, state);
        } catch { /* the test's own failure is the one to report */ }
        throw error;
    }
};

const createGroup = async account => {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Durable Kit', description: 'A second speaker.', first_mes: 'Hello from Kit.' } });
    expect(created.ok()).toBe(true);
    const second = await created.text();
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Group viewport probe', allow_create: true } });
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    return account.post('/api/groups/create', { name: 'Two speakers', members: [account.avatar, second],
        activation_strategy: 1, roleplay: { account: stamp, operationKey: randomUUID() } });
};

const openGroup = async (page, group) => {
    await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
    await acknowledgeActiveSettings(page);
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        window.__drafts = [];
        eventSource.on(event_types.GROUP_MEMBER_DRAFTED, () => window.__drafts.push(Date.now()));
    });
};

test.describe('browser image refusal notice', () => {
    test.describe.configure({ mode: 'default' });

    for (const phone of [false, true]) {
        const viewport = phone ? 'phone' : 'desktop';
        test(`shows one notice when five images are set to be sent (${viewport})`, async ({ app }, info) => {
            test.setTimeout(240000);
            app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Second try answered.' } }] };
            const account = await createRefusalAccount(app, phone);
            await watchRefusals(account.context);
            const { page, pageErrors, chatId } = await openSolo(account, phone);
            await seedImages(page, [{}, {}, {}, {}, {}], 'Five pictures.');
            await settleChat(page);
            expect(app.provider.calls).toHaveLength(0);
            const beforeErrors = [pageErrors.length, await page.evaluate(() => window.__failures.length)];
            await sendWithButton(page, phone, 'Please look.');
            const refusals = await allowRefusal(page);
            await saveState(info, `solo-five-images-${viewport}`, await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length }));

            expect(refusals).toHaveLength(1);
            expect(refusals[0].reason).toBe('too-many-images');
            expect(refusals[0].message).toBe(TOO_MANY_IMAGES_TEXT);
            expect(refusals[0].origin).toEqual({ workspace: 'roleplay', account: 'default-user',
                locator: { group: false, chat: chatId, avatar: account.avatar } });
            expect(pageErrors).toHaveLength(beforeErrors[0]);
            expect(await page.evaluate(() => window.__failures.length)).toBe(beforeErrors[1]);
            expect(app.provider.calls).toHaveLength(0);
            const last = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
            expect(last.is_user).toBe(true);
            expect(last.mes).toBe('Please look.');
            await expect(page.locator('#send_textarea')).toHaveValue('');
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
            await expect(page.locator('#send_but')).toBeVisible();

            // The one notice, its wording, and the review for the chat that was refused. Read the wording before the click, because
            // a click is also toastr's dismiss.
            await expect(noticeToast(page).locator('.toast-message')).toContainText(TOO_MANY_IMAGES_TEXT);
            await expect(noticeToast(page).locator('.toast-message')).toContainText(NOTICE_ACTION);
            await openNoticeReview(page, phone, { group: false, chat: chatId, avatar: account.avatar });
            await closeNoticeReview(page);

            // The same page sends again once the account no longer inlines chat images.
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                power_user.neconyan_prompt_media = { version: 1, images: 'display-only' };
            });
            await sendWithButton(page, phone, 'Second try.');
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText('Second try answered.');
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
            expect(await page.evaluate(() => window.__refusals.length)).toBe(1);
        });

        test(`shows one notice in a group chat with five images (${viewport})`, async ({ app }, info) => {
            test.setTimeout(240000);
            app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Group answer.' } }] };
            const account = await createRefusalAccount(app, phone);
            const group = await createGroup(account);
            await watchRefusals(account.context);
            const pageErrors = collectPageErrors(account.context);
            const page = await openRefusalPage(account, phone);
            await openGroup(page, group);
            const groupChat = await page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
            expect(groupChat).toBe(group.chat_id);
            await settleGroupChatSave(page);

            // The control: a whole-group address with no images activates both members and makes one provider call each.
            await sendWithButton(page, phone, 'Everyone, say hello.');
            await captureControlStall(info, `group-control-stall-${viewport}`, page, app, pageErrors, async () => {
                await expect.poll(() => page.evaluate(() => window.__drafts.length), { timeout: 60000 }).toBe(2);
                await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBe(2);
            });
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);

            const fiveImages = [{}, {}, {}, {}, {}];
            await seedImages(page, fiveImages, 'Five pictures.');
            await settleChat(page);
            const beforeErrors = [pageErrors.length, await page.evaluate(() => window.__failures.length)];
            const beforeDrafts = await page.evaluate(() => window.__drafts.length);
            const beforeCalls = app.provider.calls.length;
            await sendWithButton(page, phone, 'Everyone, please look at this.');
            const refusals = await allowRefusal(page);
            await saveState(info, `group-five-images-${viewport}`, await stateOf(page, { pageErrors,
                providerCalls: app.provider.calls.length, extra: { drafts: await page.evaluate(() => window.__drafts.length) } }));

            expect(refusals).toHaveLength(1);
            expect(refusals[0].origin).toEqual({ workspace: 'roleplay', account: 'default-user',
                locator: { group: true, chat: group.chat_id } });
            expect(pageErrors).toHaveLength(beforeErrors[0]);
            expect(await page.evaluate(() => window.__failures.length)).toBe(beforeErrors[1]);
            expect(app.provider.calls).toHaveLength(beforeCalls);
            expect(await page.evaluate(() => window.__drafts.length)).toBe(beforeDrafts + 1);
            const last = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
            expect(last.is_user).toBe(true);
            expect(last.mes).toBe('Everyone, please look at this.');
            await expect(page.locator('#send_textarea')).toHaveValue('');
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);

            await expect(noticeToast(page).locator('.toast-message')).toContainText(TOO_MANY_IMAGES_TEXT);
            await expect(noticeToast(page).locator('.toast-message')).toContainText(NOTICE_ACTION);
            await openNoticeReview(page, phone, { group: true, chat: group.chat_id });
        });
    }

    test('a stale image choice shows one notice', async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await createRefusalAccount(app, false);
        await watchRefusals(account.context);
        const { page, pageErrors, chatId } = await openSolo(account, false);
        await seedImages(page, [{ neconyan_prompt: { version: 1, mode: 'include', attachment_hash: 'c'.repeat(64) } }], 'Stale picture.');
        await settleChat(page);
        const beforeErrors = [pageErrors.length, await page.evaluate(() => window.__failures.length)];
        await sendWithButton(page, false, 'Stale check.');
        const refusals = await allowRefusal(page);
        await saveState(info, 'stale-choice-desktop', await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length }));

        expect(refusals).toHaveLength(1);
        expect(refusals[0].reason).toBe('stale-policy');
        expect(refusals[0].message).toBe(STALE_CHOICE_TEXT);
        expect(refusals[0].origin).toEqual({ workspace: 'roleplay', account: 'default-user',
            locator: { group: false, chat: chatId, avatar: account.avatar } });
        expect(pageErrors).toHaveLength(beforeErrors[0]);
        expect(await page.evaluate(() => window.__failures.length)).toBe(beforeErrors[1]);
        const last = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(last.is_user).toBe(true);
        expect(last.mes).toBe('Stale check.');
        await expect(page.locator('#send_textarea')).toHaveValue('');
    });

    test('the server route still shows one notice (single chat)', async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await createRefusalAccount(app, false);
        await watchRefusals(account.context);
        const { page, pageErrors } = await openSolo(account, false);
        await acknowledgeActiveSettings(page);
        await page.route('**/api/roleplay/workflow/submit', route => route.fulfill({ status: 409, contentType: 'application/json',
            body: JSON.stringify({ error: TOO_MANY_IMAGES_TEXT, code: 'ROLEPLAY_IMAGE_INPUT',
                imageIssue: { reason: 'too-many-images', index: 1, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] } }) }));
        await startNativeReply(page);
        await allowRefusal(page);
        await saveState(info, 'server-single-notice-desktop', await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length }));
        expect(await page.evaluate(() => window.__refusals.length)).toBe(1);
        await expect(noticeToast(page)).toHaveCount(1);
        await expect(noticeToast(page).locator('.toast-title')).toHaveText(NOTICE_TITLE);
    });

    test('the server route still shows one notice (group chat)', async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await createRefusalAccount(app, false);
        const group = await createGroup(account);
        await watchRefusals(account.context);
        const pageErrors = collectPageErrors(account.context);
        const page = await account.open({ workspace: false });
        await openGroup(page, group);
        await settleGroupChatSave(page);
        await page.route('**/api/roleplay/group/submit', route => route.fulfill({ status: 409, contentType: 'application/json',
            body: JSON.stringify({ error: TOO_MANY_IMAGES_TEXT, code: 'ROLEPLAY_IMAGE_INPUT',
                imageIssue: { reason: 'too-many-images', index: 1, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] } }) }));
        await startNativeReply(page);
        await allowRefusal(page);
        await saveState(info, 'server-group-notice-desktop', await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length }));
        expect(await page.evaluate(() => window.__refusals.length)).toBe(1);
        await expect(noticeToast(page)).toHaveCount(1);
        await expect(noticeToast(page).locator('.toast-title')).toHaveText(NOTICE_TITLE);
    });

    test('quiet and dry-run generations stay silent', async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await createRefusalAccount(app, false);
        await watchRefusals(account.context);
        const { page, pageErrors } = await openSolo(account, false);
        await seedImages(page, [{}, {}, {}, {}, {}], 'Five pictures.');
        await settleChat(page);
        const beforeErrors = [pageErrors.length, await page.evaluate(() => window.__failures.length)];
        const beforeRefusals = await page.evaluate(() => window.__refusals.length);
        const results = await page.evaluate(async () => {
            const core = await import('/script.js');
            const outcome = async (type, options, dryRun) => {
                try { await core.Generate(type, options, dryRun); return { resolved: true }; }
                catch (error) { return { code: error?.code, reason: error?.imageIssue?.reason }; }
            };
            return [await outcome('normal', {}, true), await outcome('quiet', { quiet_prompt: 'Fixture quiet.' })];
        });
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(500);
        await saveState(info, 'quiet-dry-run-desktop', await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length }));
        expect(results).toEqual([{ code: 'ROLEPLAY_IMAGE_INPUT', reason: 'too-many-images' },
            { code: 'ROLEPLAY_IMAGE_INPUT', reason: 'too-many-images' }]);
        expect(await page.evaluate(() => window.__refusals.length)).toBe(beforeRefusals);
        await expect(noticeToast(page)).toHaveCount(0);
        expect(pageErrors).toHaveLength(beforeErrors[0]);
        expect(await page.evaluate(() => window.__failures.length)).toBe(beforeErrors[1]);
    });

    test('a provider failure shows no image notice', async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await createRefusalAccount(app, false);
        await watchRefusals(account.context);
        const { page, pageErrors } = await openSolo(account, false);
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({ status: 500, contentType: 'application/json',
            body: JSON.stringify({ error: { message: PROVIDER_FAILURE_TEXT } }) }));
        await sendWithButton(page, false, 'Provider failure control.');
        try { await expect.poll(() => pageErrors.length, { timeout: 15000 }).toBe(PROVIDER_FAILURE_PAGE_ERRORS); }
        catch { /* the count assertion below reports the recorded value */ }
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press), { timeout: 15000 }).toBe(false);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(500);
        const genericToast = await page.locator('#toast-container .toast-error').filter({ hasText: PROVIDER_FAILURE_TEXT }).count();
        await saveState(info, 'provider-failure-desktop', await stateOf(page, { pageErrors, providerCalls: app.provider.calls.length,
            extra: { genericErrorToast: genericToast > 0 } }));
        expect(pageErrors).toHaveLength(PROVIDER_FAILURE_PAGE_ERRORS);
        expect(genericToast > 0).toBe(PROVIDER_FAILURE_GENERIC_TOAST);
        expect(await page.evaluate(() => window.__refusals.length)).toBe(0);
        await expect(noticeToast(page)).toHaveCount(0);
    });
});

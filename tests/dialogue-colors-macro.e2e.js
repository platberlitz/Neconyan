/* global window */
/**
 * The page's {{dialoguecolors}} macro text must reach a server-owned Roleplay
 * prompt, or the saved reply must refuse accurately before paying for a model
 * call. Nothing here touches real user data: the disposable fixture owns the
 * server, the account and the local mock provider.
 */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAccountStamp } = await import('../src/roleplay-store.js');

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

const MARKER = 'DC-MARKER';
const AGENT_MARKER = 'DC-AGENT-MARKER';
const MARKED_PROMPT = `${MARKER}-BEFORE {{dialoguecolors}} ${MARKER}-AFTER`;
const STREAM = { first: 'The coloured ', rest: 'reply.' };

function owned(app) {
    const owner = 'default-user';
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE)
        .map(([key, relative]) => [key, path.join(app.directory, 'data', owner, relative)]));
    const base = { owner, directories };
    const { accountId, dataEpoch } = roleplayAccountStamp(base);
    return { base, account: { accountId, dataEpoch }, directories, scope: { ...base, accountId, dataEpoch } };
}

async function savedChat(account, name) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const source = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(source.ok(), await source.text()).toBe(true);
    const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {} },
    ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { group: false, avatar: account.avatar, chat: name };
}

async function openChat(page, { avatar, chat }) {
    const opened = await page.evaluate(async ({ avatar, chat }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        if (core.getCurrentChatId() !== chat) await core.openCharacterChat(chat);
        return core.getCurrentChatId();
    }, { avatar, chat });
    expect(opened).toBe(chat);
    await expect(page.locator('#chat .mes').first()).toContainText('Retained answer.');
}

function acceptedSubmission(response) {
    return response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409;
}

/**
 * One owned account whose active Chat Completion preset carries a marker prompt
 * around the placeholder, with the Dialogue Colors extension shipped enabled.
 */
async function prepare(app, { phone = false, prompt = MARKED_PROMPT, onlyMarkedMacro = false } = {}) {
    app.provider.mode.streamReply = { ...STREAM };
    const account = await app.account({ phone, activeConnection: true, configureSettings(settings) {
        settings.power_user.collapse_newlines = false;
        settings.oai_settings.stream_openai = true;
        settings.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false } };
        // The default Formatting prompt already has this macro; isolate the exact-once cases.
        if (onlyMarkedMacro) {
            for (const item of settings.oai_settings.prompts) {
                if (typeof item.content === 'string') item.content = item.content.replace(/{{\s*dialoguecolors\s*}}/gi, '');
            }
        }
        settings.oai_settings.prompts = [...settings.oai_settings.prompts, { identifier: 'dc-macro-marker',
            name: 'Dialogue colours marker', content: prompt, role: 'system', injection_position: 0, injection_depth: 4, injection_order: 100 }];
        const order = settings.oai_settings.prompt_order.find(item => String(item.character_id) === '100001')?.order;
        if (!Array.isArray(order)) throw new Error('The fixture needs the default Chat Completion prompt order.');
        order.push({ identifier: 'dc-macro-marker', enabled: true });
    } });
    const locator = await savedChat(account, `Dialogue colours ${phone ? 'phone' : 'desktop'} ${Date.now()}`);
    // A post-processing Agent needs no provider request; the reply below is the only call.
    const native = owned(app);
    await fs.mkdir(native.directories.inChatAgents, { recursive: true });
    await fs.writeFile(path.join(native.directories.inChatAgents, 'dc-macro-agent.json'), JSON.stringify({
        id: 'dc-macro-agent', name: 'Dialogue colours agent', enabled: true, phase: 'post',
        postProcess: { enabled: true, type: 'append', appendText: `\n\n${AGENT_MARKER}` },
    }));
    const page = await account.open({ workspace: false, readyTimeout: 120000 });
    await openChat(page, locator);
    await page.waitForFunction(() => window.__dialogueColorsRuntime_v1?.initialized === true);
    return { account, locator, page };
}

/** Apply one extension state change and return the instruction its macro would deliver. */
async function setDialogueColorsState(page, change) {
    return page.evaluate(async change => {
        const state = await import('/scripts/extensions/third-party/sillytavern-character-colors/src/state.js');
        Object.assign(state.settings, change);
        const main = await import('/scripts/extensions/third-party/sillytavern-character-colors/src/main.js');
        const instruction = main.resolveDialogueColorsMacro();
        if (change.enabled !== false) main.registerDialogueColorsMacro();
        const actual = (await import('/script.js')).substituteParams('{{dialoguecolors}}');
        if (actual !== instruction) throw new Error('The registered browser macro differs from the captured instruction.');
        return actual;
    }, change);
}

/** The one provider message carrying the preset markers, as the model received it. */
function markedMessage(call) {
    return (call.messages ?? []).find(message => typeof message.content === 'string' && message.content.includes(MARKER));
}

async function finishReply(app) {
    await app.release();
    await expect.poll(() => typeof app.provider.mode.finishStream).toBe('function');
    app.provider.mode.finishStream();
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} composer reply delivers the captured Dialogue Colors instruction between the preset markers`, async ({ app }) => {
        const { account, page } = await prepare(app, { phone, onlyMarkedMacro: true });
        // Auto mode: the placeholder in the preset upgrades 'inject' to 'macro', so
        // the instruction travels through the macro once and nothing is injected twice.
        const instruction = await setDialogueColorsState(page, { coloringEngine: 'llm', enabled: true,
            promptMode: 'inject', autoPromptMode: true, themeMode: 'dark', colorTheme: 'neon' });
        expect(instruction).toContain('[Dialogue Colors');
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Colour this reply.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        const accepted = await response.json();
        const request = response.request().postDataJSON();
        expect(request.bundledMacros).toEqual({ dialoguecolors: instruction });
        expect(JSON.stringify(request.intent?.page ?? [])).not.toContain('[Dialogue Colors');
        await expect.poll(() => app.provider.calls.length).toBe(1);
        const call = app.provider.calls[0];
        expect(call.stream).toBe(true);
        expect(call.tools).toBeUndefined();
        const message = markedMessage(call);
        expect(message, JSON.stringify(call.messages)).toBeTruthy();
        expect(message.content).toBe(`${MARKER}-BEFORE ${instruction} ${MARKER}-AFTER`);
        expect(JSON.stringify(call.messages)).not.toContain('{{dialoguecolors}}');
        const deliveries = call.messages.filter(item => typeof item.content === 'string' && item.content.includes(instruction));
        expect(call.messages.reduce((count, item) => count + (typeof item.content === 'string'
            ? item.content.split(instruction).length - 1 : 0), 0), JSON.stringify(deliveries)).toBe(1);
        await finishReply(app);
        await account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('The coloured reply.');
        await expect(page.locator('#chat .mes').last()).toContainText(AGENT_MARKER);
        // The no-request Agent ran from the saved reply; no second provider call was made.
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('the settings-proof retry replays the captured instruction after the page state changes', async ({ app }) => {
    const { account, page } = await prepare(app);
    const first = await setDialogueColorsState(page, { coloringEngine: 'llm', enabled: true,
        promptMode: 'macro', themeMode: 'dark', colorTheme: 'neon' });
    expect(first).toContain('[Dialogue Colors');
    const seen = [];
    const changedResolutions = [];
    await page.route('**/api/roleplay/workflow/submit', async route => {
        const body = route.request().postDataJSON();
        seen.push(body.bundledMacros);
        if (seen.length === 1) {
            // The accepted request must replay this capture, not read the changed page again.
            await setDialogueColorsState(page, { themeMode: 'light', colorTheme: 'ocean' });
            changedResolutions.push(await page.evaluate(async () => (await import('/scripts/extensions/third-party/sillytavern-character-colors/src/main.js')).resolveDialogueColorsMacro()));
            return route.fulfill({ status: 409, json: { error: 'Save first.', code: 'roleplay_settings_ack_required' } });
        }
        return route.continue();
    });
    const submitted = page.waitForResponse(response => response.url().endsWith('/workflow/submit') && response.status() === 202);
    await page.locator('#send_textarea').fill('Keep the captured instruction.');
    await page.locator('#send_textarea').press('Enter');
    const accepted = await (await submitted).json();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ dialoguecolors: first });
    expect(seen[1]).toEqual(seen[0]);
    // The changed page state really would have resolved differently.
    expect(changedResolutions[0]).not.toBe(first);
    await finishReply(app);
    await account.settled(accepted.jobId);
    await expect(page.locator('#chat .mes').last()).toContainText('The coloured reply.');
    expect(app.provider.calls).toHaveLength(1);
});

const EMPTY_CASES = [
    ['a disabled extension', { enabled: false }],
    ['the colorize profile mode', { enabled: true, coloringEngine: 'llm', promptMode: 'profile' }],
    ['the local DOM engine', { enabled: true, coloringEngine: 'dom', promptMode: 'macro' }],
];
for (const [label, change] of EMPTY_CASES) {
    test(`${label} captures explicit empty text and the placeholder never reaches the reply prompt`, async ({ app }) => {
        const { account, page } = await prepare(app);
        expect(await setDialogueColorsState(page, change)).toBe('');
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Colour nothing.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        const accepted = await response.json();
        expect(response.request().postDataJSON().bundledMacros).toEqual({ dialoguecolors: '' });
        await expect.poll(() => app.provider.calls.length).toBe(1);
        const call = app.provider.calls[0];
        const message = markedMessage(call);
        expect(message, JSON.stringify(call.messages)).toBeTruthy();
        expect(message.content).toBe(`${MARKER}-BEFORE  ${MARKER}-AFTER`);
        expect(JSON.stringify(call.messages)).not.toContain('{{dialoguecolors}}');
        await finishReply(app);
        await account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('The coloured reply.');
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('a held reply finishes on the server after every page closes and reopens with one durable request', async ({ app, browser }) => {
    const { account, locator, page } = await prepare(app);
    const instruction = await setDialogueColorsState(page, { coloringEngine: 'llm', enabled: true,
        promptMode: 'macro', themeMode: 'dark', colorTheme: 'neon' });
    app.provider.mode.hold = ['conversation-fixture', 'unused-named-model'];
    const submitted = page.waitForResponse(acceptedSubmission);
    await page.locator('#send_textarea').fill('Finish this while I am away.');
    await page.locator('#send_textarea').press('Enter');
    const response = await submitted;
    const accepted = await response.json();
    // The accepted request carries the capture, so the closed page is not needed to finish it.
    expect(response.request().postDataJSON().bundledMacros).toEqual({ dialoguecolors: instruction });
    await expect.poll(() => app.provider.calls.length).toBe(1);
    for (const context of browser.contexts()) {
        for (const open of context.pages()) await open.close();
    }
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    await finishReply(app);
    await account.settled(accepted.jobId);
    const rows = await account.post('/api/chats/get', { avatar_url: account.avatar, file_name: locator.chat });
    expect(rows.at(-1).mes).toBe(`The coloured reply.\n\n${AGENT_MARKER}`);
    expect(app.provider.calls).toHaveLength(1);
    const reopened = await account.open({ workspace: false, readyTimeout: 120000 });
    await openChat(reopened, locator);
    await expect(reopened.locator('#chat .mes').last()).toContainText('The coloured reply.');
    expect(app.provider.calls).toHaveLength(1);
});

/** A two-speaker group whose reply arrives as one ordinary response per speaker. */
async function prepareGroup(app) {
    app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The group reply.' } }] });
    const account = await app.account({ activeConnection: true, configureSettings(settings) {
        settings.power_user.collapse_newlines = false;
        settings.oai_settings.stream_openai = false;
        settings.oai_settings.prompts = [...settings.oai_settings.prompts, { identifier: 'dc-macro-marker',
            name: 'Dialogue colours marker', content: MARKED_PROMPT, role: 'system', injection_position: 0, injection_depth: 4, injection_order: 100 }];
        const order = settings.oai_settings.prompt_order.find(item => String(item.character_id) === '100001')?.order;
        if (!Array.isArray(order)) throw new Error('The fixture needs the default Chat Completion prompt order.');
        order.push({ identifier: 'dc-macro-marker', enabled: true });
    } });
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Durable Kit', description: 'Second speaker.', first_mes: 'Hello.' } });
    expect(created.ok(), await created.text()).toBe(true);
    const kit = await created.text();
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Group probe', allow_create: true } });
    expect(probe.ok(), await probe.text()).toBe(true);
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    const group = await account.post('/api/groups/create', { name: 'Native Group', members: [account.avatar, kit],
        activation_strategy: 1, roleplay: { account: stamp, operationKey: randomUUID() } });
    const page = await account.open({ workspace: false, readyTimeout: 120000 });
    await page.evaluate(async id => (await import('/scripts/group-chats.js')).openGroupById(id), group.id);
    await expect(page.locator('#send_textarea')).toBeVisible();
    await page.waitForFunction(() => window.__dialogueColorsRuntime_v1?.initialized === true);
    return { account, page };
}

test('both speakers of a two-speaker group turn receive the same captured instruction', async ({ app }) => {
    const { account, page } = await prepareGroup(app);
    const instruction = await setDialogueColorsState(page, { coloringEngine: 'llm', enabled: true,
        promptMode: 'macro', themeMode: 'dark', colorTheme: 'neon' });
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit') && response.status() === 202);
    await page.locator('#send_textarea').fill('Everyone, please answer.');
    await page.locator('#send_textarea').press('Enter');
    const accepted = await (await submitted).json();
    await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBe(2);
    for (const call of app.provider.calls) {
        const message = markedMessage(call);
        expect(message, JSON.stringify(call.messages)).toBeTruthy();
        expect(message.content).toBe(`${MARKER}-BEFORE ${instruction} ${MARKER}-AFTER`);
    }
    const job = await account.settled(accepted.jobId);
    expect(job.state).toBe('completed');
    expect(app.provider.calls).toHaveLength(2);
});

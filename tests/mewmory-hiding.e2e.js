/* global document, window */
/* eslint playwright/expect-expect: off -- The shared regression body asserts throughout. */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240000);
// eslint-disable-next-line playwright/no-skipped-test -- This test writes chats, Mewmory state and shared settings.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable Neconyan server.');

const AUTO_HIDE = 'Hide old messages automatically';
const HIDE_TRIGGER = 'Hide older messages when the visible chat reaches, tokens';
const TRIGGER = 30000;
const OLD_ROWS = 40;
const BELOW_ROWS = 10;
const ABOVE_ROWS = 24;

const stamp = index => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
const row = (index, isUser, text) => ({
    name: isUser ? 'User' : 'Mara', is_user: isUser, mes: text, send_date: stamp(index), extra: {},
});

async function load(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
}

async function headersFor(page) {
    return page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
}

async function api(page) {
    const post = async (route, data = {}) => {
        const response = await page.request.post(route, { headers: await headersFor(page), data });
        const text = await response.text();
        expect(response.ok(), route + ': ' + text).toBe(true);
        return text ? JSON.parse(text) : {};
    };
    return { post };
}

async function saveConfig(page, config) {
    const { post } = await api(page);
    return (await post('/api/mewmory/config/save', { config })).config;
}

async function readSavedChat(page, avatar, chatName) {
    const { post } = await api(page);
    return post('/api/chats/get', { avatar_url: avatar, file_name: chatName });
}

async function visibleTokenTotal(page, rows) {
    const { post } = await api(page);
    const texts = rows.filter(message => !message.is_system).map(message => String(message.mes ?? ''));
    const counted = await post('/api/mewmory/tokens', { texts, tokenizer: { tokenizerKey: 'openai', tokenizerName: 'gpt-4o' } });
    expect(counted.counts).toHaveLength(texts.length);
    return counted.counts.reduce((total, count) => total + count, 0);
}

function hiddenCount(rows) {
    return rows.filter(message => message.is_system && message.extra?.mewmoryKeepHidden === true).length;
}

async function openChat(page, avatar, chatName) {
    await page.evaluate(async ({ avatar, chatName }) => {
        const app = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await app.openCharacterChat(chatName);
    }, { avatar, chatName });
}

async function appendAndSave(page, rows) {
    await page.evaluate(async rows => {
        const app = await import('/script.js');
        for (const message of rows) app.chat.push(message);
        const saved = await app.saveChatConditional();
        if (saved === false) throw new Error('The appended chat messages could not be saved.');
    }, rows);
}

async function fireGenerationEnded(page) {
    const counted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mewmory/tokens');
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        await eventSource.emit(event_types.GENERATION_ENDED);
    });
    await counted;
    // The listener is deliberately fire-and-forget; let the plan and any hide settle.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
}

async function hidingRegression({ page }) {
    page.setDefaultTimeout(30000);
    const width = page.viewportSize().width;
    const suffix = Date.now() + '-' + width;
    await load(page);
    const { post } = await api(page);
    const config = (await post('/api/mewmory/config/get')).config;
    Object.assign(config, { autoUpdate: false, excludeHistory: false, enableNewChats: false,
        autoHide: false, autoHideTokens: TRIGGER, writerTokenizer: 'cl100k_base' });
    for (const role of Object.values(config.roles)) Object.assign(role, {
        enabled: false, profileId: '', endpoint: '', model: '', modelOverride: '', tokenizer: 'auto',
    });
    const savedConfig = await saveConfig(page, config);
    expect(savedConfig.autoHideTokens).toBe(TRIGGER);
    expect(savedConfig.writerTokenizer).toBe('cl100k_base');

    const created = await page.request.post('/api/characters/create', {
        headers: await headersFor(page),
        data: {
            ch_name: 'Mara hiding ' + suffix,
            description: 'Mara keeps a long archive and never loses a saved word.',
            first_mes: 'The archive is open.',
        },
    });
    const createdText = await created.text();
    expect(created.ok(), createdText).toBe(true);
    const avatar = createdText;
    const chatName = 'Mewmory hiding ' + suffix;

    const oldRows = Array.from({ length: OLD_ROWS }, (_, index) => row(index, index % 2 === 0,
        'Archive row ' + index + '. ' + 'accumulated history remains saved and readable. '.repeat(140)));
    const latestReply = row(OLD_ROWS, false, 'Latest visible reply. ' + 'kept '.repeat(60));
    const trailingUser = row(OLD_ROWS + 1, true, 'Trailing user message stays visible after the clear.');
    const initial = [...oldRows, latestReply, trailingUser];
    expect(await visibleTokenTotal(page, initial)).toBeGreaterThan(TRIGGER);

    const vacant = await page.request.post('/api/chats/get', {
        headers: await headersFor(page),
        data: { avatar_url: avatar, file_name: chatName, allow_create: true },
    });
    expect(vacant.ok(), await vacant.text()).toBe(true);
    const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
    const initialSave = await page.request.post('/api/chats/save', {
        headers: await headersFor(page),
        data: {
            avatar_url: avatar, file_name: chatName,
            chat: [{ chat_metadata: {} }, ...initial],
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
        },
    });
    expect(initialSave.ok(), await initialSave.text()).toBe(true);

    // A preset far above the trigger proves hiding does not use the writing model's context size.
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await expect(page.locator('#main_api')).toBeVisible();
    await page.locator('#main_api').selectOption('openai');
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        oai_settings.openai_max_context = 200000;
    });
    await expect.poll(async () => page.evaluate(async () => (await import('/script.js')).getMaxContextTokens()))
        .toBeGreaterThan(TRIGGER);

    await openChat(page, avatar, chatName);
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
    const workspace = page.locator('#mewmory-workspace');
    await expect(workspace.getByLabel('Use Mewmory in this chat')).toBeVisible();
    await workspace.getByLabel('Use Mewmory in this chat').check();
    await expect.poll(async () => page.evaluate(async () => {
        const { mewmory } = await import('/scripts/mewmory/index.js');
        return mewmory.view?.enabled;
    })).toBe(true);

    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(workspace.getByLabel(HIDE_TRIGGER, { exact: true })).toHaveValue(String(TRIGGER));
    // The manual hiding action is in the Settings tab's Progress section.
    const hideButton = workspace.getByRole('button', { name: /Hide old messages/i });
    await expect(hideButton).toBeVisible();
    await expect(hideButton).toBeEnabled();

    const chatSaves = [];
    const countSave = request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chats/save') chatSaves.push(request);
    };
    page.on('request', countSave);
    await hideButton.click();
    const confirmation = page.locator('dialog[open] .popup-button-ok');
    await expect(confirmation).toBeVisible();
    await confirmation.click();
    await expect.poll(async () => hiddenCount((await readSavedChat(page, avatar, chatName)).slice(1)), { timeout: 30000 }).toBe(OLD_ROWS);
    page.off('request', countSave);
    expect(chatSaves.length).toBeLessThanOrEqual(1);

    let rows = (await readSavedChat(page, avatar, chatName)).slice(1);
    expect(rows.map(message => message.mes)).toEqual(initial.map(message => message.mes));
    expect(rows.slice(0, OLD_ROWS).every(message => message.is_system && message.extra?.mewmoryKeepHidden === true)).toBe(true);
    expect(rows[OLD_ROWS].is_system).not.toBe(true);
    expect(rows[OLD_ROWS + 1].is_system).not.toBe(true);
    expect(rows[OLD_ROWS].mes).toBe(latestReply.mes);
    expect(rows[OLD_ROWS + 1].mes).toBe(trailingUser.mes);

    // Enable automatic hiding through the real settings control and its autosave.
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await workspace.getByLabel(AUTO_HIDE, { exact: true }).check();
    await expect.poll(async () => (await post('/api/mewmory/config/get')).config.autoHide, { timeout: 20000 }).toBe(true);
    expect((await post('/api/mewmory/config/get')).config.autoHideTokens).toBe(TRIGGER);
    await workspace.getByRole('tab', { name: 'Now', exact: true }).click();

    const below = Array.from({ length: BELOW_ROWS }, (_, index) => row(100 + index, index % 2 === 0,
        'Below trigger row ' + index + '. ' + 'visible history accumulates here. '.repeat(200)));
    await appendAndSave(page, below);
    rows = (await readSavedChat(page, avatar, chatName)).slice(1);
    expect(await visibleTokenTotal(page, rows)).toBeLessThan(TRIGGER);
    await fireGenerationEnded(page);
    expect(hiddenCount((await readSavedChat(page, avatar, chatName)).slice(1))).toBe(OLD_ROWS);

    const above = Array.from({ length: ABOVE_ROWS }, (_, index) => row(200 + index, index % 2 === 0,
        'Above trigger row ' + index + '. ' + 'visible history accumulates here. '.repeat(200)));
    const autoTrailing = row(300, true, 'Auto trailing user message stays visible after the second clear.');
    await appendAndSave(page, [...above, autoTrailing]);
    rows = (await readSavedChat(page, avatar, chatName)).slice(1);
    expect(await visibleTokenTotal(page, rows)).toBeGreaterThanOrEqual(TRIGGER);
    await fireGenerationEnded(page);
    await expect.poll(async () => hiddenCount((await readSavedChat(page, avatar, chatName)).slice(1)), { timeout: 30000 })
        .toBe(OLD_ROWS + 2 + BELOW_ROWS + ABOVE_ROWS - 1);

    const expectedTexts = [...initial, ...below, ...above, autoTrailing].map(message => message.mes);
    rows = (await readSavedChat(page, avatar, chatName)).slice(1);
    expect(rows.map(message => message.mes)).toEqual(expectedTexts);
    expect(rows.at(-1).mes).toBe(autoTrailing.mes);
    expect(rows.at(-1).is_system).not.toBe(true);
    expect(rows.at(-2).mes).toBe(above.at(-1).mes);
    expect(rows.at(-2).is_system).not.toBe(true);

    // Reload from disk and read the same hidden flags and full text back through the application.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await openChat(page, avatar, chatName);
    const totalMessages = initial.length + below.length + above.length + 1;
    await expect.poll(async () => page.evaluate(async () => (await import('/script.js')).chat.length)).toBe(totalMessages);
    const readback = await page.evaluate(async () => {
        const { chat } = await import('/script.js');
        return {
            length: chat.length,
            hidden: chat.filter(message => message.is_system && message.extra?.mewmoryKeepHidden === true).length,
            firstText: chat[0].mes,
            latestText: chat.at(-2).mes,
            trailingText: chat.at(-1).mes,
        };
    });
    expect(readback).toMatchObject({ length: totalMessages, hidden: OLD_ROWS + 2 + BELOW_ROWS + ABOVE_ROWS - 1,
        firstText: oldRows[0].mes, latestText: above.at(-1).mes, trailingText: autoTrailing.mes });
    await expect(page.locator('#chat .mes').last()).toContainText(autoTrailing.mes.slice(0, 60));
}

test.describe('desktop 1280x900', () => {
    test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
    test('Mewmory clears the 30,000-token history trigger, repeats it and reloads the saved batch', async ({ page }) => {
        await hidingRegression({ page });
    });
});

test.describe('touch phone 393x852', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
    test('Mewmory clears the 30,000-token history trigger, repeats it and reloads the saved batch', async ({ page }) => {
        await hidingRegression({ page });
    });
});

/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const EXTENSION = 'Dooms-Enhancement-Suite';
const HISTORY = 'DES_HISTORY_ONLY_731';
const LOCATION = 'DES_NEW_ROOM_842';
const QUESTION = 'Describe the room beyond the door.';
const PROSE = 'Nova opens the door. A quiet courtyard waits beyond it.';
const REPLY = '```json\n' + JSON.stringify({ infoBox: { location: LOCATION } }) + '\n```\n\n' + PROSE;
const SCREENSHOTS = fileURLToPath(new URL('../screenshots/', import.meta.url));

// A test-owned extension, not a copy of DES. Its manifest identifies the installed
// integration, and its two handlers model the browser-only contracts DES requires.
// Installing through the real extension loader also exercises active/manifest state.
const extensionSource = `
import { chat, chat_metadata, eventSource, event_types, saveChatConditional } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const state = window.doomCompatibilityFixture = { promptCalls: 0, received: [], errors: [], ready: false };
const enabled = () => extension_settings['third-party/Dooms-Enhancement-Suite']?.enabled === true;

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, data => {
    if (!enabled() || data.dryRun || data.type === 'quiet' || !Array.isArray(data.chat)) return;
    state.promptCalls++;
    for (const message of chat) {
        if (message.is_user || message.is_system) continue;
        const tracker = message.extra?.dooms_tracker_swipes?.[message.swipe_id || 0];
        if (!tracker?.infoBox) continue;
        const location = JSON.parse(tracker.infoBox).location;
        const target = data.chat.find(item => item.role === 'assistant'
            && typeof item.content === 'string' && item.content.includes(message.mes));
        if (!target || !location) continue;
        target.content += '\\nContext for that moment:\\nLocation: ' + location;
        data.chatChanged = true;
    }
});

eventSource.on(event_types.MESSAGE_RECEIVED, async (index, type) => {
    if (!enabled() || type === 'first_message') return;
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return;
    state.received.push(index);
    try {
        const start = message.mes.indexOf('{');
        const end = message.mes.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('Tracker JSON is missing');
        const parsed = JSON.parse(message.mes.slice(start, end + 1));
        if (!parsed.infoBox) throw new Error('Tracker infoBox is missing');
        const tracker = { infoBox: JSON.stringify(parsed.infoBox) };
        message.extra ??= {};
        message.extra.dooms_tracker_swipes ??= {};
        message.extra.dooms_tracker_swipes[message.swipe_id || 0] = tracker;
        chat_metadata.dooms_tracker = { lastGeneratedData: tracker };
        if (!await saveChatConditional({ throwOnError: true })) throw new Error('Tracker save failed');
    } catch (error) {
        state.errors.push(error.message);
        throw error;
    }
});
state.ready = true;
`;

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} installed Doom hooks keep explicit server replies on the browser without changing the preference`, async ({ app }, info) => {
        const directory = path.join(app.dataRoot, 'default-user', 'extensions', EXTENSION);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
            display_name: 'Doom\'s Enhancement Suite', loading_order: 100,
            requires: [], optional: [], js: 'index.js', author: 'Doom', version: '3.2.0-beta.1',
            homePage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite',
        }));
        await fs.writeFile(path.join(directory, 'index.js'), extensionSource);

        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] };
        app.provider.mode.streamEvents = [
            { choices: [{ index: 0, delta: { reasoning_content: 'The room has changed.' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.power_user.reply_generation_location = 'server';
            saved.power_user.continue_on_send = false;
            saved.oai_settings.stream_openai = true;
            saved.oai_settings.show_thoughts = true;
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: false } };
            saved.extension_settings['third-party/' + EXTENSION] = {
                enabled: true, generationMode: 'together', autoUpdate: false,
                recoverMissingTracker: false, historyPersistence: { enabled: true },
            };
        } });
        const page = await account.open({ workspace: false });
        await page.waitForFunction(() => window.doomCompatibilityFixture?.ready === true);
        const requests = [];
        page.on('request', request => {
            if (request.method() !== 'POST') return;
            const url = new URL(request.url()).pathname;
            if (['/api/roleplay/workflow/submit', '/api/backends/chat-completions/generate'].includes(url)) requests.push(url);
        });
        await page.evaluate(async ({ avatar, history }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            const id = core.characters.findIndex(character => character.avatar === avatar);
            if (id < 0 || !await core.selectCharacterById(id, { switchMenu: false })) throw new Error('Fixture character unavailable');
            const message = (isUser, text, tracker = false) => ({
                name: isUser ? 'User' : 'Durable Nova', is_user: isUser, is_system: false,
                send_date: '2026-10-31T00:00:00.000Z', mes: text,
                extra: tracker ? { dooms_tracker_swipes: { 0: { infoBox: JSON.stringify({ location: history }) } } } : {},
                ...(!isUser ? { swipe_id: 0, swipes: [text] } : {}),
            });
            core.chat.splice(0, core.chat.length,
                message(true, 'We entered a hall earlier.'),
                message(false, 'Nova remembers an earlier room.', true),
                message(true, 'We moved to another room.'),
                message(false, 'Nova waits by the door.'));
            if (!await core.saveChatConditional({ throwOnError: true })) throw new Error('Seed save failed');
            await core.printMessages();
            window.doomCompatibilityFixture.promptCalls = 0;
            window.doomCompatibilityFixture.received = [];
        }, { avatar: account.avatar, history: HISTORY });
        await acknowledgeActiveSettings(page);
        await fs.mkdir(SCREENSHOTS, { recursive: true });
        const phase = process.env.NECONYAN_SCREENSHOT_PHASE || 'after';
        await page.screenshot({ path: path.join(SCREENSHOTS, `doom-extension-${viewport}-${phase}-before.png`), scale: 'css' });
        await page.locator('#send_textarea').fill(QUESTION);
        await page.evaluate(async () => {
            const core = await import('/script.js');
            await core.Generate('normal', { skipNativeRoleplay: false });
        });
        await expect(page.locator('#chat .mes').last()).toContainText(PROSE);
        const actual = await page.evaluate(async () => {
            const core = await import('/script.js');
            const { power_user } = await import('/scripts/power-user.js');
            return { messages: core.chat, metadata: core.chat_metadata, chatId: core.getCurrentChatId(),
                preference: power_user.reply_generation_location, fixture: window.doomCompatibilityFixture };
        });
        await page.locator('#chat .mes').last().scrollIntoViewIfNeeded();
        const screenshot = path.join(SCREENSHOTS, `doom-extension-${viewport}-${phase}-after.png`);
        await page.screenshot({ path: screenshot, scale: 'css' });
        await info.attach(`${viewport}-doom-compatibility`, { path: screenshot, contentType: 'image/png' });

        expect(requests.filter(url => url === '/api/roleplay/workflow/submit')).toHaveLength(0);
        expect(requests.filter(url => url === '/api/backends/chat-completions/generate')).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(1);
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain(HISTORY);
        expect(actual.messages).toHaveLength(6);
        expect(actual.messages.filter(message => message.is_user && message.mes === QUESTION)).toHaveLength(1);
        expect(actual.messages.filter(message => !message.is_user && message.mes.includes(PROSE))).toHaveLength(1);
        expect(actual.fixture.errors).toEqual([]);
        expect(actual.fixture.promptCalls).toBe(1);
        expect(actual.fixture.received).toEqual([5]);
        expect(JSON.parse(actual.messages[5].extra.dooms_tracker_swipes[0].infoBox)).toEqual({ location: LOCATION });
        expect(JSON.parse(actual.metadata.dooms_tracker.lastGeneratedData.infoBox)).toEqual({ location: LOCATION });
        expect(actual.preference).toBe('server');
        const saved = await account.post('/api/chats/get', { avatar_url: account.avatar, file_name: actual.chatId });
        expect(JSON.parse(saved.at(-1).extra.dooms_tracker_swipes[0].infoBox)).toEqual({ location: LOCATION });
        const settings = JSON.parse((await account.post('/api/settings/get')).settings);
        expect(settings.power_user.reply_generation_location).toBe('server');
    });
}

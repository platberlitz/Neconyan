import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

const THINKING = 'Planning the room, weather and tracker without producing story text.';
const STORY = 'The existing story remains exactly as it was.';
const USAGE = { prompt_tokens: 100, completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 32 } };

async function createChat(account, name, messageCount) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const source = await account.context.request.post('/api/chats/get', {
        headers: account.headers, data: { ...fields, allow_create: true },
    });
    expect(source.ok(), await source.text()).toBe(true);
    const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
    const history = Array.from({ length: messageCount - 1 }, (_, index) => ({
        name: index % 2 ? 'User' : 'Durable Nova', is_user: index % 2 === 1,
        mes: `Synthetic history ${index}.`, extra: {},
    }));
    await account.post('/api/chats/save', { ...fields, chat: [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        ...history,
        { name: 'Durable Nova', is_user: false, mes: STORY, extra: {},
            swipes: ['An older alternative.', STORY], swipe_id: 1 },
    ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return fields;
}

async function openChat(page, avatar, name) {
    await page.evaluate(async ({ avatar, name }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        if (core.getCurrentChatId() !== name) await core.openCharacterChat(name);
    }, { avatar, name });
}

for (const phone of [true, false]) for (const scenario of [
    { stream: true, finishReason: 'length', type: 'continue' },
    { stream: false, finishReason: 'stop', type: 'swipe' },
]) {
    const viewport = phone ? 'phone' : 'desktop';
    const transport = scenario.stream ? 'SSE' : 'JSON';
    const messageCount = !phone && scenario.stream ? 1601 : 3;
    const explanation = scenario.finishReason === 'length'
        ? 'The provider reached its output limit after returning thinking but no reply text. Automatic agents were not run.'
        : 'The provider returned thinking but no reply text. Automatic agents were not run.';
    test(`${viewport} native ${transport} thinking-only ${scenario.finishReason} preserves ${messageCount} messages on ${scenario.type}`, async ({ app }) => {
        test.setTimeout(180000);
        const message = { role: 'assistant', content: '', reasoning_content: THINKING };
        app.provider.mode.reply = { choices: [{ index: 0, message, finish_reason: scenario.finishReason }], usage: USAGE };
        app.provider.mode.streamEvents = [
            { choices: [{ index: 0, delta: message }] },
            { choices: [{ index: 0, delta: {}, finish_reason: scenario.finishReason }] },
            { choices: [], usage: USAGE },
        ];
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = scenario.stream;
            saved.oai_settings.show_thoughts = true;
            saved.extension_settings.connectionManager.profiles.push({ id: 'helper', name: 'Forbidden post-reply helper',
                api: 'custom', mode: 'cc', model: 'post-reply-helper', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                connectionProfile: 'helper', trackerCompanionAutoLoopVersion: 4 } };
        } });
        const agents = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(agents, { recursive: true });
        await fs.writeFile(path.join(agents, 'helper.json'), JSON.stringify({ id: 'helper', name: 'Forbidden post-reply helper',
            enabled: true, phase: 'post', prompt: 'Rewrite the finished story.', connectionProfile: 'helper',
            postProcess: { enabled: false, promptTransformEnabled: true } }));
        const name = `Thinking only ${viewport} ${transport}`;
        const fields = await createChat(account, name, messageCount);
        const page = await account.open({ workspace: false });
        await openChat(page, account.avatar, name);
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText(STORY);
        await acknowledgeActiveSettings(page);
        // Persist the normal message IDs and swipe metadata added when the fixture is opened.
        expect(await page.evaluate(async () => (await import('/script.js')).saveChatConditional({ throwOnError: true }))).toBe(true);
        const before = await account.post('/api/chats/get', fields);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await startNativeReply(page, scenario.type);
        const response = await submitted;
        expect(response.ok(), await response.text()).toBe(true);
        const { jobId } = await response.json();
        // The failed candidate makes its workflow interrupted; neither is a successful story result.
        const root = await account.settled(jobId, 'interrupted');
        const children = await Promise.all(root.children.map(id => account.job(id)));
        expect(children).toHaveLength(1);
        expect(children[0].state).toBe('failed');
        expect(children[0].error.code).toBe('GENERATION_NO_ANSWER');
        expect(children[0].error.message).toContain('thinking but no reply text');
        expect(children[0].error.message.includes('output limit')).toBe(scenario.finishReason === 'length');
        expect(root.error.message).toContain(children[0].error.message);
        const saved = await account.post('/api/chats/get', fields);
        expect(saved.slice(1, before.length)).toEqual(before.slice(1));
        expect(saved).toHaveLength(before.length + 1);
        const kept = saved.at(-1);
        expect(kept.mes).toBe('');
        expect(kept.extra.reasoning).toBe(THINKING);
        expect(kept.extra.generation_outcome).toEqual({ version: 1, status: 'error',
            reason: scenario.finishReason === 'length' ? 'reasoning_only_length' : 'reasoning_only' });
        expect(kept.extra.generation_finish_reason).toBe(scenario.finishReason);
        expect(kept.extra.generation_usage).toEqual(USAGE);
        expect(kept.extra.roleplay_kept_reply.reason).toBe('failed');
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].model).toBe(MODEL);
        expect(app.provider.calls[0].stream).toBe(scenario.stream);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).chat.at(-1)?.extra?.reasoning)).toBe(THINKING);
        await expect(page.locator('#chat .mes[mesid]').last().locator('.generation_outcome')).toHaveText(explanation);
        await expect(page.locator('#neconyan-roleplay-preview')).toHaveCount(0);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
        await openChat(page, account.avatar, name);
        const reloaded = await page.evaluate(async () => structuredClone((await import('/script.js')).chat));
        expect(reloaded).toHaveLength(messageCount + 1);
        expect(reloaded.filter(message => message.extra?.reasoning === THINKING)).toHaveLength(1);
        expect(reloaded.at(-2).mes).toBe(STORY);
        expect(reloaded.at(-2).swipes).toEqual(['An older alternative.', STORY]);
        expect(reloaded.at(-2).swipe_id).toBe(1);
        expect(reloaded.at(-1).extra.generation_outcome).toEqual(kept.extra.generation_outcome);
        expect(app.provider.calls).toHaveLength(1);
        await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_reasoning')).toContainText(THINKING);
        await expect(page.locator('#chat .mes[mesid]').last().locator('.generation_outcome')).toHaveText(explanation);
        await page.screenshot({ path: `../screenshots/reasoning-only-server-${viewport}-${transport}.png`, scale: 'css' });
    });
}

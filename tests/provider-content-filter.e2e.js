/* global document, window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { test, MODEL, send as sendConversation } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
const PARTIAL = 'The reply ends in the middle of';
const stream = (text, finish = 'content_filter') => [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
];
const post = { id: 'post', name: 'Post Gen', enabled: true, phase: 'post', prompt: 'Revise the reply.',
    connectionProfile: 'post', postProcess: { enabled: false, promptTransformEnabled: true } };
const companion = { id: 'companion', name: 'Companion', enabled: true, category: 'companion', execution: 'companion',
    prompt: 'Write a short note.', connectionProfile: 'companion', companion: { trigger: 'auto', displayMode: 'card' } };
const interceptor = { id: 'interceptor', name: 'Post-main interceptor', enabled: true, phase: 'pre',
    prompt: 'Revise the reply.', connectionProfile: 'interceptor',
    preProcess: { mode: 'intercept', interceptTiming: 'post-main-generation', applyMode: 'replace' } };

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

async function setup(app, { phone = false, agents = [post, companion], streaming = true, automatic = false, executionMode = 'parallel' } = {}) {
    app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === 'companion-model'
        ? 'The Companion note is ready.' : 'Post Gen revised the reply.' }, finish_reason: 'stop' }] });
    const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
        saved.oai_settings.stream_openai = streaming;
        saved.power_user.trim_sentences = true;
        saved.power_user.auto_swipe = automatic;
        saved.power_user.auto_swipe_minimum_length = automatic ? 1000 : 0;
        saved.power_user.auto_continue = { enabled: automatic, target_length: 1000, allow_chat_completions: true };
        for (const agent of agents) saved.extension_settings.connectionManager.profiles.push({
            id: agent.id, name: `${agent.name} fixture`, api: 'custom', mode: 'cc', model: `${agent.id}-model`, 'api-url': app.provider.url,
        });
        saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
            connectionProfile: 'post', trackerCompanionAutoLoopVersion: 4,
            appendAgentsExecutionMode: executionMode, companionExecutionMode: 'parallel', companionConcurrentWithPostGen: false } };
    } });
    const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
    await fs.mkdir(directory, { recursive: true });
    for (const agent of agents) await fs.writeFile(path.join(directory, `${agent.id}.json`), JSON.stringify(agent));
    return { account, page: await openChat(account) };
}

async function send(page, text, type = 'normal') {
    await page.locator('#send_textarea').fill(text);
    // Await the actual entry point; idle may still be true before Enter starts generation.
    await page.evaluate(async type => { await (await import('/script.js')).Generate(type); }, type);
}

async function wakeRecovery(page) {
    await page.evaluate(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        const core = await import('/script.js');
        await core.eventSource.emit(core.event_types.GENERATION_ENDED, core.chat.length);
    });
    // Observe several 50 ms deferred and 200 ms missed-end recovery ticks.
    await delay(1000);
}

async function evidence(page, app, label) {
    const message = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
    await fs.mkdir(path.resolve('../screenshots'), { recursive: true });
    await page.screenshot({ path: path.resolve(`../screenshots/content-filter-after-${label}.png`) });
    await fs.writeFile(path.resolve(`../../browser-after-${label}.json`), JSON.stringify({ message,
        calls: app.provider.calls.map(call => ({ model: call.model, stream: call.stream })) }, null, 2));
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`blocked caller scope ${viewport}: impersonation keeps the remaining prompt and regex work`, async ({ app }) => {
        const conditions = { generationTypes: ['impersonate'], runOnImpersonate: true };
        const first = { ...post, conditions, injection: { order: 10 } };
        const second = { ...post, id: 'polish', name: 'Polish', connectionProfile: 'polish', conditions,
            injection: { order: 20 }, regexScripts: [{ id: 'composer-regex', scriptName: 'Composer polish',
                findRegex: '/polished/g', replaceString: 'finished', placement: [1, 2], disabled: false,
                markdownOnly: false, promptOnly: false, trimStrings: [], substituteRegex: 0 }] };
        const { page } = await setup(app, { phone, agents: [first, second], streaming: false, executionMode: 'sequential' });
        const before = await page.evaluate(async () => JSON.stringify((await import('/script.js')).chat));
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === MODEL
            ? 'An ordinary draft.' : body.model === 'post-model' ? '' : 'A polished draft.' },
        finish_reason: body.model === 'post-model' ? 'content_filter' : 'stop' }] });
        await send(page, '', 'impersonate');
        await fs.mkdir(path.resolve('../screenshots'), { recursive: true });
        await page.screenshot({ path: path.resolve(`../screenshots/content-filter-caller-scope-impersonation-${viewport}.png`) });
        await expect(page.locator('#send_textarea')).toHaveValue('A finished draft.');
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, 'post-model', 'polish-model']);
        expect(await page.evaluate(async () => JSON.stringify((await import('/script.js')).chat))).toBe(before);
        await expect(page.locator('#toast-container')).not.toContainText(/will not retry automatically|Automatic agents were not run|reply was kept/i);
    });

    test(`blocked caller scope ${viewport}: two parallel blocks show one terminal warning`, async ({ app }) => {
        const second = { ...post, id: 'polish', name: 'Polish', connectionProfile: 'polish' };
        const { account, page } = await setup(app, { phone, agents: [post, second], streaming: false });
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === MODEL
            ? 'An ordinary complete reply.' : '' }, finish_reason: body.model === MODEL ? 'stop' : 'content_filter' }] });
        await send(page, 'Describe the fountain.');
        await expect.poll(() => app.provider.calls.length).toBeGreaterThanOrEqual(3);
        await delay(1800);
        await wakeRecovery(page);
        await fs.mkdir(path.resolve('../screenshots'), { recursive: true });
        await page.screenshot({ path: path.resolve(`../screenshots/content-filter-caller-scope-parallel-${viewport}.png`) });
        expect(app.provider.calls).toHaveLength(3);
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'will not retry automatically' })).toHaveCount(1);
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText('An ordinary complete reply.');
        const runs = await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.inChatAgentPostRuns);
        expect(runs.length).toBeGreaterThan(0);
        await page.close();
        const reopened = await openChat(account);
        expect(await reopened.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.inChatAgentPostRuns)).toEqual(runs);
        await wakeRecovery(reopened);
        expect(app.provider.calls).toHaveLength(3);
        await expect(reopened.locator('#toast-container .toast').filter({ hasText: 'will not retry automatically' })).toHaveCount(0);
    });
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`blocked parallel synthesis ${viewport} is terminal across retry and reopen but permits manual and later work`, async ({ app }, info) => {
        const second = { ...post, id: 'polish', name: 'Polish', connectionProfile: 'polish', prompt: 'Polish the reply.' };
        const { account, page } = await setup(app, { phone, agents: [post, second], streaming: false });
        const diagnostics = [];
        page.on('console', entry => {
            if (['error', 'warning'].includes(entry.type())) diagnostics.push(entry.text());
        });
        let blocked = true;
        app.provider.mode.reply = body => {
            const synthesis = body.messages?.some(message => String(message.content).includes('Combine parallel edits of one reply'));
            const content = body.model === MODEL ? 'An ordinary complete reply.'
                : synthesis ? blocked ? 'A blocked combined' : 'The combined revision is complete.'
                    : body.model === 'post-model' ? 'The first independent revision.' : 'The second independent revision.';
            return { choices: [{ message: { content }, finish_reason: synthesis && blocked ? 'content_filter' : 'stop' }] };
        };
        await send(page, 'Describe the fountain.');
        await expect.poll(() => app.provider.calls.length).toBeGreaterThanOrEqual(4);
        // Cross the real 1500 ms automatic-retry delay, then trigger deferred recovery.
        await delay(1800);
        await wakeRecovery(page);
        await info.attach('synthesis-diagnostics', { body: JSON.stringify({ diagnostics,
            message: await page.evaluate(async () => (await import('/script.js')).chat.at(-1)) }), contentType: 'application/json' });
        expect(app.provider.calls).toHaveLength(4);
        await expect(page.locator('#toast-container')).toContainText(/provider.*block|content filter/i);
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText('An ordinary complete reply.');
        expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.generation_outcome)).toBeUndefined();
        const terminal = await page.evaluate(async () => {
            const core = await import('/script.js');
            return { chatId: core.getCurrentChatId(), runs: core.chat.at(-1).extra.inChatAgentPostRuns };
        });
        expect(terminal.runs.length).toBeGreaterThan(0);
        const savedReply = async () => {
            const file = path.join(app.dataRoot, 'default-user', 'chats', account.avatar.replace(/\.png$/, ''), `${terminal.chatId}.jsonl`);
            return JSON.parse((await fs.readFile(file, 'utf8')).trim().split('\n').at(-1));
        };
        await expect.poll(async () => (await savedReply()).extra.inChatAgentPostRuns).toEqual(terminal.runs);
        const saved = await savedReply();
        expect(saved.swipe_info[saved.swipe_id ?? 0].extra.inChatAgentPostRuns).toEqual(terminal.runs);
        await evidence(page, app, `synthesis-${viewport}`);

        await page.close();
        const reopened = await openChat(account);
        expect(await reopened.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.inChatAgentPostRuns)).toEqual(terminal.runs);
        await wakeRecovery(reopened);
        await delay(1800);
        expect(app.provider.calls).toHaveLength(4);

        // An explicit owner rerun is permitted even when automatic work is terminal.
        blocked = false;
        await reopened.evaluate(async () => {
            const core = await import('/script.js');
            await (await import('/scripts/extensions/in-chat-agents/agent-runner.js')).rerunPostGenerationAgentsOnMessage(core.chat.length - 1);
        });
        await expect(reopened.locator('#chat .mes').last().locator('.mes_text')).toHaveText('The combined revision is complete.');
        expect(app.provider.calls).toHaveLength(7);

        await send(reopened, 'Now describe the garden.');
        await expect.poll(() => app.provider.calls.length).toBe(11);
        await expect(reopened.locator('#chat .mes').last().locator('.mes_text')).toHaveText('The combined revision is complete.');
        await wakeRecovery(reopened);
        expect(app.provider.calls).toHaveLength(11);
    });
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`content filter ${viewport} retains partial, suppresses Agents and survives reopen`, async ({ app }) => {
        app.provider.mode.streamEvents = stream(PARTIAL);
        const { account, page } = await setup(app, { phone });
        await send(page, 'Describe the fountain.');
        await expect(page.locator('#chat .generation_outcome')).toContainText('content filter');
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
        await wakeRecovery(page);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
        await evidence(page, app, viewport);
        const blocked = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(blocked.extra.generation_outcome?.status).toBe('blocked');
        await page.close();
        const reopened = await openChat(account);
        await expect(reopened.locator('#chat .generation_outcome')).toContainText('content filter');
        await wakeRecovery(reopened);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);

        // Successful later requests must still run the enabled Agents.
        app.provider.mode.streamEvents = stream('A complete ordinary reply.', 'stop');
        await send(reopened, 'Now describe the garden.');
        await expect.poll(() => app.provider.calls.some(call => call.model === 'post-model')).toBe(true);
        await expect.poll(() => app.provider.calls.some(call => call.model === 'companion-model')).toBe(true);
        await expect(reopened.locator('#chat .mes').last()).toContainText('Post Gen revised the reply.');
        const success = await reopened.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(success.extra.generation_outcome).toBeUndefined();
    });
}

test('no-text filter preserves the earlier reply and suppresses recovery work', async ({ app }) => {
    const { page } = await setup(app, { agents: [post] });
    const before = await page.evaluate(async () => structuredClone((await import('/script.js')).chat));
    app.provider.mode.streamEvents = stream('');
    await send(page, 'A request blocked before text.');
    await expect(page.locator('#toast-container')).toContainText('before returning reply text');
    await wakeRecovery(page);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
    const after = await page.evaluate(async () => (await import('/script.js')).chat);
    expect(after.at(-1).is_user).toBe(true);
    expect(after[before.length - 1].mes).toBe(before.at(-1).mes);
    expect(after[before.length - 1].extra.generation_outcome).toBeUndefined();
    await expect(page.locator('#chat .generation_outcome')).toHaveCount(0);
});

test('buffered post-main interceptor skips filtered text and a no-text continuation restores it', async ({ app }) => {
    const { page } = await setup(app, { agents: [interceptor] });
    app.provider.mode.streamEvents = stream(PARTIAL);
    await send(page, 'Describe the fountain.');
    await expect(page.locator('#chat .generation_outcome')).toContainText('content filter');
    await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
    await wakeRecovery(page);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
    app.provider.mode.streamEvents = stream('');
    await send(page, '', 'continue');
    await wakeRecovery(page);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, MODEL]);
    const restored = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
    expect(restored.mes).toBe(PARTIAL);
    expect(restored.extra.generation_outcome?.status).toBe('blocked');
});

test('non-streaming filter suppresses enabled automatic retries and a successful swipe clears only its own status', async ({ app }) => {
    const { page } = await setup(app, { agents: [], streaming: false, automatic: true });
    app.provider.mode.reply = { choices: [{ message: { content: PARTIAL }, finish_reason: 'content_filter' }] };
    await send(page, 'Describe the fountain.');
    await expect(page.locator('#chat .generation_outcome')).toContainText('content filter');
    await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
    await wakeRecovery(page);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.auto_swipe = false;
        power_user.auto_continue.enabled = false;
    });
    app.provider.mode.reply = { choices: [{ message: { content: 'An ordinary complete reply.' }, finish_reason: 'stop' }] };
    await page.locator('#chat .mes').last().locator('.swipe_right').click();
    await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText('An ordinary complete reply.');
    await expect(page.locator('#chat .generation_outcome')).toHaveCount(0);
    await page.locator('#chat .mes').last().locator('.swipe_left').click();
    await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
    await expect(page.locator('#chat .generation_outcome')).toContainText('content filter');
    await wakeRecovery(page);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, MODEL]);
});

test('Conversation renders one literal filtered reply and does not repeat its notice on reopen', async ({ app }) => {
    const partial = 'Unfinished reply. [reminder: 1h | Do not create this]';
    app.provider.mode.reply = { choices: [{ message: { content: partial }, finish_reason: 'content_filter' }] };
    app.provider.mode.streamEvents = stream(partial);
    const account = await app.account();
    const page = await account.open();
    const accepted = await sendConversation(page, 'Describe the fountain.');
    await account.settled(accepted.job.id);
    await expect(page.locator('.generation_outcome')).toContainText('content filter');
    await expect(page.locator('#toast-container')).toContainText('content filter');
    const branch = await account.branch();
    const blocked = branch.messages.filter(message => message.extra?.generation_outcome?.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].mes).toBe(partial);
    expect((await account.store()).reminders).toEqual([]);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
    await page.close();
    const reopened = await account.open();
    await expect(reopened.locator('.generation_outcome')).toContainText('content filter');
    await expect(reopened.locator('#toast-container .toast').filter({ hasText: 'content filter' })).toHaveCount(0);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
});

for (const buffered of [false, true]) {
    test(`explicit stream error ${buffered ? 'buffered' : 'unbuffered'} shows one notice and suppresses automatic work`, async ({ app }) => {
        const { page } = await setup(app, { agents: buffered ? [interceptor, post, companion] : [post, companion] });
        app.provider.mode.streamRaw = 'data: ' + JSON.stringify({ choices: [{ delta: { content: PARTIAL } }] })
            + '\n\nevent: error\ndata: {"detail":"upstream unavailable"}\n\n';
        await send(page, 'Describe the fountain.');
        await expect(page.locator('#toast-container .toast-error')).toHaveCount(1);
        await expect(page.locator('#toast-container .toast-error')).not.toHaveText('');
        await expect(page.locator('#chat .generation_outcome')).toHaveCount(0);
        await wakeRecovery(page);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
    });
}

test('filtered impersonation suppresses its opted-in Agent and the next ordinary impersonation can run it', async ({ app }) => {
    const impersonationAgent = { ...post, conditions: { generationTypes: ['impersonate'], runOnImpersonate: true } };
    const { page } = await setup(app, { agents: [impersonationAgent] });
    app.provider.mode.streamEvents = stream(PARTIAL);
    await send(page, '', 'impersonate');
    await expect(page.locator('#toast-container')).toContainText('content filter');
    await wakeRecovery(page);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
    app.provider.mode.streamEvents = stream('An ordinary complete draft.', 'stop');
    await send(page, '', 'impersonate');
    await expect.poll(() => app.provider.calls.some(call => call.model === 'post-model')).toBe(true);
    expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, MODEL, 'post-model']);
});

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`provider error ${viewport} keeps the partial, suppresses Agents and survives reopen`, async ({ app }) => {
        app.provider.mode.streamEvents = stream(PARTIAL, 'error');
        const { account, page } = await setup(app, { phone });
        await send(page, 'Describe the fountain.');
        await expect(page.locator('#chat .generation_outcome')).toContainText('The provider ended this reply with an error');
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'The provider ended this reply with an error' })).toHaveCount(1);
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
        await wakeRecovery(page);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
        const ended = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(ended.extra.generation_outcome).toEqual({ version: 1, status: 'error', reason: 'error' });
        await page.close();
        const reopened = await openChat(account);
        await expect(reopened.locator('#chat .generation_outcome')).toContainText('The provider ended this reply with an error');
        await expect(reopened.locator('#toast-container .toast').filter({ hasText: 'The provider ended this reply with an error' })).toHaveCount(0);
        await wakeRecovery(reopened);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);

        // A manual swipe succeeds and clears only its own status.
        app.provider.mode.streamEvents = stream('A complete ordinary reply.', 'stop');
        await reopened.locator('#chat .mes').last().locator('.swipe_right').click();
        await expect(reopened.locator('#chat .mes').last().locator('.mes_text')).toHaveText('Post Gen revised the reply.');
        await expect(reopened.locator('#chat .generation_outcome')).toHaveCount(0);
        await reopened.locator('#chat .mes').last().locator('.swipe_left').click();
        await expect(reopened.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
        await expect(reopened.locator('#chat .generation_outcome')).toContainText('The provider ended this reply with an error');

        // A later successful send runs the enabled Agents.
        app.provider.mode.streamEvents = stream('A complete ordinary reply.', 'stop');
        await send(reopened, 'Now describe the garden.');
        await expect.poll(() => app.provider.calls.some(call => call.model === 'post-model')).toBe(true);
        await expect.poll(() => app.provider.calls.some(call => call.model === 'companion-model')).toBe(true);
        await expect(reopened.locator('#chat .mes').last()).toContainText('Post Gen revised the reply.');
        const success = await reopened.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(success.extra.generation_outcome).toBeUndefined();
    });

    test(`provider error ${viewport} with no text restores the earlier reply and shows one notice`, async ({ app }) => {
        app.provider.mode.streamEvents = stream('', 'error');
        const { page } = await setup(app, { phone, agents: [post] });
        const before = await page.evaluate(async () => structuredClone((await import('/script.js')).chat));
        await send(page, 'A request that ends before text.');
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'The provider ended this reply with an error' })).toHaveCount(1);
        await wakeRecovery(page);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
        const after = await page.evaluate(async () => (await import('/script.js')).chat);
        expect(after.at(-1).is_user).toBe(true);
        expect(after[before.length - 1].mes).toBe(before.at(-1).mes);
        expect(after[before.length - 1].extra.generation_outcome).toBeUndefined();
        await expect(page.locator('#chat .generation_outcome')).toHaveCount(0);
    });

    test(`non-streaming provider error ${viewport} keeps the partial and restores an empty error body`, async ({ app }) => {
        const { page } = await setup(app, { phone, agents: [], streaming: false, automatic: true });
        app.provider.mode.reply = { choices: [{ message: { content: PARTIAL }, finish_reason: 'error', error: { message: 'upstream failed' } }] };
        await send(page, 'Describe the fountain.');
        await expect(page.locator('#chat .generation_outcome')).toContainText('The provider ended this reply with an error');
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(PARTIAL);
        await wakeRecovery(page);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL]);
        const ended = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(ended.extra.generation_outcome).toEqual({ version: 1, status: 'error', reason: 'error' });

        // The Gemini no-text error body restores the earlier reply with the same one notice.
        app.provider.mode.reply = { error: { message: 'Gemini Candidate text empty' },
            choices: [{ finish_reason: 'MALFORMED_FUNCTION_CALL', message: { content: '' } }] };
        const before = await page.evaluate(async () => structuredClone((await import('/script.js')).chat));
        await send(page, 'A request that ends before text.');
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'The provider ended this reply with an error' })).toHaveCount(1);
        await wakeRecovery(page);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, MODEL]);
        const after = await page.evaluate(async () => (await import('/script.js')).chat);
        expect(after.at(-1).is_user).toBe(true);
        expect(after[before.length - 1].mes).toBe(PARTIAL);
        expect(after[before.length - 1].extra.generation_outcome?.status).toBe('error');
        await expect(page.locator('#chat .generation_outcome')).toContainText('The provider ended this reply with an error');
    });

    test(`an Agent reply ending in a provider error ${viewport} stays terminal across retry and reopen`, async ({ app }) => {
        const second = { ...post, id: 'polish', name: 'Polish', connectionProfile: 'polish' };
        const { account, page } = await setup(app, { phone, agents: [post, second], streaming: false });
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === MODEL
            ? 'An ordinary complete reply.' : 'An Agent revision that must not land.' },
        finish_reason: body.model === MODEL ? 'stop' : 'error' }] });
        await send(page, 'Describe the fountain.');
        await expect.poll(() => app.provider.calls.length).toBeGreaterThanOrEqual(3);
        await delay(1800);
        await wakeRecovery(page);
        expect(app.provider.calls).toHaveLength(3);
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'will not retry automatically' })).toHaveCount(1);
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText('An ordinary complete reply.');
        const runs = await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.inChatAgentPostRuns);
        expect(runs.length).toBeGreaterThan(0);
        await page.close();
        const reopened = await openChat(account);
        expect(await reopened.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.inChatAgentPostRuns)).toEqual(runs);
        await wakeRecovery(reopened);
        expect(app.provider.calls).toHaveLength(3);
        await expect(reopened.locator('#toast-container .toast').filter({ hasText: 'will not retry automatically' })).toHaveCount(0);
    });
}

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

async function setup(app, { phone = false, agents = [post, companion], streaming = true, automatic = false } = {}) {
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
            companionExecutionMode: 'parallel', companionConcurrentWithPostGen: false } };
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

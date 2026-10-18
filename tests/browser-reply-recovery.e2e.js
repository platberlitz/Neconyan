/* global window, document */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

const reply = 'The reply kept going after the tab closed. Here is the finished answer.';
const first = 'The reply kept going';

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await expect(page.locator('#send_textarea')).toBeVisible();
    return page;
}

async function startBrowserReply(page, type = 'normal') {
    if (type === 'normal') await page.locator('#send_textarea').fill('Finish this even while I am away.');
    const request = page.waitForRequest(request => /\/api\/backends\/(chat|text)-completions\/generate$/.test(request.url()));
    await page.evaluate(async type => {
        const core = await import('/script.js');
        window.fixtureGeneration = core.Generate(type, { skipNativeRoleplay: true }).catch(error => {
            window.fixtureGenerationError = error.message;
        });
    }, type);
    const headers = await (await request).allHeaders();
    expect(headers['x-generation-context']).toBeTruthy();
    return headers['x-generation-id'];
}

async function heldReplies(account) {
    return (await account.post('/api/resumable-generations/list')).jobs;
}

async function expectSavedOnce(page, account, app, id, model = MODEL) {
    await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(reply, { timeout: 30000 });
    await expect.poll(async () => (await heldReplies(account)).some(job => job.id === id)).toBe(false);
    expect(app.provider.calls.filter(call => call.model === model)).toHaveLength(1);
    await page.close();
    const reopened = await openChat(account);
    const messages = await reopened.evaluate(async () => (await import('/script.js')).chat);
    expect(messages.filter(message => message.mes === reply)).toHaveLength(1);
    expect(messages.at(-1).extra.resumable_generation_id).toBe(id);
    expect(messages).toHaveLength(3);
    return reopened;
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} browser reply survives closing before provider headers and returning before completion`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.hold = MODEL;
        app.provider.mode.reply = { choices: [{ message: { content: reply } }] };
        app.provider.mode.streamEvents = [{ choices: [{ delta: { content: reply } }] }];
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = phone;
        } });
        const page = await openChat(account);
        const id = await startBrowserReply(page);
        await expect.poll(() => app.provider.calls.filter(call => call.model === MODEL).length).toBe(1);
        await page.close();
        await expect.poll(async () => (await heldReplies(account)).find(job => job.id === id)?.attached).toBe(false);
        const returned = await openChat(account);
        const listed = returned.waitForResponse(response => response.url().endsWith('/api/resumable-generations/list'));
        await returned.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await listed;
        expect((await heldReplies(account)).find(job => job.id === id)?.status).toBe('running');
        await app.release();
        await expectSavedOnce(returned, account, app, id);
    });

    test(`${viewport} saved partial browser reply is replaced once after reopening`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { first, rest: reply.slice(first.length), reasoning: 'Considering the reply.', holdReasoning: true };
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
        } });
        const page = await openChat(account);
        try {
            const id = await startBrowserReply(page);
            // Separate provider events by a UI update interval; a single immediate chunk
            // can be held by the ordinary streaming display throttle until the next event.
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).streamingProcessor?.pendingReasoning)).toBe('Considering the reply.');
            await expect.poll(() => Date.now() - app.provider.calls.find(call => call.model === MODEL).firstTokenAt).toBeGreaterThan(250);
            app.provider.mode.finishReasoning();
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(first);
            expect(await page.evaluate(async () => (await import('/script.js')).saveChatConditional())).toBe(true);
            await page.close();
            const returned = await openChat(account);
            await expect(returned.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(first);
            // A hidden tab should pick up the server-held completion when it becomes visible.
            await returned.evaluate(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            app.provider.mode.finishStream();
            await expect.poll(async () => (await heldReplies(account)).find(job => job.id === id)?.status).toBe('finished');
            await returned.evaluate(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
                document.dispatchEvent(new Event('visibilitychange'));
                window.dispatchEvent(new Event('online'));
            });
            await expectSavedOnce(returned, account, app, id);
        } finally {
            app.provider.mode.finishReasoning?.();
            app.provider.mode.finishStream?.();
        }
    });
}

for (const status of [507, 503]) {
    test(`a failed chat save keeps the server reply through ${status === 503 ? 'a required reload' : 'a successful retry'}`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.reply = { choices: [{ message: { content: reply } }] };
        const account = await app.account({ activeConnection: true });
        const page = await openChat(account);
        let rejectSave = true;
        let rejected = 0;
        await page.route('**/api/chats/save', route => {
            if (rejectSave && route.request().postDataJSON().chat?.some(message => message.mes === reply)) {
                rejected++;
                return route.fulfill({ status, json: { error: status === 507 ? 'roleplay_store_full' : 'Temporary save failure' } });
            }
            return route.continue();
        });
        const id = await startBrowserReply(page);
        await expect.poll(() => rejected).toBeGreaterThan(0);
        await page.evaluate(() => window.fixtureGeneration);
        expect((await heldReplies(account)).find(job => job.id === id)?.status).toBe('finished');
        rejectSave = false;
        if (status === 503) {
            // An unconfirmed write deliberately blocks this editor's save chain until
            // reload. The retained provider reply must survive that safety boundary.
            await page.close();
            await expectSavedOnce(await openChat(account), account, app, id);
        } else {
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
            await expectSavedOnce(page, account, app, id);
        }
    });
}

test('text-completion streaming recovers without another provider call', async ({ app }) => {
    test.setTimeout(180000);
    app.provider.mode.hold = 'text-writer';
    app.provider.mode.streamEvents = [{ content: first }, { content: reply.slice(first.length) }];
    const account = await app.account({ activeConnection: true, textProfile: true, configureSettings(saved) {
        saved.textgenerationwebui_settings.streaming = true;
    } });
    const page = await openChat(account);
    const id = await startBrowserReply(page);
    await expect.poll(() => app.provider.calls.filter(call => call.model === 'text-writer').length).toBe(1);
    await page.close();
    await app.release();
    await expectSavedOnce(await openChat(account), account, app, id, 'text-writer');
});

test('a browser continuation restores the original prefix only once', async ({ app }) => {
    test.setTimeout(180000);
    app.provider.mode.hold = MODEL;
    app.provider.mode.reply = { choices: [{ message: { content: reply } }] };
    const account = await app.account({ activeConnection: true });
    const page = await openChat(account);
    const prefix = await page.evaluate(async () => (await import('/script.js')).chat.at(-1).mes);
    const id = await startBrowserReply(page, 'continue');
    await expect.poll(() => app.provider.calls.filter(call => call.model === MODEL).length).toBe(1);
    await page.close();
    await app.release();
    const returned = await openChat(account);
    await expect.poll(() => returned.evaluate(async () => (await import('/script.js')).chat.at(-1).mes)).toBe(prefix + reply);
    await expect.poll(async () => (await heldReplies(account)).some(job => job.id === id)).toBe(false);
    await returned.close();
    const reopened = await openChat(account);
    expect(await reopened.evaluate(async () => (await import('/script.js')).chat.map(message => message.mes))).toEqual([prefix + reply]);
    expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
});

test('a browser swipe recovers its new slot and preserves the previous reply', async ({ app }) => {
    test.setTimeout(180000);
    const original = 'Keep this earlier reply as an alternative.';
    app.provider.mode.reply = { choices: [{ message: { content: original } }] };
    const account = await app.account({ activeConnection: true });
    const page = await openChat(account);
    await startBrowserReply(page);
    await page.evaluate(() => window.fixtureGeneration);
    await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(original);
    app.provider.mode.hold = MODEL;
    app.provider.mode.reply = { choices: [{ message: { content: reply } }] };
    const request = page.waitForRequest(request => request.url().endsWith('/api/backends/chat-completions/generate'));
    await page.evaluate(async () => {
        const core = await import('/script.js');
        const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
        window.fixtureGeneration = core.swipe(null, SWIPE_DIRECTION.RIGHT, { generationOptions: { skipNativeRoleplay: true } });
    });
    const id = (await (await request).allHeaders())['x-generation-id'];
    await expect.poll(() => app.provider.calls.filter(call => call.model === MODEL).length).toBe(2);
    await page.close();
    await app.release();
    const returned = await openChat(account);
    await expect(returned.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(reply, { timeout: 30000 });
    await expect.poll(async () => (await heldReplies(account)).some(job => job.id === id)).toBe(false);
    await returned.close();
    const reopened = await openChat(account);
    const messages = await reopened.evaluate(async () => (await import('/script.js')).chat);
    expect(messages).toHaveLength(3);
    expect(messages.at(-1).swipes).toEqual([original, reply]);
    expect(messages.at(-1).swipe_id).toBe(1);
    expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(2);
});

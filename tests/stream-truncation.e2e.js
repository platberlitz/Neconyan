/* global window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

const notice = 'The connection ended before this reply finished, so it may be incomplete. Automatic agents were not run.';
const first = 'The reply stops in the middle of';
const rest = ' a sentence, and the server has the rest.';

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

async function startBrowserReply(page) {
    await page.locator('#send_textarea').fill('Tell me something long.');
    const request = page.waitForRequest(request => request.url().endsWith('/api/backends/chat-completions/generate'));
    await page.evaluate(async () => {
        const core = await import('/script.js');
        window.fixtureGeneration = core.Generate('normal').catch(error => {
            window.fixtureGenerationError = error.message;
        });
    });
    return (await (await request).allHeaders())['x-generation-id'];
}

async function heldReplies(account) {
    return (await account.post('/api/resumable-generations/list')).jobs;
}

const streaming = saved => {
    saved.oai_settings.stream_openai = true;
};

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport}: a reply whose stream ends without the provider's finish signal says it may be incomplete`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.streamRaw = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: first } }] }) + '\n\n';
        const account = await app.account({ phone, activeConnection: true, configureSettings: streaming });
        const page = await openChat(account);
        const id = await startBrowserReply(page);
        await page.evaluate(() => window.fixtureGeneration);
        const reply = page.locator('#chat .mes[mesid]').last();
        await expect(reply.locator('.mes_text')).toHaveText(first);
        await page.screenshot({ path: `../screenshots/stream-cut-short-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        await expect(reply.locator('.generation_outcome')).toHaveText(notice);
        expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.generation_outcome))
            .toEqual({ version: 1, status: 'truncated', reason: 'incomplete_stream' });
        // The server copy holds nothing more, so it is released as usual.
        await expect.poll(async () => (await heldReplies(account)).some(job => job.id === id)).toBe(false);
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
    });
}

test('a reply cut short in transit is completed from the copy the server kept', async ({ app }) => {
    test.setTimeout(180000);
    app.provider.mode.streamReply = { first, rest };
    const account = await app.account({ activeConnection: true, configureSettings: streaming });
    await account.context.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const response = await original(input, init);
            if (!String(input?.url ?? input).endsWith('/api/backends/chat-completions/generate')) return response;
            // A proxy that closes the connection cleanly after the first event.
            const { value } = await response.body.getReader().read();
            return new Response(new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }),
                { status: response.status, statusText: response.statusText, headers: response.headers });
        };
    });
    const page = await openChat(account);
    const id = await startBrowserReply(page);
    await page.evaluate(() => window.fixtureGeneration);
    const reply = page.locator('#chat .mes[mesid]').last();
    await expect(reply.locator('.mes_text')).toHaveText(first);
    expect((await heldReplies(account)).find(job => job.id === id)?.status).toBe('running');
    app.provider.mode.finishStream();
    await expect(reply.locator('.mes_text')).toHaveText(first + rest, { timeout: 30000 });
    await expect(reply.locator('.generation_outcome')).toHaveCount(0);
    await expect.poll(async () => (await heldReplies(account)).some(job => job.id === id)).toBe(false);
    const saved = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
    expect(saved.extra.resumable_generation_id).toBe(id);
    expect(saved.extra.generation_outcome).toBeUndefined();
    expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
});

const reasoning = 'Thinking about it.';

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport}: a reply cut short before any reply text keeps its reasoning and is completed from the server copy`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { reasoning, holdReasoning: true, first, rest };
        const account = await app.account({ phone, activeConnection: true, configureSettings: streaming });
        await account.context.addInitScript(() => {
            const original = window.fetch.bind(window);
            window.fetch = async (input, init) => {
                const response = await original(input, init);
                if (!String(input?.url ?? input).endsWith('/api/backends/chat-completions/generate')) return response;
                // A proxy that closes the connection cleanly after the first event, here the reasoning.
                const { value } = await response.body.getReader().read();
                return new Response(new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }),
                    { status: response.status, statusText: response.statusText, headers: response.headers });
            };
        });
        const page = await openChat(account);
        const id = await startBrowserReply(page);
        await page.evaluate(() => window.fixtureGeneration);
        const reply = page.locator('#chat .mes[mesid]').last();
        // The empty attempt stays, with the reasoning that arrived before the cut.
        expect(await page.evaluate(async () => {
            const last = (await import('/script.js')).chat.at(-1);
            return { isUser: Boolean(last.is_user), mes: last.mes, reasoning: last.extra?.reasoning ?? null };
        })).toEqual({ isUser: false, mes: '', reasoning });
        await page.screenshot({ path: `../screenshots/stream-cut-short-reasoning-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        // The server is still writing, so its copy is kept for recovery.
        expect((await heldReplies(account)).find(job => job.id === id)?.status).toBe('running');
        await expect(reply.locator('.generation_outcome')).toHaveText(notice);
        app.provider.mode.finishReasoning();
        await expect.poll(() => typeof app.provider.mode.finishStream).toBe('function');
        app.provider.mode.finishStream();
        await expect(reply.locator('.mes_text')).toHaveText(first + rest, { timeout: 30000 });
        await expect(reply.locator('.generation_outcome')).toHaveCount(0);
        await expect.poll(async () => (await heldReplies(account)).some(job => job.id === id)).toBe(false);
        const saved = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(saved.extra.resumable_generation_id).toBe(id);
        expect(saved.extra.reasoning).toBe(reasoning);
        expect(saved.extra.generation_outcome).toBeUndefined();
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
    });
}

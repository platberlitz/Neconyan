/* global window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

const notice = 'The connection ended before this reply finished, so it may be incomplete. Automatic agents were not run.';
const first = 'The connection dropped after these words';
const rest = ', and the server kept the rest.';
const lost = 'The connection to the server was lost before the reply finished.';

async function generating(page) {
    return page.evaluate(async () => (await import('/script.js')).isGenerating());
}

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

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport}: a reply whose connection cannot be resumed keeps what arrived, says so, and is completed later`, async ({ app }) => {
        test.setTimeout(300000);
        app.provider.mode.streamReply = { first, rest };
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
        } });
        await account.context.addInitScript(() => {
            const original = window.fetch.bind(window);
            window.fixtureNetwork = { down: false, refused: [] };
            window.fetch = async (input, init) => {
                const url = String(input?.url ?? input);
                // While the network is down every control call fails, as in a real outage, and is recorded.
                const control = /\/api\/resumable-generations\/(resume|status|list|cancel|discard)$/.exec(url);
                if (window.fixtureNetwork.down && control) {
                    window.fixtureNetwork.refused.push(control[1]);
                    throw new TypeError('Failed to fetch');
                }
                const response = await original(input, init);
                if (!url.endsWith('/api/backends/chat-completions/generate')) return response;
                // The first event arrives, then the network goes away without the server noticing.
                const reader = response.body.getReader();
                let delivered = false;
                return new Response(new ReadableStream({
                    async pull(controller) {
                        if (delivered) {
                            window.fixtureNetwork.down = true;
                            controller.error(new TypeError('network error'));
                            return;
                        }
                        const { value, done } = await reader.read();
                        if (done) return controller.close();
                        delivered = true;
                        controller.enqueue(value);
                    },
                }), { status: response.status, statusText: response.statusText, headers: response.headers });
            };
        });
        const page = await openChat(account);
        await page.locator('#send_textarea').fill('Tell me something long.');
        const request = page.waitForRequest(request => request.url().endsWith('/api/backends/chat-completions/generate'));
        await page.evaluate(async () => {
            const core = await import('/script.js');
            window.fixtureGeneration = core.Generate('normal').catch(error => {
                window.fixtureGenerationError = error.message;
            });
        });
        const id = (await (await request).allHeaders())['x-generation-id'];
        const reply = page.locator('#chat .mes[mesid]').last();
        await expect(reply.locator('.mes_text')).toHaveText(first);
        app.provider.mode.finishStream();

        const said = await reply.locator('.generation_outcome').getByText(notice).waitFor({ timeout: 150000 }).then(() => true, () => false);
        await page.screenshot({ path: `../screenshots/connection-lost-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        expect(said).toBe(true);
        // The same sentence also shows once as the warning toast that a cut-short reply shows in Build B.
        await expect(page.locator('#toast-container .toast-warning').filter({ hasText: notice })).toHaveCount(1);
        await expect(reply.locator('.mes_text')).toHaveText(first);
        expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.generation_outcome))
            .toEqual({ version: 1, status: 'truncated', reason: 'connection_lost' });

        // Giving up on the connection neither cancels nor drops the copy the server kept.
        await page.evaluate(() => window.fixtureGeneration);
        expect(await page.evaluate(() => window.fixtureNetwork.refused.filter(name => name === 'cancel' || name === 'discard'))).toEqual([]);
        expect((await account.post('/api/resumable-generations/list')).jobs.some(job => job.id === id)).toBe(true);

        // Once the network is back, recovery completes the reply from the copy the server kept.
        await page.evaluate(() => { window.fixtureNetwork.down = false; });
        await expect(reply.locator('.mes_text')).toHaveText(first + rest, { timeout: 30000 });
        await expect(reply.locator('.generation_outcome')).toHaveCount(0);
        await expect.poll(async () => (await account.post('/api/resumable-generations/list')).jobs.some(job => job.id === id)).toBe(false);
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
    });

    test(`${viewport}: a reply that cannot reach the server at all stops waiting in bounded time`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
        } });
        await account.context.addInitScript(() => {
            const original = window.fetch.bind(window);
            window.fetch = async (input, init) => {
                const url = String(input?.url ?? input);
                if (/\/api\/(backends\/chat-completions\/generate|resumable-generations\/(resume|status|list|cancel|discard))$/.test(url)) throw new TypeError('Failed to fetch');
                return original(input, init);
            };
        });
        const page = await openChat(account);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('#send_textarea').fill('Is anyone there?');
        await page.locator('#send_but').click();
        await expect.poll(() => generating(page)).toBe(true);

        // Today the page keeps retrying for about five minutes; with the bound it stops after about 90 seconds.
        let stopped = true;
        try {
            await expect.poll(() => generating(page), { timeout: 150000, intervals: [1000] }).toBe(false);
        } catch {
            stopped = false;
        }
        await page.screenshot({ path: `../screenshots/first-connection-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        expect(stopped).toBe(true);
        expect(errors).toContain(lost);
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(0);
    });
}

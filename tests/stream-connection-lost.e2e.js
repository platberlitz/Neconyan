/* global document, MutationObserver, Node, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

const notice = 'The connection ended before this reply finished, so it may be incomplete. Automatic agents were not run.';
const first = 'The connection dropped after these words';
const rest = ', and the server kept the rest.';
const lost = 'The connection to the server was lost before the reply finished.';
const firstConnectionNotice = 'The connection to the server was lost. Check your connection and try again.';

function installToastRecorder() {
    window.fixtureToasts = [];
    const seen = new WeakSet();
    new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            for (const toast of [node, ...node.querySelectorAll('.toast')]) {
                if (toast.matches('.toast') && !seen.has(toast)) {
                    seen.add(toast);
                    window.fixtureToasts.push(toast.textContent.trim());
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}

test('toast recorder counts distinct Toastr elements even when their text matches', async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: fileURLToPath(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url)) });
    await page.addScriptTag({ path: fileURLToPath(new URL('../public/lib/toastr.min.js', import.meta.url)) });
    await page.evaluate(installToastRecorder);
    await page.evaluate(() => {
        window.toastr.options.timeOut = 0;
        window.toastr.options.showDuration = 0;
        window.toastr.error('Same message', 'Same title');
    });
    await expect.poll(() => page.evaluate(() => window.fixtureToasts.length)).toBe(1);
    await page.evaluate(() => window.toastr.error('Same message', 'Same title'));
    await expect.poll(() => page.evaluate(() => window.fixtureToasts.length)).toBe(2);
    await page.evaluate(() => {
        document.querySelector('#toast-container').remove();
        window.toastr.error('Same message', 'Same title');
    });
    await expect.poll(() => page.evaluate(() => window.fixtureToasts.length)).toBe(3);
    expect(await page.evaluate(() => window.fixtureToasts)).toEqual(Array(3).fill('Same titleSame message'));
});

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

    for (const streaming of [true, false]) {
        test(`${viewport}: a ${streaming ? 'streaming' : 'non-streaming'} reply that cannot reach the server at all stops waiting in bounded time`, async ({ app }) => {
            test.setTimeout(300000);
            const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
                saved.oai_settings.stream_openai = streaming;
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
            const priorRows = await page.locator('#chat .mes[mesid]').allTextContents();
            await page.evaluate(installToastRecorder);
            await page.locator('#send_textarea').fill('Is anyone there?');
            await page.locator('#send_but').click();
            await expect.poll(() => generating(page)).toBe(true);
            await expect(page.locator('#send_textarea')).toHaveValue('');
            await page.locator('#send_textarea').fill('A fresh draft.');

            // The bounded retry loop stops after about 90 seconds.
            let stopped = true;
            try {
                await expect.poll(() => generating(page), { timeout: 150000, intervals: [1000] }).toBe(false);
            } catch {
                stopped = false;
            }
            await page.screenshot({ path: `../screenshots/first-send-connection-feedback/${viewport}-${streaming ? 'streaming' : 'non-streaming'}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            expect(stopped).toBe(true);
            expect(errors).toContain(lost);
            expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(0);
            await expect(page.locator('#send_textarea')).toHaveValue('A fresh draft.');
            const rows = await page.locator('#chat .mes[mesid]').allTextContents();
            expect(rows.slice(0, priorRows.length)).toEqual(priorRows);
            expect(rows).toHaveLength(priorRows.length + 1);
            expect(rows.at(-1)).toContain('Is anyone there?');
            const saved = await page.evaluate(async avatar => {
                const core = await import('/script.js');
                return (await core.loadRoleplayChat({ group: false, chat: core.getCurrentChatId(), avatar })).records;
            }, account.avatar);
            expect(saved.filter(message => message.is_user && message.mes === 'Is anyone there?')).toHaveLength(1);
            const toasts = await page.evaluate(() => window.fixtureToasts);
            console.log(JSON.stringify({ viewport, streaming, toasts, errors, rows: rows.length, priorRows: priorRows.length }));
            expect(toasts.filter(text => text.includes(firstConnectionNotice))).toHaveLength(1);
            const toast = page.locator('#toast-container .toast-error').filter({ hasText: firstConnectionNotice });
            await expect(toast).toBeVisible();
            await expect(toast.locator('.toast-title')).toHaveText('Reply stopped');
            const bounds = await toast.boundingBox();
            const size = page.viewportSize();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.y).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
            console.log(JSON.stringify({ viewport, streaming, toastBounds: bounds, size }));
        });
    }
}

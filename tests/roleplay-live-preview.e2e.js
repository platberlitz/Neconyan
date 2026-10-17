/* global window, document, requestAnimationFrame */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { installSyntheticLongChat } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.setTimeout(180000);
const reply = 'The complete server reply stays visible.';

async function openPreview(app, phone) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
    if (phone) await installIPhoneSafari(account.context);
    const page = await account.open({ workspace: false, skipTour: false });
    await page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]').click();
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const originalFetch = window.fetch;
        window.fetch = (input, options) => {
            if (!String(input).includes('/api/jobs/live-preview-fixture/preview')) return originalFetch(input, options);
            window.previewFramesQuery = new URL(String(input), 'http://preview.local').searchParams.get('frames');
            let heartbeat;
            const stream = new ReadableStream({
                start(controller) {
                    window.previewConnections = (window.previewConnections || 0) + 1;
                    window.sendLivePreview = (preview, serverTime = Date.now()) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ preview, serverTime })}\n\n`));
                    window.sendLivePreviewDelta = (delta, serverTime = Date.now()) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta, serverTime })}\n\n`));
                    // Match the real endpoint while slow browsers prepare the synthetic chat.
                    heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 1000);
                },
                cancel() { clearInterval(heartbeat); },
            });
            return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
        };
        const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
        window.stopLivePreview = observeRoleplayPreview('live-preview-fixture', { account: 'test', isCurrent: () => true, onTerminal() {} });
    }, account.avatar);
    if (phone) await applyIOSOnlyCss(page);
    return page;
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`server preview timer tolerates clock skew, ticks between tokens and freezes on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await page.evaluate(({ text, clockOffset }) => {
            const serverTime = Date.now() + clockOffset;
            window.livePreviewStart = serverTime - 3000;
            // A retained preview's update time is not the current server clock.
            window.sendLivePreview({ childId: 'reply', stage: 'generating', text, updatedAt: serverTime - 1000,
                gen_started: new Date(window.livePreviewStart).toISOString() }, serverTime);
        }, { text: reply, clockOffset: phone ? 300000 : -300000 });
        const preview = page.locator('#neconyan-roleplay-preview');
        await expect(preview).toContainText(reply);
        await preview.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/roleplay-live-timer-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        const timer = preview.locator('.mes_timer');
        await expect(timer).toHaveText(/\d+\.\d+s/);
        const first = Number.parseFloat(await timer.textContent());
        expect(first).toBeGreaterThanOrEqual(3);
        expect(first).toBeLessThan(30);
        await page.evaluate(() => {
            window.livePreviewTextNode = document.querySelector('#neconyan-roleplay-preview .mes_text').firstChild;
        });
        await expect.poll(async () => Number.parseFloat(await timer.textContent())).toBeGreaterThan(first + 0.5);
        expect(await page.evaluate(() => window.livePreviewTextNode === document.querySelector('#neconyan-roleplay-preview .mes_text').firstChild)).toBe(true);
        await page.evaluate(text => window.sendLivePreview({ childId: 'reply', stage: 'companions', text,
            gen_started: new Date(window.livePreviewStart).toISOString(), gen_finished: new Date(window.livePreviewStart + 5000).toISOString(),
        }), reply);
        await expect(timer).toHaveText('5.0s');
        // Observe across multiple timer ticks; no provider updates arrive in this interval.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(1200);
        await expect(timer).toHaveText('5.0s');
        expect(await page.evaluate(async text => (await import('/script.js')).chat.some(message => message.mes === text), reply)).toBe(false);
        await page.evaluate(() => window.stopLivePreview());
    });

    test(`streaming deltas reconstruct the reply and draw at the reader cadence on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await page.evaluate(() => {
            window.drawCount = 0;
            document.addEventListener('neconyan:roleplay-preview-rendered', () => { window.drawCount++; });
            window.sendLivePreview({ childId: 'reply', stage: 'generating', text: 'Start', gen_started: new Date().toISOString() });
        });
        const preview = page.locator('#neconyan-roleplay-preview');
        await expect(preview).toContainText('Start');
        // Two seconds of 100ms appends, delivered as the server's delta frames.
        await page.evaluate(async () => {
            for (let index = 0; index < 20; index++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                window.sendLivePreviewDelta({ text: ` token${index}`, set: { updatedAt: Date.now() } });
            }
        });
        await expect(preview).toContainText('token19');
        await expect(preview).toContainText('token9 token10', { timeout: 2000 });
        const draws = await page.evaluate(() => window.drawCount);
        expect(draws, `full redraws over 2s of 100ms updates: ${draws}`).toBeGreaterThanOrEqual(phone ? 5 : 8);
        // The phone's conservative streaming floor must hold: deltas redraw on the
        // cadence, not once per arriving append.
        expect(draws, `full redraws over 2s of 100ms updates: ${draws}`).toBeLessThanOrEqual(phone ? 14 : Infinity);
        const connections = await page.evaluate(() => window.previewConnections);
        expect(connections, 'appended deltas never force a reconnect').toBe(1);
        expect(await page.evaluate(() => window.previewFramesQuery), 'the observer opts into delta frames').toBe('delta');
        await page.evaluate(() => window.stopLivePreview());
    });

    test(`a delta without a base reconnects for a full snapshot on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await page.evaluate(() => {
            window.sendLivePreviewDelta({ text: 'orphan', set: { stage: 'generating', childId: 'reply' } });
        });
        await expect.poll(() => page.evaluate(() => window.previewConnections || 0), { timeout: 10000 }).toBeGreaterThan(1);
        await page.evaluate(() => {
            window.sendLivePreview({ childId: 'reply', stage: 'generating', text: 'Recovered whole reply', gen_started: new Date().toISOString() });
        });
        const preview = page.locator('#neconyan-roleplay-preview');
        await expect(preview).toContainText('Recovered whole reply');
        await expect(preview).not.toContainText('orphan');
        await page.evaluate(() => window.stopLivePreview());
    });

    for (const visibleCount of [30, 50]) test(`saved reply replaces the preview without an empty frame on ${viewport} (window ${visibleCount})`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await installSyntheticLongChat(page, { messageCount: 30, visibleCount });
        await page.evaluate(text => window.sendLivePreview({ childId: 'reply', stage: 'saving', text }), reply);
        await expect(page.locator('#neconyan-roleplay-preview')).toContainText(reply);
        await page.locator('#neconyan-roleplay-preview').scrollIntoViewIfNeeded();
        const saved = await page.evaluate(async text => {
            const core = await import('/script.js');
            // Earlier metadata can change while the server works, requiring a batched redraw.
            return [{ chat_metadata: core.chat_metadata }, ...core.chat.map(message => ({ ...message, extra: { ...message.extra, refreshed: true } })),
                { name: 'Durable Nova', is_user: false, mes: text, extra: {} }];
        }, reply);
        await page.route('**/api/chats/get', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, json: saved });
        });
        const observed = await page.evaluate(async ({ text, phone }) => {
            const counts = [];
            let recording = true;
            let editAttempted = false;
            let editorOpened = false;
            const sample = () => {
                counts.push([...document.querySelectorAll('#chat .mes_text')].filter(element => element.textContent.includes(text)).length);
                const edit = document.querySelector('#chat .mes[inert].last_mes .mes_edit');
                if (phone && edit && !editAttempted) {
                    editAttempted = true;
                    // The Up hotkey uses jQuery's synthetic click, which bypasses native inert.
                    window.jQuery(edit).trigger('click');
                    editorOpened = Boolean(document.querySelector('#curEditTextarea'));
                }
                if (recording) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            window.stopLivePreview.freeze();
            await (await import('/script.js')).refreshCurrentChatFromSaved();
            window.stopLivePreview();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            recording = false;
            return { counts, editAttempted, editorOpened };
        }, { text: reply, phone });
        const { counts } = observed;
        expect(observed.editAttempted).toBe(phone);
        expect(observed.editorOpened).toBe(false);
        expect(counts.length).toBeGreaterThan(1);
        expect(counts.every(count => count === 1), `Visible reply copies by frame: ${counts}`).toBe(true);
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText(reply);
        await expect(page.locator('#neconyan-roleplay-preview')).toHaveCount(0);
    });
}

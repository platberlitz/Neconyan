/* global window, document, requestAnimationFrame */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
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
            let heartbeat;
            const stream = new ReadableStream({
                start(controller) {
                    window.sendLivePreview = (preview, serverTime = Date.now()) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ preview, serverTime })}\n\n`));
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
}

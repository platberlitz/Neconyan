/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const cases = [false, true].flatMap(phone => [false, true].map(conversation => ({ phone, conversation })));
for (const { phone, conversation } of cases) {
    test(`${phone ? 'phone' : 'desktop'} ${conversation ? 'Conversation' : 'Roleplay'} paw survives busy message preparation`, async ({ app }, info) => {
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Paw reply.' } }] };
        const account = await app.account({ phone, activeConnection: true });
        if (phone) await account.context.addInitScript(() => Object.defineProperty(window.navigator, 'platform', { get: () => 'iPhone' }));
        const page = await account.open({ workspace: conversation });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        if (!conversation) await page.evaluate(async avatar => {
            const ctx = window.SillyTavern.getContext();
            await ctx.selectCharacterById(ctx.characters.findIndex(c => c.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await page.evaluate(() => {
            window.pawFrames = [];
            window.pawSounds = [];
            new window.MutationObserver(records => {
                for (const record of records) for (const pop of record.addedNodes) {
                    if (pop.className !== 'neconyan-send-nya') continue;
                    window.pawSounds.push(pop.textContent);
                    const start = window.performance.now();
                    const frame = () => {
                        const rect = pop.getBoundingClientRect();
                        window.pawFrames.push({
                            elapsed: window.performance.now() - start,
                            opacity: Number(window.getComputedStyle(pop).opacity),
                            connected: pop.isConnected,
                            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                            width: rect.width, height: rect.height,
                        });
                        if (pop.isConnected) window.requestAnimationFrame(frame);
                    };
                    window.requestAnimationFrame(frame);
                }
            }).observe(document.body, { childList: true });
        });
        const input = page.locator(conversation ? '#sb_conversation_input' : '#send_textarea');
        const send = page.locator(conversation ? '#sb_conversation_send' : '#send_but');
        await input.fill('Hello from the paw.');
        // Message preparation can occupy the main thread longer than the pop's lifetime.
        await send.evaluate((button, phone) => {
            button.addEventListener(phone ? 'touchend' : 'click', () => {
                const until = window.performance.now() + 1400;
                while (window.performance.now() < until) { /* Simulate a busy send. */ }
            }, { once: true });
        }, phone);
        if (phone) await send.tap();
        else await send.click();
        await expect(page.locator(conversation ? '#sb_conversation_timeline' : '#chat')).toContainText('Paw reply.', { timeout: 60000 });
        expect(app.provider.calls).toHaveLength(1);
        await expect(page.locator('.neconyan-send-nya')).toHaveCount(0);
        const { frames, sounds } = await page.evaluate(() => ({ frames: window.pawFrames, sounds: window.pawSounds }));
        await info.attach('paw-frames', { body: JSON.stringify(frames), contentType: 'application/json' });
        expect(sounds).toHaveLength(1);
        expect(['nya!', 'mrrp?', 'mrrah', 'mew', 'purr']).toContain(sounds[0]);
        const visible = frames.filter(frame => frame.connected && frame.opacity >= 0.5 && frame.width > 0 && frame.height > 0);
        expect(visible.length).toBeGreaterThan(0);
        const viewport = page.viewportSize();
        expect(visible.some(frame => frame.left >= 0 && frame.top >= 0 && frame.right <= viewport.width && frame.bottom <= viewport.height)).toBe(true);
    });
}

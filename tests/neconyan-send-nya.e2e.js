/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const cases = [false, true].flatMap(phone => [false, true].map(conversation => ({ phone, conversation })));
cases.push({ phone: true, conversation: false, safariKeyboard: true });
for (const { phone, conversation, safariKeyboard = false } of cases) {
    test(`${phone ? 'phone' : 'desktop'} ${conversation ? 'Conversation' : 'Roleplay'} paw survives ${safariKeyboard ? 'simulated Safari keyboard coordinates' : 'busy message preparation'}`, async ({ app }, info) => {
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Paw reply.' } }] };
        const account = await app.account({ phone, activeConnection: true });
        if (phone) await account.context.addInitScript(() => Object.defineProperty(window.navigator, 'platform', { get: () => 'iPhone' }));
        if (safariKeyboard) await account.context.addInitScript(() => {
            // Safari reports visual-viewport coordinates for a touch while fixed
            // positioning still uses the layout viewport. Chromium needs both
            // sides of that mismatch simulated; a small viewport alone misses it.
            const viewport = new window.EventTarget();
            Object.assign(viewport, { width: 393, height: 852, offsetTop: 0, offsetLeft: 0, scale: 1 });
            Object.defineProperty(window, 'visualViewport', { value: viewport });
            const clientY = Object.getOwnPropertyDescriptor(window.Touch.prototype, 'clientY').get;
            Object.defineProperty(window.Touch.prototype, 'clientY', { get() { return clientY.call(this) - viewport.offsetTop; } });
            const elementFromPoint = document.elementFromPoint.bind(document);
            document.elementFromPoint = (x, y) => elementFromPoint(x, y + viewport.offsetTop);
        });
        const page = await account.open({ workspace: conversation, timeout: 60000 });
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
                            viewportTop: window.visualViewport.offsetTop,
                            viewportBottom: window.visualViewport.offsetTop + window.visualViewport.height,
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
        if (safariKeyboard) {
            // Safari pans far enough to keep the focused composer above the keyboard.
            await page.evaluate(() => {
                Object.assign(window.visualViewport, { height: 350, offsetTop: window.innerHeight - 350 });
                window.visualViewport.dispatchEvent(new window.Event('resize'));
            });
            await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--sb-shell-viewport-top'))).toBe(`${page.viewportSize().height - 350}px`);
            await expect(input).toBeFocused();
            await expect.poll(() => send.evaluate(button => {
                const rect = button.getBoundingClientRect();
                return rect.top >= window.visualViewport.offsetTop
                    && rect.bottom <= window.visualViewport.offsetTop + window.visualViewport.height;
            })).toBe(true);
        }
        // Message preparation can occupy the main thread longer than the pop's lifetime.
        await send.evaluate((button, phone) => {
            button.addEventListener(phone ? 'touchend' : 'click', () => {
                const until = window.performance.now() + 1400;
                while (window.performance.now() < until) { /* Simulate a busy send. */ }
            }, { once: true });
        }, phone);
        if (safariKeyboard) {
            // Direct touch avoids Playwright's hit-test helper, whose coordinates
            // are Chromium's rather than the Safari coordinates simulated above.
            const rect = await send.boundingBox();
            await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
        } else if (phone) await send.tap();
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
        expect(visible.some(frame => frame.left >= 0 && frame.top >= frame.viewportTop && frame.right <= viewport.width && frame.bottom <= frame.viewportBottom)).toBe(true);
        const buttonBox = await send.boundingBox();
        const buttonCenter = { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 };
        const nearButton = visible.some(frame => {
            const centerX = (frame.left + frame.right) / 2;
            const centerY = (frame.top + frame.bottom) / 2;
            return Math.hypot(centerX - buttonCenter.x, centerY - buttonCenter.y) < 80;
        });
        expect(nearButton).toBe(true);
    });
}

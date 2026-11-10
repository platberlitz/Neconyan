/* global document, window, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { installSyntheticLongChat, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, IPHONE_SAFARI_CONTEXT, installIPhoneSafari } from './ios-safari-emulation.js';

test.setTimeout(120_000);
test.use({ serviceWorkers: 'block' });

const para = index => `Paragraph ${index} of the reply, with enough words to wrap on a phone screen and look like prose.`;
const body = (from, to, extra = '') => Array.from({ length: to - from }, (_, i) => para(from + i)).join('\n\n') + extra;

/** Rewrites the last reply the way a browser-side Agent does: new text, then one row refresh. */
async function rewriteReply(page, text) {
    await page.evaluate(async value => {
        const context = window.SillyTavern.getContext();
        const index = context.chat.length - 1;
        const message = context.chat[index];
        message.is_user = false;
        message.name = 'Miso';
        message.mes = value;
        await context.updateMessageBlock(index, message);
    }, text);
}

async function putLineAt(page, line, offset) {
    await page.evaluate(({ text, offset }) => {
        const chat = document.querySelector('#chat');
        const p = [...chat.querySelectorAll('.mes:last-child .mes_text p')].find(el => el.textContent.startsWith(text));
        chat.scrollTop += p.getBoundingClientRect().top - chat.getBoundingClientRect().top - offset;
        chat.dispatchEvent(new Event('scroll'));
    }, { text: line, offset });
    await waitForAnimationFrames(page, 4);
}

async function scrollToEnd(page) {
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.scrollTop = chat.scrollHeight;
        chat.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);
}

/** Records where one line of the reply sits on every painted frame. */
async function recordLine(page, line) {
    await page.evaluate(text => {
        const chat = document.querySelector('#chat');
        window.agentRewriteFrames = [];
        window.agentRewriteRecording = true;
        const sample = () => {
            if (!window.agentRewriteRecording) return;
            const p = [...chat.querySelectorAll('.mes:last-child .mes_text p')].find(el => el.textContent.startsWith(text));
            window.agentRewriteFrames.push(p ? Math.round(p.getBoundingClientRect().top - chat.getBoundingClientRect().top) : null);
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, line);
}

const stopRecording = page => page.evaluate(() => {
    window.agentRewriteRecording = false;
    return window.agentRewriteFrames;
});

const firstParagraph = page => page.evaluate(() => document.querySelector('#chat .mes:last-child .mes_text p')?.textContent || '');

async function expectLineHeld(page) {
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(1200);
    const frames = await stopRecording(page);
    expect(frames.length).toBeGreaterThan(20);
    expect(frames).not.toContain(null);
    expect(Math.max(...frames) - Math.min(...frames)).toBeLessThanOrEqual(2);
}

for (const phone of [false, true]) {
    test.describe(`Agent rewrite of the current reply, ${phone ? 'iPhone emulation' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test.beforeEach(async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context);
            await openReadyChat(page);
            if (phone) await applyIOSOnlyCss(page);
            await installSyntheticLongChat(page, { messageCount: 30 });
            await rewriteReply(page, body(0, 60));
            // The landing pins from opening the chat last 2.4 seconds.
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(2800);
        });

        test('text removed above the line being read does not move that line', async ({ page }) => {
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            await rewriteReply(page, body(10, 60));
            expect(await firstParagraph(page)).toBe(para(10));
            await expectLineHeld(page);
        });

        test('text added above the line being read does not move that line', async ({ page }) => {
            await rewriteReply(page, body(10, 60));
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            await rewriteReply(page, body(0, 60));
            expect(await firstParagraph(page)).toBe(para(0));
            await expectLineHeld(page);
        });

        test('Agent output added after the reply lands below a reader at the end', async ({ page }) => {
            await scrollToEnd(page);
            await recordLine(page, para(59));
            await rewriteReply(page, body(0, 60, '\n\n' + body(100, 110)));
            await expectLineHeld(page);
        });

        test('a shorter reply keeps its last line in place for a reader at the end', async ({ page }) => {
            await scrollToEnd(page);
            await recordLine(page, para(59));
            await rewriteReply(page, body(10, 60));
            await expectLineHeld(page);
        });

        test('a rewrite waits for scrolling to stop, then lands without a jump', async ({ page }) => {
            await putLineAt(page, para(40), 200);
            const box = await page.locator('#chat').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await recordLine(page, para(40));
            const wheel = (async () => {
                for (let i = 0; i < 60; i++) {
                    await page.mouse.wheel(0, -12);
                    // eslint-disable-next-line playwright/no-wait-for-timeout
                    await page.waitForTimeout(16);
                }
            })();
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(300);
            const rewrite = rewriteReply(page, body(10, 60));
            await wheel;
            await rewrite;
            expect(await firstParagraph(page)).toBe(para(10));
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(600);
            const frames = await stopRecording(page);
            expect(frames).not.toContain(null);
            const steps = frames.slice(1).map((top, index) => top - frames[index]);
            // Scrolling up moves the line down the screen a few wheel steps per frame at most;
            // it never moves back up and never leaps.
            expect(Math.min(...steps)).toBeGreaterThanOrEqual(-2);
            expect(Math.max(...steps)).toBeLessThanOrEqual(60);
            expect(frames.at(-1) - frames[0]).toBeGreaterThan(300);
        });
    });
}

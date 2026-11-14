/* global document, window, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { installSyntheticLongChat, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, IPHONE_SAFARI_CONTEXT, installIPhoneSafari } from './ios-safari-emulation.js';

test.setTimeout(120_000);
test.use({ serviceWorkers: 'block' });

const para = index => `Paragraph ${index} of the reply, with enough words to wrap on a phone screen and look like prose.`;
const body = (from, to) => Array.from({ length: to - from }, (_, i) => para(from + i)).join('\n\n');
const FIND_LINE = '(text) => [...document.querySelectorAll(\'#neconyan-roleplay-preview .mes_text p, #chat .mes[mesid]:last-of-type .mes_text p\')].find(el => el.textContent === text)';

async function installPreview(page) {
    await page.evaluate(async () => {
        const originalFetch = window.fetch;
        const encode = text => new TextEncoder().encode(text);
        let current = null;
        let latest = null;
        const enqueue = text => { try { current?.enqueue(encode(text)); } catch { current = null; } };
        window.sendScrollPreview = preview => { latest = preview; enqueue(`data: ${JSON.stringify({ preview })}\n\n`); };
        const keepalive = setInterval(() => enqueue(': keepalive\n\n'), 1000);
        window.fetch = (input, options) => {
            if (!String(input).includes('/api/jobs/scroll-regression/preview')) return originalFetch(input, options);
            let own = null;
            return Promise.resolve(new Response(new ReadableStream({
                start(controller) { own = controller; current = controller; if (latest) controller.enqueue(encode(`data: ${JSON.stringify({ preview: latest })}\n\n`)); },
                cancel() { if (current === own) current = null; },
            }), { headers: { 'Content-Type': 'text/event-stream' } }));
        };
        const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
        const stop = observeRoleplayPreview('scroll-regression', { account: 'scroll-test', isCurrent: () => true, onTerminal: () => {} });
        window.scrollPreviewStop = stop;
        window.stopScrollPreview = () => { stop(); clearInterval(keepalive); window.fetch = originalFetch; };
    });
}

async function send(page, stage, text) {
    await page.evaluate(({ stage, text }) => window.sendScrollPreview({ childId: 'reply', name: 'Miso', stage, updatedAt: Date.now(), text }), { stage, text });
}

const previewEdges = page => page.evaluate(() => {
    const lines = [...document.querySelectorAll('#neconyan-roleplay-preview .mes_text p')];
    return [lines[0]?.textContent ?? null, lines.at(-1)?.textContent ?? null];
});

async function sendAndWait(page, stage, text) {
    await send(page, stage, text);
    const lines = text.split('\n\n');
    await expect.poll(() => previewEdges(page)).toEqual([lines[0], lines.at(-1)]);
}

async function putLineAt(page, line, offset) {
    await page.evaluate(({ line, offset, find }) => {
        const chat = document.querySelector('#chat');
        const element = (0, eval)(find)(line);
        chat.scrollTop += element.getBoundingClientRect().top - chat.getBoundingClientRect().top - offset;
        chat.dispatchEvent(new Event('scroll'));
    }, { line, offset, find: FIND_LINE });
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

async function recordLine(page, line) {
    await page.evaluate(({ line, find }) => {
        const chat = document.querySelector('#chat');
        const locate = (0, eval)(find);
        window.roleplayRewriteFrames = [];
        window.roleplayRewriteRecording = true;
        const sample = () => {
            if (!window.roleplayRewriteRecording) return;
            const element = locate(line);
            window.roleplayRewriteFrames.push(element ? Math.round(element.getBoundingClientRect().top - chat.getBoundingClientRect().top) : null);
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, { line, find: FIND_LINE });
}

const stopRecording = page => page.evaluate(() => {
    window.roleplayRewriteRecording = false;
    return window.roleplayRewriteFrames;
});

async function expectLineHeld(page, settleMs = 1200) {
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(settleMs);
    // Keep the observation period and frame count on slower browser runners.
    await expect.poll(() => page.evaluate(() => window.roleplayRewriteFrames.length), { timeout: 10000 }).toBeGreaterThan(20);
    const frames = await stopRecording(page);
    expect(frames.length).toBeGreaterThan(20);
    expect(frames).not.toContain(null);
    expect(Math.max(...frames) - Math.min(...frames)).toBeLessThanOrEqual(2);
}

const steps = frames => frames.slice(1).map((top, index) => top - frames[index]);

async function wheelUp(page, count) {
    const box = await page.locator('#chat').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < count; i++) {
        await page.mouse.wheel(0, -12);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(16);
    }
}

async function installSavedReplyRoute(page, text) {
    const tail = await page.evaluate(reply => {
        const context = window.SillyTavern.getContext();
        return [...context.chat.map(message => structuredClone(message)),
            { name: 'Miso', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: reply, extra: {} }];
    }, text);
    await page.route('**/api/chats/get', async route => {
        const request = JSON.parse(route.request().postData() || '{}');
        const response = await route.fetch({ postData: JSON.stringify({ ...request, allow_create: true }) });
        const records = await response.json().catch(() => []);
        const header = Array.isArray(records) && records[0] && !('mes' in records[0]) ? records[0] : { chat_metadata: {} };
        const headers = { ...response.headers() };
        delete headers['content-length'];
        delete headers['content-encoding'];
        await new Promise(resolve => setTimeout(resolve, 250));
        await route.fulfill({ status: 200, headers, body: JSON.stringify([header, ...tail]) });
    });
    return tail.length - 1;
}

const finishSavedReply = page => page.evaluate(async () => {
    const { keepChatReadingPositionOnNextLoad, refreshCurrentChatFromSaved, setRoleplayJobControls } = await import('/script.js');
    const { finishedReplyReadingAnchor } = await import('/scripts/neconyan-conversation/roleplay-workflows.js');
    window.scrollPreviewStop.freeze();
    keepChatReadingPositionOnNextLoad(finishedReplyReadingAnchor());
    try {
        await refreshCurrentChatFromSaved();
    } finally {
        keepChatReadingPositionOnNextLoad(null);
        setRoleplayJobControls(null);
        window.stopScrollPreview();
    }
});

async function expectSavedReply(page, messageId, firstLine) {
    await expect(page.locator('#neconyan-roleplay-preview')).toHaveCount(0);
    await expect(page.locator(`#chat .mes[mesid="${messageId}"] .mes_text p`).first()).toHaveText(firstLine);
}

/**
 * A reader who is scrolling when the saved reply replaces the preview keeps scrolling.
 * Swipe controls must be ready in the swap itself, without a one-frame height jump
 * or a correction pulling the reader back to an older position.
 * @param {number[]} frames Line position on each frame
 * @param {number} largestStep Largest distance one scroll step may cover
 */
function expectScrollNotPulledBack(frames, largestStep) {
    expect(frames).not.toContain(null);
    const moves = steps(frames);
    expect(Math.max(...moves)).toBeLessThanOrEqual(largestStep);
    expect(Math.min(...moves)).toBeGreaterThanOrEqual(-2);
    expect(frames.at(-1) - frames[0]).toBeGreaterThan(400);
}

for (const phone of [false, true]) {
    test.describe(`Agent rewrite of a reply written on the server, ${phone ? 'iPhone emulation' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test.beforeEach(async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context);
            await openReadyChat(page);
            if (phone) await applyIOSOnlyCss(page);
            await installSyntheticLongChat(page, { messageCount: 30 });
            // Let the chat-load bottom pins expire so they cannot move the viewport mid-test.
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(2800);
            await installPreview(page);
            await page.evaluate(async () => { (await import('/script.js')).setRoleplayJobControls('scroll-regression', () => {}); });
            await sendAndWait(page, 'generating', body(0, 60));
        });

        test.afterEach(async ({ page }) => {
            await page.evaluate(async () => {
                window.roleplayRewriteRecording = false;
                window.stopScrollPreview?.();
                (await import('/script.js')).setRoleplayJobControls(null);
            }).catch(() => {});
        });

        test('Agents removing text above the line being read do not move that line', async ({ page }) => {
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            await sendAndWait(page, 'agents', body(10, 60));
            await expectLineHeld(page);
        });

        test('Agents adding text above the line being read do not move that line', async ({ page }) => {
            await sendAndWait(page, 'generating', body(10, 60));
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            await sendAndWait(page, 'agents', body(0, 60));
            await expectLineHeld(page);
        });

        test('a shorter reply keeps its last line in place for a reader at the end', async ({ page }) => {
            await scrollToEnd(page);
            await recordLine(page, para(59));
            await sendAndWait(page, 'agents', body(10, 60));
            await expectLineHeld(page);
        });

        test('an Agent rewrite waits for scrolling to stop, then lands without a jump', async ({ page }) => {
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            const wheel = wheelUp(page, 60);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(300);
            await send(page, 'agents', body(10, 60));
            await wheel;
            await expect.poll(() => previewEdges(page)).toEqual([para(10), para(59)]);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(600);
            const frames = await stopRecording(page);
            expect(frames).not.toContain(null);
            const moves = steps(frames);
            expect(Math.min(...moves)).toBeGreaterThanOrEqual(-2);
            expect(Math.max(...moves)).toBeLessThanOrEqual(60);
            expect(frames.at(-1) - frames[0]).toBeGreaterThan(300);
        });

        test('a saved copy that differs above the line being read does not move that line', async ({ page }) => {
            await sendAndWait(page, 'saving', body(0, 60));
            const messageId = await installSavedReplyRoute(page, body(10, 60));
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            await finishSavedReply(page);
            await expectLineHeld(page, 3000);
            await expectSavedReply(page, messageId, para(10));
        });

        test('wheel scrolling while the saved reply arrives is not pulled back', async ({ page }) => {
            await sendAndWait(page, 'saving', body(0, 60));
            const messageId = await installSavedReplyRoute(page, body(0, 60));
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            const wheel = wheelUp(page, 90);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(200);
            const finished = finishSavedReply(page);
            await wheel;
            await finished;
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(3000);
            expectScrollNotPulledBack(await stopRecording(page), 60);
            await expectSavedReply(page, messageId, para(0));
        });

        test('scrolling without wheel or touch while the saved reply arrives is not pulled back', async ({ page }) => {
            await sendAndWait(page, 'saving', body(0, 60));
            const messageId = await installSavedReplyRoute(page, body(0, 60));
            await putLineAt(page, para(40), 200);
            await recordLine(page, para(40));
            // Momentum, scrollbar and keyboard scrolling raise scroll events only.
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                window.roleplayRewriteScroll = new Promise(resolve => {
                    let count = 0;
                    const step = () => {
                        if (count++ >= 90) return resolve();
                        chat.scrollTop -= 6;
                        requestAnimationFrame(step);
                    };
                    requestAnimationFrame(step);
                });
            });
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(200);
            await finishSavedReply(page);
            await page.evaluate(() => window.roleplayRewriteScroll);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(3000);
            expectScrollNotPulledBack(await stopRecording(page), 8);
            await expectSavedReply(page, messageId, para(0));
        });
    });
}

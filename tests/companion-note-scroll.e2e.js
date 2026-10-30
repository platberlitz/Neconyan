/* global document, window, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { getChatScrollSnapshot, growMessageBlockAboveViewport, installSyntheticLongChat, markManualMobileScroll, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, IPHONE_SAFARI_CONTEXT, installIPhoneSafari } from './ios-safari-emulation.js';

test.setTimeout(90_000);
const EVENT = 'in_chat_agent_companion_results_updated';
const companionNote = (status, lines = 0) => ({
    probe: {
        agentName: 'Probe Companion',
        status,
        content: status === 'done' ? 'Note line here.\n\n'.repeat(lines) : '',
        updatedAt: new Date().toISOString(),
    },
});

async function recordScrollFrames(page) {
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        window.companionNoteFrames = [];
        window.recordCompanionNoteScroll = true;
        const sample = () => {
            if (!window.recordCompanionNoteScroll) return;
            window.companionNoteFrames.push(chat.scrollTop);
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
}

async function stopScrollFrames(page) {
    return page.evaluate(() => {
        window.recordCompanionNoteScroll = false;
        return window.companionNoteFrames;
    });
}

async function markerTop(page, selector) {
    return page.evaluate(sel => {
        const chat = document.querySelector('#chat');
        const element = chat.querySelector(sel);
        return element ? Math.round(element.getBoundingClientRect().top - chat.getBoundingClientRect().top) : null;
    }, selector);
}

async function renderPendingNote(page) {
    const id = await page.evaluate(async ({ EVENT, pending }) => {
        const context = window.SillyTavern.getContext();
        const index = context.chat.length - 1;
        const message = context.chat[index];
        message.is_user = false;
        message.name = 'Miso';
        message.extra = { ...(message.extra || {}), inChatAgentCompanionResults: pending };
        delete message.swipe_info;
        await context.eventSource.emit(EVENT, { messageIndex: index });
        return index;
    }, { EVENT, pending: companionNote('pending') });
    await expect(page.locator(`.mes[mesid="${id}"] .ica--companion-ledger`)).toHaveCount(1);
    await waitForAnimationFrames(page, 6);
    return id;
}

async function finishNote(page, id) {
    await page.evaluate(async ({ EVENT, done, index }) => {
        const context = window.SillyTavern.getContext();
        const { updateCompanionResult } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        updateCompanionResult(context.chat[index], 'probe', { status: 'done', content: done.probe.content });
        await context.eventSource.emit(EVENT, { messageIndex: index });
    }, { EVENT, done: companionNote('done', 30), index: id });
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(1500);
}

function forwardJumps(frames) {
    return frames.filter((top, index) => index && top > frames[index - 1] + 4);
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'iPhone Safari emulation' : 'desktop'} saved Companion notes`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test.beforeEach(async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context);
            await openReadyChat(page);
            if (phone) await applyIOSOnlyCss(page);
            await installSyntheticLongChat(page, { messageCount: 30 });
            // Let the chat-load pins expire before a saved note grows the last message.
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(2800);
        });

        test('a finished note while following keeps the reply still', async ({ page }) => {
            const id = await renderPendingNote(page);
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                chat.scrollTop = chat.scrollHeight;
                chat.dispatchEvent(new Event('scroll'));
            });
            await waitForAnimationFrames(page, 4);

            const textBefore = await markerTop(page, `.mes[mesid="${id}"] .mes_text`);
            const ledgerBefore = await markerTop(page, `.mes[mesid="${id}"] .ica--companion-ledger`);
            await recordScrollFrames(page);
            await finishNote(page, id);
            const frames = await stopScrollFrames(page);

            const after = await getChatScrollSnapshot(page);
            const textAfter = await markerTop(page, `.mes[mesid="${id}"] .mes_text`);
            const ledgerAfter = await markerTop(page, `.mes[mesid="${id}"] .ica--companion-ledger`);
            const ledgerHeight = await page.evaluate(index => {
                const ledger = document.querySelector(`.mes[mesid="${index}"] .ica--companion-ledger`);
                return ledger ? Math.round(ledger.getBoundingClientRect().height) : 0;
            }, id);

            expect(Math.abs(textAfter - textBefore)).toBeLessThanOrEqual(3);
            expect(Math.abs(ledgerAfter - ledgerBefore)).toBeLessThanOrEqual(3);
            expect(ledgerHeight).toBeGreaterThan(200);
            expect(after.bottomDelta).toBeGreaterThan(120);
            expect(forwardJumps(frames)).toEqual([]);
        });

        test('an older message growing after a saved note does not pin the bottom', async ({ page }) => {
            const id = await renderPendingNote(page);
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                chat.scrollTop = chat.scrollHeight;
                chat.dispatchEvent(new Event('scroll'));
            });
            await waitForAnimationFrames(page, 4);
            await finishNote(page, id);

            await growMessageBlockAboveViewport(page, id - 2, { height: 120 });
            await waitForAnimationFrames(page, 6);

            const after = await getChatScrollSnapshot(page);
            expect(after.bottomDelta).toBeGreaterThan(120);
        });

        test('a finished note while reading above keeps its place', async ({ page }) => {
            const id = await renderPendingNote(page);
            await markManualMobileScroll(page, (await getChatScrollSnapshot(page)).scrollTop - 200);

            const before = await getChatScrollSnapshot(page);
            const textBefore = await markerTop(page, `.mes[mesid="${id}"] .mes_text`);
            const ledgerBefore = await markerTop(page, `.mes[mesid="${id}"] .ica--companion-ledger`);
            await recordScrollFrames(page);
            await finishNote(page, id);
            const frames = await stopScrollFrames(page);

            const after = await getChatScrollSnapshot(page);
            const textAfter = await markerTop(page, `.mes[mesid="${id}"] .mes_text`);
            const ledgerAfter = await markerTop(page, `.mes[mesid="${id}"] .ica--companion-ledger`);
            const ledgerHeight = await page.evaluate(index => {
                const ledger = document.querySelector(`.mes[mesid="${index}"] .ica--companion-ledger`);
                return ledger ? Math.round(ledger.getBoundingClientRect().height) : 0;
            }, id);

            expect(Math.abs(textAfter - textBefore)).toBeLessThanOrEqual(3);
            expect(Math.abs(ledgerAfter - ledgerBefore)).toBeLessThanOrEqual(3);
            expect(ledgerHeight).toBeGreaterThan(200);
            expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(3);
            expect(forwardJumps(frames)).toEqual([]);
        });

        test('clearing an older note waits for the reader to stop scrolling', async ({ page }) => {
            const olderId = await page.evaluate(async ({ EVENT, done }) => {
                const context = window.SillyTavern.getContext();
                const index = context.chat.length - 5;
                const message = context.chat[index];
                message.is_user = false;
                message.name = 'Miso';
                message.extra = { ...(message.extra || {}), inChatAgentCompanionResults: done };
                await context.eventSource.emit(EVENT, { messageIndex: index });
                return index;
            }, { EVENT, done: companionNote('done', 30) });
            const olderLedger = page.locator(`.mes[mesid="${olderId}"] .ica--companion-ledger`);
            await expect(olderLedger).toHaveCount(1);
            const readingId = olderId + 3;
            await page.evaluate(index => {
                const chat = document.querySelector('#chat');
                const text = chat.querySelector(`.mes[mesid="${index}"] .mes_text`);
                chat.scrollTop += text.getBoundingClientRect().top - chat.getBoundingClientRect().top - 80;
                chat.dispatchEvent(new Event('scroll'));
            }, readingId);
            await waitForAnimationFrames(page, 6);
            const textBefore = await markerTop(page, `.mes[mesid="${readingId}"] .mes_text`);

            // Auto clean-up removes the older note and asks for a full redraw while a finger is on the chat.
            await page.evaluate(async ({ EVENT, index }) => {
                const context = window.SillyTavern.getContext();
                document.querySelector('#chat').dispatchEvent(new Event('touchstart', { bubbles: true }));
                delete context.chat[index].extra.inChatAgentCompanionResults;
                await context.eventSource.emit(EVENT, {});
            }, { EVENT, index: olderId });
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(600);
            await expect(olderLedger).toHaveCount(1);
            expect(Math.abs(await markerTop(page, `.mes[mesid="${readingId}"] .mes_text`) - textBefore)).toBeLessThanOrEqual(3);

            await page.evaluate(() => document.querySelector('#chat').dispatchEvent(new Event('touchend', { bubbles: true })));
            await expect(olderLedger).toHaveCount(0);
            await waitForAnimationFrames(page, 6);
            expect(Math.abs(await markerTop(page, `.mes[mesid="${readingId}"] .mes_text`) - textBefore)).toBeLessThanOrEqual(3);
        });

        test('opening a chat whose last reply has notes lands at the bottom', async ({ page }) => {
            const lastId = await page.evaluate(async (done) => {
                const context = window.SillyTavern.getContext();
                const id = context.chat.length - 1;
                const last = context.chat[id];
                last.is_user = false;
                last.name = 'Miso';
                last.extra = { ...(last.extra || {}), inChatAgentCompanionResults: done };
                await context.printMessages();
                await context.eventSource.emit(context.event_types.CHAT_CHANGED, context.getCurrentChatId());
                return id;
            }, companionNote('done', 30));
            // Outlast the chat-load settle pins that run after the notes render.
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(3000);

            await expect(page.locator(`.mes[mesid="${lastId}"] .ica--companion-ledger`)).toHaveCount(1);
            const after = await getChatScrollSnapshot(page);
            expect(after.lastMesId).toBe(String(lastId));
            expect(after.bottomDelta).toBeLessThanOrEqual(16);
        });

        test('late media on a note-bearing reply still follows the bottom after the note finishes', async ({ page }) => {
            const id = await renderPendingNote(page);
            await finishNote(page, id);
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                chat.scrollTop = chat.scrollHeight;
                chat.dispatchEvent(new Event('scroll'));
            });
            await waitForAnimationFrames(page, 6);

            await growMessageBlockAboveViewport(page, id, { height: 300 });

            const after = await getChatScrollSnapshot(page);
            expect(after.bottomDelta).toBeLessThanOrEqual(16);
        });
    });
}

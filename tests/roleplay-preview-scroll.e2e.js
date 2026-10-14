/* global document, window, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { getChatScrollSnapshot, installSyntheticLongChat, markManualMobileScroll, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, IPHONE_SAFARI_CONTEXT, installIPhoneSafari } from './ios-safari-emulation.js';

test.setTimeout(90_000);

// Keep the real preview renderer, formatter and scroll observers; only replace
// the job's preview event stream so updates can arrive during a pending resize.
async function installPreview(page) {
    await page.evaluate(async () => {
        const originalFetch = window.fetch;
        window.fetch = (input, options) => String(input).includes('/api/jobs/scroll-regression/preview')
            ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
                window.sendScrollPreview = preview => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ preview })}\n\n`));
            } }), { headers: { 'Content-Type': 'text/event-stream' } }))
            : originalFetch(input, options);
        const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
        const stop = observeRoleplayPreview('scroll-regression', { account: 'scroll-test', isCurrent: () => true, onTerminal: () => {} });
        window.scrollPreviewStop = stop;
        window.stopScrollPreview = () => { stop(); window.fetch = originalFetch; };
    });
}

const STAGE_LABELS = { agents: 'Running Agents…', companions: 'Running Companions…', saving: 'Saving reply…' };
const replyText = (lines, agentLines = 0) => `A live reply.\n\n${'More words in the reply.\n\n'.repeat(lines)}${'Agent tracker line.\n\n'.repeat(agentLines)}`;

async function updatePreview(page, { stage = 'generating', lines = 1, agentLines = 0 } = {}) {
    const text = replyText(lines, agentLines);
    await page.evaluate(({ stage, text }) => window.sendScrollPreview({
        childId: 'reply', name: 'Miso', stage, updatedAt: Date.now(), text,
    }), { stage, text });
    await expect(page.locator('#neconyan-roleplay-preview [role="status"]')).toHaveText(STAGE_LABELS[stage] || 'Writing reply…');
    await expect(page.locator('#neconyan-roleplay-preview .mes_text')).toHaveText(text);
}

// Mirrors the workflow's readback: freeze the preview, hand its place to the
// reload, save the reply and rebuild the chat as reloadCurrentChat() does.
async function finishReply(page, text) {
    const finished = await page.evaluate(async (text) => {
        const chat = document.querySelector('#chat');
        const previewTop = chat.querySelector('#neconyan-roleplay-preview').getBoundingClientRect().top - chat.getBoundingClientRect().top;
        const { keepChatReadingPositionOnNextLoad, printMessages } = await import('/script.js');
        const { finishedReplyReadingAnchor } = await import('/scripts/neconyan-conversation/roleplay-workflows.js');
        window.scrollPreviewStop.freeze();
        keepChatReadingPositionOnNextLoad(finishedReplyReadingAnchor());
        const context = window.SillyTavern.getContext();
        context.chat.push({ name: 'Miso', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: text, extra: {} });
        window.jQuery(chat).children().remove();
        await printMessages();
        window.stopScrollPreview();
        return { previewTop, messageId: String(context.chat.length - 1) };
    }, text);
    // Outlast every chat-load settle pin.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(2800);
    const savedTop = await page.evaluate((messageId) => {
        const chat = document.querySelector('#chat');
        return chat.querySelector(`.mes[mesid="${messageId}"]`).getBoundingClientRect().top - chat.getBoundingClientRect().top;
    }, finished.messageId);
    return { ...finished, savedTop };
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'iPhone Safari emulation' : 'desktop'} Roleplay preview scrolling`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test.beforeEach(async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context);
            await openReadyChat(page);
            if (phone) await applyIOSOnlyCss(page);
            await installSyntheticLongChat(page, { messageCount: 30 });
            // Let initial chat-load pins expire before testing live updates.
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(2800);
            await installPreview(page);
        });

        test.afterEach(async ({ page }) => {
            await page.evaluate(() => window.stopScrollPreview?.());
        });

        test('a live bottom landing supersedes a delayed resize anchor', async ({ page }) => {
            await page.evaluate(async () => {
                const chat = document.querySelector('#chat');
                chat.scrollTop -= 400;
                chat.dispatchEvent(new Event('scroll'));
                const growth = document.createElement('div');
                growth.style.height = '20px';
                chat.querySelector('.mes .mes_block').append(growth);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                // The reader returns to the bottom while the older resize is
                // still settling. The first preview now owns this position.
                chat.scrollTop = chat.scrollHeight;
                window.sendScrollPreview({ childId: 'reply', stage: 'generating', text: 'First words.' });
            });
            await expect(page.locator('#neconyan-roleplay-preview')).toContainText('First words.');
            await waitForAnimationFrames(page, 12);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeLessThanOrEqual(3);
            await updatePreview(page, { stage: 'agents', lines: 12 });
            await waitForAnimationFrames(page, 12);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeLessThanOrEqual(3);
        });

        test('reply growth and the Agents stage keep following without touch', async ({ page }) => {
            await updatePreview(page);
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                window.previewScrollFrames = [];
                window.recordPreviewScroll = true;
                const sample = () => {
                    if (!window.recordPreviewScroll) return;
                    window.previewScrollFrames.push(chat.scrollTop);
                    requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
            for (const stage of ['generating', 'generating', 'agents', 'agents']) {
                await updatePreview(page, { stage, lines: stage === 'agents' ? 18 : 12 });
                await waitForAnimationFrames(page, 4);
                expect((await getChatScrollSnapshot(page)).bottomDelta).toBeLessThanOrEqual(3);
            }
            const reversals = await page.evaluate(() => {
                window.recordPreviewScroll = false;
                return window.previewScrollFrames.filter((top, index, frames) => index && top < frames[index - 1] - 3);
            });
            expect(reversals).toEqual([]);
        });

        test('preview updates respect disabled automatic scrolling', async ({ page }) => {
            await page.evaluate(() => { window.SillyTavern.getContext().powerUserSettings.auto_scroll_chat_to_bottom = false; });
            const before = await getChatScrollSnapshot(page);
            await updatePreview(page, { lines: 12 });
            await waitForAnimationFrames(page, 12);
            expect(Math.abs((await getChatScrollSnapshot(page)).scrollTop - before.scrollTop)).toBeLessThanOrEqual(3);
        });

        test('reading above the reply stays put while Agents run', async ({ page }) => {
            await updatePreview(page, { lines: 12 });
            await markManualMobileScroll(page, 500);
            const before = await getChatScrollSnapshot(page);
            await updatePreview(page, { stage: 'agents', lines: 18 });
            await waitForAnimationFrames(page, 12);
            const after = await getChatScrollSnapshot(page);
            expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(3);
            expect(after.bottomDelta).toBeGreaterThan(120);
        });

        test('finishing a reply keeps the reader where they were reading it', async ({ page }) => {
            await updatePreview(page, { lines: 12 });
            await updatePreview(page, { stage: 'agents', lines: 18 });
            await waitForAnimationFrames(page, 4);
            await markManualMobileScroll(page, (await getChatScrollSnapshot(page)).scrollTop - 250);
            const finished = await finishReply(page, replyText(18, 10));
            expect(Math.abs(finished.savedTop - finished.previewTop)).toBeLessThanOrEqual(4);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeGreaterThan(120);
        });

        test('Agent output after the reply lands below the reader, and saving does not jump to it', async ({ page }) => {
            await updatePreview(page, { lines: 12 });
            await updatePreview(page, { stage: 'agents', lines: 18 });
            await waitForAnimationFrames(page, 4);
            const following = await getChatScrollSnapshot(page);
            expect(following.bottomDelta).toBeLessThanOrEqual(3);
            for (const stage of ['companions', 'saving']) {
                await updatePreview(page, { stage, lines: 18, agentLines: 14 });
                await waitForAnimationFrames(page, 12);
                const after = await getChatScrollSnapshot(page);
                expect(Math.abs(after.scrollTop - following.scrollTop)).toBeLessThanOrEqual(3);
                expect(after.bottomDelta).toBeGreaterThan(120);
            }
            const finished = await finishReply(page, replyText(18, 14));
            expect(Math.abs(finished.savedTop - finished.previewTop)).toBeLessThanOrEqual(4);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeGreaterThan(120);
        });
    });
}

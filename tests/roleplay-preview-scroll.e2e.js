/* global document, requestAnimationFrame, window */
import { expect, test } from '@playwright/test';
import { getChatScrollSnapshot, growMessageBlockAboveViewport, installSyntheticLongChat, markManualMobileScroll, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, IPHONE_SAFARI_CONTEXT, installIPhoneSafari } from './ios-safari-emulation.js';

test.setTimeout(90_000);
test.use({ serviceWorkers: 'block' });

// Keep the real preview renderer, formatter and scroll observers; only replace
// the job's preview event stream so updates can arrive during a pending resize.
async function installPreview(page) {
    await page.evaluate(async () => {
        const originalFetch = window.fetch;
        const encode = text => new TextEncoder().encode(text);
        let current = null;
        let latest = null;
        const enqueue = text => {
            try { current?.enqueue(encode(text)); } catch { current = null; }
        };
        // Like the server: every connection opens with the current snapshot, and a
        // keepalive every second tells the reader the stream is still open.
        window.sendScrollPreview = preview => {
            latest = preview;
            enqueue(`data: ${JSON.stringify({ preview })}\n\n`);
        };
        const keepalive = setInterval(() => enqueue(': keepalive\n\n'), 1000);
        window.fetch = (input, options) => {
            if (!String(input).includes('/api/jobs/scroll-regression/preview')) return originalFetch(input, options);
            let own = null;
            return Promise.resolve(new Response(new ReadableStream({
                start(controller) {
                    own = controller;
                    current = controller;
                    if (latest) controller.enqueue(encode(`data: ${JSON.stringify({ preview: latest })}\n\n`));
                },
                cancel() { if (current === own) current = null; },
            }), { headers: { 'Content-Type': 'text/event-stream' } }));
        };
        const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
        const stop = observeRoleplayPreview('scroll-regression', { account: 'scroll-test', isCurrent: () => true, onTerminal: () => {} });
        window.scrollPreviewStop = stop;
        window.stopScrollPreview = () => {
            stop();
            clearInterval(keepalive);
            window.fetch = originalFetch;
        };
    });
}

const STAGE_LABELS = { agents: 'Running Agents…', companions: 'Running Companions…', saving: 'Saving reply…' };
const replyText = (lines, agentLines = 0) => `A live reply.\n\n${'More words in the reply.\n\n'.repeat(lines)}${'Agent tracker line.\n\n'.repeat(agentLines)}`;
const companionNote = (status, lines = 0) => ({
    probe: {
        agentName: 'Probe Companion',
        status,
        content: status === 'done' ? 'Note line here.\n\n'.repeat(lines) : '',
        updatedAt: new Date().toISOString(),
    },
});
const COMPANION_STATUSES = new Set(['pending', 'done', 'error', 'cancelled']);
const companionStatus = result => COMPANION_STATUSES.has(result?.status) ? result.status : 'done';

// Reply text and stage can match a frame drawn before a same-stage note change,
// and iPhone draws those changes at a 250ms floor. Wait for the requested card
// status and its rendered body before the caller measures geometry.
async function waitForPreviewCompanions(page, companionResults) {
    const preview = page.locator('#neconyan-roleplay-preview');
    const entries = Object.entries(companionResults ?? {}).filter(([, result]) => result && typeof result === 'object');
    if (entries.length === 0) {
        // A preview without notes removes the previous ledger in the same render.
        await expect(preview.locator('.ica--companion-ledger')).toHaveCount(0);
        return;
    }
    for (const [agentId, result] of entries) {
        const status = companionStatus(result);
        const card = preview.locator(`.ica--companion-card[data-agent-id="${agentId}"]`);
        await expect(card).toHaveCount(1);
        await expect(card).toHaveClass(new RegExp(`\\bica--companion-card--${status}\\b`));
        const body = card.locator('.ica--companion-body');
        if (status === 'pending') {
            await expect(body.locator('.ica--companion-pending')).toHaveCount(1);
        } else if (status === 'done') {
            const content = String(result.content ?? '').replace(/\s+/g, ' ').trim();
            if (content) await expect(body).toContainText(content);
            else await expect(body.locator('.ica--companion-empty')).toHaveCount(1);
        } else if (status === 'error') {
            await expect(body.locator('.ica--companion-error')).toContainText(String(result.error || 'Companion run failed.'));
        } else {
            await expect(body.locator('.ica--companion-empty')).toContainText('Companion run was cancelled.');
        }
    }
}

async function updatePreview(page, { stage = 'generating', lines = 1, agentLines = 0, companionResults = null } = {}) {
    const text = replyText(lines, agentLines);
    await page.evaluate(({ stage, text, inChatAgentCompanionResults }) => window.sendScrollPreview({
        childId: 'reply', name: 'Miso', stage, updatedAt: Date.now(), text, inChatAgentCompanionResults,
    }), { stage, text, inChatAgentCompanionResults: companionResults ?? undefined });
    await expect(page.locator('#neconyan-roleplay-preview [role="status"]')).toHaveText(STAGE_LABELS[stage] || 'Writing reply…');
    await expect(page.locator('#neconyan-roleplay-preview .mes_text')).toHaveText(text);
    await waitForPreviewCompanions(page, companionResults);
}

async function previewCompanionDiagnostics(page) {
    return page.evaluate(() => {
        const chat = document.querySelector('#chat');
        const preview = chat.querySelector('#neconyan-roleplay-preview');
        if (!preview) return null;
        const chatTop = chat.getBoundingClientRect().top;
        return {
            previewHeight: Math.round(preview.getBoundingClientRect().height),
            textHeight: Math.round((preview.querySelector('.mes_text') || preview).getBoundingClientRect().height),
            cards: [...preview.querySelectorAll('.ica--companion-card')].map(card => {
                const body = card.querySelector('.ica--companion-body');
                const ledger = card.closest('.ica--companion-ledger');
                return {
                    agentId: card.getAttribute('data-agent-id'),
                    cardClass: card.className,
                    statusText: card.querySelector('.ica--companion-status')?.textContent ?? null,
                    bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : 0,
                    bodyCharacters: body?.textContent?.trim().length ?? 0,
                    ledgerHeight: ledger ? Math.round(ledger.getBoundingClientRect().height) : 0,
                    ledgerTop: ledger ? Math.round(ledger.getBoundingClientRect().top - chatTop) : null,
                };
            }),
        };
    });
}

async function previewMarkerTop(page, selector) {
    return page.evaluate(sel => {
        const chat = document.querySelector('#chat');
        const element = chat.querySelector(sel);
        return element ? Math.round(element.getBoundingClientRect().top - chat.getBoundingClientRect().top) : null;
    }, selector);
}

async function installSavedReplyRoute(page, { text, extra }) {
    const tail = await page.evaluate(({ text: reply, extra: replyExtra }) => {
        const context = window.SillyTavern.getContext();
        return [
            ...context.chat.map(message => structuredClone(message)),
            { name: 'Miso', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: reply, extra: replyExtra },
        ];
    }, { text, extra });
    await page.route('**/api/chats/get', async route => {
        const body = JSON.parse(route.request().postData() || '{}');
        const response = await route.fetch({ postData: JSON.stringify({ ...body, allow_create: true }) });
        const records = await response.json().catch(() => []);
        const header = Array.isArray(records) && records[0] && !('mes' in records[0]) ? records[0] : { chat_metadata: {} };
        const headers = { ...response.headers() };
        delete headers['content-length'];
        delete headers['content-encoding'];
        await route.fulfill({ status: 200, headers, body: JSON.stringify([header, ...tail]) });
    });
    return tail.length - 1;
}

// Keep CHAT_CHANGED pending while late content appears below the saved notes,
// optionally starting a new Send and its intentional bottom landing first.
async function installHandoverGrowth(page, { selector, delayMs = 120, height = 240, jobId = null } = {}) {
    await page.evaluate(({ selector: targetSelector, delayMs: waitMs, height: growthHeight, jobId: nextJobId }) => {
        const context = window.SillyTavern.getContext();
        const handler = async () => {
            await new Promise(resolve => setTimeout(resolve, waitMs));
            if (nextJobId) {
                const { setRoleplayJobControls } = await import('/script.js');
                setRoleplayJobControls(nextJobId, () => {});
                context.scrollChatToBottom({ force: true });
                // Let the new Send's forced bottom paint before late media arrives.
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
            const chat = document.querySelector('#chat');
            const target = chat.querySelector(targetSelector);
            if (!target) throw new Error(`No saved growth target: ${targetSelector}`);
            const growth = document.createElement('div');
            growth.className = 'handover-late-media';
            growth.style.height = `${growthHeight}px`;
            growth.style.margin = '8px 0';
            growth.style.width = '100%';
            target.append(growth);
        };
        context.eventSource.on(context.event_types.CHAT_CHANGED, handler);
    }, { selector, delayMs, height, jobId });
}

async function recordScrollFrames(page) {
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        window.savedReplyFrames = [];
        window.recordSavedReplyScroll = true;
        const sample = () => {
            if (!window.recordSavedReplyScroll) return;
            window.savedReplyFrames.push(chat.scrollTop);
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
}

async function stopScrollFrames(page) {
    return page.evaluate(() => {
        window.recordSavedReplyScroll = false;
        return window.savedReplyFrames;
    });
}

async function startActiveSavedReply(page) {
    await page.evaluate(async () => {
        const { setRoleplayJobControls } = await import('/script.js');
        setRoleplayJobControls('scroll-regression', () => {});
    });
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.scrollTop = chat.scrollHeight;
        chat.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 6);
}

async function startMarkerPostPaint(page, messageId) {
    await page.evaluate((savedId) => {
        const chat = document.querySelector('#chat');
        const read = () => {
            const saved = chat.querySelector(`.mes[mesid="${savedId}"]`);
            const preview = chat.querySelector('#neconyan-roleplay-preview');
            const text = (saved || preview)?.querySelector('.mes_text');
            const ledger = (saved || preview)?.querySelector('.ica--companion-ledger');
            const chatTop = chat.getBoundingClientRect().top;
            return {
                text: text ? text.getBoundingClientRect().top - chatTop : null,
                ledger: ledger ? ledger.getBoundingClientRect().top - chatTop : null,
            };
        };
        window.handoverMarkerInitial = read();
        window.handoverMarkerSamples = [];
        window.recordHandoverMarkers = true;
        const channel = new MessageChannel();
        const schedule = () => {
            if (!window.recordHandoverMarkers) return;
            requestAnimationFrame(() => channel.port2.postMessage(0));
        };
        channel.port1.onmessage = () => {
            if (!window.recordHandoverMarkers) return;
            window.handoverMarkerSamples.push(read());
            schedule();
        };
        window.stopHandoverMarkerSampler = () => {
            window.recordHandoverMarkers = false;
            channel.port1.close();
            channel.port2.close();
        };
        schedule();
    }, messageId);
}

async function stopMarkerPostPaint(page) {
    return page.evaluate(() => {
        window.stopHandoverMarkerSampler?.();
        return { initial: window.handoverMarkerInitial, samples: window.handoverMarkerSamples };
    });
}

function expectMarkerStable(marker) {
    expect(marker.initial.text).not.toBeNull();
    expect(marker.initial.ledger).not.toBeNull();
    expect(marker.samples.length).toBeGreaterThan(0);
    expect(marker.samples.every(sample => Number.isFinite(sample.text) && Number.isFinite(sample.ledger))).toBe(true);
    const shifts = key => marker.samples.map(sample => Math.abs(sample[key] - marker.initial[key]));
    const textShifts = shifts('text');
    const ledgerShifts = shifts('ledger');
    expect(textShifts.length).toBeGreaterThan(0);
    expect(ledgerShifts.length).toBeGreaterThan(0);
    expect(Math.max(...textShifts)).toBeLessThanOrEqual(4);
    expect(Math.max(...ledgerShifts)).toBeLessThanOrEqual(4);
}

// Mirrors the workflow's readback: freeze the preview, hand its place to the
// reload, save the reply and rebuild the chat as reloadCurrentChat() does.
async function finishReply(page, text) {
    const finished = await page.evaluate(async (text) => {
        const chat = document.querySelector('#chat');
        const preview = chat.querySelector('#neconyan-roleplay-preview');
        const previewTop = (preview.querySelector('.mes_text') || preview).getBoundingClientRect().top - chat.getBoundingClientRect().top;
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
        const message = chat.querySelector(`.mes[mesid="${messageId}"]`);
        return (message.querySelector('.mes_text') || message).getBoundingClientRect().top - chat.getBoundingClientRect().top;
    }, finished.messageId);
    return { ...finished, savedTop };
}

// Uses the real saved-copy handover: the server read replaces the preview in the
// same atomic render that saves the reply, with its Companion notes already on it.
async function finishSavedReply(page, messageId, { clearJob = true } = {}) {
    const finished = await page.evaluate(async ({ clearJob: shouldClearJob }) => {
        const chat = document.querySelector('#chat');
        const preview = chat.querySelector('#neconyan-roleplay-preview');
        if (!preview) throw new Error('No live preview to save.');
        const previewTextTop = (preview.querySelector('.mes_text') || preview).getBoundingClientRect().top - chat.getBoundingClientRect().top;
        const { keepChatReadingPositionOnNextLoad, refreshCurrentChatFromSaved, setRoleplayJobControls } = await import('/script.js');
        const { finishedReplyReadingAnchor } = await import('/scripts/neconyan-conversation/roleplay-workflows.js');
        // The server owns Send/Stop until the saved readback has finished, so a
        // real handover starts its hold while is_send_press is still true.
        setRoleplayJobControls('scroll-regression', () => {});
        window.scrollPreviewStop.freeze();
        keepChatReadingPositionOnNextLoad(finishedReplyReadingAnchor());
        try {
            await refreshCurrentChatFromSaved();
        } finally {
            keepChatReadingPositionOnNextLoad(null);
            if (shouldClearJob) setRoleplayJobControls(null);
            window.stopScrollPreview();
        }
        return { previewTextTop };
    }, { clearJob });
    // Outlast every chat-load settle pin and the reading-anchor hold.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(3000);
    const savedTextTop = await previewMarkerTop(page, `.mes[mesid="${messageId}"] .mes_text`);
    return { ...finished, savedTextTop };
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
            await page.evaluate(async () => {
                window.stopScrollPreview?.();
                const { setRoleplayJobControls } = await import('/script.js');
                setRoleplayJobControls(null);
            });
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

        test('Companion notes during the Agents stage stop following without moving the reply', async ({ page }) => {
            await updatePreview(page, { stage: 'agents', lines: 12 });
            await waitForAnimationFrames(page, 4);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeLessThanOrEqual(3);
            const textBefore = await previewMarkerTop(page, '#neconyan-roleplay-preview .mes_text');

            await updatePreview(page, { stage: 'agents', lines: 12, companionResults: companionNote('pending') });
            await expect(page.locator('#neconyan-roleplay-preview .ica--companion-ledger')).toHaveCount(1);
            await waitForAnimationFrames(page, 4);
            await updatePreview(page, { stage: 'agents', lines: 12, companionResults: companionNote('done', 30) });
            await waitForAnimationFrames(page, 8);

            const textAfter = await previewMarkerTop(page, '#neconyan-roleplay-preview .mes_text');
            const after = await getChatScrollSnapshot(page);
            await test.info().attach('preview-companion-measurement', {
                body: JSON.stringify({
                    textBefore, textAfter, scroll: after,
                    companion: await previewCompanionDiagnostics(page),
                }),
                contentType: 'application/json',
            });
            expect(Math.abs(textAfter - textBefore)).toBeLessThanOrEqual(3);
            expect(after.bottomDelta).toBeGreaterThan(120);
        });

        test('older message growth after Companion notes does not pin the preview', async ({ page }) => {
            await updatePreview(page, { stage: 'generating', lines: 12 });
            await waitForAnimationFrames(page, 4);
            const olderId = await page.evaluate(() => window.SillyTavern.getContext().chat.length - 1);
            await updatePreview(page, { stage: 'agents', lines: 12, companionResults: companionNote('pending') });
            await updatePreview(page, { stage: 'agents', lines: 12, companionResults: companionNote('done', 30) });
            await waitForAnimationFrames(page, 8);

            const textBefore = await previewMarkerTop(page, '#neconyan-roleplay-preview .mes_text');
            const olderHeightBefore = await page.evaluate(id => document.querySelector(`#chat .mes[mesid="${id}"]`).getBoundingClientRect().height, olderId);
            await growMessageBlockAboveViewport(page, olderId, { height: 120 });
            await waitForAnimationFrames(page, 6);

            const textAfter = await previewMarkerTop(page, '#neconyan-roleplay-preview .mes_text');
            const olderHeightAfter = await page.evaluate(id => document.querySelector(`#chat .mes[mesid="${id}"]`).getBoundingClientRect().height, olderId);
            const measuredAdded = olderHeightAfter - olderHeightBefore;
            const after = await getChatScrollSnapshot(page);
            expect(measuredAdded).toBeGreaterThanOrEqual(120);
            expect(after.bottomDelta).toBeGreaterThan(120);
            const textMovement = textAfter - textBefore;
            expect(textMovement).toBeGreaterThanOrEqual(-4);
            expect(textMovement).toBeLessThanOrEqual(measuredAdded + 4);
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

        test('saving a reply through the server handover keeps its text and notes in place', async ({ page }) => {
            await startActiveSavedReply(page);
            await updatePreview(page, { stage: 'agents', lines: 12 });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('pending') });
            await expect(page.locator('#neconyan-roleplay-preview .ica--companion-ledger')).toHaveCount(1);
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('done', 30) });
            await waitForAnimationFrames(page, 8);
            const messageId = await installSavedReplyRoute(page, {
                text: replyText(18),
                extra: { inChatAgentCompanionResults: companionNote('done', 30) },
            });
            await recordScrollFrames(page);
            await startMarkerPostPaint(page, messageId);
            const finished = await finishSavedReply(page, messageId);
            const marker = await stopMarkerPostPaint(page);
            const frames = await stopScrollFrames(page);
            await test.info().attach('handover-reply-raw-scroll', {
                body: JSON.stringify({ frames, marker, previewTextTop: finished.previewTextTop, savedTextTop: finished.savedTextTop }),
                contentType: 'application/json',
            });

            expect(finished.previewTextTop).not.toBeNull();
            expect(finished.savedTextTop).not.toBeNull();
            expect(Math.abs(finished.savedTextTop - finished.previewTextTop)).toBeLessThanOrEqual(4);
            expectMarkerStable(marker);
            await expect(page.locator(`.mes[mesid="${messageId}"] .ica--companion-ledger`)).toHaveCount(1);
        });

        test('scrolling into the notes before the server handover does not jump back', async ({ page }) => {
            await startActiveSavedReply(page);
            await updatePreview(page, { stage: 'agents', lines: 12 });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('pending') });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('done', 30) });
            await expect(page.locator('#neconyan-roleplay-preview .ica--companion-ledger')).toHaveCount(1);
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                chat.scrollTop = chat.scrollHeight;
                chat.dispatchEvent(new Event('scroll'));
            });
            await waitForAnimationFrames(page, 6);

            const textBefore = await previewMarkerTop(page, '#neconyan-roleplay-preview .mes_text');
            const ledgerBefore = await previewMarkerTop(page, '#neconyan-roleplay-preview .ica--companion-ledger');
            const messageId = await installSavedReplyRoute(page, {
                text: replyText(18),
                extra: { inChatAgentCompanionResults: companionNote('done', 30) },
            });
            await recordScrollFrames(page);
            await startMarkerPostPaint(page, messageId);
            const finished = await finishSavedReply(page, messageId);
            const marker = await stopMarkerPostPaint(page);
            const frames = await stopScrollFrames(page);
            await test.info().attach('handover-notes-raw-scroll', {
                body: JSON.stringify({ frames, marker, previewTextTop: finished.previewTextTop, savedTextTop: finished.savedTextTop }),
                contentType: 'application/json',
            });

            const textAfter = await previewMarkerTop(page, `.mes[mesid="${messageId}"] .mes_text`);
            const ledgerAfter = await previewMarkerTop(page, `.mes[mesid="${messageId}"] .ica--companion-ledger`);
            expect(Math.abs(finished.savedTextTop - finished.previewTextTop)).toBeLessThanOrEqual(4);
            expect(Math.abs(textAfter - textBefore)).toBeLessThanOrEqual(4);
            expect(Math.abs(ledgerAfter - ledgerBefore)).toBeLessThanOrEqual(4);
            expectMarkerStable(marker);
        });

        test('a late resize during the saved readback keeps the held notes', async ({ page }) => {
            await startActiveSavedReply(page);
            await updatePreview(page, { stage: 'agents', lines: 12 });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('pending') });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('done', 30) });
            await expect(page.locator('#neconyan-roleplay-preview .ica--companion-ledger')).toHaveCount(1);
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                chat.scrollTop = chat.scrollHeight;
                chat.dispatchEvent(new Event('scroll'));
            });
            await waitForAnimationFrames(page, 6);

            const textBefore = await previewMarkerTop(page, '#neconyan-roleplay-preview .mes_text');
            const ledgerBefore = await previewMarkerTop(page, '#neconyan-roleplay-preview .ica--companion-ledger');
            const messageId = await installSavedReplyRoute(page, {
                text: replyText(18),
                extra: { inChatAgentCompanionResults: companionNote('done', 30) },
            });
            await installHandoverGrowth(page, { selector: `.mes[mesid="${messageId}"] .mes_block`, delayMs: 120, height: 240 });
            const finished = await finishSavedReply(page, messageId);

            const textAfter = await previewMarkerTop(page, `.mes[mesid="${messageId}"] .mes_text`);
            const ledgerAfter = await previewMarkerTop(page, `.mes[mesid="${messageId}"] .ica--companion-ledger`);
            expect(Math.abs(finished.savedTextTop - finished.previewTextTop)).toBeLessThanOrEqual(4);
            expect(Math.abs(textAfter - textBefore)).toBeLessThanOrEqual(4);
            expect(Math.abs(ledgerAfter - ledgerBefore)).toBeLessThanOrEqual(4);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeGreaterThanOrEqual(224);
        });

        test('a new Send during the saved readback releases the held notes', async ({ page }) => {
            await startActiveSavedReply(page);
            await updatePreview(page, { stage: 'agents', lines: 12 });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('pending') });
            await updatePreview(page, { stage: 'agents', lines: 18, companionResults: companionNote('done', 30) });
            await expect(page.locator('#neconyan-roleplay-preview .ica--companion-ledger')).toHaveCount(1);
            await waitForAnimationFrames(page, 6);
            expect((await getChatScrollSnapshot(page)).bottomDelta).toBeGreaterThan(120);

            const messageId = await installSavedReplyRoute(page, {
                text: replyText(18),
                extra: { inChatAgentCompanionResults: companionNote('done', 30) },
            });
            await installHandoverGrowth(page, { selector: `.mes[mesid="${messageId}"] .mes_block`, delayMs: 120, height: 240, jobId: 'next-roleplay' });
            await finishSavedReply(page, messageId, { clearJob: false });

            const after = await getChatScrollSnapshot(page);
            expect(after.bottomDelta).toBeLessThanOrEqual(16);
        });
    });
}

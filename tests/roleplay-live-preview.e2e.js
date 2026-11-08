/* global window, document, requestAnimationFrame, getComputedStyle, WheelEvent */
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
    test(`server preview strips empty tracker lines before balancing Markdown on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        const raw = '*The reply is still arriving.\ntracker-none\nPHONE_NONE';
        await page.evaluate(text => window.sendLivePreview({ childId: 'reply', stage: 'generating', text }), raw);
        const body = page.locator('#neconyan-roleplay-preview .mes_text');
        await expect(body).toContainText('The reply is still arriving.');
        await page.screenshot({ path: `../screenshots/server-sentinel-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        await expect(body).not.toContainText(/tracker-none|PHONE_NONE/);
        expect(await page.evaluate(() => window.stopLivePreview.reply().text)).toBe(raw);
        await page.evaluate(() => window.sendLivePreviewDelta({ text: '\nThe words tracker-none remain in ordinary prose.' }));
        await expect(body).toContainText('The words tracker-none remain in ordinary prose.');
        await page.evaluate(async () => {
            const { buildRegexScriptRefsForAgent } = await import('/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
            const scripts = [{ id: 'live-display', findRegex: '/^CUSTOM_EMPTY$/gm', replaceString: '', placement: [2], markdownOnly: true }];
            window.sendLivePreview({ childId: 'reply', stage: 'agents', text: '*An unfinished sentence.\nCUSTOM_EMPTY',
                inChatAgents: { activeAgentIds: ['tracker'], edited: false, generationType: 'normal',
                    regexScriptRefs: buildRegexScriptRefsForAgent('tracker', scripts),
                    nativeRegexScripts: scripts.map(script => ({ agentId: 'tracker', script })) } });
        });
        await expect(body).toContainText('An unfinished sentence.');
        await expect(body).not.toContainText('CUSTOM_EMPTY');
        await page.evaluate(() => window.stopLivePreview());
    });

    test(`Agent preview updates do not take over an active scroll near the bottom on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await installSyntheticLongChat(page, { messageCount: 12 });
        await page.evaluate(() => window.sendLivePreview({ childId: 'reply', stage: 'agents', text: 'The reply.\n'.repeat(60) }));
        await expect(page.locator('#neconyan-roleplay-preview')).toContainText('The reply.');
        // Let the synthetic chat's initial-load bottom lock expire.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(2800);
        const shifts = await page.evaluate(async () => {
            const chat = document.querySelector('#chat');
            const shifts = [];
            for (let index = 0; index < 8; index++) {
                chat.scrollTop = chat.scrollHeight - chat.clientHeight - 70;
                chat.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -12 }));
                chat.dispatchEvent(new Event('scroll', { bubbles: true }));
                const before = chat.scrollTop;
                window.sendLivePreview({ childId: 'reply', stage: 'agents', text: `${'The reply.\n'.repeat(60)}Agent progress ${index}` });
                await new Promise(resolve => setTimeout(resolve, 250));
                shifts.push(chat.scrollTop - before);
            }
            return shifts;
        });
        expect(Math.max(...shifts.map(Math.abs)), JSON.stringify(shifts)).toBeLessThan(3);
        await page.evaluate(() => window.stopLivePreview());
    });

    test(`server swipe reserves the old reply while the new reply starts on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await installSyntheticLongChat(page, { messageCount: 12 });
        await page.evaluate(async () => {
            const core = await import('/script.js');
            core.chat[11].mes = 'The previous long reply.\n'.repeat(100);
            core.updateMessageBlock(11, core.chat[11]);
        });
        await expect(page.locator('#chat .mes[mesid="11"] .mes_text')).toContainText('The previous long reply.');
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(2800);
        const before = await page.evaluate(async () => {
            const chat = document.querySelector('#chat');
            chat.scrollTop = chat.scrollHeight;
            await new Promise(resolve => requestAnimationFrame(resolve));
            return chat.scrollTop;
        });
        await page.evaluate(async () => {
            window.stopLivePreview();
            const { beginRoleplayReplacement } = await import('/scripts/neconyan-conversation/roleplay-replacement.js');
            window.restoreSwipeSource = beginRoleplayReplacement('roleplay.swipe', 11, () => true);
            const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
            window.stopLivePreview = observeRoleplayPreview('live-preview-fixture', {
                account: 'test', isCurrent: () => true, onTerminal() {}, name: 'roleplay.swipe', messageIndex: 11,
            });
        });
        const waiting = await page.locator('#chat').evaluate(chat => chat.scrollTop);
        await page.evaluate(() => window.sendLivePreview({ childId: 'swipe', stage: 'generating', text: 'The new swipe starts here.' }));
        const body = page.locator('#neconyan-roleplay-preview .mes_text');
        await expect(body).toHaveText('The new swipe starts here.');
        await page.screenshot({ path: `../screenshots/server-swipe-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        const bottomGap = await page.locator('#chat').evaluate(chat => chat.scrollHeight - chat.clientHeight - chat.scrollTop);
        expect(Math.abs(waiting - before), 'waiting must not collapse the old reply').toBeLessThan(3);
        expect(bottomGap, 'first tokens must stay at the bottom, not above the new reply').toBeLessThan(3);
        await expect(page.locator('#chat .mes[mesid="11"]')).toHaveCount(0);
        await expect(body).toBeInViewport();
        await page.evaluate(() => { window.stopLivePreview(); window.restoreSwipeSource(); });
    });

    test(`server preview shows Thinking without traces and clears it on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await page.evaluate(() => window.sendLivePreview({ childId: 'reply', stage: 'generating', text: '' }));
        const preview = page.locator('#neconyan-roleplay-preview');
        await expect(preview).toBeVisible();
        const indicator = preview.locator('.neconyan-streaming-thinking');
        await expect(indicator).toHaveText('Thinking...');
        await expect(indicator).toBeVisible();
        await page.evaluate(() => window.sendLivePreviewDelta({ text: 'The first words.' }));
        await expect(preview.locator('.mes_text')).toHaveText('The first words.');
        await expect(indicator).toHaveCount(0);
        await page.evaluate(() => window.sendLivePreview({ childId: 'next', stage: 'generating', text: '' }));
        await expect(indicator).toBeVisible();
        await page.evaluate(() => window.stopLivePreview.freeze());
        await expect(indicator).toHaveCount(0);
        await page.evaluate(() => window.stopLivePreview());
    });

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
            window.previewDrawTimes = [];
            document.addEventListener('neconyan:roleplay-preview-rendered', () => {
                window.drawCount++;
                window.previewDrawTimes.push(performance.now());
            });
            window.sendLivePreview({ childId: 'reply', stage: 'generating', text: 'Start', gen_started: new Date().toISOString() });
        });
        const preview = page.locator('#neconyan-roleplay-preview');
        await expect(preview).toContainText('Start');
        // Two seconds of 100ms appends, delivered as the server's delta frames.
        await page.evaluate(async () => {
            window.previewAppendsStartedAt = performance.now();
            for (let index = 0; index < 20; index++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                window.sendLivePreviewDelta({ text: ` token${index}`, set: { updatedAt: Date.now() } });
            }
        });
        await expect(preview).toContainText('token19');
        await expect(preview).toContainText('token9 token10', { timeout: 2000 });
        const { draws, times, elapsed } = await page.evaluate(() => ({ draws: window.drawCount,
            times: window.previewDrawTimes, elapsed: performance.now() - window.previewAppendsStartedAt }));
        expect(draws, `full redraws over 2s of 100ms updates: ${draws}`).toBeGreaterThanOrEqual(phone ? 5 : 8);
        // The phone's conservative streaming floor must hold: deltas redraw on the
        // cadence, not once per arriving append.
        expect(draws, `full redraws: ${draws}, elapsed: ${elapsed}ms, times: ${JSON.stringify(times)}`).toBeLessThanOrEqual(phone ? 14 : Infinity);
        const connections = await page.evaluate(() => window.previewConnections);
        expect(connections, 'appended deltas never force a reconnect').toBe(1);
        expect(await page.evaluate(() => window.previewFramesQuery), 'the observer opts into delta frames').toBe('delta');
        await page.evaluate(() => window.stopLivePreview());
    });

    test(`a preview that arrives before saved messages render stays after them on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await page.evaluate(async text => {
            document.querySelector('#chat').replaceChildren();
            const core = await import('/script.js');
            core.chat.splice(0, core.chat.length);
            window.sendLivePreview({ childId: 'reply', stage: 'generating', text, gen_started: new Date().toISOString() });
        }, reply);
        await expect(page.locator('#neconyan-roleplay-preview')).toContainText(reply);

        // A reload draws the saved chat after the resumed preview is already on
        // screen. The greeting must stay first and the draft must follow the last row.
        await page.evaluate(async () => {
            const core = await import('/script.js');
            core.chat.splice(0, core.chat.length,
                { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {}, send_date: new Date().toISOString() },
                { name: 'User', is_user: true, mes: 'Retained question.', extra: {}, send_date: new Date().toISOString() });
            await core.printMessages();
        });
        await expect.poll(() => page.evaluate(() => {
            const rows = [...document.querySelectorAll('#chat .mes')];
            const preview = document.querySelector('#neconyan-roleplay-preview');
            return rows.length === 3 && rows[0].textContent.includes('Retained answer.')
                && rows[1].textContent.includes('Retained question.') && rows[2] === preview;
        })).toBe(true);
        await expect(page.locator('#neconyan-roleplay-preview')).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`preview-order-${viewport}.png`), scale: 'css' });
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

    test(`aggressive unloading keeps the finished reply at the reading position on ${viewport}`, async ({ app }) => {
        const page = await openPreview(app, phone);
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().powerUserSettings;
            settings.aggressive_dom_unload = true;
            settings.aggressive_dom_window_size = 5;
        });
        await installSyntheticLongChat(page, { messageCount: 30, visibleCount: 5 });
        const text = `${reply}\n\n${'A long reply should stay where I am reading it.\n\n'.repeat(40)}`;
        await page.evaluate(text => window.sendLivePreview({ childId: 'reply', stage: 'saving', text }), text);
        await expect(page.locator('#neconyan-roleplay-preview')).toContainText(reply);
        const saved = await page.evaluate(async text => {
            const core = await import('/script.js');
            return [{ chat_metadata: core.chat_metadata }, ...core.chat.map(message => ({ ...message, extra: { ...message.extra, refreshed: true } })),
                { name: 'Durable Nova', is_user: false, mes: text, extra: {} }];
        }, text);
        await page.route('**/api/chats/get', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, json: saved });
        });
        const before = await page.evaluate(async () => {
            const chat = document.querySelector('#chat');
            const preview = document.querySelector('#neconyan-roleplay-preview .mes_text');
            chat.dispatchEvent(new Event('touchstart', { bubbles: true }));
            chat.dispatchEvent(new Event('wheel', { bubbles: true }));
            chat.scrollTop += preview.getBoundingClientRect().top - chat.getBoundingClientRect().top - 20;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const { finishedReplyReadingAnchor } = await import('/scripts/neconyan-conversation/roleplay-workflows.js');
            const { keepChatReadingPositionOnNextLoad, refreshCurrentChatFromSaved } = await import('/script.js');
            const anchor = finishedReplyReadingAnchor();
            const distanceFromBottom = chat.scrollHeight - chat.clientHeight - chat.scrollTop;
            window.stopLivePreview.freeze();
            keepChatReadingPositionOnNextLoad(anchor);
            await refreshCurrentChatFromSaved();
            window.stopLivePreview();
            return { offsetTop: anchor.offsetTop, distanceFromBottom };
        });
        await page.screenshot({ path: `../screenshots/completed-reply-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        expect(before.distanceFromBottom).toBeGreaterThan(500);
        await expect(page.locator('#chat .mes[mesid="30"]')).toContainText(reply);
        await expect(page.locator('#chat .mes[mesid]')).toHaveCount(5);
        await expect(page.locator('#neconyan-roleplay-preview, #show_newer_messages')).toHaveCount(0);
        const after = await page.locator('#chat .mes[mesid="30"] .mes_text').evaluate(element => {
            const chat = document.querySelector('#chat');
            return { offsetTop: element.getBoundingClientRect().top - chat.getBoundingClientRect().top,
                display: getComputedStyle(element).display, height: element.getBoundingClientRect().height };
        });
        expect(Math.abs(after.offsetTop - before.offsetTop)).toBeLessThan(3);
        expect(after.display).not.toBe('none');
        expect(after.height).toBeGreaterThan(500);
    });
}

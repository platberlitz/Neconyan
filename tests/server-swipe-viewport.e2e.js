/* global document, window, requestAnimationFrame, WheelEvent */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const paragraphs = (label, count) => Array.from(
    { length: count },
    (_, index) => `${label} paragraph ${index} with enough words to wrap across the phone screen at least once or twice.`,
).join('\n\n');

const LONG_OLD = paragraphs('Old', 30);
const SHORT_OLD = 'Short old reply first paragraph.\n\nShort old reply second paragraph.';

async function createSwipeChat(account, name, oldReply) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const source = await account.context.request.post('/api/chats/get', {
        headers: account.headers,
        data: { ...fields, allow_create: true },
    });
    const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
    const history = Array.from({ length: 12 }, (_, index) => ({
        name: index % 2 ? 'Durable Nova' : 'User',
        is_user: index % 2 === 0,
        mes: paragraphs(`History ${index}`, 3),
        extra: {},
    }));
    history[history.length - 1] = { name: 'User', is_user: true, mes: 'Please continue the story.', extra: {} };
    await account.post('/api/chats/save', {
        ...fields,
        chat: [
            { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
            ...history,
            { name: 'Durable Nova', is_user: false, mes: oldReply, extra: {}, swipes: ['An older alternative.', oldReply], swipe_id: 1 },
        ],
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
    });
    return fields;
}

async function setupSwipeFixture(app, { phone, chatName, oldReply, mainReply, postReply, companionReply }) {
    const holdModels = ['post-held', 'companion-held'];
    const lines = mainReply.split('\n\n');
    app.provider.mode.hold = [...holdModels];
    app.provider.mode.reply = body => {
        app.provider.mode.hold = [...holdModels];
        const content = body.model === MODEL
            ? mainReply
            : body.model === 'post-held' ? postReply : companionReply;
        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] };
    };
    app.provider.mode.streamReply = () => ({ first: lines[0], rest: '' });

    const account = await app.account({
        phone,
        activeConnection: true,
        contextOptions: phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } },
        configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
            saved.power_user.auto_swipe = false;
            saved.power_user.auto_continue = { enabled: false };
            saved.extension_settings.connectionManager.profiles.push(
                { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-held', 'api-url': app.provider.url },
                { id: 'companion', name: 'Companion fixture', api: 'custom', mode: 'cc', model: 'companion-held', 'api-url': app.provider.url },
            );
            saved.extension_settings.inChatAgents = {
                globalSettings: {
                    enabled: true,
                    separateRecentChats: false,
                    trackerCompanionAutoLoopVersion: 4,
                    connectionProfile: 'post',
                    companionExecutionMode: 'parallel',
                    companionConcurrentWithPostGen: false,
                },
            };
        },
    });
    if (phone) await installIPhoneSafari(account.context);

    const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
    await fs.mkdir(directory, { recursive: true });
    for (const agent of [
        {
            id: 'post',
            name: 'Post Gen',
            enabled: true,
            phase: 'post',
            prompt: 'Revise the reply.',
            connectionProfile: 'post',
            postProcess: { enabled: false, promptTransformEnabled: true },
        },
        {
            id: 'companion',
            name: 'Story Companion',
            enabled: true,
            category: 'companion',
            execution: 'companion',
            prompt: 'Write a note about the reply.',
            connectionProfile: 'companion',
            companion: { trigger: 'auto', displayMode: 'card' },
        },
    ]) {
        await fs.writeFile(path.join(directory, `${agent.id}.json`), JSON.stringify(agent));
    }

    await createSwipeChat(account, chatName, oldReply);
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    if (phone) await applyIOSOnlyCss(page);
    await page.evaluate(async ({ avatar, name }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        if (core.getCurrentChatId() !== name) await core.openCharacterChat(name);
    }, { avatar: account.avatar, name: chatName });
    await expect(page.locator('#chat .mes[mesid]').last()).toContainText(lines.length > 1 ? oldReply.split('\n\n').at(-1) : oldReply);
    await acknowledgeActiveSettings(page);
    expect(await page.evaluate(async () => (await import('/script.js')).saveChatConditional({ throwOnError: true }))).toBe(true);
    // Let initial chat-load settle pins expire before measuring swipe geometry.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(2800);
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.scrollTop = chat.scrollHeight;
    });
    await waitForPostPaintFrames(page, 3);
    return { account, page, remainingStreamParagraphs: lines.slice(1) };
}

async function waitForPostPaintFrames(page, count = 2) {
    await page.evaluate(total => new Promise(resolve => {
        let remaining = total;
        const channel = new MessageChannel();
        const next = () => requestAnimationFrame(() => channel.port2.postMessage(0));
        channel.port1.onmessage = () => {
            if (--remaining <= 0) {
                channel.port1.close();
                channel.port2.close();
                resolve();
                return;
            }
            next();
        };
        next();
    }), count);
}

async function startPostPaintSampler(page) {
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        window.viewportSamples = [];
        window.viewportTargetParagraphIndex = null;
        window.viewportSampling = true;
        const read = () => {
            const box = chat.getBoundingClientRect();
            const rows = [...chat.querySelectorAll(':scope > .mes')];
            const tail = rows.at(-1);
            const user = rows.filter(row => row.getAttribute('is_user') === 'true').at(-1);
            const userRect = user?.getBoundingClientRect();
            const tailRect = tail?.getBoundingClientRect();
            const targetIndex = window.viewportTargetParagraphIndex;
            const paragraph = Number.isInteger(targetIndex)
                ? tail?.querySelectorAll('.mes_text > p')?.[targetIndex] ?? null
                : null;
            return {
                scrollTop: chat.scrollTop,
                scrollHeight: chat.scrollHeight,
                clientHeight: chat.clientHeight,
                gap: chat.scrollHeight - chat.scrollTop - chat.clientHeight,
                tailId: tail?.id || tail?.getAttribute('mesid') || null,
                hasReplacementMarker: Boolean(chat.querySelector('[data-roleplay-replacement]')),
                tailTop: tailRect ? tailRect.top - box.top : null,
                tailHeight: tailRect ? tailRect.height : null,
                tailMinHeight: tail?.style?.minHeight || '',
                userTop: userRect ? userRect.top - box.top : null,
                userBottom: userRect ? userRect.bottom - box.top : null,
                stage: document.querySelector('#neconyan-roleplay-preview [role="status"]')?.textContent || '',
                targetParagraphTop: paragraph ? paragraph.getBoundingClientRect().top - box.top : null,
            };
        };
        window.readViewportSample = read;
        const channel = new MessageChannel();
        const schedule = () => {
            if (!window.viewportSampling) return;
            requestAnimationFrame(() => channel.port2.postMessage(0));
        };
        channel.port1.onmessage = () => {
            if (!window.viewportSampling) return;
            window.viewportSamples.push(read());
            schedule();
        };
        window.stopViewportSampler = () => {
            window.viewportSampling = false;
            channel.port1.close();
            channel.port2.close();
            return window.viewportSamples;
        };
        window.viewportSamples.push(read());
        schedule();
    });
}

async function stopPostPaintSampler(page) {
    return page.evaluate(() => window.stopViewportSampler());
}

function findBeforeSwapSample(samples, firstPreviewIndex) {
    return samples.slice(0, firstPreviewIndex).findLast(sample => sample.hasReplacementMarker)
        ?? samples[firstPreviewIndex - 1];
}

async function streamAndCompleteJob(app, account, page, remainingParagraphs, { onBeforeStreamEnd } = {}) {
    const submitted = page.waitForResponse(
        response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409,
    );
    await startNativeReply(page, 'swipe');
    const { jobId } = await (await submitted).json();

    await expect.poll(() => app.provider.calls.length, { timeout: 40000 }).toBe(1);
    await expect.poll(() => typeof app.provider.mode.finishStream, { timeout: 20000 }).toBe('function');
    for (const paragraph of remainingParagraphs) {
        app.provider.mode.writeStream(`\n\n${paragraph}`);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(80);
    }
    await waitForPostPaintFrames(page, 3);
    if (onBeforeStreamEnd) await onBeforeStreamEnd();
    app.provider.mode.finishStream();

    for (const call of [2, 3]) {
        await expect.poll(() => app.provider.calls.length, { timeout: 40000 }).toBe(call);
        await waitForPostPaintFrames(page, 4);
        await app.release();
    }

    await account.settled(jobId);
    await expect(page.locator('#neconyan-roleplay-preview')).toHaveCount(0);
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`long old reply swipe starts at the top and stays steady through handover on ${viewport}`, async ({ app }) => {
        test.setTimeout(240000);
        const mainReply = paragraphs('New', 30);
        const postReply = mainReply.replace(
            'New paragraph 1 ',
            'Revised paragraph 1 with an extra inserted sentence that makes it longer than before. ',
        );
        const companionReply = 'A Companion note.\n\n- one\n- two\n- three\n- four';
        const { account, page, remainingStreamParagraphs } = await setupSwipeFixture(app, {
            phone,
            chatName: `Swipe steady long ${viewport}`,
            oldReply: LONG_OLD,
            mainReply,
            postReply,
            companionReply,
        });

        await startPostPaintSampler(page);
        await streamAndCompleteJob(app, account, page, remainingStreamParagraphs);
        // Outlast every reload hold and settle timer for 3 s after handover.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(3000);
        const samples = await stopPostPaintSampler(page);

        const firstPreviewIndex = samples.findIndex(sample => sample.tailId === 'neconyan-roleplay-preview');
        expect(firstPreviewIndex).toBeGreaterThan(0);
        const firstPreview = samples[firstPreviewIndex];
        expect(firstPreview.userBottom, 'previous user message must not be visible on first preview frame').toBeLessThanOrEqual(0.5);
        expect(Math.abs(firstPreview.tailTop), 'preview top starts at chat viewport top').toBeLessThanOrEqual(2);

        const postSwap = samples.slice(firstPreviewIndex);
        const stagesSeen = new Set(postSwap.map(sample => sample.stage).filter(Boolean));
        expect(stagesSeen.has('Writing reply…')).toBe(true);
        expect(stagesSeen.has('Running Agents…')).toBe(true);
        expect(stagesSeen.has('Running Companions…')).toBe(true);
        expect(stagesSeen.has('Saving reply…')).toBe(true);
        expect(postSwap.some(sample => sample.tailId !== 'neconyan-roleplay-preview')).toBe(true);

        const maxDrift = Math.max(...postSwap.map(sample => Math.abs(sample.tailTop)));
        expect(maxDrift, 'reply row top stays within 2px of viewport top across all stages, handover and 3 s after').toBeLessThanOrEqual(2);
    });

    test(`short new reply after a long old reply carries and releases the reserve without jumping on ${viewport}`, async ({ app }) => {
        test.setTimeout(240000);
        const mainReply = Array.from({ length: 4 }, (_, index) => `Short paragraph ${index} of the replacement reply.`).join('\n\n');
        const postReply = mainReply.replace('Short paragraph 1', 'Revised short paragraph 1');
        const companionReply = 'Short Companion note.';
        const { account, page, remainingStreamParagraphs } = await setupSwipeFixture(app, {
            phone,
            chatName: `Swipe short reserve ${viewport}`,
            oldReply: LONG_OLD,
            mainReply,
            postReply,
            companionReply,
        });

        await startPostPaintSampler(page);
        await streamAndCompleteJob(app, account, page, remainingStreamParagraphs);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(3000);
        const handoverSamples = await stopPostPaintSampler(page);

        const firstPreviewIndex = handoverSamples.findIndex(sample => sample.tailId === 'neconyan-roleplay-preview');
        expect(firstPreviewIndex).toBeGreaterThan(0);
        const postSwap = handoverSamples.slice(firstPreviewIndex);
        const savedFrames = postSwap.filter(sample => sample.tailId !== 'neconyan-roleplay-preview');
        expect(savedFrames.length).toBeGreaterThan(10);
        expect(Math.max(...postSwap.map(sample => Math.abs(sample.tailTop)))).toBeLessThanOrEqual(2);
        expect(savedFrames.at(-1).tailMinHeight).not.toBe('');

        // Scroll up in smooth steps so the reserve shrinks and releases completely without jumping visible content.
        const scrollResult = await page.evaluate(async () => {
            const chat = document.querySelector('#chat');
            const savedRow = [...chat.querySelectorAll(':scope > .mes[mesid]')].at(-1);
            const userRow = [...chat.querySelectorAll(':scope > .mes[is_user="true"]')].at(-1);
            const waitPostPaint = () => new Promise(resolve => {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => {
                    channel.port1.close();
                    channel.port2.close();
                    resolve();
                };
                requestAnimationFrame(() => channel.port2.postMessage(0));
            });

            const stepDeltas = [];
            for (let step = 0; step < 12; step++) {
                const beforeRowTop = savedRow.getBoundingClientRect().top - chat.getBoundingClientRect().top;
                const beforeScrollTop = chat.scrollTop;
                chat.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
                chat.scrollTop -= 50;
                chat.dispatchEvent(new Event('scroll', { bubbles: true }));
                await waitPostPaint();
                const scrolled = beforeScrollTop - chat.scrollTop;
                const afterRowTop = savedRow.getBoundingClientRect().top - chat.getBoundingClientRect().top;
                stepDeltas.push(Math.abs((afterRowTop - beforeRowTop) - scrolled));
            }
            const settledUserTop = userRow.getBoundingClientRect().top - chat.getBoundingClientRect().top;
            const settledRowTop = savedRow.getBoundingClientRect().top - chat.getBoundingClientRect().top;
            for (let index = 0; index < 10; index++) await waitPostPaint();
            return {
                maxStepError: Math.max(...stepDeltas),
                minHeightAfter: savedRow.style.minHeight,
                postSettleRowDrift: Math.abs((savedRow.getBoundingClientRect().top - chat.getBoundingClientRect().top) - settledRowTop),
                postSettleUserDrift: Math.abs((userRow.getBoundingClientRect().top - chat.getBoundingClientRect().top) - settledUserTop),
                bottomGap: chat.scrollHeight - chat.scrollTop - chat.clientHeight,
            };
        });

        expect(scrollResult.minHeightAfter, 'reserved min-height must be removed once scrolled up').toBe('');
        expect(scrollResult.maxStepError, 'releasing reserve must not move visible content beyond the scroll step').toBeLessThanOrEqual(2);
        expect(scrollResult.postSettleRowDrift).toBeLessThanOrEqual(1);
        expect(scrollResult.postSettleUserDrift).toBeLessThanOrEqual(1);
        expect(scrollResult.bottomGap).toBeGreaterThan(200);
    });

    test(`rewriting every paragraph keeps the middle paragraph index in place on ${viewport}`, async ({ app }) => {
        test.setTimeout(240000);
        const mainReply = paragraphs('New', 30);
        const postReply = Array.from(
            { length: 30 },
            (_, index) => `Rewritten ${index}: the agent changed every sentence here${index % 3 === 0 ? ', and this one became a good deal longer than it used to be so that it wraps onto extra lines on a phone' : ''}. Closing words differ ${index} too.`,
        ).join('\n\n');
        const companionReply = 'A Companion note.\n\n- one\n- two\n- three\n- four';
        const { account, page, remainingStreamParagraphs } = await setupSwipeFixture(app, {
            phone,
            chatName: `Swipe full rewrite ${viewport}`,
            oldReply: LONG_OLD,
            mainReply,
            postReply,
            companionReply,
        });

        let targetParagraph = null;
        await streamAndCompleteJob(app, account, page, remainingStreamParagraphs, {
            async onBeforeStreamEnd() {
                targetParagraph = await page.evaluate(() => {
                    const chat = document.querySelector('#chat');
                    const preview = document.querySelector('#neconyan-roleplay-preview');
                    chat.scrollTop = preview.offsetTop + Math.round(preview.offsetHeight / 2);
                    chat.dispatchEvent(new Event('scroll', { bubbles: true }));
                    const chatTop = chat.getBoundingClientRect().top;
                    const blocks = [...preview.querySelectorAll('.mes_text > p')];
                    const index = blocks.findIndex(block => block.getBoundingClientRect().bottom > chatTop + 4);
                    return {
                        index,
                        top: blocks[index].getBoundingClientRect().top - chatTop,
                    };
                });
                await waitForPostPaintFrames(page, 3);
                await startPostPaintSampler(page);
                await page.evaluate(index => {
                    window.viewportTargetParagraphIndex = index;
                    window.viewportSamples = [window.readViewportSample()];
                }, targetParagraph.index);
            },
        });
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(3000);
        const samples = await stopPostPaintSampler(page);

        expect(targetParagraph.index).toBeGreaterThan(5);
        await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toContainText(`Rewritten ${targetParagraph.index}:`);
        expect(samples.every(sample => Number.isFinite(sample.targetParagraphTop))).toBe(true);
        const maxDrift = Math.max(...samples.map(sample => Math.abs(sample.targetParagraphTop - targetParagraph.top)));
        expect(maxDrift, 'paragraph at the same index stays within 2px through rewrite, Companion, saving and handover').toBeLessThanOrEqual(2);
    });

    test(`short old reply keeps its visible top at swap and keeps earlier messages still at saving on ${viewport}`, async ({ app }) => {
        test.setTimeout(240000);
        const mainReply = 'Fresh short first paragraph.\n\nFresh short second paragraph.';
        const postReply = 'Revised short first paragraph.\n\nRevised short second paragraph.';
        const companionReply = 'Brief Companion note.';
        const { account, page, remainingStreamParagraphs } = await setupSwipeFixture(app, {
            phone,
            chatName: `Swipe visible top ${viewport}`,
            oldReply: SHORT_OLD,
            mainReply,
            postReply,
            companionReply,
        });

        await startPostPaintSampler(page);
        await streamAndCompleteJob(app, account, page, remainingStreamParagraphs, {
            async onBeforeStreamEnd() {
                // Position the reader looking above the short reply so the previous user message is in view through saving and handover.
                await page.evaluate(() => {
                    const chat = document.querySelector('#chat');
                    chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight - 140);
                    chat.dispatchEvent(new Event('scroll', { bubbles: true }));
                });
                await waitForPostPaintFrames(page, 3);
            },
        });
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(3000);
        const samples = await stopPostPaintSampler(page);

        const firstPreviewIndex = samples.findIndex(sample => sample.tailId === 'neconyan-roleplay-preview');
        expect(firstPreviewIndex).toBeGreaterThan(0);
        const beforeSwap = findBeforeSwapSample(samples, firstPreviewIndex);
        const firstPreview = samples[firstPreviewIndex];
        expect(beforeSwap.tailTop, 'short old reply top must be visible before swap').toBeGreaterThan(80);
        expect(Math.abs(firstPreview.tailTop - beforeSwap.tailTop), 'row top does not move at the swap').toBeLessThanOrEqual(2);

        const firstSavingIndex = samples.findIndex(sample => sample.stage === 'Saving reply…');
        expect(firstSavingIndex).toBeGreaterThan(firstPreviewIndex);
        const savingSample = samples[firstSavingIndex];
        expect(savingSample.tailTop, 'preview row top is visible while looking above the short reply').toBeGreaterThan(40);
        expect(savingSample.userTop, 'previous user message is visible above the short reply').toBeGreaterThanOrEqual(0);
        const handoverSamples = samples.slice(firstSavingIndex);
        const maxUserDrift = Math.max(...handoverSamples.map(sample => Math.abs(sample.userTop - savingSample.userTop)));
        const maxRowDrift = Math.max(...handoverSamples.map(sample => Math.abs(sample.tailTop - savingSample.tailTop)));
        expect(maxUserDrift, 'previous user message row stays within 2px across the handover').toBeLessThanOrEqual(2);
        expect(maxRowDrift, 'reply row top stays within 2px across the handover').toBeLessThanOrEqual(2);
    });
}

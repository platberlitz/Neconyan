/* global window, document */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAccountStamp } = await import('../src/roleplay-store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

const ANSWER = 'The server wrote this reply.';

function owned(app) {
    const owner = 'default-user';
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE)
        .map(([key, relative]) => [key, path.join(app.directory, 'data', owner, relative)]));
    const base = { owner, directories };
    const { accountId, dataEpoch } = roleplayAccountStamp(base);
    return { base, account: { accountId, dataEpoch }, directories, scope: { ...base, accountId, dataEpoch } };
}

async function savedChat(account, name) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const source = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(source.ok(), await source.text()).toBe(true);
    const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: { stage9: true } },
        { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {},
            swipes: ['Retained answer.', 'Retained alternative.'], swipe_id: 0 },
        { name: 'User', is_user: true, mes: 'Retained question.', extra: {} },
    ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { group: false, avatar: account.avatar, chat: name };
}

async function openChat(page, { avatar, chat }) {
    const opened = await page.evaluate(async ({ avatar, chat }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        // The card remembers the saved chat, so selecting the character opens it.
        if (core.getCurrentChatId() !== chat) await core.openCharacterChat(chat);
        return core.getCurrentChatId();
    }, { avatar, chat });
    expect(opened).toBe(chat);
    await expect(page.locator('#chat .mes').first()).toContainText('Retained answer.');
}

// A stale settings acknowledgement is refused once; the browser saves its settings and
// replays the same key, so the test waits for the submission the server accepted.
function acceptedSubmission(response) {
    return response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409;
}

function noPages(browser) {
    return browser.contexts().flatMap(context => context.pages());
}

async function terminal(account, id) {
    await expect.poll(async () => (await account.job(id)).state, { timeout: 60000 })
        .toMatch(/^(completed|failed|interrupted|cancelled|conflict)$/);
    return account.job(id);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} leaving before the first token submits without a paint and finishes with the page frozen`, async ({ app }) => {
        app.provider.mode.hold = 'conversation-fixture';
        app.provider.mode.streamReply = { first: 'The server ', rest: 'wrote this reply.' };
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
            configureSettings: settings => { settings.oai_settings.stream_openai = true; } });
        if (phone) await installIPhoneSafari(account.context);
        const native = owned(app);
        const locator = await savedChat(account, `Background send ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            context.eventSource.once(context.eventTypes.USER_MESSAGE_RENDERED, () => {
                // Headless Chromium keeps painting background tabs. Model Safari's
                // paused frames at the exact point before Generate submits its work.
                const request = window.requestAnimationFrame;
                const cancel = window.cancelAnimationFrame;
                const frames = new Map();
                let nextId = -1;
                window.requestAnimationFrame = callback => {
                    const id = nextId--;
                    frames.set(id, callback);
                    return id;
                };
                window.cancelAnimationFrame = id => frames.delete(id) || cancel.call(window, id);
                Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                document.dispatchEvent(new Event('visibilitychange'));
                window.restoreBackgroundSend = () => {
                    window.requestAnimationFrame = request;
                    window.cancelAnimationFrame = cancel;
                    delete document.visibilityState;
                    delete document.hidden;
                    for (const callback of frames.values()) request.call(window, callback);
                    document.dispatchEvent(new Event('visibilitychange'));
                };
            });
        });
        const client = await account.context.newCDPSession(page);
        const submissions = [];
        page.on('response', response => { if (acceptedSubmission(response)) submissions.push(response); });
        await page.locator('#send_textarea').fill('Start my reply even if I leave immediately.');
        await page.locator('#send_textarea').press('Enter');
        try {
            await expect.poll(() => app.provider.calls.length, { timeout: 15000,
                message: 'The provider starts without a foreground animation frame' }).toBe(1);
            expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
            expect(app.provider.calls[0].completedAt).toBeNull();
            expect(app.provider.calls[0].firstTokenAt).toBeUndefined();
            expect(app.provider.calls[0].stream).toBe(true);
            await expect.poll(() => submissions.length).toBe(1);
            const response = submissions[0];
            expect(response.status(), await response.text()).toBe(202);
            const { jobId } = await response.json();
            await client.send('Page.setWebLifecycleState', { state: 'frozen' });
            await app.release();
            await expect.poll(() => typeof app.provider.mode.finishStream).toBe('function');
            app.provider.mode.finishStream();
            await account.settled(jobId);
            const records = readRoleplayChat(native.scope, locator).records;
            expect(records.filter(row => row.mes === ANSWER)).toHaveLength(1);
            expect(records.filter(row => row.mes === 'Start my reply even if I leave immediately.')).toHaveLength(1);
        } finally {
            app.provider.mode.finishStream?.();
            await client.send('Page.setWebLifecycleState', { state: 'active' });
            await page.bringToFront();
            await page.evaluate(() => window.restoreBackgroundSend?.());
            await client.detach();
            await app.release();
        }
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);
        expect(app.provider.calls).toHaveLength(1);
        expect(submissions).toHaveLength(1);
    });

    test(`${viewport} live Roleplay text appears before completion and remains visible while Companions run`, async ({ app }, info) => {
        app.provider.mode.streamReply = { first: 'First words', rest: ' and the finished reply.', reasoning: 'Considering the answer.', holdReasoning: true };
        app.provider.mode.reply = { choices: [{ message: { content: 'A saved Companion note.' }, finish_reason: 'stop' }] };
        app.provider.mode.hold = 'unused-named-model';
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
            saved.power_user.message_token_count_enabled = true;
            saved.power_user.timestamp_model_name = true;
            saved.power_user.timestamp_model_icon = false;
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                connectionProfile: 'durable', companionConcurrentWithPostGen: true } };
        } });
        const native = owned(app);
        await fs.mkdir(native.directories.inChatAgents, { recursive: true });
        await fs.writeFile(path.join(native.directories.inChatAgents, 'live-note.json'), JSON.stringify({
            id: 'live-note', name: 'Live note', enabled: true, category: 'companion', execution: 'companion', prompt: 'Keep a note.',
        }));
        const locator = await savedChat(account, `Live preview ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Show the reply as it arrives.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const { jobId } = await response.json();
        const preview = page.locator('#neconyan-roleplay-preview');
        let firstCount;
        let thinkingSeconds;
        try {
            const thinking = preview.locator('.mes_reasoning_header_title');
            await expect(thinking).toBeVisible({ timeout: 60000 });
            await expect.poll(async () => Number(await thinking.getAttribute('data-duration'))).toBeGreaterThan(1);
            const initialSeconds = Number(await thinking.getAttribute('data-duration'));
            await expect.poll(async () => Number(await thinking.getAttribute('data-duration'))).toBeGreaterThan(initialSeconds);
            app.provider.mode.finishReasoning();
            await expect(preview).toContainText('First words', { timeout: 60000 });
            thinkingSeconds = Number(await thinking.getAttribute('data-duration'));
            await expect(preview.locator('.tokenCounterDisplay')).toHaveText(/^[1-9]\d*t$/);
            await expect(preview.locator('.tokenCounterDisplay')).toBeVisible();
            firstCount = parseInt(await preview.locator('.tokenCounterDisplay').textContent());
            await expect(preview.locator('.timestamp-model')).toHaveCount(1);
            await expect(preview.locator('.timestamp-model')).toBeVisible();
            expect(app.provider.calls[0].stream).toBe(true);
            expect(app.provider.calls[0].completedAt).toBeNull();
            expect(readRoleplayChat(native.scope, locator).records.at(-1).is_user).toBe(true);
            expect(await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).is_user)).toBe(true);
            const geometry = await preview.boundingBox();
            expect(geometry.width).toBeGreaterThan(0);
            expect(geometry.x + geometry.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            app.provider.mode.finishStream();
            await expect(preview).toContainText('First words and the finished reply.', { timeout: 30000 });
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
            await expect.poll(async () => parseInt(await preview.locator('.tokenCounterDisplay').textContent())).toBeGreaterThan(firstCount);
            await expect(thinking).toHaveAttribute('data-duration', String(thinkingSeconds));
            expect(app.provider.calls[1].completedAt).toBeNull();
            expect(readRoleplayChat(native.scope, locator).records.at(-1).is_user).toBe(true);
            await page.screenshot({ path: info.outputPath('live-reply-with-companion-pending.png') });
            // Reopening only observes the existing reply; it cannot pay for another one.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 120000 });
            await openChat(page, locator);
            await page.evaluate(async () => (await import('/scripts/neconyan-conversation/roleplay-workflows.js')).resumeNativeRoleplayWorkflowObservation());
            await expect(preview).toContainText('First words and the finished reply.', { timeout: 30000 });
            expect(app.provider.calls).toHaveLength(2);
        } finally {
            app.provider.mode.finishReasoning?.();
            app.provider.mode.finishStream?.();
            await app.release();
        }
        await account.settled(jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('First words and the finished reply.', { timeout: 30000 });
        await expect(preview).toHaveCount(0);
        const records = readRoleplayChat(native.scope, locator).records;
        expect(records.filter(row => row.mes === 'First words and the finished reply.')).toHaveLength(1);
        expect(records.at(-1).extra.inChatAgentCompanionResults['live-note'].status).toBe('done');
        expect(records.at(-1).extra.token_count).toBeGreaterThan(firstCount);
        expect(records.at(-1).extra.model).toBe(app.provider.calls[0].model);
        expect(records.at(-1).extra.reasoning_duration / 1000).toBe(thinkingSeconds);
        await expect(page.locator('#chat .mes').last().locator('.mes_reasoning_header_title')).toHaveAttribute('data-duration', String(thinkingSeconds));
        await expect(page.locator('#chat .mes').last().locator('.tokenCounterDisplay')).toHaveText(`${records.at(-1).extra.token_count}t`);
        await expect(page.locator('#chat .mes').last().locator('.timestamp-model')).toHaveCount(1);
        expect(app.provider.calls).toHaveLength(2);
    });

    test(`${viewport} a live preview whose connection went silent in the background catches up`, async ({ app }) => {
        app.provider.mode.streamReply = { first: 'First words', rest: ' and the finished reply.' };
        app.provider.mode.reply = { choices: [{ message: { content: 'A saved Companion note.' }, finish_reason: 'stop' }] };
        app.provider.mode.hold = 'unused-named-model';
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
                saved.oai_settings.stream_openai = true;
                saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                    connectionProfile: 'durable', companionConcurrentWithPostGen: true } };
            } });
        if (phone) await installIPhoneSafari(account.context);
        const native = owned(app);
        await fs.mkdir(native.directories.inChatAgents, { recursive: true });
        await fs.writeFile(path.join(native.directories.inChatAgents, 'silent-note.json'), JSON.stringify({
            id: 'silent-note', name: 'Silent note', enabled: true, category: 'companion', execution: 'companion', prompt: 'Keep a note.',
        }));
        const locator = await savedChat(account, `Silent preview ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(() => {
            // A suspended phone tab can lose a streaming connection without any error:
            // the reader simply never hears from it again until it gives up itself.
            const original = window.fetch;
            const open = new Set();
            window.previewAttempts = 0;
            window.previewLive = () => [...open].filter(connection => !connection.silent).length;
            window.silencePreviews = () => { for (const connection of open) connection.silent = true; };
            window.fetch = async (input, init = {}) => {
                const url = typeof input === 'string' ? input : input.url;
                if (!/\/api\/jobs\/[^/]+\/preview$/.test(url)) return original(input, init);
                window.previewAttempts += 1;
                const response = await original(input, init);
                if (!response.ok || !response.body) return response;
                const connection = { silent: false };
                const source = response.body.getReader();
                const lost = () => new Promise((_, reject) => {
                    const fail = () => reject(new DOMException('The connection was abandoned.', 'AbortError'));
                    if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail, { once: true });
                });
                open.add(connection);
                const body = new ReadableStream({
                    async pull(controller) {
                        try {
                            if (connection.silent) { void source.cancel().catch(() => {}); await lost(); }
                            const chunk = await source.read();
                            if (connection.silent) { void source.cancel().catch(() => {}); await lost(); }
                            if (chunk.done) { open.delete(connection); controller.close(); } else controller.enqueue(chunk.value);
                        } catch (error) { open.delete(connection); throw error; }
                    },
                    cancel() { open.delete(connection); return source.cancel(); },
                });
                return new Response(body, { status: response.status, headers: response.headers });
            };
        });
        const setVisibility = state => page.evaluate(state => {
            if (state === 'hidden') {
                Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            } else {
                delete document.visibilityState;
                delete document.hidden;
            }
            document.dispatchEvent(new Event('visibilitychange'));
        }, state);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Keep writing while I check another tab.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const { jobId } = await response.json();
        const preview = page.locator('#neconyan-roleplay-preview');
        const status = preview.locator('[role="status"]');
        try {
            await expect(preview).toContainText('First words', { timeout: 60000 });
            await expect(status).toHaveText('Writing reply…');
            await page.evaluate(() => window.silencePreviews());
            await setVisibility('hidden');
            app.provider.mode.finishStream();
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
            await page.waitForTimeout(1500);
            await expect(preview).not.toContainText('the finished reply.');
            await expect(status).toHaveText('Writing reply…');
            // Back on the tab: the preview shows the finished text and the real stage
            // well before the silence limit would have noticed the lost connection.
            await setVisibility('visible');
            await expect(preview).toContainText('First words and the finished reply.', { timeout: 3000 });
            await expect(status).toHaveText('Running Companions…');
            // Without a tab change, silence alone reconnects, and a refused
            // reconnection is retried instead of ending the preview for good.
            let refusals = 0;
            await page.route('**/api/jobs/*/preview', route => { refusals += 1; return route.fulfill({ status: 502, body: 'Bad gateway' }); }, { times: 1 });
            const attempts = await page.evaluate(() => window.previewAttempts);
            await page.evaluate(() => window.silencePreviews());
            await expect.poll(() => page.evaluate(() => window.previewLive()), { timeout: 15000 }).toBe(1);
            expect(refusals).toBe(1);
            expect(await page.evaluate(() => window.previewAttempts)).toBeGreaterThanOrEqual(attempts + 2);
            await expect(status).toHaveText('Running Companions…');
            expect(readRoleplayChat(native.scope, locator).records.at(-1).is_user).toBe(true);
        } finally {
            app.provider.mode.finishStream?.();
            await app.release();
        }
        await account.settled(jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('First words and the finished reply.', { timeout: 30000 });
        await expect(preview).toHaveCount(0);
        const records = readRoleplayChat(native.scope, locator).records;
        expect(records.filter(row => row.mes === 'First words and the finished reply.')).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(2);
    });

    test(`${viewport} Agents can be switched off during setup recovery and the Companion paw stays available`, async ({ app }, info) => {
        const agent = { id: 'controls-companion', name: 'Controls companion', enabled: true, category: 'companion',
            execution: 'companion', prompt: 'Keep a note.', companion: { displayMode: 'panel' } };
        const account = await app.account({ configureSettings(saved) {
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false } };
        }, phone });
        const native = owned(app);
        await fs.mkdir(path.join(native.directories.inChatAgents, 'presets'), { recursive: true });
        await fs.writeFile(path.join(native.directories.inChatAgents, `${agent.id}.json`), JSON.stringify(agent));
        await fs.writeFile(path.join(native.directories.inChatAgents, 'presets', 'controls-recovery.json'), JSON.stringify({
            id: 'controls-recovery', name: 'Recovery before controls', version: 1, recoveryFor: 'controls', agents: [agent], globalSettings: { enabled: true },
        }));
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        const toggle = page.locator('#ica--globalEnabled');
        await expect(toggle).toHaveText('Agents On', { timeout: 30000 });
        await expect(page.locator('#ica--run-status')).toHaveText('Agent setup or library needs recovery');
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).setCompanionPanelLauncher('topbar'));
        const paw = page.locator('#ica--tracker-panel-topbar');
        await expect(paw).toBeVisible();
        await toggle.click();
        await expect(toggle).toHaveText('Agents Off');
        const saved = await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }));
        expect(saved).toBe(true);
        expect(JSON.parse((await account.post('/api/settings/get')).settings).extension_settings.inChatAgents.globalSettings.enabled).toBe(false);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 120000 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        await expect(toggle).toHaveText('Agents Off', { timeout: 30000 });
        await expect(paw).toBeVisible();
        const geometry = await paw.boundingBox();
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.height).toBeGreaterThan(0);
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.x + geometry.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await paw.click();
        await expect(page.locator('#ica--tracker-panel')).toHaveAttribute('aria-hidden', 'false');
        await expect(page.locator('#ica--tracker-panel')).toContainText('Controls companion');
        await expect(page.locator('[data-action="panel-regenerate-all"]')).toBeDisabled();
        expect(app.provider.calls).toHaveLength(0);
        await page.screenshot({ path: info.outputPath('agent-controls.png') });
    });

    test(`${viewport} returning to a completed workflow does not reload over a pending chat save`, async ({ app }) => {
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
        const account = await app.account({ phone, activeConnection: true });
        const native = owned(app);
        const locator = await savedChat(account, `Readback save ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('One reply before returning to the tab.');
        await page.locator('#send_textarea').press('Enter');
        const accepted = await (await submitted).json();
        await account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);

        try {
            await page.evaluate(() => {
                window.readbackTestFetch = window.fetch;
                window.fetch = async (...args) => {
                    const response = await window.readbackTestFetch(...args);
                    if (String(args[0]).endsWith('/api/chats/save') && !window.readbackSaveArrived) {
                        window.readbackSaveArrived = true;
                        await new Promise(resolve => { window.releaseReadbackSave = resolve; });
                    }
                    return response;
                };
                window.pendingReadbackTestSave = import('/script.js').then(core => core.saveChatConditional({ throwOnError: true }));
            });
            await page.waitForFunction(() => window.readbackSaveArrived);
            await page.evaluate(async () => {
                const workflows = await import('/scripts/neconyan-conversation/roleplay-workflows.js');
                await Promise.all([workflows.resumeNativeRoleplayWorkflowObservation(), workflows.resumeNativeRoleplayWorkflowObservation()]);
            });
            await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
            await expect(page.locator('#toast-container').filter({ hasText: 'Could not load chat data' })).toHaveCount(0);
        } finally {
            await page.evaluate(async () => {
                window.releaseReadbackSave?.();
                await window.pendingReadbackTestSave;
                window.fetch = window.readbackTestFetch;
            });
        }
        expect(app.provider.calls).toHaveLength(1);
        // Both replacement controls must preserve the saved reply until the server
        // accepts and completes its replacement, including after a tab resume.
        for (const action of ['regenerate', 'swipe']) {
            let beforeSubmission;
            let releaseSubmission;
            const gate = new Promise(resolve => { releaseSubmission = resolve; });
            await page.route('**/api/roleplay/workflow/submit', async route => {
                beforeSubmission = readRoleplayChat(native.scope, locator).records.at(-1);
                await gate;
                return route.continue();
            });
            const replacement = page.waitForResponse(acceptedSubmission);
            if (action === 'regenerate') {
                await page.evaluate(() => document.querySelector('#option_regenerate').click());
            } else {
                await page.locator('#chat .mes').last().locator('.swipe_right').click();
            }
            try {
                await expect(page.locator('#chat [data-roleplay-replacement]')).toHaveCount(1);
                await expect(page.locator('#chat .mes').filter({ hasText: ANSWER })).toHaveCount(0);
                expect(await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).mes)).toBe(ANSWER);
            } finally {
                releaseSubmission();
            }
            const response = await replacement;
            expect(response.status(), await response.text()).toBe(202);
            const replacementJob = await terminal(account, (await response.json()).jobId);
            const children = await Promise.all((replacementJob.children ?? []).map(id => account.job(id)));
            expect(replacementJob.state, JSON.stringify({ action, error: replacementJob.error,
                children: children.map(job => ({ state: job.state, error: job.error })) })).toBe('completed');
            await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);
            expect(beforeSubmission.mes).toBe(ANSWER);
            await expect(page.locator('#chat [data-roleplay-replacement]')).toHaveCount(0);
            await page.unroute('**/api/roleplay/workflow/submit');
        }
        expect(app.provider.calls).toHaveLength(3);
    });

    test(`${viewport} replacement previews recover after refusal, cancellation and reopening`, async ({ app }) => {
        app.provider.mode.reply = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] };
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = false;
        } });
        const native = owned(app);
        const locator = await savedChat(account, `Replacement recovery ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Write the original reply.');
        await page.locator('#send_textarea').press('Enter');
        await account.settled((await (await submitted).json()).jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);

        await page.evaluate(async () => { (await import('/scripts/openai.js')).oai_settings.stream_openai = true; });
        app.provider.mode.streamReply = { first: 'Replacement in progress', rest: ' must not be saved.' };
        const replacement = page.waitForResponse(acceptedSubmission);
        await page.evaluate(() => document.querySelector('#option_regenerate').click());
        const { jobId } = await (await replacement).json();
        const preview = page.locator('#neconyan-roleplay-preview');
        try {
            await expect(preview).toContainText('Replacement in progress', { timeout: 60000 });
            await expect(page.locator('#chat .mes').filter({ hasText: ANSWER })).toHaveCount(0);
            expect(readRoleplayChat(native.scope, locator).records.at(-1).mes).toBe(ANSWER);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 120000 });
            await openChat(page, locator);
            await page.evaluate(async () => (await import('/scripts/neconyan-conversation/roleplay-workflows.js')).resumeNativeRoleplayWorkflowObservation());
            await expect(preview).toContainText('Replacement in progress', { timeout: 30000 });
            await expect(page.locator('#chat .mes').filter({ hasText: ANSWER })).toHaveCount(0);
            await account.post(`/api/jobs/${jobId}/cancel`);
            expect((await terminal(account, jobId)).state).toBe('cancelled');
            await expect(preview).toHaveCount(0);
            await expect(page.locator('#chat [data-roleplay-replacement]')).toHaveCount(0);
            await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
            expect(readRoleplayChat(native.scope, locator).records.at(-1).mes).toBe(ANSWER);
        } finally {
            app.provider.mode.finishStream?.();
            await app.release();
        }
        await page.route('**/api/roleplay/workflow/submit', route => route.fulfill({
            status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Test refusal' }),
        }));
        const refused = page.waitForResponse(acceptedSubmission);
        await page.locator('#chat .mes').last().locator('.swipe_right').click();
        expect((await refused).status()).toBe(400);
        await expect(page.locator('#chat [data-roleplay-replacement]')).toHaveCount(0);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
        expect(readRoleplayChat(native.scope, locator).records.at(-1).mes).toBe(ANSWER);
        expect(app.provider.calls).toHaveLength(2);
    });

    test(`${viewport} hidden Companions do not block a named Roleplay reply with a false capacity error`, async ({ app }, info) => {
        const agents = Array.from({ length: 31 }, (_, index) => ({ id: `capacity-${index}`, name: `Capacity ${index}`,
            enabled: true, category: 'companion', execution: 'companion', phase: 'pre', prompt: `TASK_CAPACITY_${index}`,
            conditions: { generationTypes: ['normal', 'swipe'] }, companion: { trigger: 'auto', includeWorldInfo: false } }));
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.character_allowed_regex = ['Another character.png'];
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, connectionProfile: 'durable',
                separateRecentChats: false, hiddenCompanionAgentIds: agents.slice(9).map(agent => agent.id),
                companionExecutionMode: 'parallel', companionConcurrentWithPostGen: true } };
        } });
        const native = owned(app);
        await fs.mkdir(native.directories.inChatAgents, { recursive: true });
        await Promise.all(agents.map(agent => fs.writeFile(path.join(native.directories.inChatAgents, `${agent.id}.json`), JSON.stringify(agent))));
        const locator = await savedChat(account, `Companion capacity ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Generate with the visible Companions.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        await account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);
        const result = readRoleplayChat(native.scope, locator).records.at(-1);
        expect(Object.keys(result.extra.inChatAgentCompanionResults).sort()).toEqual(agents.slice(0, 9).map(agent => agent.id).sort());
        expect(app.provider.calls).toHaveLength(10);
        const swiped = page.waitForResponse(acceptedSubmission);
        await page.locator('#chat .mes').last().locator('.swipe_right').click();
        const swipeResponse = await swiped;
        expect(swipeResponse.status(), await swipeResponse.text()).toBe(202);
        const swipeJob = await terminal(account, (await swipeResponse.json()).jobId);
        const children = await Promise.all((swipeJob.children ?? []).map(id => account.job(id)));
        expect(swipeJob.state, JSON.stringify(children.map(job => job.error))).toBe('completed');
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
        const replacement = readRoleplayChat(native.scope, locator).records.at(-1);
        expect(replacement.swipes).toHaveLength(2);
        expect(Object.keys(replacement.extra.inChatAgentCompanionResults).sort()).toEqual(agents.slice(0, 9).map(agent => agent.id).sort());
        expect(app.provider.calls).toHaveLength(20);
        await page.screenshot({ path: info.outputPath('companion-capacity-reply.png') });
    });

    test(`${viewport} a named Roleplay reply from the browser completes once, closes its page and reopens without replaying`, async ({ app, browser }, info) => {
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
        const account = await app.account({ phone, activeConnection: true });
        const native = owned(app);
        const locator = await savedChat(account, `Stage9 ${viewport} reply`);
        const page = await account.open({ workspace: false });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Ask the server one question.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        expect(accepted.name).toBe('roleplay.reply');
        expect(accepted.jobId).toBeTruthy();

        // The browser adopts the server's durable write by reloading the chat it owns,
        // so the answer appears without a page refresh and without a second generation.
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        const job = await account.settled(accepted.jobId);
        expect(job.result.result.status).toBe('completed');
        expect(app.provider.calls).toHaveLength(1);

        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Retained answer.', 'Retained alternative.']);
        expect(records[1].swipe_id).toBe(0);
        expect(records.at(-1).mes).toBe(ANSWER);
        expect(records.filter(record => record.is_user)).toHaveLength(2);

        const receipt = await (await account.context.request.get(
            `/api/roleplay/workflow/receipt?key=${encodeURIComponent(accepted.key)}`, { headers: account.headers })).json();
        expect(receipt.accepted).toBe(true);
        expect(receipt.state).toBe('closed');
        expect(receipt.result.named).toEqual({ appended: true });
        expect(receipt.jobId).toBe(accepted.jobId);

        await page.screenshot({ path: info.outputPath('completed-reply.png') });
        await page.close();
        expect(noPages(browser)).toHaveLength(0);

        // Reopening the same chat reads the receipt back; it never submits again.
        const reopened = await account.open({ workspace: false });
        await openChat(reopened, locator);
        await expect(reopened.locator('#chat .mes').last()).toContainText(ANSWER);
        expect(app.provider.calls).toHaveLength(1);
        await reopened.close();
        expect(noPages(browser)).toHaveLength(0);
    });

    test(`${viewport} a failed named Roleplay workflow keeps the saved chat and never generates a second time`, async ({ app, browser }, info) => {
        // The fixture's canned reply wins over fail mode, so clear it first.
        app.provider.mode.reply = null;
        app.provider.mode.fail = true;
        const account = await app.account({ phone, activeConnection: true });
        const native = owned(app);
        const locator = await savedChat(account, `Stage9 ${viewport} failure`);
        const page = await account.open({ workspace: false });
        await openChat(page, locator);

        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('This answer cannot be produced.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.ok(), await response.text()).toBe(true);
        const accepted = await response.json();

        const job = await terminal(account, accepted.jobId);
        expect(job.state).not.toBe('completed');
        // A refused or failed paid step is never repeated automatically.
        expect(app.provider.calls).toHaveLength(1);
        await expect(page.locator('#chat .mes').last()).toContainText('This answer cannot be produced.');
        await page.screenshot({ path: info.outputPath('failed-workflow.png') });

        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Retained answer.', 'Retained alternative.']);
        expect(records.at(-1).is_user).toBe(true);
        expect(records.at(-1).mes).toBe('This answer cannot be produced.');
        expect(records).toHaveLength(4);
        await page.close();
        expect(noPages(browser)).toHaveLength(0);
    });
}

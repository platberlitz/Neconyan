/* global window, document */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const completedReply = 'The main reply is finished. You can read it while the Companions work.';
const visibility = (page, state) => page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
}, state);

for (const [phone, stopAfterReturn] of [[true, false], [false, false], [true, true]]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} returning to a reply shows completed Companions before the last one finishes${stopAfterReturn ? ' and Stop keeps the reply' : ''}`, async ({ app }, info) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { first: 'The main reply', rest: completedReply.slice('The main reply'.length) };
        app.provider.mode.hold = 'held-note';
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === 'held-note'
            ? 'The last Companion has finished.' : 'The first Companion is already ready.' }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
                saved.oai_settings.stream_openai = true;
                saved.extension_settings.connectionManager.profiles.push({ id: 'slow', name: 'Slow fixture',
                    api: 'custom', mode: 'cc', model: 'held-note', 'api-url': app.provider.url });
                saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                    trackerCompanionAutoLoopVersion: 4,
                    connectionProfile: 'durable', companionExecutionMode: 'parallel', companionConcurrentWithPostGen: true } };
            } });
        if (phone) await installIPhoneSafari(account.context);
        const agents = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(agents, { recursive: true });
        for (const [id, name, mode, profile] of [['early', 'First Companion', 'card', 'durable'], ['late', 'Last Companion', 'panel', 'slow']]) {
            await fs.writeFile(path.join(agents, `${id}.json`), JSON.stringify({ id, name, enabled: true,
                category: 'companion', execution: 'companion', prompt: `Write the ${id} note.`, connectionProfile: profile,
                companion: { trigger: 'auto', includeWorldInfo: false, displayMode: mode } }));
        }
        const page = await account.open({ workspace: false, skipTour: false });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.evaluate(() => document.addEventListener('neconyan:roleplay-preview-rendered', event => {
            window.fixturePreview = event.detail.message;
        }));
        await page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]').click();
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Keep working while I switch tabs.');
        await startNativeReply(page);
        const { jobId } = await (await submitted).json();
        const preview = page.locator('#neconyan-roleplay-preview');
        try {
            await expect(preview).toContainText('The main reply');
            await visibility(page, 'hidden');
            app.provider.mode.finishStream();
            await expect.poll(() => app.provider.calls.length).toBe(3);
            await visibility(page, 'visible');
            await expect(preview.locator('.mes_text')).toHaveText(completedReply, { timeout: 3000 });
            await preview.scrollIntoViewIfNeeded();
            const capture = () => page.screenshot({ path: `../screenshots/companion-return-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            if (process.env.NECONYAN_SCREENSHOT_PHASE === 'before') await capture();
            await expect(preview.locator('.mes_timer')).not.toBeEmpty();
            await expect(preview.locator('.ica--companion-ledger')).toContainText('The first Companion is already ready.');
            await expect(preview.locator('.ica--companion-action')).toHaveCount(0);
            if (process.env.NECONYAN_SCREENSHOT_PHASE !== 'before') await capture();
            expect(app.provider.calls.find(call => call.model === 'held-note').completedAt).toBeNull();
            expect((await account.job(jobId)).state).not.toBe('completed');
            expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).is_user)).toBe(true);

            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
            await expect(page.locator('#ica--tracker-panel [data-agent-id="late"] .ica--companion-pending')).toBeVisible();
            await expect(page.locator('#ica--tracker-panel [data-agent-id="late"] [data-action="panel-edit-note"]')).toHaveCount(0);
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());

            // A fresh page also reads the existing results, without submitting any model work again.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('button', { name: /^Open Durable Nova: Durable Nova -/ }).click();
            if (phone) await applyIOSOnlyCss(page);
            await expect(preview.locator('.ica--companion-ledger')).toContainText('The first Companion is already ready.', { timeout: 60000 });
            expect(app.provider.calls).toHaveLength(3);
            await preview.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `../screenshots/roleplay-reopened-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(true);
            await expect(page.locator('#mes_stop')).toBeVisible();
            const length = await page.evaluate(async () => (await import('/script.js')).chat.length);
            await page.locator('#send_textarea').fill('This must wait for the current reply.');
            await startNativeReply(page);
            expect(await page.evaluate(async () => (await import('/script.js')).chat.length)).toBe(length);
            await page.locator('#send_textarea').fill('');
            if (stopAfterReturn) {
                await page.locator('#mes_stop').click();
                await account.settled(jobId);
                expect(app.provider.calls.find(call => call.model === 'held-note').completedAt).toBeNull();
            }
        } finally {
            await info.attach('preview-progress', { body: JSON.stringify({ errors, preview: await page.evaluate(() => window.fixturePreview) }), contentType: 'application/json' });
            app.provider.mode.finishStream?.();
            await app.release();
        }
        await account.settled(jobId);
        await expect(preview).toHaveCount(0);
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText(completedReply);
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        if (!stopAfterReturn) await expect(page.locator('#ica--tracker-panel')).toContainText('The last Companion has finished.');
        else await expect(page.locator('#ica--tracker-panel')).not.toContainText('The last Companion has finished.');
        expect(app.provider.calls).toHaveLength(3);
    });
}

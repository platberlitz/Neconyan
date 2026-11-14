/* global document, getComputedStyle */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

const prose = 'The paid main reply survives a failed helper.';
const thought = 'The formatting stays with the saved reply.';
const answer = `${prose}\n\n[THOUGHT]${thought}[/THOUGHT]`;
const displayScript = { id: 'thought', findRegex: '/\\[THOUGHT\\]([\\s\\S]*?)\\[\\/THOUGHT\\]/g',
    replaceString: '<aside class="failure-thought"><h3>Private thought</h3><p>$1</p></aside>', placement: [2], markdownOnly: true };

async function openRoleplay(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

for (const phone of [false, true]) for (const change of ['agent', 'settings', 'agent and restarting', 'settings with page open']) {
    const viewport = phone ? 'phone' : 'desktop';
    const settingsChange = change.startsWith('settings');
    const staysOpen = change.endsWith('page open');
    test(`${viewport} keeps formatting and warns after changing ${change} and helper failure`, async ({ app, browser, initialServerOptions }, info) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { first: 'The paid main reply', rest: answer.slice('The paid main reply'.length) };
        app.provider.mode.hold = ['failed-helper'];
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
            saved.world_info_settings = { world_info: { globalSelect: [] } };
            saved.extension_settings.connectionManager.profiles.push({ id: 'helper', name: 'Failing helper',
                api: 'custom', mode: 'cc', model: 'failed-helper', 'api-url': app.provider.url });
            saved.extension_settings.connectionManager.profiles.push({ id: 'companion', name: 'Automatic Companion',
                api: 'custom', mode: 'cc', model: 'automatic-companion', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                connectionProfile: 'helper', trackerCompanionAutoLoopVersion: 4, hiddenCompanionAgentIds: ['hidden-companion'] } };
            saved.extension_settings.translate = { provider: 'libre', target_language: 'fr', internal_language: 'en',
                auto_mode: 'none' };
        } });
        // Keep even an unexpected translation request on this disposable local provider.
        await account.post('/api/secrets/write', { key: 'libre_url', value: app.provider.url + '/translate' });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        const agent = { id: 'helper', name: 'Failing helper', enabled: true, phase: 'post',
            prompt: 'Revise the reply.', connectionProfile: 'helper',
            postProcess: { enabled: false, promptTransformEnabled: true }, regexScripts: [displayScript] };
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'helper.json'), JSON.stringify(agent));
        for (const [id, trigger, enabled] of [['auto-companion', 'auto', true], ['manual-companion', 'manual', true],
            ['hidden-companion', 'auto', true], ['disabled-companion', 'auto', false]]) {
            await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, name: id, enabled,
                execution: 'companion', category: 'companion', phase: 'post', prompt: `Write a note for ${id}.`,
                connectionProfile: 'companion', companion: { trigger, contextMessages: 10, format: 'markdown', displayMode: 'card' } }));
        }
        const page = await openRoleplay(account);
        await page.evaluate(async autoMode => {
            const { extension_settings } = await import('/scripts/extensions.js');
            extension_settings.translate.auto_mode = autoMode;
        }, settingsChange ? 'responses' : 'none');
        await acknowledgeActiveSettings(page);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Keep this finished reply even if the helper fails.');
        await startNativeReply(page);
        const response = await submitted;
        expect(response.ok(), await response.text()).toBe(true);
        const { jobId } = await response.json();
        const preview = page.locator('#neconyan-roleplay-preview');
        try {
            await expect(preview).toContainText('The paid main reply');
            app.provider.mode.finishStream();
            await expect.poll(() => app.provider.calls.some(call => call.model === 'failed-helper')).toBe(true);
            await expect(preview.locator('.custom-failure-thought')).toContainText(thought);
            // eslint-disable-next-line playwright/no-conditional-in-test -- Each scenario makes its specified external edit.
            if (!settingsChange) {
                await fs.writeFile(path.join(directory, 'helper.json'), JSON.stringify({ ...agent, prompt: 'An edited instruction.',
                    regexScripts: [{ ...displayScript, replaceString: 'Wrong new formatting' }] }));
            } else {
                const saved = JSON.parse((await account.post('/api/settings/get')).settings);
                saved.active_character = 'a-different-character.png';
                await account.post('/api/settings/save', saved);
            }
            app.provider.mode.reply = null;
            app.provider.mode.fail = true;
            // eslint-disable-next-line playwright/no-conditional-in-test -- Cover live observation and a closed page separately.
            if (!staysOpen) await page.close();
            expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(staysOpen ? 1 : 0);
            // eslint-disable-next-line playwright/no-conditional-in-test -- This scenario loses the server's in-memory Agent copy.
            if (change === 'agent and restarting') {
                await app.restart(initialServerOptions);
            }
            expect(app.processes).toHaveLength(change === 'agent and restarting' ? 2 : 1);
            expect(app.processes[0].signal).toBe(change === 'agent and restarting' ? 'SIGKILL' : undefined);
        } finally {
            app.provider.mode.finishStream?.();
            await app.release();
        }
        const settled = await account.settled(jobId);
        const reopened = staysOpen ? page : await openRoleplay(account);
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText(prose);
        expect(await reopened.evaluate(async text => (await import('/script.js')).chat.filter(message => message.mes === text).length, answer)).toBe(1);
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
        expect(app.provider.calls.filter(call => call.model === 'failed-helper')).toHaveLength(1);
        expect(app.provider.calls.filter(call => call.url.endsWith('/translate'))).toHaveLength(0);
        await expect(reopened.locator('#neconyan-roleplay-preview')).toHaveCount(0);
        const formatted = reopened.locator('#chat .mes[mesid]').last().locator('.custom-failure-thought');
        await expect(formatted).toContainText(thought);
        // Receipt adoption can replace the chat between locator resolution and
        // evaluation. Query and measure the current message in one browser task.
        await expect.poll(() => reopened.evaluate(viewportWidth => {
            const message = Array.from(document.querySelectorAll('#chat .mes[mesid]')).at(-1);
            const element = message?.querySelector('.custom-failure-thought');
            if (!element) return null;
            const width = element.getBoundingClientRect().width;
            return { headingWeight: getComputedStyle(element.querySelector('h3')).fontWeight,
                visible: width > 0, fits: width < viewportWidth };
        }, phone ? 393 : 1280)).toEqual({ headingWeight: '700', visible: true, fits: true });
        expect(settled.result?.agentsFailed ?? settled.result?.result?.agentsFailed).toBe(true);
        await expect(reopened.locator('.toast-warning')).toContainText('Your reply was saved, but some Agents could not finish.');
        await reopened.evaluate(async () => (await import('/scripts/neconyan-conversation/roleplay-workflows.js')).resumeNativeRoleplayWorkflowObservation());
        await expect(reopened.locator('.toast-warning')).toHaveCount(1);
        const warning = reopened.locator('.toast-warning').filter({ hasText: 'Agents did not finish' });
        const rerun = warning.getByRole('button', { name: 'Rerun agents', exact: true });
        await expect(rerun).toBeVisible();
        await reopened.screenshot({ path: `../screenshots/helper-failure-${change}-${viewport}.png`, scale: 'css' });
        // eslint-disable-next-line playwright/no-conditional-in-test -- The open-page cases accept; reopened cases decline.
        if (staysOpen) {
            await verifyRerunButton(reopened, rerun, phone, info);
            app.provider.mode.fail = false;
            app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant',
                content: body.model === 'automatic-companion' ? 'The automatic Companion was rerun.' : `${answer}\n\nRevised by the after-reply Agent.` } }] });
            await rerun.click();
            await expect(warning).toHaveCount(0);
            await expect.poll(() => app.provider.calls.filter(call => call.model === 'automatic-companion').length).toBe(1);
            await expect.poll(() => reopened.evaluate(async () => {
                const { chat } = await import('/script.js');
                return chat.at(-1)?.extra?.inChatAgentCompanionResults?.['auto-companion']?.content;
            })).toBe('The automatic Companion was rerun.');
            await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText('Revised by the after-reply Agent.');
            expect(app.provider.calls.filter(call => call.model === 'failed-helper')).toHaveLength(2);
            expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
            const companionRequest = app.provider.calls.find(call => call.model === 'automatic-companion');
            expect(JSON.stringify(companionRequest)).toContain('Revised by the after-reply Agent.');
        } else {
            await warning.locator('.toast-close-button').click();
            await expect(warning).toHaveCount(0);
            await reopened.evaluate(async () => (await import('/scripts/neconyan-conversation/roleplay-workflows.js')).resumeNativeRoleplayWorkflowObservation());
            await expect(warning).toHaveCount(0);
            expect(app.provider.calls.filter(call => call.model === 'failed-helper')).toHaveLength(1);
            expect(app.provider.calls.filter(call => call.model === 'automatic-companion')).toHaveLength(0);
        }
    });
}

async function verifyRerunButton(page, button, phone, info) {
    await page.screenshot({ path: `../screenshots/rerun-agents-after-${phone ? 'phone' : 'desktop'}.png`, scale: 'css' });
    const measurements = [];
    for (const accent of [null, 'Pearl', 'Midnight Ink']) {
        if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
        const sample = await button.evaluate(async element => {
            const { contrastRatio } = await import('/scripts/theme-contrast.js');
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas').getContext('2d');
            const channels = colour => {
                canvas.fillStyle = colour;
                canvas.fillRect(0, 0, 1, 1);
                return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const rect = element.getBoundingClientRect();
            return { contrast: contrastRatio(channels(style.color), channels(style.backgroundColor)),
                height: rect.height, left: rect.left, right: rect.right };
        });
        expect(sample.contrast).toBeGreaterThanOrEqual(4.5);
        expect(sample.height).toBeGreaterThanOrEqual(44);
        expect(sample.left).toBeGreaterThanOrEqual(0);
        expect(sample.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        measurements.push({ accent: accent || 'default', ...sample });
    }
    await info.attach('rerun-button-measurements', { body: JSON.stringify(measurements), contentType: 'application/json' });
}

for (const phone of [false, true]) for (const stage of ['translation', 'speech']) {
    const viewport = phone ? 'phone' : 'desktop';
    const route = stage === 'translation' ? '/translate' : '/audio/speech';
    const heldModel = stage === 'translation' ? undefined : 'tts-1';
    const optionalSettings = { autoMode: stage === 'translation' ? 'responses' : 'none', automaticSpeech: stage === 'speech' };
    const fixtureReply = body => body.q
        ? { translatedText: `FR: ${body.q}` }
        : { choices: [{ message: { role: 'assistant', content: answer } }] };
    test(`${viewport} saves the finished reply after restarting during ${stage} without repeating paid work`, async ({ app, browser, initialServerOptions }) => {
        test.setTimeout(180000);
        app.provider.mode.reply = fixtureReply;
        const account = await app.account({ phone, activeConnection: true, tts: stage === 'speech', configureSettings(saved) {
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: false } };
            saved.extension_settings.translate = { provider: 'libre', target_language: 'fr', internal_language: 'en',
                auto_mode: 'none' };
            saved.extension_settings.tts = { ...saved.extension_settings.tts, auto_generation: false };
        } });
        await account.post('/api/secrets/write', { key: 'libre_url', value: app.provider.url + '/translate' });
        const page = await openRoleplay(account);
        // The fixture's new-character greeting must finish before the paid reply's optional work is held.
        expect(app.provider.calls.filter(call => call.url.endsWith(route))).toHaveLength(0);
        await page.evaluate(async ({ autoMode, automaticSpeech }) => {
            const { extension_settings } = await import('/scripts/extensions.js');
            extension_settings.translate.auto_mode = autoMode;
            extension_settings.tts.auto_generation = automaticSpeech;
        }, optionalSettings);
        await acknowledgeActiveSettings(page);
        app.provider.mode.hold = [heldModel];
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Keep this finished reply through the restart.');
        await startNativeReply(page);
        const response = await submitted;
        expect(response.ok(), await response.text()).toBe(true);
        const { jobId } = await response.json();
        try {
            await expect.poll(() => app.provider.calls.filter(call => call.url.endsWith(route)).length).toBe(1);
            await expect(page.locator('#neconyan-roleplay-preview')).toContainText(answer);
            await page.close();
            expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
            await app.restart(initialServerOptions);
            expect(app.processes).toHaveLength(2);
            expect(app.processes[0].signal).toBe('SIGKILL');
        } finally {
            await app.release();
        }
        await account.settled(jobId);
        // A further restart must neither duplicate delivery nor repeat the uncertain optional request.
        await app.restart(initialServerOptions);
        await account.settled(jobId);
        const reopened = await openRoleplay(account);
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText(answer);
        expect(await reopened.evaluate(async text => (await import('/script.js')).chat.filter(message => message.mes === text).length, answer)).toBe(1);
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
        expect(app.provider.calls.filter(call => call.url.endsWith(route))).toHaveLength(1);
        await expect(reopened.locator('#neconyan-roleplay-preview')).toHaveCount(0);
        await reopened.screenshot({ path: `../screenshots/helper-restart-${stage}-${viewport}.png`, scale: 'css' });
    });
}

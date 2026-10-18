import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

const answer = 'The paid main reply survives a failed helper.';

async function openRoleplay(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

for (const phone of [false, true]) for (const change of ['agent', 'settings', 'agent and restarting']) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} saves the finished reply after changing ${change} and helper failure with every page closed`, async ({ app, browser, initialServerOptions }) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { first: 'The paid main reply', rest: answer.slice('The paid main reply'.length) };
        app.provider.mode.hold = ['failed-helper'];
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
            saved.extension_settings.connectionManager.profiles.push({ id: 'helper', name: 'Failing helper',
                api: 'custom', mode: 'cc', model: 'failed-helper', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                connectionProfile: 'helper', trackerCompanionAutoLoopVersion: 4 } };
            saved.extension_settings.translate = { provider: 'libre', target_language: 'fr', internal_language: 'en',
                auto_mode: 'none' };
        } });
        // Keep even an unexpected translation request on this disposable local provider.
        await account.post('/api/secrets/write', { key: 'libre_url', value: app.provider.url + '/translate' });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        const agent = { id: 'helper', name: 'Failing helper', enabled: true, phase: 'post',
            prompt: 'Revise the reply.', connectionProfile: 'helper',
            postProcess: { enabled: false, promptTransformEnabled: true } };
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'helper.json'), JSON.stringify(agent));
        const page = await openRoleplay(account);
        await page.evaluate(async autoMode => {
            const { extension_settings } = await import('/scripts/extensions.js');
            extension_settings.translate.auto_mode = autoMode;
        }, change === 'settings' ? 'responses' : 'none');
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
            await expect(preview).toContainText(answer);
            // eslint-disable-next-line playwright/no-conditional-in-test -- Each scenario makes its specified external edit.
            if (change !== 'settings') {
                await fs.writeFile(path.join(directory, 'helper.json'), JSON.stringify({ ...agent, prompt: 'An edited instruction.' }));
            } else {
                const saved = JSON.parse((await account.post('/api/settings/get')).settings);
                saved.active_character = 'a-different-character.png';
                await account.post('/api/settings/save', saved);
            }
            app.provider.mode.reply = null;
            app.provider.mode.fail = true;
            await page.close();
            expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
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
        await account.settled(jobId);
        const reopened = await openRoleplay(account);
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText(answer);
        expect(await reopened.evaluate(async text => (await import('/script.js')).chat.filter(message => message.mes === text).length, answer)).toBe(1);
        expect(app.provider.calls.filter(call => call.model === MODEL)).toHaveLength(1);
        expect(app.provider.calls.filter(call => call.model === 'failed-helper')).toHaveLength(1);
        expect(app.provider.calls.filter(call => call.url.endsWith('/translate'))).toHaveLength(0);
        await expect(reopened.locator('#neconyan-roleplay-preview')).toHaveCount(0);
        await reopened.screenshot({ path: `../screenshots/helper-failure-${change}-${viewport}.png`, scale: 'css' });
    });
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

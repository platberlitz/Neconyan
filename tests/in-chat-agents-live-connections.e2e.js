/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(120000);

for (const phone of [true, false]) {
    test(`new companion connections use fresh notes without leaving the chat on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        let sourceRuns = 0;
        const replies = { 'live-source': () => `Source note ${++sourceRuns}.`, 'live-target': () => 'Target note.' };
        app.provider.mode.reply = body => ({ choices: [{ message: { content: replies[body.model]() }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, trackerCompanionAutoLoopVersion: 4,
                connectionProfile: 'durable', companionExecutionMode: 'parallel' } };
        } });
        const page = await account.open({ workspace: false });
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).areAgentsLoaded())).toBe(true);
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            for (const [order, id] of ['live-target', 'live-source'].entries()) {
                const agent = store.createDefaultAgent();
                Object.assign(agent, { id, name: id, execution: 'companion', category: 'companion', enabled: true,
                    prompt: `Write the ${id} note.`, connectionProfile: 'durable', modelOverride: id });
                Object.assign(agent.companion, { trigger: 'auto', includeWorldInfo: false, displayMode: 'panel', history: false });
                agent.injection.order = order;
                await store.saveAgent(agent);
            }
        }, account.avatar);
        const chatId = await page.evaluate(() => window.SillyTavern.getContext().chatId);
        const runNextReply = () => page.evaluate(async () => {
            const core = await import('/script.js');
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
            const message = { mes: 'Continue this existing chat.', name: 'Durable Nova', is_user: false, is_system: false, extra: {} };
            const messageIndex = core.chat.push(message) - 1;
            core.addOneMessage(message);
            await runner.runCompanionStage({ messageIndex, message, activeAgents: store.getEnabledAgents().filter(agent => agent.id.startsWith('live-')) });
        });
        await runNextReply();
        expect(sourceRuns).toBe(1);
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        await expect(page.locator('#ica--settings')).toBeVisible();
        await page.locator('#ica--search').fill('live-target');
        const card = page.locator('#ica--agentList .ica--agent-card').filter({ has: page.locator('.ica--card-name:text-is("live-target")') });
        await expect(card).toHaveCount(1);
        await card.locator('.ica--companion-quick-links > summary').click();
        const source = card.getByRole('group', { name: 'Runs after', exact: true }).getByLabel('live-source', { exact: true });
        await source.check();
        const config = () => page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgentById('live-target').companion);
        await expect.poll(config).toMatchObject({ dependencies: ['live-source'] });
        await expect(source).toBeEnabled();
        const callsBefore = app.provider.calls.length;
        await runNextReply();
        const calls = app.provider.calls.slice(callsBefore);
        expect(calls.map(call => call.model)).toEqual(['live-source', 'live-target']);
        const prompt = JSON.stringify(calls[1].messages);
        expect(prompt).toContain('[Completed companion: live-source]');
        expect(prompt).toContain('Source note 2.');
        expect(prompt).not.toContain('Source note 1.');
        expect(await config()).toMatchObject({ waitForDependencies: true });

        await source.uncheck();
        await expect.poll(config).toMatchObject({ dependencies: [], waitForDependencies: false });
        await expect(source).toBeEnabled();
        const unlinkedStart = app.provider.calls.length;
        await runNextReply();
        const unlinkedTarget = app.provider.calls.slice(unlinkedStart).find(call => call.model === 'live-target');
        expect(JSON.stringify(unlinkedTarget.messages)).not.toContain('Source note');
        expect(await page.evaluate(() => window.SillyTavern.getContext().chatId)).toBe(chatId);
        expect(app.navigationErrors).toEqual([]);
    });
}

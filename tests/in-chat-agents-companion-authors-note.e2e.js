import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(120000);

for (const phone of [true, false]) {
    test(`companion notes read character, persona and chat Author's Notes on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        app.provider.mode.reply = () => ({ choices: [{ message: { content: 'Companion saw the active Author\'s Note.' }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, configureSettings(saved) {
            saved.power_user ??= {};
            saved.power_user.personas = { ...(saved.power_user.personas ?? {}), 'note-hero.png': 'Hero' };
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, trackerCompanionAutoLoopVersion: 4,
                connectionProfile: 'durable', companionExecutionMode: 'parallel' } };
        } });
        const page = await account.open({ workspace: false });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).areAgentsLoaded())).toBe(true);

        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const { setUserAvatar } = await import('/scripts/personas.js');
            await setUserAvatar('note-hero.png', { toastPersonaNameChange: false, readOnlyRoute: true });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const agent = store.createDefaultAgent();
            Object.assign(agent, {
                id: 'authors-note-observer',
                name: 'Author Note Observer',
                execution: 'companion',
                category: 'companion',
                enabled: true,
                prompt: 'Active note macro: {{active-authors-note}}',
                connectionProfile: 'durable',
                modelOverride: 'companion-an-check',
            });
            Object.assign(agent.companion, {
                trigger: 'auto',
                includeAuthorsNote: true,
                includeCharacterCard: false,
                includeWorldInfo: false,
                displayMode: 'panel',
                history: false,
            });
            await store.saveAgent(agent);
        }, account.avatar);

        // Configure Character, Persona and Chat Author's Notes through the real Author's Note panel.
        await page.evaluate(async () => (await import('/scripts/authors-note.js')).openAuthorsNotePanel('chat'));
        await expect(page.locator('#extension_floating_prompt')).toBeVisible();
        await page.locator('#extension_floating_prompt').fill('Chat note for {{char}}.');

        await page.locator('#an_tab_character').click();
        await expect(page.locator('#extension_floating_chara')).toBeVisible();
        await page.locator('#extension_use_floating_chara').check();
        await page.locator('label.an-segment:has(input[name="extension_floating_char_position"][value="1"])').click();
        await page.locator('#extension_floating_chara').fill('Character note before for {{char}}.');

        await page.locator('#an_tab_persona').click();
        await expect(page.locator('#extension_floating_persona')).toBeVisible();
        await page.locator('#extension_use_floating_persona').check();
        await page.locator('label.an-segment:has(input[name="extension_floating_persona_position"][value="2"])').click();
        await page.locator('#extension_floating_persona').fill('Persona note after for {{user}}.');

        const runCompanion = () => page.evaluate(async () => {
            const core = await import('/script.js');
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
            const message = { mes: 'A fresh scene unfolds.', name: 'Durable Nova', is_user: false, is_system: false, extra: {} };
            const messageIndex = core.chat.push(message) - 1;
            core.addOneMessage(message);
            await runner.runCompanionStage({ messageIndex, message, activeAgents: [store.getAgentById('authors-note-observer')] });
        });

        const callsBeforeCombined = app.provider.calls.length;
        await runCompanion();
        const combinedCall = app.provider.calls.slice(callsBeforeCombined).find(call => call.model === 'companion-an-check');
        expect(combinedCall).toBeTruthy();
        const expectedCombined = [
            'Character note before for Durable Nova.',
            'Chat note for Durable Nova.',
            'Persona note after for Hero.',
        ].join('\n');
        expect(combinedCall.messages[0].content).toContain(`Active note macro: ${expectedCombined}`);
        expect(combinedCall.messages[1].content).toContain(`[Author's Note]\n${expectedCombined}`);

        // Clearing the chat-level note still sends active Character and Persona Author's Notes.
        await page.locator('#an_tab_chat').click();
        await page.locator('#extension_floating_prompt').fill('');
        const callsBeforeScopedOnly = app.provider.calls.length;
        await runCompanion();
        const scopedCall = app.provider.calls.slice(callsBeforeScopedOnly).find(call => call.model === 'companion-an-check');
        expect(scopedCall).toBeTruthy();
        const expectedScoped = [
            'Character note before for Durable Nova.',
            'Persona note after for Hero.',
        ].join('\n');
        expect(scopedCall.messages[1].content).toContain(`[Author's Note]\n${expectedScoped}`);
        expect(scopedCall.messages[1].content).not.toContain('Chat note for Durable Nova.');

        // Setting insertion frequency to 0 disables Author's Notes for Companions as well.
        await page.locator('#extension_floating_interval').fill('0');
        const callsBeforeDisabled = app.provider.calls.length;
        await runCompanion();
        const disabledCall = app.provider.calls.slice(callsBeforeDisabled).find(call => call.model === 'companion-an-check');
        expect(disabledCall).toBeTruthy();
        expect(disabledCall.messages[1].content).not.toContain('[Author\'s Note]');

        expect(pageErrors).toEqual([]);
        expect(app.navigationErrors).toEqual([]);
    });
}

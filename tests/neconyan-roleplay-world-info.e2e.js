/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} shared World Info scan activates saved lore`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: settings => {
            settings.world_info_settings.world_info.globalSelect = ['Stage4-fixture'];
            settings.world_info_settings.world_info_budget = 100;
        } });
        await account.post('/api/worldinfo/edit', { name: 'Stage4-fixture', data: { entries: {
            1: { uid: 1, key: ['Original question'], keysecondary: [], content: 'The harbour is safe.',
                order: 100, position: 0, probability: 100, useProbability: true },
            2: { uid: 2, key: ['Original question'], keysecondary: [], content: 'The constructor is safe.',
                order: 90, position: 0, probability: 100, useProbability: true, group: 'constructor' },
            3: { uid: 3, key: ['Original question'], keysecondary: [], content: 'The prototype is safe.',
                order: 80, position: 0, probability: 100, useProbability: true, group: '__proto__' },
        } } });
        const page = await account.open({ workspace: false });
        const result = await page.evaluate(async () => {
            const world = await import('/scripts/world-info.js');
            return world.checkWorldInfo(['Original question.'], 4096, true);
        });
        expect(result.worldInfoBefore).toContain('The harbour is safe.');
        expect(result.worldInfoBefore).toContain('The constructor is safe.');
        expect(result.worldInfoBefore).toContain('The prototype is safe.');
        await page.close();
    });

    test(`${phone ? 'phone' : 'desktop'} depth persona activates lore during a real browser generation`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            settings.world_info_settings.world_info.globalSelect = ['Stage4-persona'];
            settings.world_info_settings.world_info_budget = 100;
            settings.power_user.persona_description = 'The visiting astronomer';
            settings.power_user.persona_description_position = 4;
            settings.power_user.personas[settings.user_avatar] = 'User';
            settings.power_user.persona_descriptions[settings.user_avatar] = {
                description: 'The visiting astronomer', position: 4, depth: 2, role: 0,
                lorebook: '', connections: [], title: '', appendices: [], activeAppendices: {},
            };
        } });
        await account.post('/api/worldinfo/edit', { name: 'Stage4-persona', data: { entries: {
            1: { uid: 1, key: ['The visiting astronomer'], keysecondary: [], content: 'The observatory is open.',
                order: 100, position: 0, probability: 100, useProbability: true },
        } } });
        const page = await account.open({ workspace: false });
        const scan = await page.evaluate(async avatar => {
            const core = await import('/script.js');
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            const id = context.characters.findIndex(character => character.avatar === avatar);
            if (id < 0 || !await core.selectCharacterById(id, { switchMenu: false })) throw new Error('Fixture character unavailable');
            const { power_user } = await import('/scripts/power-user.js');
            const before = { description: power_user.persona_description, position: power_user.persona_description_position };
            const values = [];
            const listener = entries => values.push(...entries.map(entry => entry.content));
            core.eventSource.on(core.event_types.WORLD_INFO_ACTIVATED, listener);
            try { await core.Generate('normal', { suppressUserMessage: true }); }
            finally { core.eventSource.removeListener(core.event_types.WORLD_INFO_ACTIVATED, listener); }
            const after = { description: power_user.persona_description, position: power_user.persona_description_position };
            return { values, before, after };
        }, account.avatar);
        expect(scan.values, JSON.stringify(scan)).toContain('The observatory is open.');
        await page.close();
    });
}

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
        } } });
        const page = await account.open({ workspace: false });
        const result = await page.evaluate(async () => {
            const world = await import('/scripts/world-info.js');
            return world.checkWorldInfo(['Original question.'], 4096, true);
        });
        expect(result.worldInfoBefore).toContain('The harbour is safe.');
        await page.close();
    });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const block = '[WORLD|Culture|Market]\ndetail: Bells mark closing time.\n[/WORLD]';
const profiles = ['broken', 'limited', 'empty', 'prose', 'working'];
const reply = body => ({ choices: [{ message: { role: 'assistant', content: {
    broken: '[WORLD|Market]\nmissing closing tag', limited: block, empty: '',
    prose: 'Mira walked through the market and asked the merchant whether the evening bells had already rung.', working: block,
}[body.model] ?? 'Unexpected request' }, finish_reason: body.model === 'limited' ? 'length' : 'stop' }] });

for (const phone of [true, false]) {
    test(`${phone ? 'phone' : 'desktop'} tracker reaches the fourth fallback without a manual rerun`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.reply = reply;
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.connectionManager.profiles.push(...profiles.map(id => ({
                id, name: id, api: 'custom', mode: 'cc', model: id, 'api-url': app.provider.url,
            })));
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true,
                trackerCompanionAutoLoopVersion: 4, companionConnectionFallbacks: profiles.slice(1) } };
        } });
        const agents = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(agents, { recursive: true });
        await fs.writeFile(path.join(agents, 'fallback-world.json'), JSON.stringify({
            id: 'fallback-world', name: 'Fallback World', enabled: true, category: 'tracker', execution: 'companion',
            connectionProfile: 'broken', prompt: 'Return the world tracker.',
            companion: { trigger: 'manual', includeWorldInfo: false, displayMode: 'panel' },
            postProcess: { enabled: true, type: 'extract', extractVariable: 'world_data',
                extractPattern: '\\[WORLD\\|[^\\]]*\\][\\s\\S]*?\\[\\/WORLD\\]' },
        }));
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const result = await page.evaluate(async () => {
            const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
            return runner.runCompanionAgentOnMessage('fallback-world', 0);
        });
        expect(result).toMatchObject({ status: 'done', content: block, profileId: 'working' });
        expect(app.provider.calls.map(call => call.model)).toEqual(profiles);
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        await expect(page.locator('#ica--tracker-panel')).toContainText('Bells mark closing time.');
    });
}

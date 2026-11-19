/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`a new account starts without an Agents update notice on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone });
        // Startup notices can be asked for before the page shows toasts, so record the request itself.
        await account.context.addInitScript(() => {
            window.newAccountToasts = [];
            let toastr;
            Object.defineProperty(window, 'toastr', {
                configurable: true,
                get: () => toastr,
                set(value) {
                    toastr = value;
                    const success = value?.success;
                    if (typeof success !== 'function') return;
                    value.success = function (message, title, ...rest) {
                        window.newAccountToasts.push(`${title ?? ''} ${message ?? ''}`.trim());
                        return success.call(this, message, title, ...rest);
                    };
                },
            });
        });
        const page = await account.open({ workspace: false });
        // Startup notices appear once the Agents finish their first start, which ends with the Dice Roller defaults.
        await expect.poll(() => page.evaluate(async () => {
            const [{ extension_settings }, store] = await Promise.all([
                import('/scripts/extensions.js'),
                import('/scripts/extensions/in-chat-agents/agent-store.js'),
            ]);
            return store.areAgentsLoaded() && Boolean(extension_settings.inChatAgents?.diceRoller)
                && store.getAgents().some(agent => agent.sourceTemplateId === 'tpl-pathfinder');
        }), { timeout: 60000 }).toBe(true);
        await page.waitForTimeout(1000);
        const pawthfinder = await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const { getPathfinderToolDefinitions } = await import('/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js');
            const agent = store.getAgents().find(item => item.sourceTemplateId === 'tpl-pathfinder');
            return {
                expected: getPathfinderToolDefinitions().map(tool => tool.name).sort(),
                tools: (agent.tools || []).map(tool => tool.name),
                states: Object.keys(agent.settings?.toolStates || {}),
            };
        });
        expect(pawthfinder.tools).toEqual(expect.arrayContaining(pawthfinder.expected));
        expect(pawthfinder.states).toEqual(expect.arrayContaining(pawthfinder.expected));
        expect(await page.evaluate(() => window.newAccountToasts.filter(text => text.includes('Agents updated')))).toEqual([]);
    });
}

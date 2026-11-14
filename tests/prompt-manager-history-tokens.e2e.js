/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

async function showCounts(page, { history, agent }) {
    return page.evaluate(async ({ history, agent }) => {
        const { promptManager, ChatCompletion, Message, MessageCollection } = await import('/scripts/openai.js');
        const completion = new ChatCompletion();
        const main = await Message.createAsync('system', 'Stay in character.', 'main');
        completion.messages.add(new MessageCollection('main', main));
        if (history) {
            const message = await Message.createAsync('user', history, 'chat-0');
            completion.messages.add(new MessageCollection('chatHistory', message));
        }
        if (agent) {
            completion.messages.add(await Message.createAsync('system', agent, 'inchat_agent_fixture'));
        }
        await completion.buildRuntimeAgentMessages();
        promptManager.setChatCompletion(completion);
        await promptManager.renderPromptManager();
        await promptManager.renderPromptManagerListItems();
        return {
            total: completion.messages.getTokens(),
            history: completion.messages.getItemByIdentifier('chatHistory')?.getTokens() ?? 0,
            agent: completion.getRuntimeAgentMessages().getTokens(),
        };
    }, { history, agent });
}

for (const phone of [true, false]) {
    test(`Presets summarises chat history tokens between total and agents (${phone ? 'phone' : 'desktop'})`, async ({ app }) => {
        const account = await app.account({ activeConnection: true, phone,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: false });
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
        await page.getByRole('tab', { name: 'Prompts', exact: true }).click();
        const summary = page.locator('.prompt_manager_header_tokens');
        await expect(summary).toBeVisible();
        await page.evaluate(async () => {
            const { promptManager } = await import('/scripts/openai.js');
            // Finish the panel's initial dry run before installing the counted messages.
            await promptManager.tryGenerate();
            ++promptManager.renderRequestId;
        });
        if (phone) await applyIOSOnlyCss(page);

        const counts = await showCounts(page, { history: 'Tell me about the old observatory.', agent: 'Keep the scene at night.' });
        expect(counts.history).toBeGreaterThan(0);
        expect(counts.agent).toBeGreaterThan(0);
        await summary.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        if (process.env.NECONYAN_TOKEN_SCREENSHOTS) {
            await page.screenshot({ path: `../screenshots/presets-history-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_TOKEN_SCREENSHOTS}.png` });
        }
        await expect(summary).toHaveText(`Total Tokens: ${counts.total} · Chat History Tokens: ${counts.history} · Agent Tokens: ${counts.agent}`);
        await expect(page.locator('[data-pm-identifier="chatHistory"] .prompt_manager_prompt_tokens')).toHaveText(String(counts.history));
        const layout = await summary.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, width: element.clientWidth, scrollWidth: element.scrollWidth,
                fontSize: Number.parseFloat(getComputedStyle(element).fontSize) };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(page.viewportSize().width);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.fontSize).toBeGreaterThanOrEqual(11);

        const updated = await showCounts(page, { history: 'Tell me about the old observatory. '.repeat(20), agent: '' });
        expect(updated.history).toBeGreaterThan(counts.history);
        await expect(summary).toHaveText(`Total Tokens: ${updated.total} · Chat History Tokens: ${updated.history}`);
        await expect(page.locator('[data-pm-identifier="chatHistory"] .prompt_manager_prompt_tokens')).toHaveText(String(updated.history));

        const empty = await showCounts(page, { history: '', agent: '' });
        await expect(summary).toHaveText(`Total Tokens: ${empty.total} · Chat History Tokens: 0`);
    });
}

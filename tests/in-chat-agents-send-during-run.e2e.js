/* global window */
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- Uses an owned server and a deterministic model provider.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable agent fixture.');

const cases = [
    { kind: 'post', phone: false, rewritesReply: true },
    { kind: 'companion', phone: true, rewritesReply: false },
];

for (const { kind, phone, rewritesReply } of cases) {
    test(`a non-streamed reply unlocks Send while a ${kind} Agent runs on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        app.provider.mode.hold = 'held-agent';
        app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant',
            content: body.model === 'held-agent' ? 'Agent output.' : 'Main reply.' } }] });
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        // eslint-disable-next-line playwright/no-networkidle -- Inspect after the disposable preview finishes startup.
        await page.waitForLoadState('networkidle');
        await page.evaluate(async ({ avatar, kind }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            store.setGlobalSettings({ enabled: true, appendAgentsExecutionMode: 'parallel' });
            const agent = store.createDefaultAgent();
            if (kind === 'post') {
                await store.saveAgent({ ...agent, id: 'held', name: 'Held', enabled: true, phase: 'post', execution: 'inline',
                    category: 'custom', prompt: 'Rewrite the reply.', modelOverride: 'held-agent',
                    postProcess: { ...agent.postProcess, promptTransformEnabled: true, promptTransformMode: 'rewrite' } });
            } else {
                await store.saveAgent({ ...agent, id: 'held', name: 'Held', enabled: true, category: 'companion',
                    execution: 'companion', prompt: 'Write a note.', modelOverride: 'held-agent',
                    companion: { ...(agent.companion || {}), trigger: 'auto', displayMode: 'card' } });
            }
        }, { avatar: account.avatar, kind });
        await acknowledgeActiveSettings(page);
        const chatState = () => page.evaluate(async () => {
            const core = await import('/script.js');
            const runner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
            return { generating: core.isGenerating(), agentsActive: runner.isAgentGenerationActive(),
                messages: core.chat.map(message => `${message.is_user ? 'user' : 'char'}: ${message.mes}`) };
        });
        const heldAgentCalls = () => app.provider.calls.filter(call => call.model === 'held-agent').length;

        await page.locator('#send_textarea').fill('First message.');
        await page.locator('#send_but').click();
        await expect.poll(heldAgentCalls, { timeout: 60000 }).toBeGreaterThan(0);

        await expect.poll(async () => (await chatState()).generating, { timeout: 15000 }).toBe(false);
        const whileHeld = await chatState();
        expect(whileHeld.agentsActive).toBe(true);
        expect(whileHeld.messages.at(-1)).toBe('char: Main reply.');
        await expect(page.locator('#send_but')).toBeVisible();
        await expect(page.locator('#mes_stop')).toBeHidden();
        await expect(page.locator('#ica--cancel-agents')).toBeVisible();

        await page.locator('#send_textarea').fill('Second message.');
        await page.locator('#send_but').click();
        await expect.poll(async () => (await chatState()).messages.includes('user: Second message.'), { timeout: 15000 }).toBe(true);
        await expect(page.locator('#send_textarea')).toHaveValue('');

        await app.release();
        await expect.poll(async () => {
            const state = await chatState();
            return !state.generating && !state.agentsActive;
        }, { timeout: 60000 }).toBe(true);
        await expect(page.locator('#send_but')).toBeVisible();
        const finalMessages = (await chatState()).messages;
        expect(finalMessages).toContain('user: First message.');
        expect(finalMessages.at(-1) === 'char: Agent output.').toBe(rewritesReply);
    });
}

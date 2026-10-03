/* global window */
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- Uses an owned server and a deterministic model provider.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable agent fixture.');

for (const phone of [false, true]) {
    test(`manual pre and post agents run during Companions on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true });
        app.provider.mode.hold = 'held-companion';
        const replies = { 'held-companion': 'Companion note survives both rewrites.',
            'manual-pre': 'Rewritten by manual-pre.', 'manual-post': 'Rewritten by manual-post.' };
        app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: replies[body.model] } }] });
        const page = await account.open({ workspace: false });
        // eslint-disable-next-line playwright/no-networkidle -- Inspect after the disposable preview finishes startup.
        await page.waitForLoadState('networkidle');
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            store.setGlobalSettings({ enabled: true, appendAgentsExecutionMode: 'sequential' });
            for (const phase of ['pre', 'post']) {
                const agent = store.createDefaultAgent();
                await store.saveAgent({ ...agent, id: `manual-${phase}`, name: `Manual ${phase}`, enabled: true, phase,
                    execution: 'inline', category: 'custom', prompt: 'Rewrite the reply.', modelOverride: `manual-${phase}`,
                    postProcess: { ...agent.postProcess, promptTransformEnabled: true, promptTransformMode: 'rewrite' } });
            }
            await store.saveAgent({ ...store.createDefaultAgent(), id: 'held-companion', name: 'Held Companion', enabled: true,
                execution: 'companion', category: 'custom', prompt: 'Write a separate note.', modelOverride: 'held-companion',
                companion: { trigger: 'manual' } });
            window.NeconyanShell.openTab('left', 'agents');
        }, account.avatar);
        await acknowledgeActiveSettings(page);
        await page.locator('#ica--agentTabs [data-tab="all"]:visible, #ica--agentViewSelect:visible').evaluate(element => {
            if (element.tagName === 'SELECT') {
                element.value = 'all';
                element.dispatchEvent(new Event('change', { bubbles: true }));
            } else element.click();
        });
        await page.locator('#ica--search').fill('Held Companion');
        // Use the rendered Run controls for both kinds of request.
        await page.locator('#ica--agentList [data-agent-id="held-companion"] .ica--btn-run').click();
        await expect.poll(() => app.provider.calls.filter(call => call.model === 'held-companion').length).toBe(1);
        for (const phase of ['pre', 'post']) {
            await page.locator('#ica--search').fill(`Manual ${phase}`);
            const run = page.locator(`#ica--agentList [data-agent-id="manual-${phase}"] .ica--btn-run`);
            await expect(run).toBeEnabled();
            await run.click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes)).toBe(`Rewritten by manual-${phase}.`);
            expect(app.provider.calls.find(call => call.model === 'held-companion').completedAt).toBeNull();
            const geometry = await run.evaluate(element => ({ width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height, display: window.getComputedStyle(element).display,
                touchPoints: window.navigator.maxTouchPoints }));
            expect(geometry.width).toBeGreaterThan(0);
            expect(geometry.height).toBeGreaterThan(0);
            expect(geometry.display).not.toBe('none');
            expect(geometry.touchPoints > 0).toBe(phone);
            await info.attach(`${phase}-run-control`, { body: JSON.stringify(geometry), contentType: 'application/json' });
        }
        await app.release();
        await expect.poll(() => page.evaluate(async () => {
            const runtime = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
            return runtime.getCompanionResults(window.SillyTavern.getContext().chat.at(-1))['held-companion'];
        })).toMatchObject({ status: 'done', content: 'Companion note survives both rewrites.' });
        await page.screenshot({ path: info.outputPath('manual-agents-completed.png') });
    });
}

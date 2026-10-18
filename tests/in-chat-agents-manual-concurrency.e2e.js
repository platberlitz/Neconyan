/* global document, window */
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- Uses an owned server and a deterministic model provider.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable agent fixture.');

async function openRerunFixture(app, { phone, mode, reply, hold = '' }) {
    app.provider.mode.hold = hold;
    if (reply !== undefined) app.provider.mode.reply = reply;
    const account = await app.account({ phone, activeConnection: true });
    const page = await account.open({ workspace: false });
    // eslint-disable-next-line playwright/no-networkidle -- Inspect after the disposable preview finishes startup.
    await page.waitForLoadState('networkidle');
    await page.evaluate(async ({ avatar, executionMode }) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.setGlobalSettings({ enabled: true, appendAgentsExecutionMode: executionMode });
        for (const name of ['first', 'second']) {
            const agent = store.createDefaultAgent();
            await store.saveAgent({ ...agent, id: `rerun-${name}`, name: `Rerun ${name}`, enabled: true, phase: 'post',
                execution: 'inline', category: 'custom', prompt: 'Rewrite the reply.', modelOverride: `rerun-${name}`,
                postProcess: { ...agent.postProcess, promptTransformEnabled: true, promptTransformMode: 'rewrite' } });
        }
        window.NeconyanShell.openTab('left', 'agents');
    }, { avatar: account.avatar, executionMode: mode });
    await acknowledgeActiveSettings(page);
    await page.locator('#ica--agentTabs [data-tab="all"]:visible, #ica--agentViewSelect:visible').evaluate(element => {
        if (element.tagName === 'SELECT') {
            element.value = 'all';
            element.dispatchEvent(new Event('change', { bubbles: true }));
        } else element.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('#ica--agentList [data-agent-id^="rerun-"]').length >= 2);
    const close = page.locator('#left-nav-panel .sb-shell-close');
    await expect(close).toBeVisible();
    await close.click();
    const messageIndex = await page.evaluate(() => window.SillyTavern.getContext().chat
        .findLastIndex(message => message && !message.is_user && !message.is_system));
    const message = page.locator(`#chat .mes[mesid="${messageIndex}"]`);
    await message.locator('.extraMesButtonsHint').click();
    const rerun = message.locator('.mes_rerun_agents');
    await expect(rerun).toBeVisible();
    const originalText = await page.evaluate(index => window.SillyTavern.getContext().chat[index].mes, messageIndex);
    return { account, page, messageIndex, rerun, originalText };
}

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

    test(`manual after-reply agents queue under Run together on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true });
        app.provider.mode.hold = 'manual-first';
        const replies = { 'manual-first': 'Rewritten by manual-first.', 'manual-second': 'Rewritten by manual-second.' };
        app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: replies[body.model] } }] });
        const page = await account.open({ workspace: false });
        // eslint-disable-next-line playwright/no-networkidle -- Inspect after the disposable preview finishes startup.
        await page.waitForLoadState('networkidle');
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            store.setGlobalSettings({ enabled: true, appendAgentsExecutionMode: 'parallel' });
            for (const name of ['first', 'second']) {
                const agent = store.createDefaultAgent();
                await store.saveAgent({ ...agent, id: `manual-${name}`, name: `Manual ${name}`, enabled: true, phase: 'post',
                    execution: 'inline', category: 'custom', prompt: 'Rewrite the reply.', modelOverride: `manual-${name}`,
                    postProcess: { ...agent.postProcess, promptTransformEnabled: true, promptTransformMode: 'rewrite' } });
            }
            window.NeconyanShell.openTab('left', 'agents');
        }, account.avatar);
        await acknowledgeActiveSettings(page);
        await page.locator('#ica--agentTabs [data-tab="all"]:visible, #ica--agentViewSelect:visible').evaluate(element => {
            if (element.tagName === 'SELECT') {
                element.value = 'all';
                element.dispatchEvent(new Event('change', { bubbles: true }));
            } else element.click();
        });
        const callsFor = model => app.provider.calls.filter(call => call.model === model);
        await page.locator('#ica--search').fill('Manual first');
        await page.locator('#ica--agentList [data-agent-id="manual-first"] .ica--btn-run').click();
        await expect.poll(() => callsFor('manual-first').length).toBe(1);
        await page.locator('#ica--search').fill('Manual second');
        const second = page.locator('#ica--agentList [data-agent-id="manual-second"] .ica--btn-run');
        await expect(second).toBeEnabled();
        await second.click();
        // The second run must wait for the first to finish, even with Run together selected.
        // eslint-disable-next-line playwright/no-wait-for-timeout -- Proves a request is not sent during the window.
        await page.waitForTimeout(1500);
        expect(callsFor('manual-second')).toHaveLength(0);
        await app.release();
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes)).toBe('Rewritten by manual-second.');
        const [first] = callsFor('manual-first');
        const [queued] = callsFor('manual-second');
        expect(queued.startedAt).toBeGreaterThanOrEqual(first.completedAt);
        expect(JSON.stringify(queued.messages)).toContain('Rewritten by manual-first.');
        await info.attach('provider-order', { body: JSON.stringify({ first: [first.startedAt, first.completedAt], second: queued.startedAt }), contentType: 'application/json' });
    });

    test(`message Rerun agents runs after-reply agents together on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const replies = { 'rerun-first': 'First rerun.', 'rerun-second': 'Second rerun.' };
        const { page, messageIndex, rerun, originalText } = await openRerunFixture(app, {
            phone,
            mode: 'parallel',
            hold: 'rerun-first',
            reply: body => {
                const content = JSON.stringify(body.messages ?? '').includes('Combine parallel edits')
                    ? 'Combined rerun.'
                    : replies[body.model];
                return { choices: [{ message: { role: 'assistant', content } }] };
            },
        });
        const callsFor = model => app.provider.calls.filter(call => call.model === model);
        await rerun.click();
        await expect(rerun).toHaveClass(/mes_rerun_agents--running/);
        await expect.poll(() => callsFor('rerun-first').length).toBe(1);
        await expect.poll(() => callsFor('rerun-second').length).toBe(1);
        expect(callsFor('rerun-first')[0].completedAt).toBeNull();
        expect(callsFor('rerun-second')[0].completedAt).not.toBeNull();
        await expect.poll(() => page.evaluate(index => window.SillyTavern.getContext().chat[index].mes, messageIndex)).toBe(originalText);
        await app.release();
        await expect.poll(() => page.evaluate(index => window.SillyTavern.getContext().chat[index].mes, messageIndex)).toBe('Combined rerun.');
        await expect(rerun).not.toHaveClass(/mes_rerun_agents--running/);
        const timeline = { first: [callsFor('rerun-first')[0].startedAt, callsFor('rerun-first')[0].completedAt],
            second: [callsFor('rerun-second')[0].startedAt, callsFor('rerun-second')[0].completedAt],
            synthesis: callsFor('rerun-second').slice(1).map(call => [call.startedAt, call.completedAt]) };
        await info.attach('rerun-together-timeline', { body: JSON.stringify(timeline), contentType: 'application/json' });
        await page.evaluate(async index => {
            const runner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
            await runner.undoPromptTransform(index);
        }, messageIndex);
        await expect.poll(() => page.evaluate(index => window.SillyTavern.getContext().chat[index].mes, messageIndex)).toBe(originalText);
        await page.screenshot({ path: info.outputPath('rerun-agents-together.png') });
    });

    test(`message Rerun agents follows Run one at a time on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const replies = { 'rerun-first': 'First rerun.', 'rerun-second': 'Second rerun.' };
        const { page, messageIndex, rerun } = await openRerunFixture(app, {
            phone,
            mode: 'sequential',
            hold: 'rerun-first',
            reply: body => ({ choices: [{ message: { role: 'assistant', content: replies[body.model] } }] }),
        });
        const callsFor = model => app.provider.calls.filter(call => call.model === model);
        await rerun.click();
        await expect.poll(() => callsFor('rerun-first').length).toBe(1);
        // eslint-disable-next-line playwright/no-wait-for-timeout -- Proves the second request waits for the held first one.
        await page.waitForTimeout(1000);
        expect(callsFor('rerun-second')).toHaveLength(0);
        await app.release();
        await expect.poll(() => callsFor('rerun-second').length).toBe(1);
        expect(JSON.stringify(callsFor('rerun-second')[0].messages)).toContain('First rerun.');
        await expect.poll(() => page.evaluate(index => window.SillyTavern.getContext().chat[index].mes, messageIndex)).toBe('Second rerun.');
        await expect(rerun).not.toHaveClass(/mes_rerun_agents--running/);
        const [first] = callsFor('rerun-first');
        const [second] = callsFor('rerun-second');
        expect(second.startedAt).toBeGreaterThanOrEqual(first.completedAt);
        await info.attach('rerun-one-at-a-time-timeline', { body: JSON.stringify({ first: [first.startedAt, first.completedAt], second: second.startedAt }), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('rerun-agents-one-at-a-time.png') });
    });
}

test('message Rerun agents leaves the reply untouched when the agents fail', async ({ app }, info) => {
    const { page, messageIndex, rerun, originalText } = await openRerunFixture(app, { phone: false, mode: 'sequential', reply: null });
    app.provider.mode.fail = true;
    await rerun.click();
    await expect(page.locator('#toast-container .toast-warning').filter({ hasText: 'left unchanged' })).toBeVisible();
    await expect(rerun).not.toHaveClass(/mes_rerun_agents--running/);
    await expect.poll(() => page.evaluate(index => window.SillyTavern.getContext().chat[index].mes, messageIndex)).toBe(originalText);
    expect(await page.evaluate(index => window.SillyTavern.getContext().chat[index].extra?.inChatAgentTransformHistory, messageIndex)).toBeUndefined();
    await page.screenshot({ path: info.outputPath('rerun-agents-failed.png') });
});

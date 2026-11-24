/* global window, document */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const notes = { 'slow-card': 'Slow card note', 'slow-panel': 'Slow panel note', quick: 'Quick note' };
const reply = body => ({ choices: [{ message: { role: 'assistant', content: notes[body.model] ?? 'Unexpected request' }, finish_reason: 'stop' }] });
const companion = (id, displayMode) => ({
    id, name: id, enabled: true, category: 'custom', execution: 'companion', connectionProfile: id,
    prompt: `Write the ${id} note.`, companion: { trigger: 'manual', includeWorldInfo: false, displayMode },
});

const disabledActions = async (root, actions) => root.evaluate((node, wanted) => wanted
    .filter(action => !node.querySelector(`button[data-action="${action}"]`)?.disabled), actions);

for (const phone of [true, false]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size} Stop ends one writing companion and leaves the others running`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.reply = reply;
        app.provider.mode.hold = ['slow-card', 'slow-panel'];
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.connectionManager.profiles.push(...Object.keys(notes).map(id => ({
                id, name: id, api: 'custom', mode: 'cc', model: id, 'api-url': app.provider.url,
            })));
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, trackerCompanionAutoLoopVersion: 4 } };
        } });
        const agents = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(agents, { recursive: true });
        await fs.writeFile(path.join(agents, 'slow-card.json'), JSON.stringify(companion('slow-card', 'card')));
        await fs.writeFile(path.join(agents, 'slow-panel.json'), JSON.stringify(companion('slow-panel', 'panel')));
        await fs.writeFile(path.join(agents, 'quick.json'), JSON.stringify(companion('quick', 'panel')));
        const page = await account.open({ workspace: false });
        try {
            await page.evaluate(async avatar => {
                const core = await import('/script.js');
                await core.getCharacters();
                await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            }, account.avatar);
            await page.evaluate(async () => {
                const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                window.__companionRuns = ['slow-card', 'slow-panel'].map(id => runner.runCompanionAgentOnMessage(id, 0)
                    .then(result => ({ id, status: result?.status ?? null }), error => ({ id, error: String(error) })));
                await (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            });
            await expect.poll(() => app.provider.calls.map(call => call.model).sort()).toEqual(['slow-card', 'slow-panel']);

            const card = page.locator('#chat .mes[mesid="0"] .ica--companion-card[data-agent-id="slow-card"]');
            await expect(card.locator('button[data-action="stop"]')).toBeEnabled();
            expect(await disabledActions(card, ['regenerate', 'fix', 'edit', 'copy', 'delete'])).toEqual([]);

            const panel = page.locator('#ica--tracker-panel');
            const panelEntry = panel.locator('.ica--tpanel-agent[data-agent-id="slow-panel"]');
            await expect(panelEntry.locator('button[data-action="panel-stop"]')).toBeEnabled();
            expect(await disabledActions(panelEntry, ['panel-hide', 'panel-run-latest', 'panel-regenerate', 'panel-fix',
                'panel-edit-note', 'panel-open-window', 'panel-edit', 'panel-jump'])).toEqual([]);
            expect(await disabledActions(panel, ['panel-regenerate-all', 'panel-run-auto'])).toEqual([]);

            await page.evaluate(() => document.querySelectorAll('#toast-container, #nn-update-toast').forEach(node => { node.style.display = 'none'; }));
            await page.screenshot({ path: `../screenshots/companion-stop-panel-${size}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png` });
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel?.());
            await card.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `../screenshots/companion-stop-card-${size}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png` });

            await card.locator('button[data-action="stop"]').click();
            await expect(card).toHaveClass(/ica--companion-card--cancelled/);
            await expect(card.locator('button[data-action="stop"]')).toHaveCount(0);
            expect(await card.evaluate(node => [...node.querySelectorAll('.ica--companion-actions button')]
                .filter(button => button.disabled).map(button => button.dataset.action))).toEqual([]);

            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
            await expect(panelEntry.locator('button[data-action="panel-stop"]')).toBeEnabled();
            await panelEntry.locator('button[data-action="panel-stop"]').click();
            await expect(panelEntry.locator('button[data-action="panel-stop"]')).toHaveCount(0);
            await expect.poll(() => page.evaluate(async () => Promise.all(window.__companionRuns))).toEqual([
                { id: 'slow-card', status: 'cancelled' }, { id: 'slow-panel', status: 'cancelled' },
            ]);
            await expect(panelEntry.locator('button[data-action="panel-regenerate"]')).toBeEnabled();

            const quick = await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js'))
                .runCompanionAgentOnMessage('quick', 0));
            expect(quick).toMatchObject({ status: 'done', content: 'Quick note' });
        } finally {
            await fetch(`${app.provider.url.replace(/\/v1$/, '')}/fixture/release`, { method: 'POST', body: '{}' }).catch(() => {});
        }
    });
}

test('Stop reaches a companion that is writing on the server', async ({ app }) => {
    test.setTimeout(180000);
    app.provider.mode.reply = reply;
    app.provider.mode.hold = ['slow-card', 'slow-panel'];
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.reply_generation_location = 'server';
        saved.extension_settings.connectionManager.profiles.push(...Object.keys(notes).map(id => ({
            id, name: id, api: 'custom', mode: 'cc', model: id, 'api-url': app.provider.url,
        })));
        saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, trackerCompanionAutoLoopVersion: 4 } };
    } });
    const agents = path.join(app.dataRoot, 'default-user', 'InChatAgents');
    await fs.mkdir(agents, { recursive: true });
    await fs.writeFile(path.join(agents, 'slow-card.json'), JSON.stringify(companion('slow-card', 'card')));
    await fs.writeFile(path.join(agents, 'slow-panel.json'), JSON.stringify(companion('slow-panel', 'panel')));
    const page = await account.open({ workspace: false });
    try {
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);

        await page.evaluate(async () => {
            const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
            window.__companionRun = runner.runCompanionAgentOnMessage('slow-panel', 0)
                .then(result => ({ status: result?.status ?? null }), error => ({ error: String(error) }));
            await (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
        });
        await expect.poll(() => app.provider.calls.map(call => call.model)).toEqual(['slow-panel']);
        const panel = page.locator('#ica--tracker-panel');
        const panelEntry = panel.locator('.ica--tpanel-agent[data-agent-id="slow-panel"]');
        await expect(panelEntry.locator('button[data-action="panel-stop"]')).toBeEnabled();
        expect(await disabledActions(panelEntry, ['panel-run-latest', 'panel-edit', 'panel-open-window'])).toEqual([]);
        await panelEntry.locator('button[data-action="panel-stop"]').click();
        await expect.poll(() => page.evaluate(() => window.__companionRun)).toEqual({ status: 'cancelled' });
        await expect(panelEntry.locator('button[data-action="panel-stop"]')).toHaveCount(0);
        await expect(panelEntry.locator('button[data-action="panel-run-latest"]')).toBeEnabled();

        await page.evaluate(async () => {
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel();
            const runner = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
            window.__companionRun = runner.runCompanionAgentOnMessage('slow-card', 0)
                .then(result => ({ status: result?.status ?? null }), error => ({ error: String(error) }));
        });
        await expect.poll(() => app.provider.calls.map(call => call.model)).toEqual(['slow-panel', 'slow-card']);
        const card = page.locator('#chat .mes[mesid="0"] .ica--companion-card[data-agent-id="slow-card"]');
        await expect(card.locator('button[data-action="stop"]')).toBeEnabled();
        expect(await disabledActions(card, ['regenerate', 'fix', 'edit', 'copy', 'delete'])).toEqual([]);
        await card.locator('button[data-action="stop"]').click();
        await expect.poll(() => page.evaluate(() => window.__companionRun)).toEqual({ status: 'cancelled' });
        await expect(card).toHaveClass(/ica--companion-card--cancelled/);
    } finally {
        await fetch(`${app.provider.url.replace(/\/v1$/, '')}/fixture/release`, { method: 'POST', body: '{}' }).catch(() => {});
    }
});

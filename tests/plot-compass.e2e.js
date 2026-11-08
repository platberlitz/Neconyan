/* global document, getComputedStyle, window */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

test.setTimeout(180000);

for (const phone of [true, false]) {
    test(`Plot Compass plans before a reply on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const baseline = process.env.PLOT_COMPASS_BASELINE_ROOT;
        if (baseline) await app.restart({ checkoutRoot: baseline });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, connectionProfile: 'durable', trackerCompanionAutoLoopVersion: 4 } };
        } });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Bring a sealed letter into the scene.' }, finish_reason: 'stop' }] };
        const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
            ch_name: 'Plot Director', description: 'A character with no greeting.', first_mes: '',
        } });
        expect(created.ok()).toBe(true);
        const avatar = await created.text();
        const chatName = 'Plot Compass empty chat';
        const request = { avatar_url: avatar, file_name: chatName };
        const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...request, allow_create: true } });
        expect(vacant.ok()).toBe(true);
        const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...request, chat: [{ chat_metadata: {} }],
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        const page = await account.open({ workspace: false });
        const opened = await page.evaluate(async ({ avatar, chatName }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/plot-compass-companion.json')).json();
            await store.saveAgent({ ...template, id: 'plot-fixture', sourceTemplateId: template.id, enabled: true,
                connectionProfile: 'durable', companion: { ...template.companion, trigger: 'manual', displayMode: 'panel' } });
            const openedChat = await (await import('/script.js')).openSavedCharacterChat(avatar, chatName);
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            return { openedChat, chatId: context.getCurrentChatId(), messages: context.chat.map(message => message.mes) };
        }, { avatar, chatName });
        await acknowledgeActiveSettings(page);
        expect(opened).toEqual({ openedChat: true, chatId: chatName, messages: [] });
        const panel = page.locator('#ica--tracker-panel');
        const section = panel.locator('[data-agent-id="plot-fixture"]');
        const objective = section.locator('[data-role="plot-compass-objective"]');
        await expect(objective).toBeVisible();
        await page.evaluate(() => window.toastr?.remove());
        await panel.evaluate(root => Promise.all(root.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))));
        await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
        await page.screenshot({ path: new URL(`../screenshots/plot-compass-${phone ? 'phone' : 'desktop'}-${baseline ? 'before' : 'after'}.png`, import.meta.url).pathname, scale: 'css' });
        if (baseline) return;

        const scope = section.locator('[data-role="plot-compass-scope"]');
        await scope.selectOption('chat');
        await objective.fill('Find the missing letter');
        await objective.press('Enter');
        await expect(section).toContainText('Bring a sealed letter into the scene.', { timeout: 30000 });
        await expect(section).toContainText('Before the conversation');
        expect(app.provider.calls).toHaveLength(1);
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('Find the missing letter');
        const saved = await account.post('/api/chats/get', request);
        expect(saved).toHaveLength(1);
        expect(saved[0].chat_metadata.inChatAgentPlotCompassOpeningNotes['plot-fixture'].content).toBe('Bring a sealed letter into the scene.');
        const geometry = await panel.evaluate(root => {
            const control = root.querySelector('[data-role="plot-compass-scope"]');
            const bounds = control.getBoundingClientRect();
            return { viewport: window.innerWidth, document: document.documentElement.scrollWidth, panelWidth: root.clientWidth,
                panelScrollWidth: root.scrollWidth, left: bounds.left, right: bounds.right, height: bounds.height,
                colour: getComputedStyle(control).color, display: getComputedStyle(control).display };
        });
        expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.panelScrollWidth).toBeLessThanOrEqual(geometry.panelWidth + 1);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.height).toBeGreaterThan(0);

        await scope.selectOption('global');
        await expect(objective).toHaveValue('');
        await objective.fill('An unsaved shared idea');
        await scope.selectOption('chat');
        await expect(objective).toHaveValue('Find the missing letter');
        await scope.selectOption('global');
        await expect(objective).toHaveValue('An unsaved shared idea');
        await objective.fill('');
        await scope.selectOption('chat');
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).refreshCompanionPanel());
        await expect(scope).toHaveValue('chat');
        await expect(objective).toHaveValue('Find the missing letter');

        // A save from the agent editor must refresh an untouched field, but not a draft.
        await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const { getPlotCompassIdentity } = await import('/scripts/extensions/in-chat-agents/companion/plot-compass-context.js');
            const { setPlotCompassObjective } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
            await store.saveAgent('plot-fixture', { update: agent => {
                agent.settings = setPlotCompassObjective(agent.settings, getPlotCompassIdentity(), 'chat', 'Find the secret passage');
                return agent;
            } });
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).refreshCompanionPanel();
        });
        await expect(objective).toHaveValue('Find the secret passage');
        await objective.fill('A draft to keep');
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).refreshCompanionPanel());
        await expect(objective).toHaveValue('A draft to keep');

        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('I open the door.');
        await startNativeReply(page);
        const { jobId } = await (await submitted).json();
        await account.settled(jobId);
        expect(JSON.stringify(app.provider.calls.at(-1).messages)).toContain('Bring a sealed letter into the scene.');
        await expect.poll(() => page.evaluate(async () => !(await import('/script.js')).is_send_press), { timeout: 30000 }).toBe(true);

        const secondName = 'Plot Compass user-only chat';
        const secondRequest = { avatar_url: avatar, file_name: secondName };
        const secondVacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...secondRequest, allow_create: true } });
        expect(secondVacant.ok()).toBe(true);
        const secondRoleplay = JSON.parse(secondVacant.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...secondRequest, chat: [{ chat_metadata: {} },
            { name: 'You', is_user: true, is_system: false, mes: 'I find a clue.', send_date: Date.now(), extra: {} }],
        roleplay: { account: secondRoleplay.account, vacancy: secondRoleplay.vacancy, operationKey: randomUUID() } });
        const secondOpened = await page.evaluate(async ({ avatar, secondName }) => (await import('/script.js')).openSavedCharacterChat(avatar, secondName), { avatar, secondName });
        expect(secondOpened).toBe(true);
        await expect(scope).toHaveValue('chat');
        await expect(objective).toHaveValue('');
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'A stranger notices the clue.' }, finish_reason: 'stop' }] };
        await objective.fill('Follow the clue');
        await objective.press('Enter');
        await expect(section).toContainText('A stranger notices the clue.', { timeout: 30000 });
        await expect.poll(async () => {
            const savedChat = await account.post('/api/chats/get', secondRequest);
            return savedChat[1]?.extra?.inChatAgentCompanionResults?.['plot-fixture']?.content;
        }, { timeout: 30000 }).toBe('A stranger notices the clue.');
        expect(JSON.stringify(app.provider.calls.at(-1).messages)).toContain('Follow the clue');
        expect(JSON.stringify(app.provider.calls.at(-1).messages)).not.toContain('Find the secret passage');
        const firstReopened = await page.evaluate(async ({ avatar, chatName }) => (await import('/script.js')).openSavedCharacterChat(avatar, chatName), { avatar, chatName });
        expect(firstReopened).toBe(true);
        await expect(objective).toHaveValue('Find the secret passage');
    });
}

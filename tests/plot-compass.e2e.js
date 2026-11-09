/* global document, getComputedStyle, window */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

test.setTimeout(300000);

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
                version: 2, settings: { plotCompassScope: 'global', plotCompassObjective: 'Keep a hopeful tone',
                    plotCompassObjectives: { [JSON.stringify(['character', avatar])]: 'Reveal the family secret', [JSON.stringify(['character', avatar, chatName])]: 'Find the missing letter' } },
                connectionProfile: 'durable', companion: { ...template.companion, trigger: 'manual', displayMode: 'panel' } });
            const openedChat = await (await import('/script.js')).openSavedCharacterChat(avatar, chatName);
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            return { openedChat, chatId: context.getCurrentChatId(), messages: context.chat.map(message => message.mes) };
        }, { avatar, chatName });
        await acknowledgeActiveSettings(page);
        expect(opened).toEqual({ openedChat: true, chatId: chatName, messages: [] });
        const panel = page.locator('#ica--tracker-panel');
        const section = panel.locator('[data-agent-id="plot-fixture"]');
        const field = scope => section.locator(`[data-role="plot-compass-objective"][data-plot-scope="${scope}"]`);
        const toggle = scope => section.locator(`[data-role="plot-compass-enabled"][data-plot-scope="${scope}"]`);
        const objective = field('chat');
        const save = section.locator('[data-action="panel-plot-compass-save"]');
        await expect(section.locator('[data-role="plot-compass-objective"]').first()).toBeVisible();
        await page.evaluate(() => window.toastr?.remove());
        await page.locator('[data-crash-action="dismiss"]').evaluateAll(buttons => buttons.forEach(button => button.click()));
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        await expect(section.locator('[data-role="plot-compass-objective"]').first()).toBeVisible();
        await panel.evaluate(root => Promise.all(root.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))));
        await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
        await page.screenshot({ path: new URL(`../screenshots/plot-compass-${phone ? 'phone' : 'desktop'}-${baseline ? 'before' : 'after'}.png`, import.meta.url).pathname, scale: 'css' });
        if (baseline) {
            await section.locator('[data-action="panel-edit"]').click();
            const editor = page.locator('#ica--editor');
            await expect(editor).toBeVisible();
            await editor.locator('[data-editor-tab="companion"]').click();
            await editor.locator('#ica--plot-compass-objective-row').scrollIntoViewIfNeeded();
            await page.screenshot({ path: new URL(`../screenshots/plot-compass-editor-${phone ? 'phone' : 'desktop'}-before.png`, import.meta.url).pathname, scale: 'css' });
            return;
        }

        // Existing v2 settings are composed automatically, including a legacy global selection.
        await expect(field('global')).toHaveValue('Keep a hopeful tone');
        await expect(field('character')).toHaveValue('Reveal the family secret');
        await expect(objective).toHaveValue('Find the missing letter');
        await objective.press('Enter');
        await expect(section).toContainText('Bring a sealed letter into the scene.', { timeout: 30000 });
        await expect(section).toContainText('Before the conversation');
        expect(app.provider.calls).toHaveLength(1);
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('Find the missing letter');
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('Keep a hopeful tone');
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('Reveal the family secret');
        const saved = await account.post('/api/chats/get', request);
        expect(saved).toHaveLength(1);
        expect(saved[0].chat_metadata.inChatAgentPlotCompassOpeningNotes['plot-fixture'].content).toBe('Bring a sealed letter into the scene.');
        const geometry = await panel.evaluate(root => {
            const control = root.querySelector('[data-action="panel-plot-compass-save"]');
            const bounds = control.getBoundingClientRect();
            return { viewport: window.innerWidth, document: document.documentElement.scrollWidth, panelWidth: root.clientWidth,
                panelScrollWidth: root.scrollWidth, left: bounds.left, right: bounds.right, height: bounds.height,
                colour: getComputedStyle(control).color, display: getComputedStyle(control).display };
        });
        expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.panelScrollWidth).toBeLessThanOrEqual(geometry.panelWidth + 1);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.height).toBeGreaterThanOrEqual(44);

        // Every switch affects the next real request; switching off retains the saved text.
        for (const scope of ['global', 'character', 'chat']) {
            const count = app.provider.calls.length;
            await toggle(scope).uncheck();
            await save.click();
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(count + 1);
            await expect(save).toBeEnabled();
            const prompt = JSON.stringify(app.provider.calls.at(-1).messages);
            expect(prompt).not.toContain('Keep a hopeful tone');
            if (scope !== 'global') expect(prompt).not.toContain('Reveal the family secret');
            if (scope === 'chat') expect(prompt).toContain('[Plot Compass Objective]\\nnone set');
            else expect(prompt).toContain('Find the missing letter');
        }
        // Reload checks both stored switches and the automatic upgrade of a saved v2 agent.
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgentById('plot-fixture')?.version), { timeout: 30000 }).toBe(2);
        await page.evaluate(async ({ avatar, chatName }) => {
            await (await import('/script.js')).openSavedCharacterChat(avatar, chatName);
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
        }, { avatar, chatName });
        for (const scope of ['global', 'character', 'chat']) await expect(toggle(scope)).not.toBeChecked();
        await expect(objective).toHaveValue('Find the missing letter');
        for (const scope of ['global', 'character', 'chat']) await toggle(scope).check();
        await save.click();
        await expect(save).toBeEnabled();

        await field('global').fill('An unsaved shared idea');
        await toggle('character').uncheck();
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).refreshCompanionPanel());
        await expect(objective).toHaveValue('Find the missing letter');
        await expect(field('global')).toHaveValue('An unsaved shared idea');
        await expect(toggle('character')).not.toBeChecked();
        await field('global').fill('Keep a hopeful tone');
        await toggle('character').check();

        // A save from the agent editor must refresh an untouched field, but not a draft.
        await section.locator('[data-action="panel-edit"]').click();
        const editor = page.locator('#ica--editor');
        await expect(editor).toBeVisible();
        await editor.locator('[data-editor-tab="companion"]').click();
        await editor.locator('[data-role="plot-compass-objective"][data-plot-scope="chat"]').fill('Find the secret passage');
        await editor.locator('[data-role="plot-compass-enabled"][data-plot-scope="global"]').uncheck();
        await editor.locator('#ica--plot-compass-objective-row').scrollIntoViewIfNeeded();
        await page.screenshot({ path: new URL(`../screenshots/plot-compass-editor-${phone ? 'phone' : 'desktop'}-after.png`, import.meta.url).pathname, scale: 'css' });
        await page.locator('dialog.popup:visible .popup-button-ok').click();
        await expect(editor).toBeHidden();
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        await expect(objective).toHaveValue('Find the secret passage');
        await expect(toggle('global')).not.toBeChecked();
        await toggle('global').check();
        await save.click();
        await expect(save).toBeEnabled();
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
        await expect(objective).toHaveValue('');
        await expect(field('global')).toHaveValue('Keep a hopeful tone');
        await expect(field('character')).toHaveValue('Reveal the family secret');
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
        expect(JSON.stringify(app.provider.calls.at(-1).messages)).toContain('Reveal the family secret');
        // The message-card controls save the same layers as the panel and editor.
        await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const agent = store.getAgentById('plot-fixture');
            await store.saveAgent({ ...agent, companion: { ...agent.companion, displayMode: 'card' } });
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel();
            (await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js')).refreshCompanionCards();
        });
        const card = page.locator('#chat .ica--companion-card[data-agent-id="plot-fixture"]');
        await card.evaluate(element => { element.open = true; });
        const cardObjective = card.locator('[data-role="plot-compass-objective"][data-plot-scope="chat"]');
        await expect(cardObjective).toHaveValue('Follow the clue');
        await cardObjective.fill('Follow the clue from the card');
        const cardCallCount = app.provider.calls.length;
        await cardObjective.press('Enter');
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(cardCallCount + 1);
        await expect(card.locator('[data-action="plot-compass-save"]')).toBeEnabled();
        expect(JSON.stringify(app.provider.calls.at(-1).messages)).toContain('Follow the clue from the card');
        await cardObjective.scrollIntoViewIfNeeded();
        await page.screenshot({ path: new URL(`../screenshots/plot-compass-card-${phone ? 'phone' : 'desktop'}-after.png`, import.meta.url).pathname, scale: 'css' });
        await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const agent = store.getAgentById('plot-fixture');
            await store.saveAgent({ ...agent, companion: { ...agent.companion, displayMode: 'panel' } });
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
        });
        const firstReopened = await page.evaluate(async ({ avatar, chatName }) => (await import('/script.js')).openSavedCharacterChat(avatar, chatName), { avatar, chatName });
        expect(firstReopened).toBe(true);
        await expect(objective).toHaveValue('Find the secret passage');

        // A different card, even with the same chat name, gets neither local objective.
        const otherCreated = await account.context.request.post('/api/characters/create', { headers: account.headers, data: { ch_name: 'Other director', first_mes: '' } });
        const otherAvatar = await otherCreated.text();
        const otherRequest = { avatar_url: otherAvatar, file_name: chatName };
        const otherVacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...otherRequest, allow_create: true } });
        const otherRoleplay = JSON.parse(otherVacant.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...otherRequest, chat: [{ chat_metadata: {} }],
            roleplay: { account: otherRoleplay.account, vacancy: otherRoleplay.vacancy, operationKey: randomUUID() } });
        await page.evaluate(async ({ otherAvatar, chatName }) => {
            await window.SillyTavern.getContext().getCharacters();
            await (await import('/script.js')).openSavedCharacterChat(otherAvatar, chatName);
        }, { otherAvatar, chatName });
        await expect(field('character')).toHaveValue('');
        await expect(objective).toHaveValue('');
        await expect(field('global')).toHaveValue('Keep a hopeful tone');
        const count = app.provider.calls.length;
        await save.click();
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(count + 1);
        await expect(save).toBeEnabled();
        const otherPrompt = JSON.stringify(app.provider.calls.at(-1).messages);
        expect(otherPrompt).toContain('Keep a hopeful tone');
        expect(otherPrompt).not.toContain('Reveal the family secret');
        expect(otherPrompt).not.toContain('Find the secret passage');

        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(button => button.click());
            await save.evaluate(button => Promise.all(button.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))));
            const ratio = await save.evaluate(async button => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                const rgb = colour => { context.fillStyle = colour; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                const style = getComputedStyle(button);
                return contrastRatio(rgb(style.color), rgb(style.backgroundColor));
            });
            expect(ratio, `${accent ?? 'default'} button contrast`).toBeGreaterThanOrEqual(4.5);
        }
    });
}

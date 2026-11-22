/* global document, getComputedStyle, window */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

test.setTimeout(300000);

const NOTE = [
    '**Direction:** Keep the heist tense and hopeful.',
    '',
    '**Where we are:** Mira waits by the vault door.',
    '',
    '**Possible developments:**',
    '1. Mira bribes the night guard with a forged pass.',
    '2. The rival crew arrives early and forces a truce.',
    '3. Mira finds a note from her missing brother.',
    '',
    '**Next move:** 2. Let the rival crew burst in while Mira is mid-sentence.',
].join('\n');

async function createChat(account, avatar, fileName, messages = []) {
    const request = { avatar_url: avatar, file_name: fileName };
    const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...request, allow_create: true } });
    expect(vacant.ok()).toBe(true);
    const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...request, chat: [{ chat_metadata: {} }, ...messages],
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return request;
}

async function settle(locator) {
    await locator.evaluate(root => Promise.all(root.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))));
}

async function sendReply(page, account, text) {
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
    await page.locator('#send_textarea').fill(text);
    await startNativeReply(page);
    const { jobId } = await (await submitted).json();
    await account.settled(jobId);
    await expect.poll(() => page.evaluate(async () => !(await import('/script.js')).is_send_press), { timeout: 30000 }).toBe(true);
}

for (const phone of [true, false]) {
    test(`Plot Compass directions steer the next reply on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const viewport = phone ? 'phone' : 'desktop';
        const baseline = process.env.PLOT_COMPASS_BASELINE_ROOT;
        if (baseline) await app.restart({ checkoutRoot: baseline });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, connectionProfile: 'durable', trackerCompanionAutoLoopVersion: 4 } };
        } });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: NOTE }, finish_reason: 'stop' }] };
        const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
            ch_name: 'Plot Director', description: 'A character with no greeting.', first_mes: '',
        } });
        expect(created.ok()).toBe(true);
        const avatar = await created.text();
        const chatName = 'Plot Compass choices chat';
        const request = await createChat(account, avatar, chatName);
        const page = await account.open({ workspace: false });
        await page.evaluate(async ({ avatar, chatName }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/plot-compass-companion.json')).json();
            // An existing v2 install, so the picks reach users without a template update.
            await store.saveAgent({ ...template, id: 'plot-fixture', sourceTemplateId: template.id, enabled: true,
                version: 2, settings: { plotCompassScope: 'global', plotCompassObjective: 'Keep a hopeful tone' },
                connectionProfile: 'durable', companion: { ...template.companion, trigger: 'manual', displayMode: 'panel' } });
            await (await import('/script.js')).openSavedCharacterChat(avatar, chatName);
        }, { avatar, chatName });
        await acknowledgeActiveSettings(page);
        await page.evaluate(() => window.toastr?.remove());
        await page.locator('[data-crash-action="dismiss"]').evaluateAll(buttons => buttons.forEach(button => button.click()));
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        const panel = page.locator('#ica--tracker-panel');
        const section = panel.locator('[data-agent-id="plot-fixture"]');
        await section.locator('[data-action="panel-plot-compass-save"]').click();
        await expect(section).toContainText('Mira finds a note from her missing brother.', { timeout: 30000 });
        if (!baseline) {
            const prompt = JSON.stringify(app.provider.calls[0].messages);
            expect(prompt).toContain('[Plot Compass Choices]');
            expect(prompt).toContain('Start **Next move:** with the number of the direction you recommend');
        }
        await page.evaluate(() => window.toastr?.remove());
        await settle(panel);
        const choices = section.locator('.ica--tpanel-agent-body .ica--choice-line');
        await choices.nth(2).scrollIntoViewIfNeeded();
        await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
        const shot = name => page.screenshot({ path: new URL(`../screenshots/plot-compass-choices-${name}-${viewport}-${baseline ? 'before' : 'after'}.png`, import.meta.url).pathname, scale: 'css' });
        await shot('panel');
        if (baseline) return;

        // The model's recommendation is marked; nothing is picked yet.
        const picks = section.locator('.ica--tpanel-agent-body .ica--plot-choice');
        await expect(picks).toHaveCount(3);
        for (let index = 0; index < 3; index++) await expect(picks.nth(index)).toHaveAttribute('aria-pressed', 'false');
        await expect(picks.nth(1).locator('.ica--plot-choice-tag')).toHaveText('Suggested');
        await expect(section.locator('.ica--plot-choice-tag')).toHaveCount(1);
        await expect(section.locator('.ica--plot-choice-hint')).toHaveText('Pick a direction for the next reply, or leave it and Plot Compass goes with its suggestion.');
        const geometry = await picks.evaluateAll(buttons => buttons.map(button => {
            const bounds = button.getBoundingClientRect();
            return { height: bounds.height, left: bounds.left, right: bounds.right, viewport: window.innerWidth,
                panel: button.closest('#ica--tracker-panel').getBoundingClientRect().right };
        }));
        for (const bounds of geometry) {
            expect(bounds.height).toBeGreaterThanOrEqual(32);
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(Math.min(bounds.viewport, bounds.panel) + 1);
        }

        // Picking saves the direction on the note and leaves the message box alone.
        await picks.nth(0).click();
        await expect(picks.nth(0)).toHaveAttribute('aria-pressed', 'true');
        await expect(picks.nth(0).locator('.ica--plot-choice-tag')).toHaveText('Your pick');
        await expect(section.locator('.ica--plot-choice-tag')).toHaveCount(2);
        await expect(picks.nth(1).locator('.ica--plot-choice-tag')).toHaveText('Suggested');
        await expect(section.locator('.ica--plot-choice-hint')).toHaveText('The next reply follows your pick. Select it again to let Plot Compass choose.');
        await expect(panel).toBeVisible();
        await expect(page.locator('#send_textarea')).toHaveValue('');
        await expect.poll(async () => (await account.post('/api/chats/get', request))[0]?.chat_metadata?.inChatAgentPlotCompassOpeningNotes?.['plot-fixture']?.plotCompassChoice,
            { timeout: 30000 }).toEqual({ number: 1, text: 'Mira bribes the night guard with a forged pass.' });
        await settle(panel);
        await picks.nth(0).scrollIntoViewIfNeeded();
        await shot('picked');

        const accentBefore = await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            return { quote: power_user.quote_text_color, underline: power_user.underline_text_color };
        });
        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(button => button.click());
            await settle(panel);
            const ratio = await picks.nth(0).locator('.ica--plot-choice-tag').evaluate(async tag => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                const rgb = colour => { context.clearRect(0, 0, 1, 1); context.fillStyle = colour; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                const style = getComputedStyle(tag);
                return contrastRatio(rgb(style.color), rgb(style.backgroundColor));
            });
            expect(ratio, `${accent ?? 'default'} pick tag contrast`).toBeGreaterThanOrEqual(4.5);
        }
        await page.evaluate(({ quote, underline }) => {
            if (quote) document.querySelector('#sb-accent-primary-picker')?.dispatchEvent(new CustomEvent('change', { detail: { rgba: quote } }));
            if (underline) document.querySelector('#sb-accent-secondary-picker')?.dispatchEvent(new CustomEvent('change', { detail: { rgba: underline } }));
        }, accentBefore);

        // The pick reaches the next reply as an instruction.
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'The guard pockets the pass.' }, finish_reason: 'stop' }] };
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());
        await sendReply(page, account, 'I wave the pass.');
        const picked = JSON.stringify(app.provider.calls.at(-1).messages);
        expect(picked).toContain('[User\'s chosen direction]\\n1. Mira bribes the night guard with a forged pass.');
        expect(picked).toContain('Follow their choice.');
        expect(picked).not.toContain('Let the rival crew burst in while Mira is mid-sentence.');

        // Selecting it again hands the choice back to Plot Compass.
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        await expect(picks.nth(0)).toHaveAttribute('aria-pressed', 'true');
        await picks.nth(0).click();
        await expect(picks.nth(0)).toHaveAttribute('aria-pressed', 'false');
        await expect(picks.nth(1).locator('.ica--plot-choice-tag')).toHaveText('Suggested');
        await expect.poll(async () => (await account.post('/api/chats/get', request))[0]?.chat_metadata?.inChatAgentPlotCompassOpeningNotes?.['plot-fixture'],
            { timeout: 30000 }).not.toHaveProperty('plotCompassChoice');
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());
        await sendReply(page, account, 'I wait.');
        const unpicked = JSON.stringify(app.provider.calls.at(-1).messages);
        expect(unpicked).toContain('Let the rival crew burst in while Mira is mid-sentence.');
        expect(unpicked).not.toContain('[User\'s chosen direction]');

        // A note on a message, shown as a card, takes picks the same way.
        const cardChat = 'Plot Compass card chat';
        const cardRequest = await createChat(account, avatar, cardChat, [
            { name: 'You', is_user: true, is_system: false, mes: 'I reach the vault.', send_date: Date.now(), extra: {} },
            { name: 'Plot Director', is_user: false, is_system: false, mes: 'The vault hums.', send_date: Date.now(), extra: {
                inChatAgentCompanionResults: { 'plot-fixture': { status: 'done', content: NOTE, format: 'markdown', updatedAt: new Date().toISOString() } },
            } },
        ]);
        await page.evaluate(async ({ avatar, cardChat }) => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const agent = store.getAgentById('plot-fixture');
            await store.saveAgent({ ...agent, companion: { ...agent.companion, displayMode: 'card' } });
            await (await import('/script.js')).openSavedCharacterChat(avatar, cardChat);
            (await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js')).refreshCompanionCards();
        }, { avatar, cardChat });
        const card = page.locator('#chat .ica--companion-card[data-agent-id="plot-fixture"]');
        await card.evaluate(element => { element.open = true; });
        const cardPicks = card.locator('.ica--plot-choice');
        await expect(cardPicks).toHaveCount(3);
        await cardPicks.nth(2).click();
        await expect(cardPicks.nth(2)).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#send_textarea')).toHaveValue('');
        await expect.poll(async () => (await account.post('/api/chats/get', cardRequest))[2]?.extra?.inChatAgentCompanionResults?.['plot-fixture']?.plotCompassChoice,
            { timeout: 30000 }).toEqual({ number: 3, text: 'Mira finds a note from her missing brother.' });
        await page.evaluate(() => window.toastr?.remove());
        await settle(card);
        await cardPicks.nth(2).scrollIntoViewIfNeeded();
        // The highlight stays clear of the list numbers.
        const overlaps = await cardPicks.evaluateAll(buttons => buttons.map(button => {
            const item = button.closest('li');
            return item ? Math.round(button.getBoundingClientRect().left - item.getBoundingClientRect().left) : 0;
        }));
        for (const offset of overlaps) expect(offset).toBeGreaterThanOrEqual(0);
        await shot('card');
    });

    test(`a picked direction on a kept card reaches browser and server replies on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, connectionProfile: 'durable', trackerCompanionAutoLoopVersion: 4 } };
        } });
        const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
            ch_name: 'Kept Plot Director', description: 'A character with no greeting.', first_mes: '',
        } });
        expect(created.ok()).toBe(true);
        const avatar = await created.text();
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/plot-compass-companion.json')).json();
            await store.saveAgent({ ...template, id: 'plot-fixture', sourceTemplateId: template.id, enabled: true, version: 2,
                connectionProfile: 'durable', companion: { ...template.companion, trigger: 'manual', displayMode: 'card', includeInChatHistory: true } });
        }, avatar);
        await acknowledgeActiveSettings(page);
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'The guard pockets the pass.' }, finish_reason: 'stop' }] };

        for (const server of [false, true]) {
            const chatName = `Kept Plot Compass ${server ? 'server' : 'browser'}`;
            const request = await createChat(account, avatar, chatName, [
                { name: 'You', is_user: true, is_system: false, mes: 'I reach the vault.', send_date: Date.now(), extra: {} },
                { name: 'Kept Plot Director', is_user: false, is_system: false, mes: 'The vault hums.', send_date: Date.now(), extra: {
                    inChatAgentCompanionResults: { 'plot-fixture': { status: 'done', content: NOTE, format: 'markdown',
                        includeInChatHistory: true, chatHistoryPlacement: 'block', updatedAt: new Date().toISOString() } },
                } },
            ]);
            await page.evaluate(async ({ avatar, chatName }) => {
                await (await import('/script.js')).openSavedCharacterChat(avatar, chatName);
                (await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js')).refreshCompanionCards();
            }, { avatar, chatName });
            await page.evaluate(() => window.toastr?.remove());
            const card = page.locator('#chat .ica--companion-card[data-agent-id="plot-fixture"]');
            await card.evaluate(element => { element.open = true; });
            const pick = card.locator('.ica--plot-choice').first();
            await pick.click();
            await expect(pick).toHaveAttribute('aria-pressed', 'true');
            await expect.poll(async () => (await account.post('/api/chats/get', request))[2]?.extra?.inChatAgentCompanionResults?.['plot-fixture']?.plotCompassChoice,
                { timeout: 30000 }).toEqual({ number: 1, text: 'Mira bribes the night guard with a forged pass.' });
            const calls = app.provider.calls.length;
            await page.locator('#send_textarea').fill('I wave the pass.');
            if (server) {
                const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
                await startNativeReply(page);
                await account.settled((await (await submitted).json()).jobId);
            } else {
                await page.evaluate(async () => { void (await import('/script.js')).Generate('normal', { skipNativeRoleplay: true }); });
            }
            await expect(page.locator('#chat .mes').last()).toContainText('The guard pockets the pass.', { timeout: 60000 });
            expect(app.provider.calls.length).toBeGreaterThan(calls);
            const prompt = JSON.stringify(app.provider.calls.at(-1).messages);
            expect(prompt).toContain('[User\'s chosen direction]\\n1. Mira bribes the night guard with a forged pass.');
            expect(prompt).toContain('The user picked this direction for the next response.');
            expect(prompt).not.toContain('Let the rival crew burst in while Mira is mid-sentence.');
        }
    });
}

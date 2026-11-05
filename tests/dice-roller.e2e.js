/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Viewport setup and named accent variants share the same checks. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { searchAgentList } from './in-chat-agents-e2e-helpers.js';

test.setTimeout(240000);

const SCREENSHOTS = process.env.NECONYAN_DICE_SCREENSHOTS || '';
const ROLL = '🎲 Pick the lock - rolled 18 vs 12 (1d20: 18) - SUCCESS';
const DIRECTIVE = '[Dice result for User]';

function useReplyLocation(saved, location) {
    saved.power_user.reply_generation_location = location;
}

async function measureContrast(locator) {
    return locator.evaluate(async element => {
        const { contrastRatio } = await import('/scripts/theme-contrast.js');
        const canvas = document.createElement('canvas').getContext('2d');
        const channels = colour => {
            canvas.clearRect(0, 0, 1, 1);
            canvas.fillStyle = colour;
            canvas.fillRect(0, 0, 1, 1);
            return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { ratio: contrastRatio(channels(style.color), channels(style.backgroundColor)), color: style.color, background: style.backgroundColor, width: rect.width, height: rect.height };
    });
}

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await expect(page.locator('#chat .mes').first()).toContainText('Hello.');
    return page;
}

async function waitForAgents(page) {
    await expect.poll(() => page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        return store.areAgentsLoaded()
            && store.getAgents().length > 0
            && (extension_settings.inChatAgents?.autoSeededTemplateIds ?? []).includes('tpl-dice-roller-companion');
    }), { timeout: 30000 }).toBe(true);
}

async function diceAgent(page) {
    return page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const agent = store.getAgents().find(item => item.sourceTemplateId === 'tpl-dice-roller-companion');
        return agent ? { id: agent.id, name: agent.name, enabled: agent.enabled, displayMode: agent.companion?.displayMode, trigger: agent.companion?.trigger } : null;
    });
}

async function enableDice(page, displayMode = 'panel') {
    const id = await page.evaluate(async displayMode => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const agent = store.getAgents().find(item => item.sourceTemplateId === 'tpl-dice-roller-companion');
        if (!agent) throw new Error('The seeded Dice Roller agent is missing.');
        const saved = await store.saveAgent(agent.id, { update: draft => {
            draft.enabled = true;
            draft.companion = { ...draft.companion, displayMode };
            return draft;
        } });
        return saved?.id ?? agent.id;
    }, displayMode);
    return id;
}

async function openAgentsTab(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
    await expect(page.locator('#ica--settings')).toBeVisible({ timeout: 45000 });
}

async function saveDiceViaAgents(page, { enabled = true, displayMode = 'card' } = {}) {
    await openAgentsTab(page);
    await searchAgentList(page, 'Dice Roller', { count: 1 });
    const card = page.locator('#ica--agentList .ica--agent-card').filter({ hasText: 'Dice Roller' }).first();
    await expect(card).toBeVisible();
    const toggle = card.locator('.ica--card-toggle');
    if ((await toggle.getAttribute('aria-pressed')) !== String(enabled)) {
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', String(enabled));
    }
    await card.locator('.ica--btn-edit').click();
    const popup = page.locator('dialog[open]:has(#ica--editor)');
    await expect(popup).toBeVisible();
    await popup.locator('[data-editor-tab="companion"]').click();
    await popup.locator('#ica--editor-companion-displayMode').selectOption(displayMode);
    await popup.locator('.popup-button-ok').click();
    await expect(popup).toBeHidden();
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
}

async function openCompanionPanel(page) {
    await page.evaluate(async () => {
        const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
        panel.openCompanionPanel();
    });
    const panel = page.locator('#ica--tracker-panel');
    await expect(panel).toBeVisible();
    return panel;
}

async function closeCompanionPanel(page) {
    await page.evaluate(async () => {
        const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
        panel.closeCompanionPanel();
    });
}

async function rollSuccess(widget) {
    await widget.getByLabel('What are you attempting?').fill('Pick the lock');
    await widget.locator('.neco-dice-roll').click();
    await expect(widget.locator('.neco-dice-outcome')).toContainText('Success');
}

async function shot(page, name) {
    if (!SCREENSHOTS) return;
    await page.screenshot({ path: path.join(SCREENSHOTS, name) });
}

function promptText(call) {
    return (call?.messages || []).map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`);
}

for (const [location, phone] of [['browser', false], ['server', true]]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} dice companion rolls in its panel and reaches the ${location} reply as a settled result`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: { reducedMotion: 'no-preference' },
            configureSettings: saved => useReplyLocation(saved, location) });
        const page = await openChat(account);
        await waitForAgents(page);
        expect(await diceAgent(page)).toEqual(expect.objectContaining({ name: 'Dice Roller', enabled: false, displayMode: 'panel', trigger: 'manual' }));

        await page.evaluate(() => { Math.random = () => 0.85; });
        await enableDice(page);
        const panel = await openCompanionPanel(page);
        const widget = panel.locator('.neco-dice');
        await expect(widget).toBeVisible();
        // It starts in the Companion panel, not beside the message box or in the wand menu.
        await expect(page.locator('#neco-dice-composer-button')).toHaveCount(0);
        await expect(page.locator('#neco-dice-wand-button')).toHaveCount(0);
        await expect(page.locator('.neco-dice-popup')).toHaveCount(0);
        expect(await page.evaluate(() => typeof window.necoDiceRollerInterceptor)).toBe('undefined');
        await expect(widget.locator('.neco-dice-outcome')).toContainText('Success');
        await shot(page, `dice-${viewport}-panel.png`);

        const attempt = widget.getByLabel('What are you attempting?');
        await attempt.fill('Pick the lock');
        // Another Companion result can redraw the panel; the live widget and its typing stay put.
        await page.evaluate(async () => {
            const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
            panel.refreshCompanionPanel();
        });
        await expect(attempt).toBeFocused();
        await expect(attempt).toHaveValue('Pick the lock');
        await widget.locator('.neco-dice-roll').click();
        await expect(widget).toHaveClass(/is-rolling/);
        await shot(page, `dice-${viewport}-rolling.png`);
        await expect(widget).not.toHaveClass(/is-rolling/);
        await expect(widget.locator('.neco-dice-outcome')).toContainText('Success');
        await shot(page, `dice-${viewport}-success.png`);

        const before = app.provider.calls.length;
        if (phone) {
            // A deliberate Add from the phone panel reveals the composer, even if the panel is locked.
            await panel.locator('[data-action="panel-lock"]').click();
            await expect(panel.locator('[data-action="panel-lock"]')).toHaveAttribute('aria-pressed', 'true');
            await widget.getByRole('button', { name: 'Add to message', exact: true }).click();
            await expect(page.locator('#send_textarea')).toHaveValue(new RegExp(ROLL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            await expect(page.locator('#send_textarea')).toBeFocused();
            await expect(panel).not.toHaveClass(/is-open/);
            const exposure = await page.evaluate(() => {
                const textarea = document.getElementById('send_textarea');
                const rect = textarea.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                const panelElement = document.getElementById('ica--tracker-panel');
                return {
                    composerHit: hit === textarea || textarea.contains(hit),
                    panelOpen: panelElement.classList.contains('is-open') || panelElement.getAttribute('aria-hidden') === 'false',
                };
            });
            expect(exposure).toEqual({ composerHit: true, panelOpen: false });
            await page.locator('#send_but').click();
        } else {
            // Desktop keeps the panel and its lock after Add; it does not cover the composer.
            await panel.locator('[data-action="panel-lock"]').click();
            await expect(panel.locator('[data-action="panel-lock"]')).toHaveAttribute('aria-pressed', 'true');
            await widget.getByRole('button', { name: 'Add to message', exact: true }).click();
            await expect(page.locator('#send_textarea')).toHaveValue(new RegExp(ROLL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            await expect(panel).toHaveClass(/is-open/);
            await expect(panel).toHaveAttribute('aria-hidden', 'false');
            await page.locator('#send_textarea').fill('');
            await widget.getByRole('button', { name: 'Send', exact: true }).click();
        }
        await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBeGreaterThan(before);
        const lines = promptText(app.provider.calls.at(-1));
        const userIndex = lines.findIndex(line => line.includes(ROLL));
        const directiveIndex = lines.findIndex(line => line.startsWith('system: ') && line.includes(DIRECTIVE));
        expect(userIndex, lines.join('\n')).toBeGreaterThanOrEqual(0);
        expect(directiveIndex, lines.join('\n')).toBeGreaterThan(userIndex);
        expect(lines[directiveIndex]).toContain('keep the dice, the numbers and the word roll out of the reply');

        await closeCompanionPanel(page);
        const chip = page.locator('#chat .mes[is_user="true"] .neco-dice-chip').last();
        await expect(chip).toBeVisible();
        await expect(chip).toHaveAttribute('data-outcome', 'success');
        await expect.poll(() => page.locator('#chat .mes').count(), { timeout: 60000 }).toBeGreaterThanOrEqual(3);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
        await shot(page, `dice-${viewport}-chat.png`);

        // An ordinary message afterwards carries no dice result.
        const next = app.provider.calls.length;
        await page.locator('#send_textarea').fill('Look around the room.');
        await page.locator('#send_but').click();
        await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBeGreaterThan(next);
        expect(promptText(app.provider.calls.at(-1)).join('\n')).not.toContain('[Dice result for');
    });
}

test('dice companion switches notes, cards and the global switch through the real UI, and is seeded only once', async ({ app }) => {
    const account = await app.account({ phone: false, activeConnection: true });
    const page = await openChat(account);
    await waitForAgents(page);
    expect(await diceAgent(page)).toEqual(expect.objectContaining({ enabled: false }));

    await page.evaluate(() => { Math.random = () => 0.85; });
    // The real editor save and enable toggle must refresh the chat card without a manual render.
    await saveDiceViaAgents(page, { enabled: true, displayMode: 'card' });
    const card = page.locator('#chat .ica--companion-card--dice');
    await expect(card).toBeVisible();
    const widget = card.locator('.neco-dice');
    await expect(widget).toBeVisible();
    await expect(page.locator('.neco-dice')).toHaveCount(1);
    await rollSuccess(widget);
    await widget.getByRole('button', { name: 'Add to message', exact: true }).click();
    await expect(page.locator('#send_textarea')).toHaveValue(new RegExp(ROLL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await shot(page, 'dice-desktop-card.png');

    const id = (await diceAgent(page)).id;
    // A collapsed window hides its body; the live widget must fall back to the note card.
    await page.evaluate(async id => {
        const windows = await import('/scripts/extensions/in-chat-agents/companion/companion-windows.js');
        windows.openCompanionWindow(id);
    }, id);
    const windowPanel = page.locator('.ica--cwin');
    await expect(windowPanel.locator('.neco-dice')).toBeVisible();
    await windowPanel.locator('[data-action="cwin-collapse"]').click();
    await expect(card.locator('.neco-dice')).toBeVisible();
    await expect(windowPanel.locator('.neco-dice')).toHaveCount(0);
    await windowPanel.locator('[data-action="cwin-collapse"]').click();
    await expect(windowPanel.locator('.neco-dice')).toBeVisible();
    await page.evaluate(async id => {
        const windows = await import('/scripts/extensions/in-chat-agents/companion/companion-windows.js');
        windows.closeCompanionWindow(id);
    }, id);
    await expect(card.locator('.neco-dice')).toBeVisible();

    // A new reply moves the one card to the newest assistant reply; no old Ready shell stays behind.
    await page.locator('#send_textarea').fill('Look around the room.');
    const beforeReply = app.provider.calls.length;
    await page.locator('#send_but').click();
    await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBeGreaterThan(beforeReply);
    await expect(page.locator('#chat .ica--companion-card--dice')).toHaveCount(1);
    expect(await page.locator('#chat .ica--companion-card--dice').evaluate(cardElement =>
        cardElement.closest('.mes')?.getAttribute('is_user') !== 'true')).toBe(true);

    // The global Agents switch removes and restores the card in the live chat.
    await openAgentsTab(page);
    await page.locator('#ica--globalEnabled').click();
    await expect(page.locator('#chat .ica--companion-card--dice')).toHaveCount(0);
    await page.locator('#ica--globalEnabled').click();
    await expect(page.locator('#chat .ica--companion-card--dice')).toHaveCount(1);
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());

    // Switching to the panel removes the old card immediately.
    await saveDiceViaAgents(page, { enabled: true, displayMode: 'panel' });
    await expect(page.locator('#chat .ica--companion-card--dice')).toHaveCount(0);

    // Back to a live card, then delete from the agent's own card action. The
    // disabled stale note must go immediately, not only after a reload.
    await saveDiceViaAgents(page, { enabled: true, displayMode: 'card' });
    await expect(page.locator('#chat .ica--companion-card--dice')).toBeVisible();
    await openAgentsTab(page);
    await searchAgentList(page, 'Dice Roller', { count: 1 });
    const agentCard = page.locator('#ica--agentList .ica--agent-card').filter({ hasText: 'Dice Roller' }).first();
    await expect(agentCard).toBeVisible();
    await agentCard.locator('.ica--card-more').click();
    await agentCard.locator('.ica--btn-delete').click();
    await page.locator('dialog.popup:visible .popup-button-ok').click();
    await expect.poll(() => diceAgent(page)).toBeNull();
    await expect(page.locator('#chat .ica--companion-card--dice')).toHaveCount(0);
    await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await waitForAgents(page);
    expect(await diceAgent(page)).toBeNull();
});

for (const [viewport, phone] of [['phone', true], ['desktop', false]]) {
    test(`${viewport} dice companion controls stay readable with default, pale and dark accents`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await openChat(account);
        await waitForAgents(page);
        await enableDice(page);
        const panel = await openCompanionPanel(page);
        const widget = panel.locator('.neco-dice');
        await expect(widget).toBeVisible();
        await panel.locator('[data-action="panel-lock"]').click();
        await expect(page.locator('#ica--tracker-panel [data-action="panel-lock"]')).toHaveAttribute('aria-pressed', 'true');
        await page.addStyleTag({ content: '#toast-container { display: none; }' });
        const controls = [
            ['pressed die', '.neco-dice-segment[aria-pressed="true"]'],
            ['die', '.neco-dice-segment[aria-pressed="false"]'],
            ['step', '.neco-dice-step:not(:disabled)'],
            ['add', '.neco-dice-actions .menu_button:not(.menu_button_primary)'],
            ['send', '.neco-dice-actions .menu_button_primary'],
        ];
        const results = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            // The theme picker sits in a closed settings drawer.
            // eslint-disable-next-line playwright/no-force-option
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const [name, selector] of controls) {
                    const measured = await measureContrast(widget.locator(selector).first());
                    results.push({ theme, accent, name, ...measured });
                    expect(measured.ratio, JSON.stringify(results.at(-1))).toBeGreaterThanOrEqual(4.5);
                    expect(measured.height, name).toBeGreaterThanOrEqual(phone ? 44 : 32);
                    if (phone) expect(measured.width, name).toBeGreaterThanOrEqual(44);
                }
                if (accent === 'Pearl' || accent === 'Midnight Ink') await shot(page, `dice-${viewport}-${theme === 'Neconyan Calico' ? 'light' : 'dark'}-${accent.split(' ')[0].toLowerCase()}.png`);
            }
        }
        await test.info().attach('accent-measurements', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    });
}

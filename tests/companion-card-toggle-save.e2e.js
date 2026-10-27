/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const STAMP = '2026-10-27T08:42:25.555Z';

// Drawing a Companion card as <details open> fires 'toggle' by itself. Saving on that
// gave the chat a new revision, so a server reply still running for the old revision
// was rejected and thrown away. Identical saves are fine: the server skips them.
const savedStamps = body => [...body.matchAll(/"(?:first|second)":\{[^{}]*?"updatedAt":"([^"]+)"/g)].map(match => match[1]);

test('redrawing open Companion cards never changes the saved chat', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async ({ avatar, stamp }) => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        c.chat[0].extra = { ...c.chat[0].extra, [COMPANION_RESULTS_EXTRA_KEY]: {
            first: { agentName: 'First Notes', status: 'done', content: 'FIRST NOTE', collapsed: false, updatedAt: stamp },
            second: { agentName: 'Second Notes', status: 'done', content: 'SECOND NOTE', collapsed: false, updatedAt: stamp },
        } };
        await c.saveChat(); await c.reloadCurrentChat(); await window.NeconyanShell.activateMode('roleplay');
    }, { avatar: account.avatar, stamp: STAMP });

    const cards = page.locator('#chat > .mes[mesid="0"] details.ica--companion-card');
    await expect(cards).toHaveCount(2);
    const saves = [];
    page.on('request', request => { if (request.url().includes('/api/chats/save')) saves.push(request.postData() || ''); });

    for (let pass = 0; pass < 2; pass++) {
        await page.evaluate(async () => {
            const { renderCompanionResultsForMessage } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
            document.querySelectorAll('#chat > .mes[mesid="0"] .ica--companion-ledger').forEach(node => node.remove());
            renderCompanionResultsForMessage(0);
        });
        await expect(cards).toHaveCount(2);
    }
    await page.evaluate(async () => { await window.SillyTavern.getContext().reloadCurrentChat(); });
    await expect(cards).toHaveCount(2);
    await page.evaluate(async () => { const { flushPendingChatSaves } = await import('/script.js'); await flushPendingChatSaves({ silent: true }); });

    expect(saves.flatMap(savedStamps).filter(stamp => stamp !== STAMP)).toEqual([]);
    const stamps = await page.evaluate(() => Object.values(window.SillyTavern.getContext().chat[0].extra.inChatAgentCompanionResults).map(result => result.updatedAt));
    expect(stamps).toEqual([STAMP, STAMP]);

    await cards.first().locator('summary').first().click();
    await expect(cards.first()).not.toHaveAttribute('open', '');
    await expect.poll(() => saves.flatMap(savedStamps).some(stamp => stamp !== STAMP), { timeout: 10000 }).toBe(true);
    const first = await page.evaluate(() => window.SillyTavern.getContext().chat[0].extra.inChatAgentCompanionResults.first);
    expect(first.collapsed).toBe(true);
    expect(first.updatedAt).not.toBe(STAMP);
    await account.context.close();
});

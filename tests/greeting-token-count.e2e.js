/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(120000);

for (const phone of [false, true]) {
    test(`greeting counts appear without sending or swiping on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: saved => {
            saved.power_user.message_token_count_enabled = true;
        } });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);

        const greeting = page.locator('#chat .mes[mesid="0"]');
        await expect(greeting.locator('.mes_text')).toContainText('Hello.');
        await expect(greeting.locator('.tokenCounterDisplay')).toHaveText(/^\d+t$/);
        await expect(greeting.locator('.tokenCounterDisplay')).toBeVisible();
        const result = await page.evaluate(async () => {
            const message = window.SillyTavern.getContext().chat[0];
            const expected = await (await import('/scripts/tokenizers.js')).getTokenCountAsync(message.mes, 0);
            const counter = document.querySelector('#chat .mes[mesid="0"] .tokenCounterDisplay');
            const rect = counter.getBoundingClientRect();
            return { count: message.extra.token_count, expected, width: rect.width, height: rect.height, display: getComputedStyle(counter).display };
        });
        expect(result.count).toBe(result.expected);
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
        expect(result.display).not.toBe('none');
        expect(await page.evaluate(() => window.SillyTavern.getContext().chat.length)).toBe(1);

        // Reopening an old greeting with no saved count uses the same rendering path.
        await page.evaluate(async () => {
            const context = window.SillyTavern.getContext();
            delete context.chat[0].extra.token_count;
            for (const swipe of context.chat[0].swipe_info ?? []) delete swipe.extra?.token_count;
            await context.saveChat();
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await expect(greeting.locator('.tokenCounterDisplay')).toHaveText(/^\d+t$/);
    });
}

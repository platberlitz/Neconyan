/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(120000);

for (const phone of [false, true]) {
    test(`old token caches shrink on reload and exact counting survives eviction on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const account = await app.account({ phone, configureSettings: saved => {
            saved.main_api = 'openai';
            saved.power_user.message_token_count_enabled = true;
        } });
        const page = await account.open({ workspace: false });
        const before = await page.evaluate(async () => {
            const { localforage } = await import('/lib.js');
            const storage = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
            const saved = Object.fromEntries(Array.from({ length: 40 }, (_, chat) => [
                `legacy-${chat}`, Object.fromEntries(Array.from({ length: 4096 }, (_, entry) => [`gpt-4-${chat * 4096 + entry}`, entry])),
            ]));
            await storage.setItem('tokenCache', saved);
            return { chats: Object.keys(saved).length, entries: 40 * 4096, bytes: JSON.stringify(saved).length };
        });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        const after = await page.evaluate(async () => {
            const { localforage } = await import('/lib.js');
            const saved = await localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).getItem('tokenCache');
            const entries = Object.values(saved).map(chat => Object.keys(chat).length);
            return { chats: Object.keys(saved).length, largestChat: Math.max(...entries), entries: entries.reduce((sum, count) => sum + count, 0), bytes: JSON.stringify(saved).length };
        });
        expect(after.chats).toBeLessThanOrEqual(8);
        expect(after.largestChat).toBeLessThanOrEqual(2048);
        expect(after.entries).toBeLessThanOrEqual(16384);
        expect(after.bytes).toBeLessThan(before.bytes / 8);

        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const greeting = page.locator('#chat .mes[mesid="0"] .tokenCounterDisplay');
        await expect(greeting).toHaveText(/^\d+t$/);
        await expect(greeting).toBeVisible();

        const result = await page.evaluate(async () => {
            const { countTokensOpenAIAsync, primeOpenAITokenCache, resetTokenCache, saveTokenCache } = await import('/scripts/tokenizers.js');
            const { localforage } = await import('/lib.js');
            await resetTokenCache({ toast: false });
            const message = { role: 'user', content: '日本語 café 👋 count this exactly after eviction.' };
            const beforeEviction = await countTokensOpenAIAsync(message, true);
            const messages = Array.from({ length: 2049 }, (_, index) => ({ role: 'user', content: `Browser cache entry ${index}.` }));
            // Exercise the real server batch endpoint while applying the chat-history window size.
            for (let offset = 0; offset < messages.length; offset += 64) {
                await primeOpenAITokenCache(messages.slice(offset, offset + 64));
            }
            const afterEviction = await countTokensOpenAIAsync(message, true);
            await saveTokenCache();
            const saved = await localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).getItem('tokenCache');
            const chatId = window.SillyTavern.getContext().characters[window.SillyTavern.getContext().characterId].chat;
            return { beforeEviction, afterEviction, entries: Object.keys(saved[chatId]).length };
        });
        expect(result.beforeEviction).toBeGreaterThan(0);
        expect(result.afterEviction).toBe(result.beforeEviction);
        expect(result.entries).toBe(2048);
        await expect(greeting).toBeVisible();
        await info.attach('token-cache-measurements', { body: JSON.stringify({ before, after, counting: result }, null, 2), contentType: 'application/json' });
    });
}

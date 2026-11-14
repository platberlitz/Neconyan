/* global window */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const TITLE = 'Add as another version of the last story reply';
const REPLY = 'Nova folds the map and points at the lighthouse.';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} adds a Scratchpad reply as another version of the last story reply`, async ({ app }) => {
        test.setTimeout(150000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const story = () => page.evaluate(() => {
            const last = window.SillyTavern.getContext().chat.at(-1);
            return { text: last?.mes ?? null, user: Boolean(last?.is_user), swipes: last?.swipes ?? null, swipeId: last?.swipe_id ?? null, model: last?.extra?.model ?? null };
        });
        await expect.poll(async () => (await story()).text).toBe('Hello.');
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        expect(source.kind).toBe('roleplay');
        const change = { type: 'character', character: 'Durable Nova', field: 'description', value: 'Changed.' };
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Lighthouse', messages: [
            { role: 'assistant', text: REPLY + '\n```scratchpad-change\n' + JSON.stringify(change) + '\n```' },
        ] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const menu = page.locator('.scratchpad-message.is-assistant summary[aria-label="Message actions"]');
        const button = page.getByRole('button', { name: TITLE, exact: true });
        await menu.click();
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.width).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
        await page.screenshot({ path: path.resolve('../screenshots/scratchpad-reply-version', `${size}-button.png`) });

        await button.click();
        const dialog = page.locator('dialog[open]').last();
        await expect(dialog).toContainText('from Durable Nova');
        await page.screenshot({ path: path.resolve('../screenshots/scratchpad-reply-version', `${size}-confirm.png`) });
        await dialog.getByText('Not now', { exact: true }).click();
        expect(await story()).toMatchObject({ text: 'Hello.' });

        await menu.click();
        await button.click();
        await page.locator('dialog[open]').last().getByText('Add version', { exact: true }).click();
        await expect(page.locator('.toast-success').filter({ hasText: 'Added as a new version of the last story reply.' })).toBeVisible();
        await expect.poll(async () => (await story()).text).toBe(REPLY);
        const added = await story();
        expect(added.swipes.at(-1)).toBe(REPLY);
        expect(added.swipes).toContain('Hello.');
        expect(added.swipeId).toBe(added.swipes.length - 1);
        expect(added.model).toBe('Scratchpad');
        if (phone) await expect(page.locator('#neconyan-scratchpad')).toBeHidden();
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toContainText(REPLY);
        await page.screenshot({ path: path.resolve('../screenshots/scratchpad-reply-version', `${size}-added.png`) });

        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await expect.poll(async () => (await story()).text).toBe(REPLY);
        expect((await story()).swipes).toContain('Hello.');

        await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            context.chat.push({ name: context.name1, is_user: true, is_system: false, send_date: '', mes: 'And then?', extra: {} });
        });
        await open();
        await menu.click();
        await button.click();
        await expect(page.locator('.toast-error').last()).toContainText('The last message in this chat is yours');
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        expect(await story()).toMatchObject({ text: 'And then?', user: true, swipes: null });
    });
}

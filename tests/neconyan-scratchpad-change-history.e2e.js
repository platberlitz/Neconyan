/* global document, getComputedStyle, navigator, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const OLD_DESCRIPTION = 'Nova waits by the old harbour.';
const NEW_DESCRIPTION = 'Nova waits by the quiet harbour. <img src=x onerror=alert(1)>';
const OLD_PERSONALITY = 'Quiet.';
const OLD_NOTE = 'Keep {{char}} calm.';
const NEW_NOTE = 'Keep {{char}} calm and brief.';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad undoes saved changes and keeps a Change history`, async ({ app }) => {
        test.setTimeout(240000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const merge = data => account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar: account.avatar, data } });
        expect((await merge({ description: OLD_DESCRIPTION, personality: OLD_PERSONALITY })).ok()).toBe(true);
        await account.post('/api/worldinfo/edit', { name: 'Harbour', data: { entries: { 0: { uid: 0, comment: 'Ferry', key: ['ferry'], content: 'The old timetable.' } } } });

        const page = await account.open({ workspace: false });
        const alerts = [];
        page.on('dialog', dialog => {
            alerts.push(dialog.message());
            void dialog.dismiss();
        });
        const selectStory = () => page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const note = () => page.evaluate(async () => (await import('/script.js')).chat_metadata.note_prompt ?? null);
        await selectStory();
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes ?? null)).toBe('Hello.');
        await page.evaluate(async value => {
            const { chat_metadata, saveChatConditional } = await import('/script.js');
            chat_metadata.note_prompt = value;
            await saveChatConditional();
        }, OLD_NOTE);

        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        expect(source.kind).toBe('roleplay');
        const changes = [
            { type: 'character', character: 'Durable Nova', field: 'description', value: NEW_DESCRIPTION },
            { type: 'lorebook', action: 'edit', book: 'Harbour', uid: 0, content: 'The new timetable.' },
            { type: 'authors-note', action: 'replace', value: NEW_NOTE },
            { type: 'character', character: 'Durable Nova', field: 'personality', value: 'Quiet, but stubborn.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Harbour revisions', messages: [
            { role: 'assistant', text: 'Four small fixes.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') },
        ] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);

        const shots = name => path.resolve('../screenshots/scratchpad-change-history', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        // Toasts already checked are cleared so they do not cover the screenshot.
        const snap = async (name, target = null) => {
            await page.evaluate(() => document.querySelectorAll('#toast-container .toast').forEach(toast => toast.remove()));
            if (target) await target.evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.screenshot({ path: shots(name) });
        };
        const width = phone ? 393 : 1280;
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const headerHistory = page.locator('#neconyan-scratchpad .scratchpad-history-button');
        const readCharacter = async () => (await account.post('/api/characters/get', { avatar_url: account.avatar })).data;
        const readBook = async () => (await account.post('/api/worldinfo/get', { name: 'Harbour' })).entries;
        const cardUndo = index => cards.nth(index).getByRole('button', { name: 'Undo', exact: true });
        const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
        const tab = name => page.getByRole('tab', { name, exact: true }).click();

        await expect(cards).toHaveCount(4);
        await expect(headerHistory).toBeHidden();
        await tab('Sessions');
        await expect(page.getByRole('button', { name: 'Change history', exact: true })).toBeVisible();
        await tab('Chat');
        // The header History link joins the summary line, so the message list must not move down.
        const listTop = () => page.locator('.scratchpad-messages').evaluate(list => list.getBoundingClientRect().top);
        const topBefore = await listTop();

        for (let index = 0; index < changes.length; index++) {
            await cards.nth(index).getByRole('button', { name: 'Review', exact: true }).click();
            await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
            await expect(cards.nth(index)).toContainText('Saved');
            await expect(cardUndo(index)).toBeVisible();
        }
        expect((await readCharacter()).description).toBe(NEW_DESCRIPTION);
        expect((await readBook())['0'].content).toBe('The new timetable.');
        expect(await note()).toBe(NEW_NOTE);
        await expect(headerHistory).toBeVisible();
        await expect(headerHistory).toHaveAttribute('title', 'Change history (4)');
        expect(Math.abs(await listTop() - topBefore)).toBeLessThan(1);

        // The history lives on the server, so a reload keeps every Undo.
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await selectStory();
        await open();
        if (phone) await applyIOSOnlyCss(page);
        await expect(cards).toHaveCount(4);
        for (let index = 0; index < changes.length; index++) await expect(cardUndo(index)).toBeVisible();
        await expect(headerHistory).toBeVisible();
        const undo = cardUndo(0);
        await undo.scrollIntoViewIfNeeded();
        const box = await undo.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 28);
        expect(await noOverflow()).toBe(true);
        await snap('saved-card');

        // Undo stays readable with the default, a pale and a dark accent.
        const contrast = {};
        for (const [name, rgba] of [['Calico', null], ['Mint Glass', 'rgba(110,231,183,1)'], ['Plum Wine', 'rgba(126,34,206,1)']]) {
            if (rgba) {
                await page.evaluate(value => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id)?.dispatchEvent(new CustomEvent('change', { detail: { rgba: value } }));
                }, rgba);
            }
            await settleCssTransitions(page);
            contrast[name] = await undo.evaluate(async element => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
                const channels = colour => {
                    context.clearRect(0, 0, 1, 1);
                    context.fillStyle = colour;
                    context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                let surface = element;
                while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                const label = element.querySelector('span') ?? element;
                return {
                    ratio: Math.round(contrastRatio(channels(getComputedStyle(label).color), channels(getComputedStyle(surface ?? document.body).backgroundColor)) * 100) / 100,
                    border: getComputedStyle(element).borderTopColor,
                };
            });
            expect(contrast[name].ratio, name).toBeGreaterThanOrEqual(4.5);
        }
        console.log(`${phone ? 'phone' : 'desktop'} Undo contrast ${JSON.stringify(contrast)}`);
        // The accent really changed between samples: the accent-aware border follows it.
        expect(new Set(Object.values(contrast).map(item => item.border)).size).toBe(3);
        await page.evaluate(() => {
            for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id)?.dispatchEvent(new CustomEvent('change', { detail: { rgba: null } }));
        });

        // Sessions shows the count and opens the list, newest first.
        await tab('Sessions');
        await page.getByRole('button', { name: 'Change history (4)', exact: true }).click();
        const entries = dialog.locator('.scratchpad-history-entry');
        await expect(entries).toHaveCount(4);
        await expect(entries.nth(0)).toContainText('personality');
        await expect(entries.nth(3)).toContainText('description');
        await expect(entries.nth(3).locator('.scratchpad-history-badge')).toHaveText('Saved');
        await entries.nth(3).locator('summary', { hasText: 'View before & after' }).click();
        await expect(entries.nth(3).locator('.scratchpad-history-text.is-before')).toContainText(OLD_DESCRIPTION);
        await expect(entries.nth(3).locator('.scratchpad-history-text.is-after')).toContainText('<img src=x onerror=alert(1)>');
        await expect(entries.nth(3).locator('.ica-transform-diff-part--ins').first()).toBeVisible();
        expect(await dialog.locator('img[src="x"]').count()).toBe(0);
        await entries.nth(3).getByRole('button', { name: 'Copy previous text', exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(OLD_DESCRIPTION);
        const panel = await dialog.boundingBox();
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(width);
        expect(await noOverflow()).toBe(true);
        await snap('history-diff', entries.nth(3));

        // Undo from the list puts the lorebook entry back exactly.
        const lore = entries.filter({ hasText: 'lorebook' });
        await lore.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(toasts).toContainText('Undid:');
        await expect(lore.locator('.scratchpad-history-badge')).toHaveText('Undone');
        await expect(lore.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
        expect((await readBook())['0'].content).toBe('The old timetable.');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await tab('Chat');
        await expect(cards.nth(1)).toContainText('Undone');
        await expect(cards.nth(1).getByRole('button', { name: 'Review again', exact: true })).toBeVisible();

        // Inline Undo on the card restores the character description and the Author's Note exactly.
        await cardUndo(0).click();
        await expect(cards.nth(0)).toContainText('Undone');
        expect((await readCharacter()).description).toBe(OLD_DESCRIPTION);
        await cardUndo(2).click();
        await expect(cards.nth(2)).toContainText('Undone');
        expect(await note()).toBe(OLD_NOTE);
        expect(await page.evaluate(() => document.getElementById('extension_floating_prompt')?.value ?? null)).toBe(OLD_NOTE);
        await snap('undone', cards.nth(0));

        // A later manual edit stops Undo and keeps that edit.
        expect((await merge({ personality: 'Changed by hand.' })).ok()).toBe(true);
        await cardUndo(3).click();
        await expect(toasts).toContainText('automatic undo was stopped to avoid overwriting your later changes');
        await expect(cards.nth(3).locator('.scratchpad-change-conflict')).toContainText('This character card was edited after Scratchpad saved it');
        await expect(cards.nth(3)).toContainText('Saved');
        expect((await readCharacter()).personality).toBe('Changed by hand.');
        await cards.nth(3).getByRole('button', { name: 'Copy previous text', exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(OLD_PERSONALITY);
        expect(await noOverflow()).toBe(true);
        await snap('conflict', cards.nth(3));

        // The header shortcut opens the same list with the final states.
        await headerHistory.click();
        await expect(entries).toHaveCount(4);
        await expect(entries.locator('.scratchpad-history-badge')).toHaveText(['Saved', 'Undone', 'Undone', 'Undone']);
        await expect(entries.nth(0).locator('.scratchpad-history-conflict')).toContainText('automatic undo was stopped');
        expect(await dialog.locator('img[src="x"]').count()).toBe(0);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        expect(alerts).toEqual([]);
    });
}

/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Before captures and both viewport sizes share the same setup. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });
const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad saves a reviewed Mewmory correction only while it is current`, async ({ app }) => {
        test.setTimeout(240000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes)).toBe('Hello.');
        const locator = await page.evaluate(async () => (await import('/scripts/mewmory/index.js')).getMewmoryLocator());
        let archive = await account.post('/api/mewmory/inspect', { locator });
        const chatRef = archive.sources.find(source => source.type === 'chat' && source.eligible);
        expect(chatRef).toBeTruthy();
        const ref = { id: chatRef.id, revision: chatRef.revision };
        const save = async record => {
            const { revision } = await account.post('/api/mewmory/inspect', { locator });
            archive = await account.post('/api/mewmory/record/save', { locator, revision, record: { kind: 'event', refs: [ref], ...record } });
        };
        await save({ id: 'ferry', text: 'The ferry leaves at noon.' });
        await save({ id: 'harbour', text: 'The harbour is closed.' });
        await save({ id: 'secret', text: 'EXCLUDED-MEMORY', excluded: true });
        const record = async id => (await account.post('/api/mewmory/inspect', { locator })).records.find(item => item.id === id);

        const open = async tab => {
            await page.evaluate(async tab => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab }), tab);
            if (phone) await applyIOSOnlyCss(page);
        };
        await open('chat');
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'mewmory', action: 'replace', record: 'ferry', field: 'text', value: 'The ferry leaves at dusk.', reason: 'The latest scene moved it.' },
            { type: 'mewmory', action: 'replace', record: 'harbour', field: 'status', value: 'resolved' },
            { type: 'mewmory', action: 'replace', record: 'secret', field: 'text', value: 'Leaked.' },
        ];
        await account.post('/api/scratchpad/session/import', {
            source,
            session: { name: 'Memory fixes', messages: [{ role: 'assistant', text: 'Three corrections.\n' + changes.map(fence).join('\n') }] },
        });
        await open('chat');
        await page.evaluate(() => window.toastr?.remove());
        const prefix = `../screenshots/scratchpad-mewmory-corrections/${phone ? 'phone' : 'desktop'}`;
        const cards = page.locator('.scratchpad-change');
        if (before) {
            await expect(page.locator('.scratchpad-message.is-assistant')).toContainText('Three corrections.');
            await expect(cards.filter({ hasText: 'Correct memory' })).toHaveCount(0);
            await page.screenshot({ path: `${prefix}-before.png` });
            return;
        }
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });
        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText('Correct memory \'ferry\'');
        await page.screenshot({ path: `${prefix}-after.png` });

        // Corrections stay unavailable until Mewmory is shared with this session.
        await review(0).click();
        await expect(toasts).toContainText('Share Mewmory under Context before saving a memory correction.');
        await expect(dialog).toHaveCount(0);
        expect((await record('ferry')).text).toBe('The ferry leaves at noon.');

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const checkbox = page.locator('label.scratchpad-check').filter({ hasText: 'Reads saved memories from this Roleplay chat' }).locator('input');
        await expect(async () => { await checkbox.scrollIntoViewIfNeeded(); }).toPass({ timeout: 10000 });
        const updated = page.waitForResponse('**/api/scratchpad/session/update');
        await checkbox.check();
        expect((await updated).ok()).toBe(true);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.evaluate(() => window.toastr?.remove());

        await review(0).click();
        await expect(dialog).toContainText('Mewmory: ferry');
        await expect(dialog).toContainText('noon');
        await expect(dialog.getByRole('textbox', { name: 'Proposed text', exact: true })).toHaveValue('The ferry leaves at dusk.');
        await expect(dialog).toContainText('Mewmory keeps the earlier version');
        await page.screenshot({ path: `${prefix}-review.png` });
        const saveButton = dialog.getByRole('button', { name: 'Save change', exact: true });
        const geometry = await saveButton.boundingBox();
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.x + geometry.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await saveButton.click();
        await expect(cards.nth(0)).toContainText('Saved');
        const corrected = await record('ferry');
        expect(corrected.text).toBe('The ferry leaves at dusk.');
        expect(corrected.version).toBeGreaterThan(1);
        expect(corrected.origin).toBe('author');
        await page.screenshot({ path: `${prefix}-saved.png` });

        // Excluded memories are never offered for correction.
        await review(2).click();
        await expect(toasts).toContainText('no longer shared with Scratchpad');
        await expect(dialog).toHaveCount(0);
        expect((await record('secret')).text).toBe('EXCLUDED-MEMORY');
        await page.evaluate(() => window.toastr?.remove());

        // Another change to the same memory while the review is open wins.
        await review(1).click();
        await expect(dialog).toContainText('Mewmory: harbour');
        await save({ id: 'harbour', text: 'The harbour reopened at dawn.' });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('This memory changed after you reviewed it.');
        const harbour = await record('harbour');
        expect(harbour.text).toBe('The harbour reopened at dawn.');
        expect(harbour.status).toBe('active');
        await expect(cards.nth(1)).not.toContainText('Saved');
        if (await dialog.count()) await dialog.getByRole('button', { name: 'Not now', exact: true }).click();

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
}

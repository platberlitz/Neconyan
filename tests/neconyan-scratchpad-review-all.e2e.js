/* global document, getComputedStyle */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} reviews every change card of a Scratchpad reply together`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const saved = await account.context.request.post('/api/characters/merge-attributes', {
            headers: account.headers,
            data: { avatar: account.avatar, data: { description: 'Nova waits by the old harbour.', personality: 'Quiet.', scenario: 'A foggy morning.' } },
        });
        expect(saved.ok()).toBe(true);
        const writeBook = timetable => account.post('/api/worldinfo/edit', { name: 'Harbour', data: { entries: {
            0: { uid: 0, comment: 'Ferry', key: ['ferry'], content: timetable },
            1: { uid: 1, comment: 'Lantern', key: ['lantern'], content: 'Lanterns are forbidden.' },
        } } });
        await writeBook('The old timetable.');
        const page = await account.open();
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'character', character: 'Durable Nova', field: 'description', value: 'Nova waits by the quiet harbour.' },
            { type: 'character', character: 'Durable Nova', field: 'personality', value: 'Quiet, but stubborn.' },
            { type: 'character', character: 'Durable Nova', field: 'scenario', value: 'A foggy evening.' },
            { type: 'lorebook', action: 'edit', book: 'Harbour', uid: 0, content: 'The new timetable.' },
            { type: 'lorebook', action: 'edit', book: 'Harbour', uid: 1, content: 'Lanterns are welcome.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Harbour revisions', messages: [
            { role: 'assistant', text: 'Five small fixes.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') },
        ] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const shots = name => path.resolve('../screenshots/scratchpad-review-all', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        await expect(cards).toHaveCount(5);
        const reviewAll = page.getByRole('button', { name: 'Review all 5 changes', exact: true });
        await reviewAll.scrollIntoViewIfNeeded();
        const box = await reviewAll.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: shots('button') });

        const readCharacter = async () => (await account.post('/api/characters/get', { avatar_url: account.avatar })).data;
        const readBook = async () => (await account.post('/api/worldinfo/get', { name: 'Harbour' })).entries;
        const items = page.locator('.scratchpad-batch-item');

        // Not now saves nothing and leaves every card open.
        await reviewAll.click();
        await expect(items).toHaveCount(5);
        await expect(items.locator('input[type="checkbox"]:checked')).toHaveCount(5);
        await expect(items.nth(0).locator('.ica-transform-diff-part--ins')).toHaveText(['quiet']);
        const layout = await page.locator('.scratchpad-batch').evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(layout.width);
        const tick = await items.nth(0).locator('label').boundingBox();
        if (phone) expect(tick.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: shots('list') });
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await readCharacter()).description).toBe('Nova waits by the old harbour.');
        await expect(reviewAll).toBeEnabled();

        // One unticked, one edited, one made stale while the list is open.
        await reviewAll.click();
        await expect(items).toHaveCount(5);
        await items.nth(2).locator('input[type="checkbox"]').uncheck();
        await items.nth(1).locator('summary').click();
        await items.nth(1).getByRole('textbox').fill('Quiet, and very stubborn.');
        await expect(items.nth(1).locator('.ica-transform-diff-part--ins')).toHaveText([', and very stubborn']);
        await writeBook('A timetable somebody else rewrote.');
        await page.getByRole('button', { name: 'Save ticked changes', exact: true }).click();

        const report = page.locator('dialog[open] .scratchpad-batch');
        await expect(report).toContainText('1 change was not saved');
        await expect(report.locator('li')).toHaveCount(1);
        await page.screenshot({ path: shots('not-saved') });
        await page.locator('dialog[open]').getByRole('button', { name: 'Close', exact: true }).click();

        const character = await readCharacter();
        expect(character.description).toBe('Nova waits by the quiet harbour.');
        expect(character.personality).toBe('Quiet, and very stubborn.');
        expect(character.scenario).toBe('A foggy morning.');
        const book = await readBook();
        expect(book[0].content).toBe('A timetable somebody else rewrote.');
        expect(book[1].content).toBe('Lanterns are welcome.');

        await expect(cards.nth(0)).toContainText('Saved');
        await expect(cards.nth(1)).toContainText('Saved');
        await expect(cards.nth(4)).toContainText('Saved');
        await expect(cards.nth(2).getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
        await expect(cards.nth(3).getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
        const remaining = page.getByRole('button', { name: 'Review all 2 changes', exact: true });
        await expect(remaining).toBeEnabled();
        await page.screenshot({ path: shots('after') });

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                const contrast = await remaining.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const context = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    let surface = element;
                    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                    return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(surface ?? document.body).backgroundColor));
                });
                expect(contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
        }


        // With one card left the button goes away.
        await cards.nth(2).getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(page.locator('.scratchpad-review-all')).toHaveCount(0);
    });
}

/* global document, getComputedStyle */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} reviews Scratchpad text changes`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const saved = await account.context.request.post('/api/characters/merge-attributes', {
            headers: account.headers,
            data: { avatar: account.avatar, data: { description: 'Nova waits by the old harbour.\nThe ferry leaves at dawn.' } },
        });
        expect(saved.ok()).toBe(true);
        await account.post('/api/worldinfo/edit', { name: 'Harbour', data: { entries: {
            0: { uid: 0, comment: 'Ferry', key: ['ferry'], content: 'The old timetable.' },
        } } });
        const page = await account.open();
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'character', character: 'Durable Nova', field: 'description', value: 'Nova waits by the quiet harbour.\nThe ferry leaves at dusk.' },
            { type: 'lorebook', action: 'delete', book: 'Harbour', uid: 0 },
            { type: 'lorebook', action: 'add', book: 'Harbour', title: 'Lantern', keys: ['lantern'], content: 'Bring a lantern.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Harbour revisions', messages: [
            { role: 'assistant', text: 'I adjusted the setting and the departure time.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') },
        ] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const cards = page.locator('.scratchpad-change');
        await cards.first().getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('.scratchpad-review')).toBeVisible();
        const diff = page.locator('.scratchpad-review .ica-transform-diff');
        const added = diff.locator('.ica-transform-diff-part--ins');
        const removed = diff.locator('.ica-transform-diff-part--del');
        await expect(added).toHaveText(['quiet', 'usk']);
        await expect(removed).toHaveText(['old', 'awn']);
        const layout = await diff.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth,
                scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, whiteSpace: style.whiteSpace,
                touchAction: style.touchAction, removedDecoration: getComputedStyle(element.querySelector('.ica-transform-diff-part--del')).textDecorationLine };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(layout.width);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
        expect(layout.whiteSpace).toBe('pre-wrap');
        expect(layout.removedDecoration).toBe('line-through');
        if (phone) expect(layout.touchAction).toBe('pan-y');
        await page.screenshot({ path: path.resolve('../screenshots/scratchpad-diff', `${phone ? 'phone' : 'desktop'}-after.png`) });
        const editor = page.getByRole('textbox', { name: 'Proposed text', exact: true });
        const edited = 'Nova waits by the old harbour.\nThe ferry leaves at midnight.\n<img src=x onerror=alert(1)> & <script>bad()</script>';
        await editor.fill(edited);
        await expect(added).toHaveText(['midnight.\n<img src=x onerror=alert(1)> & <script>bad()</script>']);
        await expect(removed).toHaveText(['dawn.']);
        await expect(diff.locator('img, script')).toHaveCount(0);
        await editor.fill('x'.repeat(2000));
        expect(await diff.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        const readCharacter = () => account.post('/api/characters/get', { avatar_url: account.avatar });
        expect((await readCharacter()).data.description).toBe('Nova waits by the old harbour.\nThe ferry leaves at dawn.');
        await cards.first().getByRole('button', { name: 'Review', exact: true }).click();
        await editor.fill('Nova waits by the old harbour.\nThe ferry leaves at midnight.');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.first()).toContainText('Saved');
        expect((await readCharacter()).data.description).toBe('Nova waits by the old harbour.\nThe ferry leaves at midnight.');

        await cards.nth(1).getByRole('button', { name: 'Review', exact: true }).click();
        await expect(removed).toContainText('The old timetable.');
        await expect(added).toHaveCount(0);
        await expect(editor).toHaveCount(0);
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        await cards.nth(2).getByRole('button', { name: 'Review', exact: true }).click();
        await expect(added).toContainText('Bring a lantern.');
        await expect(removed).toHaveCount(0);
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
    });
}

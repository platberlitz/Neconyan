import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} appends reviewed alternate greetings without replacing existing ones`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const existing = ['  The first existing greeting.  ', 'The last existing greeting.\n\n---\n\nStill the same greeting.'];
        const saveGreetings = async greetings => {
            const response = await account.context.request.post('/api/characters/merge-attributes', {
                headers: account.headers, data: { avatar: account.avatar, data: { alternate_greetings: greetings } },
            });
            expect(response.ok()).toBe(true);
        };
        const readCharacter = () => account.post('/api/characters/get', { avatar_url: account.avatar });
        await saveGreetings(existing);
        const original = await readCharacter();
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            await expect(page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true })).toBeEnabled();
        };
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const proposals = [
            { type: 'character', action: 'append', character: 'Durable Nova', field: 'alternate_greetings', value: ['Proposed addition.'] },
            { type: 'character', action: 'append', character: 'Durable Nova', field: 'alternate_greetings', value: ['The final addition.'] },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Greeting additions', messages: [
            { role: 'assistant', text: proposals.map(proposal => '```scratchpad-change\n' + JSON.stringify(proposal) + '\n```').join('\n') },
        ] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const first = page.locator('.scratchpad-change').first();
        await expect(first).toContainText('Add alternate greetings to Durable Nova');
        await first.getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('.scratchpad-review')).toContainText('Existing greetings (kept)');
        await expect(page.locator('.scratchpad-review-before')).toContainText(existing[1]);
        const editor = page.getByRole('textbox', { name: 'New greetings to append', exact: true });
        await expect(editor).toHaveValue('Proposed addition.');
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await readCharacter()).data.alternate_greetings).toEqual(existing);
        await first.getByRole('button', { name: 'Review', exact: true }).click();
        await editor.fill('Reviewed addition one.\n\n---\n\nReviewed addition two.');
        await page.screenshot({ path: test.info().outputPath('greeting-review.png') });
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(first).toContainText('Saved');
        const afterFirst = [...existing, 'Reviewed addition one.', 'Reviewed addition two.'];
        expect((await readCharacter()).data.alternate_greetings).toEqual(afterFirst);

        const second = page.locator('.scratchpad-change').nth(1);
        await second.getByRole('button', { name: 'Review', exact: true }).click();
        const afterOtherTab = [...afterFirst, 'Added in another tab.'];
        await saveGreetings(afterOtherTab);
        const refused = page.waitForResponse('**/api/characters/merge-attributes');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        expect((await refused).status()).toBe(409);
        await expect(second).not.toHaveClass(/is-applied/);
        expect((await readCharacter()).data.alternate_greetings).toEqual(afterOtherTab);
        await second.getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('.scratchpad-review-before')).toContainText('Added in another tab.');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(second).toContainText('Saved');
        const saved = await readCharacter();
        expect(saved.data.alternate_greetings).toEqual([...afterOtherTab, 'The final addition.']);
        expect(saved.data.first_mes).toBe(original.data.first_mes);
    });
}

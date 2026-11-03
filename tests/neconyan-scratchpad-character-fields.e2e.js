import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} reviews all character settings and preserves card siblings`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const read = () => account.post('/api/characters/get', { avatar_url: account.avatar });
        const setup = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar: account.avatar, data: {
            extensions: { depth_prompt: { prompt: 'Original note', depth: 4, role: 'system' }, scratchpad_test: { keep: 'untouched' } },
        } } });
        expect(setup.ok()).toBe(true);
        const original = await read();
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
        const fields = [
            ['extensions.depth_prompt.prompt', 'New {{char}} note'], ['extensions.depth_prompt.depth', 0],
            ['extensions.depth_prompt.role', 'assistant'], ['creator', 'Card author'], ['character_version', '2.0'],
            ['extensions.talkativeness', 0], ['extensions.fav', true], ['group_only_greetings', ['Group hello']],
            ['name', 'Renamed Nova'],
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Character settings', messages: [
            { role: 'assistant', text: fields.map(([field, value]) => '```scratchpad-change\n' + JSON.stringify({ type: 'character', character: 'Durable Nova', field, value }) + '\n```').join('\n') },
        ] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const cards = page.locator('.scratchpad-change');
        await cards.first().getByRole('button', { name: 'Review', exact: true }).click();
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await read()).data.extensions.depth_prompt.prompt).toBe('Original note');
        for (let index = 0; index < fields.length; index++) {
            await cards.nth(index).getByRole('button', { name: 'Review', exact: true }).click();
            if (index === 0) {
                await expect(page.getByRole('textbox', { name: 'Proposed text', exact: true })).toHaveValue('New {{char}} note');
                await page.screenshot({ path: test.info().outputPath('character-fields-review.png') });
            }
            await page.getByRole('button', { name: 'Save change', exact: true }).click();
            await expect(cards.nth(index)).toContainText('Saved');
        }
        const saved = await read();
        expect(saved.data.extensions.depth_prompt).toEqual({ prompt: 'New {{char}} note', depth: 0, role: 'assistant' });
        expect(saved.data.extensions.scratchpad_test).toEqual({ keep: 'untouched' });
        expect(saved.data.extensions.talkativeness).toBe(0);
        expect(saved.data.extensions.fav).toBe(true);
        expect(saved.data.creator).toBe('Card author');
        expect(saved.data.character_version).toBe('2.0');
        expect(saved.data.group_only_greetings).toEqual(['Group hello']);
        expect(saved.data.name).toBe('Renamed Nova');
        expect(saved.name).toBe('Renamed Nova');
        expect(saved.chat).toBe(original.chat);
        expect(saved.data.first_mes).toBe(original.data.first_mes);
    });
}

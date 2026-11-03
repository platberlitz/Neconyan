import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Creator recommended format and editable Dossier lore on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByLabel('Character dossier', { exact: true }).fill('Moon Harbour is a sheltered port. Mira repairs ships there.');
        await creator.getByRole('button', { name: 'purachina’s recommended', exact: true }).click();
        await expect(creator.getByRole('button', { name: 'purachina’s recommended', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.screenshot({ path: `../screenshots/creator-readable-format-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Lorebooks', exact: true }).click();
        await creator.getByLabel('Lorebook name', { exact: true }).fill('Places');
        await creator.getByRole('button', { name: 'New lorebook', exact: true }).click();
        await creator.locator('summary').filter({ hasText: 'Create entries from Dossier or character' }).click();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ entries: [{ uid: null, title: 'Moon Harbour', keys: ['Moon Harbour'], content: 'A sheltered port.', constant: false }], description: null, coverage: ['Created harbour entry'] }) } }] };
        await creator.getByRole('button', { name: 'Create entries from Dossier', exact: true }).click();
        await expect(creator.getByLabel('Entry content', { exact: true })).toHaveValue('[\nA sheltered port.\n]', { timeout: 30000 });
        await creator.getByLabel('Activation keywords, one per line', { exact: true }).fill('Moon Harbour\nMoon Port');
        await creator.getByLabel('Entry content', { exact: true }).fill('[\nA sheltered port with a repair dock.\n]');
        await page.screenshot({ path: `../screenshots/creator-readable-lore-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Accept entries and source choice', exact: true }).click();
        await creator.locator('summary').filter({ hasText: /^Moon Harbour$/ }).click();
        await expect(creator.getByLabel('Content', { exact: true })).toHaveValue('[\nA sheltered port with a repair dock.\n]');
        await expect(creator.getByLabel('Keys, one per line', { exact: true })).toHaveValue('Moon Harbour\nMoon Port');
    });
}

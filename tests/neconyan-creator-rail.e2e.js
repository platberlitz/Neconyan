import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Creator rail stays put and routes PList to the note on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        const rail = creator.locator('.creator-sections');
        const left = creator.getByRole('button', { name: 'Scroll Creator sections left' });
        const right = creator.getByRole('button', { name: 'Scroll Creator sections right' });
        await expect(left).toBeDisabled();
        await right.click();
        await expect.poll(() => rail.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
        await expect(left).toBeEnabled();
        const macros = rail.getByRole('button', { name: 'Macros & pronouns', exact: true });
        await macros.scrollIntoViewIfNeeded();
        const before = await rail.evaluate(node => node.scrollLeft);
        await macros.click();
        await expect(creator.getByLabel('Sentence to preview', { exact: true })).toBeVisible();
        expect(await rail.evaluate(node => node.scrollLeft)).toBeCloseTo(before, 0);
        await page.screenshot({ path: `../screenshots/creator-rail-${phone ? 'phone' : 'desktop'}.png` });
        await left.click();
        await expect.poll(() => rail.evaluate(node => node.scrollLeft)).toBeLessThan(before);
        await rail.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByLabel('Character dossier', { exact: true }).fill('Mira repairs ships.');
        await creator.getByRole('button', { name: 'PList', exact: true }).click();
        await creator.getByLabel('Custom writing format instructions', { exact: true }).fill('Use bracketed categories.');
        await creator.getByRole('button', { name: 'Expand Custom writing format instructions', exact: true }).click();
        await expect(page.locator('.creator-fullscreen textarea')).toHaveValue('Use bracketed categories.');
        await page.keyboard.press('Escape');
        await creator.getByRole('button', { name: 'Character’s Note', exact: true }).click();
        await page.screenshot({ path: `../screenshots/creator-note-format-${phone ? 'phone' : 'desktop'}.png` });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: { depth_prompt: '[Work: ship repairs]' }, questions: [], coverage: ['Kept occupation'] }) } }] };
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        await expect(creator.locator('.creator-proposal')).toBeVisible({ timeout: 30000 });
        await expect(creator.locator('.creator-proposal')).toContainText('Character’s Note');
        await creator.getByRole('button', { name: 'Accept all fields', exact: true }).click();
        await rail.getByRole('button', { name: 'Prompts', exact: true }).click();
        await expect(creator.getByLabel('Depth prompt', { exact: true })).toHaveValue('[Work: ship repairs]');
        expect(app.provider.calls.some(call => call.messages?.some(message => message.content?.includes('Use bracketed categories.')))).toBe(true);
    });
}

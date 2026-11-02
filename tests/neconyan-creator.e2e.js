/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Creator retains fullscreen dossier and publishes reviewed draft on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByLabel('Display name', { exact: true }).fill('Creator Mira');
        await creator.getByLabel('Description', { exact: true }).fill('Mira keeps {{charposs}} promises.');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByLabel('Character dossier', { exact: true }).fill('Private working notes.');
        await creator.getByRole('button', { name: 'Expand Character dossier', exact: true }).click();
        const editor = page.locator('.creator-fullscreen textarea');
        await editor.fill('Private working notes with {{poss}} intact.');
        await editor.press('Escape');
        await expect(creator.getByLabel('Character dossier', { exact: true })).toHaveValue('Private working notes with {{poss}} intact.');
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        const png = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 96; canvas.height = 128;
            canvas.getContext('2d').fillRect(0, 0, 96, 128);
            return canvas.toDataURL('image/png').split(',')[1];
        });
        await creator.getByLabel('Upload portrait', { exact: true }).setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
        await expect(creator.getByRole('button', { name: 'Selected portrait', exact: true })).toBeVisible();
        await creator.getByRole('button', { name: 'Crop square', exact: true }).click();
        await expect.poll(() => creator.locator('.creator-portrait img').evaluate(image => image.naturalWidth === image.naturalHeight)).toBe(true);
        const galleryFits = await creator.locator('.creator-portrait').evaluate(card => {
            const bounds = card.getBoundingClientRect();
            return [...card.children].every(child => {
                const box = child.getBoundingClientRect();
                return box.left >= bounds.left && box.right <= bounds.right + 1 && box.bottom <= bounds.bottom + 1;
            });
        });
        expect(galleryFits).toBe(true);
        await creator.getByRole('button', { name: 'Lorebooks', exact: true }).click();
        await creator.getByLabel('Lorebook name', { exact: true }).fill('Mira world');
        await creator.getByRole('button', { name: 'New lorebook', exact: true }).click();
        await creator.getByRole('button', { name: 'Add entry', exact: true }).click();
        await creator.locator('summary').filter({ hasText: /^Entry 0$/ }).click();
        await creator.getByLabel('Entry title', { exact: true }).fill('Alba');
        await creator.getByLabel('Content', { exact: true }).fill('Alba is a city.');
        await creator.getByRole('button', { name: 'Review & save', exact: true }).click();
        await creator.getByRole('button', { name: 'Save to library', exact: true }).click();
        await expect(creator.getByRole('status')).toHaveText('Character and reviewed lorebooks saved to your library.', { timeout: 30000 });
        await creator.getByRole('button', { name: 'Preview & export', exact: true }).click();
        const preview = creator.locator('pre');
        await expect(preview).toContainText('Mira keeps {{charposs}} promises.');
        await expect(preview).not.toContainText('Private working notes');
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
        await page.locator('#sb_character_tab_creator').waitFor({ state: 'attached' });
        if (!await creator.isVisible()) {
            await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
            await page.locator('#sb_character_tab_creator').click();
        }
        await creator.getByRole('button', { name: 'Creator Mira', exact: true }).first().click();
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await expect(creator.getByLabel('Character dossier', { exact: true })).toHaveValue('Private working notes with {{poss}} intact.');
    });
}

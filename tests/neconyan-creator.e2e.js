/* global document, jQuery, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';
import { contrastRatio } from '../public/scripts/theme-contrast.js';

async function sampleButtonContrast(locator) {
    return locator.evaluate(element => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const rgb = colour => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        };
        const composite = (over, under) => over.slice(0, 3).map((channel, i) => Math.round(channel * over[3] / 255 + under[i] * (1 - over[3] / 255)));
        const format = channels => `rgb(${channels.slice(0, 3).join(', ')})`;
        let backdrop = [255, 255, 255];
        const ancestors = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
        for (const parent of ancestors) backdrop = composite(rgb(getComputedStyle(parent).backgroundColor), backdrop);
        const base = composite(rgb(style.backgroundColor), backdrop);
        return { ink: format(rgb(style.color)), bg: format(base) };
    });
}

for (const phone of [false, true]) {
    test(`Creator retains fullscreen dossier and publishes reviewed draft on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await expect(creator.getByRole('button', { name: 'Create a character', exact: true })).toBeVisible();
        await page.screenshot({ path: `../screenshots/creator-redesign-hub-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByLabel('Display name', { exact: true }).fill('Creator Mira');
        await creator.getByLabel('Description', { exact: true }).fill('Mira keeps {{charposs}} promises.');
        await page.screenshot({ path: `../screenshots/creator-redesign-identity-${phone ? 'phone' : 'desktop'}.png` });

        // Measure accent contrast across default, pale (Mint Glass) and dark (Plum Wine) accents in Calico Dark and Calico Light
        const primarySave = creator.getByRole('button', { name: 'Review & save', exact: true });
        const selectedFormat = creator.locator('.creator-choice-grid--formats > .creator-choice-pill').filter({ hasText: 'Natural description' });
        const secondaryDrafts = creator.getByRole('button', { name: 'Drafts', exact: true });
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            for (const profile of [null, 'Mint Glass', 'Plum Wine']) {
                await page.evaluate(name => jQuery('#themes').val(name).trigger('change'), theme);
                if (profile) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(el => el.click());
                await settleCssTransitions(page);
                for (const [btnName, btn] of [['primary', primarySave], ['selected', selectedFormat], ['secondary', secondaryDrafts]]) {
                    const { ink, bg } = await sampleButtonContrast(btn);
                    expect(contrastRatio(ink, bg), `${theme} / ${profile || 'default'} / ${btnName}: ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
        await page.evaluate(() => {
            jQuery('#themes').val('Neconyan Calico Dark').trigger('change');
            const reset = document.querySelector('.sb-theme-preset-reset');
            if (reset) reset.click();
            document.querySelectorAll('#toast-container .toast').forEach(node => node.remove());
        });

        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByLabel('Character dossier', { exact: true }).fill('Private working notes.');
        await page.screenshot({ path: `../screenshots/creator-redesign-dossier-${phone ? 'phone' : 'desktop'}.png` });
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
        await page.screenshot({ path: `../screenshots/creator-redesign-lore-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Review & save', exact: true }).click();
        await page.screenshot({ path: `../screenshots/creator-redesign-review-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Save to library', exact: true }).click();
        const status = creator.locator('.creator-status');
        await expect(status.locator(':scope > span')).toHaveText('Character and reviewed lorebooks saved to your library.', { timeout: 30000 });
        await status.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(status).toBeHidden();
        await expect(status).toHaveText('');
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
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        await creator.getByRole('button', { name: 'Discard Creator Mira', exact: true }).click();
        await creator.getByRole('button', { name: 'Keep draft', exact: true }).click();
        await expect(creator.getByRole('button', { name: 'Creator Mira', exact: true }).first()).toBeVisible();
        await creator.getByRole('button', { name: 'Discard Creator Mira', exact: true }).click();
        await creator.getByRole('button', { name: 'Confirm discard', exact: true }).click();
        await expect(status.locator(':scope > span')).toHaveText('Draft discarded. Published library items were not changed.');
        await expect(status.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
        await expect(creator.locator('.creator-draft-list').getByRole('button', { name: 'Creator Mira', exact: true })).toHaveCount(0);
        await expect(creator.locator('.creator-library-grid').getByRole('button', { name: 'Creator Mira', exact: true })).toBeVisible();
    });
}

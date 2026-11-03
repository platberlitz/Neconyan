/* global document, requestAnimationFrame, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { fileURLToPath } from 'node:url';

for (const phone of [false, true]) {
    test(`Catelier explains formats, isolates Custom and dismisses errors on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.locator('[data-creator-section="dossier"]').click();
        const help = creator.getByRole('button', { name: 'What is purachina’s recommended?', exact: true });
        const helpBox = await help.boundingBox();
        expect(helpBox.width).toBeLessThanOrEqual(24);
        expect(Math.abs(helpBox.width - helpBox.height)).toBeLessThanOrEqual(1);
        const legend = creator.locator('.creator-format-box > legend');
        const before = (await creator.locator('.creator-format-box > .creator-muted').first().boundingBox()).y;
        await help.click();
        const tip = creator.getByRole('tooltip');
        await expect(tip).toContainText('square-bracketed profile');
        await expect(help).toHaveAttribute('aria-expanded', 'true');
        expect((await creator.locator('.creator-format-box > .creator-muted').first().boundingBox()).y).toBe(before);
        const tipBox = await tip.boundingBox();
        const fieldBox = await creator.locator('.creator-format-box').boundingBox();
        expect(tipBox.y).toBeGreaterThan(helpBox.y + helpBox.height);
        expect(tipBox.x).toBeGreaterThanOrEqual(fieldBox.x);
        expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width + 1);
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-format-help-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await help.click();
        await expect(tip).toBeHidden();
        await help.click();
        await expect(tip).toBeVisible();
        await legend.click();
        await expect(tip).toBeHidden();
        await expect(help).toHaveAttribute('aria-expanded', 'false');
        await creator.getByRole('button', { name: 'Custom', exact: true }).click();
        await expect(creator.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute('aria-pressed', 'true');
        for (const accent of [null, 'rgba(110, 231, 183, 1)', 'rgba(126, 34, 206, 1)']) {
            const contrast = await creator.getByRole('button', { name: 'Custom', exact: true }).evaluate(async (node, colour) => {
                if (colour) {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: colour } }));
                }
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                const rgba = value => {
                    context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255);
                };
                const layers = [];
                for (let parent = node; parent; parent = parent.parentElement) layers.unshift(rgba(getComputedStyle(parent).backgroundColor));
                const background = layers.reduce((back, front) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])), [1, 1, 1]);
                const luminance = rgb => rgb.slice(0, 3).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
                const text = luminance(rgba(getComputedStyle(node).color));
                const surface = luminance(background);
                return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
            }, accent);
            expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
        await creator.getByLabel('Character dossier', { exact: true }).fill('Mira repairs boats in Moon Harbour.');
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        const status = creator.locator('.creator-status');
        await expect(status).toContainText('Add your custom writing format instructions');
        await status.scrollIntoViewIfNeeded();
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-dismiss-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await status.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(status).toBeHidden();
        await expect(creator.getByLabel('Character dossier', { exact: true })).toHaveValue('Mira repairs boats in Moon Harbour.');
        await creator.getByLabel('Custom writing format instructions', { exact: true }).fill('Use a YAML mapping with biography and voice keys.');
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-custom-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await creator.locator('[data-creator-section="identity"]').click();
        await expect(creator.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(creator.getByLabel('Custom writing format instructions', { exact: true })).toHaveValue('Use a YAML mapping with biography and voice keys.');
        await creator.locator('[data-creator-section="instructions"]').click();
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
        await creator.locator('[data-creator-section="dossier"]').click();
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '<none>' }) }));
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        await expect(status).toContainText('HTTP 502', { timeout: 30000 });
        await status.scrollIntoViewIfNeeded();
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-dismiss-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await status.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(status).toBeHidden();
        await creator.locator('[data-creator-section="identity"]').click();
        await expect(status).toBeHidden();
    });
}

/* global document, getComputedStyle, Image, window */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { isolateSettingsSaves, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

const files = ['Neconyan - Sunlit Window.jpg', 'Neconyan - Midnight Rooftops.jpg', 'Neconyan - Cream Clouds.jpg'];
const tile = (page, file) => page.locator('#bg_menu_content .bg_example').filter({ has: page.locator(`button[aria-label="Delete background: ${file}"]`) });
const screenshotDirectory = process.env.NECONYAN_BACKGROUND_SCREENSHOTS;
const contentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../default/content');
const defaultFiles = JSON.parse(fs.readFileSync(path.join(contentDirectory, 'index.json'), 'utf8'))
    .filter(item => item.type === 'background')
    .map(item => path.basename(item.filename));

test.describe.configure({ mode: 'serial' });
for (const width of [393, 1280]) {
    test(`delete and restore backgrounds at ${width}px`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const context = await browser.newContext({
            baseURL: info.project.use.baseURL,
            viewport: { width, height: width === 393 ? 852 : 900 },
            hasTouch: width === 393,
            serviceWorkers: 'block',
        });
        let page;
        let deletingDefaults = false;
        try {
            page = await context.newPage();
            await isolateSettingsSaves(page);
            await openQuietChatForSmoke(page);
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
            if (await dismiss.isVisible()) await dismiss.click();
            await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
            const notNow = page.getByRole('button', { name: 'Not now', exact: true });
            if (await notNow.isVisible()) await notNow.click();
            await expect(tile(page, files[0])).toBeVisible({ timeout: 60000 });
            const available = await page.locator('#bg_menu_content .bg_example').evaluateAll(elements => elements.map(element => element.getAttribute('bgfile')));
            expect(available, 'Run against a disposable library with every default already present').toEqual(expect.arrayContaining(defaultFiles));
            for (const file of files) {
                const response = await page.request.get(new URL(`backgrounds/${encodeURIComponent(file)}`, page.url()).href);
                expect(response.ok()).toBe(true);
                const expected = fs.readFileSync(path.join(contentDirectory, 'backgrounds', file));
                const hash = bytes => createHash('sha256').update(bytes).digest('hex');
                expect(hash(await response.body()), `Refusing to delete a customised ${file}`).toBe(hash(expected));
            }
            await expect(page.locator('#bg_restore_defaults_button')).toBeVisible();
            if (screenshotDirectory) {
                await page.evaluate(() => window.toastr?.clear());
                await expect(page.locator('#toast-container .toast')).toHaveCount(0);
                fs.mkdirSync(screenshotDirectory, { recursive: true });
                await page.screenshot({ path: path.join(screenshotDirectory, `background-gallery-after-${width}.png`) });
            }
            await page.locator('#bg_menu_content .bg_example').first().scrollIntoViewIfNeeded();
            if (screenshotDirectory) {
                await page.waitForFunction(() => Array.from(document.querySelectorAll('#bg_menu_content .bg_example .thumbnail-clipper'))
                    .filter(element => {
                        const rect = element.getBoundingClientRect();
                        return rect.top < window.innerHeight && rect.bottom > 0 && element.style.backgroundImage && !element.style.backgroundImage.includes('data:image');
                    }).length >= 5);
                await page.evaluate(async () => {
                    const sources = Array.from(document.querySelectorAll('#bg_menu_content .bg_example .thumbnail-clipper'))
                        .filter(element => {
                            const rect = element.getBoundingClientRect();
                            return rect.top < window.innerHeight && rect.bottom > 0 && !element.style.backgroundImage.includes('data:image');
                        })
                        .map(element => element.style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1])
                        .filter(Boolean);
                    await Promise.all(sources.map(source => {
                        const image = new Image();
                        image.src = source;
                        return image.decode();
                    }));
                });
                await page.screenshot({ path: path.join(screenshotDirectory, `background-gallery-controls-${width}.png`) });
            }

            const deleteButton = tile(page, files[0]).locator('button[data-action="delete"]');
            const box = await deleteButton.boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(width === 393 ? 44 : 30);
            expect(box.height).toBeGreaterThanOrEqual(width === 393 ? 44 : 30);
            for (const profile of [null, 'Mint Glass', 'Plum Wine']) {
                await page.mouse.move(0, 0);
                await page.evaluate(() => window.jQuery('#themes').val('Neconyan Calico').trigger('change'));
                if (profile) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(element => element.click());
                const contrast = () => deleteButton.locator('i').evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }))
                    .then(colours => contrastRatio(colours.foreground, colours.background));
                await expect.poll(contrast, { message: `${profile || 'default'} delete button contrast` }).toBeGreaterThanOrEqual(4.5);
                if (width !== 393) {
                    await deleteButton.hover();
                    await expect.poll(contrast, { message: `${profile || 'default'} hovered delete button contrast` }).toBeGreaterThanOrEqual(4.5);
                }
            }

            await tile(page, files[0]).click();
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage.replaceAll('%20', ' '))).toContain(files[0]);
            await page.locator('#bg_selection_mode_button').click();
            await expect(page.locator('#bg_selection_mode_button')).toHaveAttribute('aria-pressed', 'true');
            await expect(deleteButton).toBeHidden();
            await tile(page, files[0]).focus();
            await tile(page, files[0]).press('Space');
            await expect(tile(page, files[0])).toHaveAttribute('aria-checked', 'true');
            await tile(page, files[1]).click();
            await expect(page.locator('#bg_group_select_count')).toContainText('2');

            await page.route('**/api/backgrounds/delete', async route => {
                const body = route.request().postDataJSON();
                if (body.bg === files[1]) await route.fulfill({ status: 500, json: { error: 'test failure' } });
                else await route.continue();
            });
            await page.locator('#bg_group_delete_button').click();
            deletingDefaults = true;
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(tile(page, files[0])).toHaveCount(0);
            await expect(tile(page, files[1])).toHaveClass(/folder-group-selected/);
            await expect(page.locator('#bg_group_select_count')).toContainText('1');
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage.replaceAll('%20', ' '))).not.toContain(files[0]);
            await expect(page.locator('#toast-container')).toContainText('1 deleted; 1 could not be deleted.');
            await page.unroute('**/api/backgrounds/delete');
            await page.locator('#bg_group_delete_button').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(tile(page, files[1])).toHaveCount(0);
            await expect(page.locator('#bg_selection_mode_button')).toHaveAttribute('aria-pressed', 'false');

            await tile(page, files[2]).locator('button[data-action="delete"]').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(tile(page, files[2])).toHaveCount(0);
            const activeBeforeRestore = await page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage);
            await page.locator('#bg_restore_defaults_button').click();
            for (const file of files) await expect(tile(page, file)).toBeVisible({ timeout: 30000 });
            expect(await page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toBe(activeBeforeRestore);

            await tile(page, files[0]).click();
            await tile(page, files[1]).locator('.jg-lock').evaluate(element => element.click());
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage.replaceAll('%20', ' '))).toContain(files[1]);
            await tile(page, files[1]).locator('button[data-action="delete"]').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(tile(page, files[1])).toHaveCount(0);
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage.replaceAll('%20', ' '))).toContain(files[0]);
            await page.locator('#bg_restore_defaults_button').click();
            await expect(tile(page, files[1])).toBeVisible({ timeout: 30000 });
            deletingDefaults = false;
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        } finally {
            if (deletingDefaults && page && !page.isClosed()) {
                await page.evaluate(async () => {
                    const { getRequestHeaders } = await import('/script.js');
                    const response = await fetch('/api/backgrounds/restore-defaults', {
                        method: 'POST', headers: getRequestHeaders(), body: '{}',
                    });
                    if (!response.ok) throw new Error('Could not restore backgrounds after the test');
                });
            }
            await context.close();
        }
    });
}

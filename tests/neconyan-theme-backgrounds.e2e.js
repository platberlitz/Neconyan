/* global document, getComputedStyle, window */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'default/content/backgrounds/artwork-provenance.json'), 'utf8'));
const backgrounds = provenance.backgrounds.filter(item => item.batch === 'themeMatchedBatch');
const samples = ['Neconyan Calico', 'Neconyan Calico Dark', 'Arcade Cabinet', 'Dracula Light'];
const screenshotDirectory = process.env.NECONYAN_BACKGROUND_SCREENSHOTS;

for (const width of [393, 1280]) {
    test.describe(`theme backgrounds at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, serviceWorkers: 'block' });
        test('offers every match and applies light and dark samples', async ({ page }) => {
            test.setTimeout(180000);
            await isolateSettingsSaves(page);
            await openQuietChatForSmoke(page);
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
            if (await dismiss.isVisible()) await dismiss.click();
            await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
            if (screenshotDirectory) {
                fs.mkdirSync(screenshotDirectory, { recursive: true });
                await page.screenshot({ path: path.join(screenshotDirectory, `theme-background-before-${width}.png`) });
            }
            await page.evaluate(() => {
                window.NeconyanShell.applyTheme('calico');
                window.NeconyanShell.openTab('right', 'background');
            });
            const notNow = page.getByRole('button', { name: 'Not now', exact: true });
            if (await notNow.isVisible()) await notNow.click();
            await page.locator('#background_fitting').selectOption('cover');
            await expect(page.locator('#bg_menu_content .bg_example').first()).toBeAttached({ timeout: 30000 });
            const available = await page.locator('#bg_menu_content .bg_example').evaluateAll(elements => elements.map(el => el.getAttribute('bgfile')));
            expect(backgrounds).toHaveLength(182);
            for (const item of backgrounds) expect(available).toContain(path.basename(item.finalFile));

            let previousFile;
            for (const theme of samples) {
                const item = backgrounds.find(background => background.theme === theme);
                const file = path.basename(item.finalFile);
                await page.evaluate(name => window.$('#themes').val(name).trigger('change'), theme);
                if (previousFile) {
                    await expect.poll(() => page.locator('#bg1').evaluate(el => getComputedStyle(el).backgroundImage.replaceAll('%20', ' '))).toContain(previousFile);
                }
                await page.locator(`#bg_menu_content .bg_example[bgfile="${file}"]`).click();
                await expect.poll(() => page.locator('#bg1').evaluate(el => {
                    const background = getComputedStyle(el).backgroundImage;
                    return background.startsWith('url("') ? background.replaceAll('%20', ' ') : '';
                })).toContain(file);
                const geometry = await page.locator('#bg1').evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    return { width: rect.width, height: rect.height, fit: getComputedStyle(el).backgroundSize };
                });
                expect(geometry.width).toBeGreaterThan(0);
                expect(geometry.height).toBeGreaterThan(0);
                expect(geometry.fit).toContain('cover');
                expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
                previousFile = file;
                if (screenshotDirectory) {
                    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
                    await page.screenshot({ path: path.join(screenshotDirectory, `theme-background-${theme.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${width}.png`) });
                    await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
                }
            }
        });
    });
}

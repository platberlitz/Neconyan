/* global document, getComputedStyle, window */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'default/content/backgrounds/artwork-provenance.json'), 'utf8'));
const backgrounds = provenance.backgrounds.filter(item => item.batch === 'themeMatchedBatch');
const mobileBackgrounds = JSON.parse(fs.readFileSync(path.join(root, 'default/content/backgrounds-mobile/artwork-provenance.json'), 'utf8')).backgrounds;
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
            await page.locator('#background_position').selectOption('auto');
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
                const imageUrl = await page.locator('#bg1').evaluate(el => {
                    const match = /^url\("(.*)"\)$/.exec(getComputedStyle(el).backgroundImage);
                    return match ? new URL(match[1], window.location.href).href : '';
                });
                expect(new URL(imageUrl).pathname.startsWith('/api/backgrounds/mobile/')).toBe(width === 393);
                const image = await page.request.get(imageUrl);
                expect(image.status()).toBe(200);
                const expectedHash = width === 393
                    ? mobileBackgrounds.find(background => background.theme === theme).mobileSha256
                    : item.finalSha256;
                expect(createHash('sha256').update(await image.body()).digest('hex')).toBe(expectedHash);
                const saved = await page.evaluate(async () => (await import('/scripts/backgrounds.js')).background_settings.url);
                expect(saved).toBe(`url("backgrounds/${encodeURIComponent(file)}")`);
                expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
                previousFile = file;
                if (screenshotDirectory) {
                    await page.evaluate(async src => {
                        const image = new window.Image();
                        image.src = src;
                        await image.decode();
                    }, imageUrl);
                    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
                    await page.screenshot({ path: path.join(screenshotDirectory, `theme-background-mobile-${theme.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${width}.png`) });
                    await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
                }
            }

            if (width === 393) {
                const imagePath = () => page.locator('#bg1').evaluate(el => {
                    const image = getComputedStyle(el).backgroundImage;
                    const match = /^url\("(.*)"\)$/.exec(image);
                    return match ? new URL(match[1], window.location.href).pathname : image;
                });
                const file = previousFile;
                await page.locator('#background_fitting').selectOption('classic');
                await expect.poll(imagePath).toBe(`/api/backgrounds/mobile/${encodeURIComponent(file)}`);
                await page.locator('#background_fitting').selectOption('contain');
                await expect.poll(imagePath).toBe(`/backgrounds/${encodeURIComponent(file)}`);
                await page.locator('#background_fitting').selectOption('cover');
                await expect.poll(imagePath).toBe(`/api/backgrounds/mobile/${encodeURIComponent(file)}`);
                await page.locator('#background_position').selectOption('left');
                await expect.poll(imagePath).toBe(`/backgrounds/${encodeURIComponent(file)}`);
                await page.locator('#background_position').selectOption('auto');
                await expect.poll(imagePath).toBe(`/api/backgrounds/mobile/${encodeURIComponent(file)}`);
                await page.setViewportSize({ width: 1280, height: 900 });
                await expect.poll(imagePath).toBe(`/backgrounds/${encodeURIComponent(file)}`);
                await page.setViewportSize({ width: 700, height: 393 });
                await expect.poll(imagePath).toBe(`/backgrounds/${encodeURIComponent(file)}`);
                await page.setViewportSize({ width: 393, height: 852 });
                await expect.poll(imagePath).toBe(`/api/backgrounds/mobile/${encodeURIComponent(file)}`);

                // Generated and extension backgrounds can set the element directly.
                await page.locator('#bg1').evaluate(element => { element.style.backgroundImage = 'url("/backgrounds/__transparent.png")'; });
                await page.locator('#background_fitting').selectOption('contain');
                await expect.poll(imagePath).toBe('/backgrounds/__transparent.png');
                await page.locator('#background_fitting').selectOption('cover');
                await page.evaluate(() => {
                    window.__backgroundMediaChanges = 0;
                    window.matchMedia('(max-width: 768px) and (orientation: portrait)').addEventListener('change', () => { window.__backgroundMediaChanges++; });
                });
                await page.setViewportSize({ width: 1280, height: 900 });
                await expect.poll(() => page.evaluate(() => window.__backgroundMediaChanges)).toBe(1);
                await expect.poll(imagePath).toBe('/backgrounds/__transparent.png');
                await page.setViewportSize({ width: 393, height: 852 });
                await expect.poll(() => page.evaluate(() => window.__backgroundMediaChanges)).toBe(2);
                await expect.poll(imagePath).toBe('/backgrounds/__transparent.png');
                await page.locator('#background_position').selectOption('left');
                await expect.poll(imagePath).toBe('/backgrounds/__transparent.png');
                await page.locator('#background_position').selectOption('auto');
                await page.locator(`#bg_menu_content .bg_example[bgfile="${file}"]`).click();
                await expect.poll(imagePath).toBe(`/api/backgrounds/mobile/${encodeURIComponent(file)}`);
                await page.locator(`#bg_menu_content .bg_example[bgfile="${file}"] .jg-lock`).evaluate(element => element.click());
                const locked = await page.evaluate(async () => (await import('/script.js')).chat_metadata.custom_background);
                expect(locked).toBe(`url("backgrounds/${encodeURIComponent(file)}")`);
                await expect.poll(imagePath).toBe(`/api/backgrounds/mobile/${encodeURIComponent(file)}`);
            }
        });
    });
}

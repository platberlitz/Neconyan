/* global document, window, Image, getComputedStyle */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

const titles = ['Velvet Moon', 'Rainy Lantern Loft', 'Mosslight Grotto', 'Indigo Tide', 'Ember Hearth', 'Starlit Snow'];

for (const width of [393, 1280]) {
    test.describe(`dark backgrounds at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, serviceWorkers: 'block' });
        test('installs and applies all six night scenes without bright large surfaces', async ({ page }) => {
            test.setTimeout(120000);
            await isolateSettingsSaves(page);
            await openQuietChatForSmoke(page);
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
            await page.evaluate(() => {
                window.NeconyanShell.applyTheme('calico');
                window.$('#themes').val('Neconyan Calico Dark').trigger('change');
                window.NeconyanShell.openTab('right', 'background');
            });
            await page.locator('#background_fitting').selectOption('cover');
            // A fresh server builds metadata for every background on the first gallery load.
            await expect(page.locator('#bg_menu_content .bg_example').first()).toBeAttached({ timeout: 30000 });
            for (const title of titles) {
                const file = `Neconyan - ${title}.jpg`;
                const choice = page.locator(`#bg_menu_content .bg_example[bgfile="${file}"]`);
                await expect(choice).toHaveCount(1);
                await choice.click();
                // During the transition Chromium returns cross-fade(... N%, ...), not a URL.
                await expect.poll(() => page.locator('#bg1').evaluate(el => {
                    const background = getComputedStyle(el).backgroundImage;
                    return background.startsWith('url("') ? decodeURIComponent(background) : '';
                })).toContain(file);
                const image = await page.locator('#bg1').evaluate(async el => {
                    const image = new Image();
                    image.src = getComputedStyle(el).backgroundImage.slice(5, -2);
                    await image.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = 96;
                    canvas.height = 64;
                    const context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0, 96, 64);
                    const pixels = context.getImageData(0, 0, 96, 64).data;
                    let dark = 0;
                    for (let i = 0; i < pixels.length; i += 4) {
                        if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] < 100) dark++;
                    }
                    return { width: image.naturalWidth, height: image.naturalHeight, darkFraction: dark / (96 * 64) };
                });
                expect(image.width).toBe(1536);
                expect(image.height).toBe(1024);
                expect(image.darkFraction, title).toBeGreaterThan(0.85);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        });
    });
}

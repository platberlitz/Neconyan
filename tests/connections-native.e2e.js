/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

for (const phone of [true, false]) {
    test(`Connections feedback stays compact on ${phone ? 'phone' : 'desktop'}`, async ({ browser }, info) => {
        const context = await browser.newContext({
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            serviceWorkers: 'block', reducedMotion: 'reduce',
        });
        if (phone) await installIPhoneSafari(context, { standalone: true });
        const page = await context.newPage();
        try {
            await page.goto(process.env.NECONYAN_TEST_BASE_URL || 'http://127.0.0.1:4433');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('#main_api').selectOption('openai');
            await page.locator('#chat_completion_source').selectOption('custom');
            const tools = page.locator('.neconyan-connection-tools');
            const status = page.locator('#openai_api .online_status');
            const connect = page.locator('#api_button_openai');
            await tools.locator('summary').click();
            if (phone) await applyIOSOnlyCss(page);
            await page.evaluate(async () => {
                (await import('/script.js')).startStatusLoading();
                document.querySelector('#openai_api .online_status_text').textContent = 'Status check bypassed';
            });
            for (const width of phone ? [393, 320, 768] : [1280, 997]) {
                await page.setViewportSize({ width, height: phone ? 852 : 900 });
                await expect.poll(() => status.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(65);
                const bounds = await status.boundingBox();
                const toolBounds = await tools.boundingBox();
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(toolBounds.y);
                expect((await connect.boundingBox()).height).toBeGreaterThanOrEqual(44);
                expect((await connect.boundingBox()).height).toBeLessThan(60);
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
            }
            await page.setViewportSize({ width: phone ? 393 : 1280, height: phone ? 852 : 900 });
            await connect.scrollIntoViewIfNeeded();
            await page.evaluate(() => { document.activeElement?.blur(); window.toastr?.remove(); });
            await page.screenshot({ path: info.outputPath('loading-expanded.png') });
            await page.locator('#openai_api .api_loading').click();
            await expect(page.locator('#openai_api .api_loading')).toBeHidden();
            await expect(connect).not.toHaveClass(/disabled/);
            await page.locator('#customize_additional_parameters').click();
            await expect(page.locator('dialog[open]')).toBeVisible();
            await page.locator('dialog[open] .popup-button-ok').click();

            // A long model name or translated status wraps inside the panel.
            await status.locator('.online_status_text').evaluate(element => element.textContent = 'Connected to a custom provider with a very long model identifier '.repeat(3));
            expect(await status.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            const dot = await status.locator('.online_status_indicator').boundingBox();
            expect(dot.width).toBe(8);
            expect(dot.height).toBe(8);

            for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
                await page.locator('#themes').selectOption({ label: theme }, { force: true });
                for (const accent of [null, 'Mint Glass', 'Plum Wine']) {
                    if (accent) await page.locator(`.sb-accent-profile-apply[title="Apply ${accent}"]`).evaluate(element => element.click());
                    await expect.poll(() => connect.evaluate(element => {
                        const style = getComputedStyle(element);
                        const canvas = document.createElement('canvas');
                        canvas.width = canvas.height = 1;
                        const context = canvas.getContext('2d');
                        const luminance = colour => {
                            context.clearRect(0, 0, 1, 1);
                            context.fillStyle = colour;
                            context.fillRect(0, 0, 1, 1);
                            const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                                const channel = value / 255;
                                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                            });
                            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                        };
                        const foreground = luminance(style.color);
                        const background = luminance(style.backgroundColor);
                        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
                    }), { message: `${theme}: ${accent || 'default'} Connect contrast` }).toBeGreaterThanOrEqual(4.5);
                }
            }
            await page.locator('#themes').selectOption({ label: 'Neconyan Calico Dark' }, { force: true });
        } finally {
            await context.close();
        }
    });
}

/* global window */
import { expect, test } from '@playwright/test';

test.setTimeout(60000);

async function expand(page, selector) {
    const header = page.locator(selector);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`assistant icons at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width < 768, isMobile: viewport.width < 768, serviceWorkers: 'block' });
        test('selects, badges and remembers each assistant icon', async ({ page }, testInfo) => {
            await page.goto('/');
            await expect(page.locator('.neconyan-assistant-row').first()).toBeAttached({ timeout: 60000 });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
            await expand(page, '#AppearanceSection > .inline-drawer-header');
            await expand(page, '#sb-interface-drawer > .inline-drawer-header');
            const options = page.locator('[data-sb-frontend-icon-option]');
            await expect(options).toHaveCount(4);
            for (const id of ['miso', 'taro', 'nori']) {
                const button = page.locator(`[data-sb-frontend-icon-option="${id}"]`);
                await button.click();
                await expect(button).toHaveAttribute('aria-pressed', 'true');
                await expect.poll(() => page.evaluate(() => window.localStorage.getItem('sb-frontend-icon'))).toBe(id);
                await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', new RegExp(`assistant-icons/${id}\\.png$`));
                const geometry = await button.evaluate(element => {
                    const box = element.getBoundingClientRect();
                    const image = element.querySelector('img');
                    return { width: box.width, height: box.height, left: box.left, right: box.right, imageWidth: image.naturalWidth, rendering: window.getComputedStyle(image).imageRendering };
                });
                expect(geometry.width).toBeGreaterThanOrEqual(44);
                expect(geometry.height).toBeGreaterThanOrEqual(44);
                expect(geometry.left).toBeGreaterThanOrEqual(0);
                expect(geometry.right).toBeLessThanOrEqual(viewport.width);
                expect(geometry.imageWidth).toBe(192);
                expect(geometry.rendering).toBe('auto');
                await page.evaluate(async () => {
                    const notifications = await import('/scripts/neconyan-conversation/notifications.js');
                    notifications.updateConversationFaviconBadge(2);
                });
                await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /^data:image\/png/);
                await page.evaluate(async () => {
                    const notifications = await import('/scripts/neconyan-conversation/notifications.js');
                    notifications.updateConversationFaviconBadge(0);
                });
                await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', new RegExp(`assistant-icons/${id}\\.png$`));
            }
            await page.locator('.sb-frontend-icon-group').screenshot({ path: testInfo.outputPath('assistant-icons.png') });
            await page.reload();
            await expect(page.locator('.neconyan-assistant-row').first()).toBeAttached({ timeout: 60000 });
            await expect(page.locator('html')).toHaveAttribute('data-sb-frontend-icon', 'nori');
            await expect.poll(() => page.evaluate(() => window.NeconyanFrontendIcon.getSrc())).toBe('/img/neconyan/assistant-icons/nori.png');
            await page.evaluate(() => window.NeconyanShell.showHome());
            const miso = page.locator('[data-assistant-personality="miso"]');
            await miso.locator('input[value="miso-neutral"]').check();
            await miso.locator('[data-assistant-open]').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().characterId)).toBeDefined();
            await page.evaluate(() => window.NeconyanShell.activateMode('meower'));
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-chat-mode', 'meower');
            await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', '/img/neconyan-paw-192.png');
            await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
            await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /assistant-icons\/nori\.png$/);
        });
    });
}

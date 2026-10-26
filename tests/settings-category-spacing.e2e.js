/* global document, window, NeconyanShell */
import { expect, test } from '@playwright/test';

test('settings categories fit their labels across responsive layouts', async ({ browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext({
        viewport: { width: 1000, height: 900 },
        hasTouch: true,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
        await page.goto('/');
        await page.waitForFunction(() => window.NeconyanShell);
        await page.locator('#preloader').waitFor({ state: 'detached' });
        const skip = page.getByRole('button', { name: 'Skip', exact: true });
        if (await skip.isVisible()) await skip.click();
        await page.evaluate(() => NeconyanShell.openTab('right', 'settings'));
        const nav = page.locator('#sb-settings-tabs');
        await expect(nav).toBeVisible();
        await page.evaluate(() => document.fonts.ready);

        for (const width of [769, 1000, 1100, 1280, 393]) {
            await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
            const metrics = await nav.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                return {
                    width: bounds.width,
                    scrollWidth: element.scrollWidth,
                    buttons: [...element.querySelectorAll('button')].map(button => {
                        const rect = button.getBoundingClientRect();
                        const range = document.createRange();
                        range.selectNodeContents(button);
                        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, contentWidth: range.getBoundingClientRect().width };
                    }),
                };
            });
            expect(metrics.buttons).toHaveLength(4);
            for (const button of metrics.buttons) expect(button.height).toBeGreaterThanOrEqual(44);

            if (width > 768 && width <= 1100) {
                for (const button of metrics.buttons) {
                    expect(button.width - button.contentWidth).toBeLessThanOrEqual(26);
                }
                for (let i = 1; i < metrics.buttons.length; i++) {
                    const previous = metrics.buttons[i - 1];
                    const current = metrics.buttons[i];
                    if (current.y === previous.y) expect(current.x - previous.x - previous.width).toBeCloseTo(4, 0);
                }
                expect(metrics.scrollWidth).toBeLessThanOrEqual(Math.ceil(metrics.width));
            } else if (width > 1100) {
                expect(new Set(metrics.buttons.map(button => button.x)).size).toBe(1);
                expect(new Set(metrics.buttons.map(button => button.y)).size).toBe(4);
            } else {
                expect(new Set(metrics.buttons.map(button => button.y)).size).toBe(1);
                expect(metrics.scrollWidth).toBeGreaterThan(metrics.width);
            }
            await nav.locator('[data-tab="cache-account"]').click();
            await expect(page.locator('#user-settings-block-content')).toHaveAttribute('data-active-tab', 'cache-account');
            await nav.locator('[data-tab="appearance"]').click();
            await expect(page.locator('#user-settings-block-content')).toHaveAttribute('data-active-tab', 'appearance');
        }
    } finally {
        await context.close();
    }
});

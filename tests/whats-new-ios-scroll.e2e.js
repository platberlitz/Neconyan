/* global document, window */
import { test, expect } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

// iPhones size every popup body to its content (popup-safari-fix.css). The full-screen
// What's new sheet then grew past the screen, Done sat below the fold and nothing scrolled.
test('What\'s new fits the screen and scrolls on an iPhone home-screen app', async ({ browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext(IPHONE_SAFARI_CONTEXT);
    await installIPhoneSafari(context, { standalone: true });
    const page = await context.newPage();
    try {
        await page.goto('/');
        await page.waitForFunction(() => document.querySelector('[data-action="whats-new"]') && !document.querySelector('.neconyan-home-booting'));
        await page.addStyleTag({ content: '#nn-update-toast, #toast-container { display: none !important; }' });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        await page.addLocatorHandler(skip, () => skip.click());
        await applyIOSOnlyCss(page);
        expect(await page.evaluate(() => document.body.classList.contains('safari'))).toBe(true);

        await page.locator('[data-action="whats-new"]:visible').first().click();
        const dialog = page.locator('dialog.neconyan-whats-new-dialog[open]');
        await expect(dialog).toBeVisible();
        await applyIOSOnlyCss(page);
        // A new version may have only a few lines; make sure the list is longer than the screen.
        await dialog.evaluate(element => {
            const filler = document.createElement('div');
            filler.style.blockSize = '1600px';
            element.querySelector('.popup-content').append(filler);
        });

        const geometry = await dialog.evaluate(element => {
            const content = element.querySelector('.popup-content');
            const done = element.querySelector('.popup-button-ok').getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return {
                viewport: window.innerHeight,
                dialogBottom: box.bottom,
                doneTop: done.top,
                doneBottom: done.bottom,
                scrollable: content.scrollHeight > content.clientHeight + 1,
            };
        });
        expect(geometry.dialogBottom).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.doneTop).toBeGreaterThanOrEqual(0);
        expect(geometry.doneBottom).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.scrollable).toBe(true);

        const scrolled = await dialog.evaluate(element => {
            const content = element.querySelector('.popup-content');
            content.scrollTop = 300;
            return content.scrollTop;
        });
        expect(scrolled).toBeGreaterThan(0);

        await dialog.locator('.popup-button-ok').click();
        await expect(page.locator('dialog.neconyan-whats-new-dialog[open]')).toHaveCount(0);
    } finally {
        await context.close();
    }
});

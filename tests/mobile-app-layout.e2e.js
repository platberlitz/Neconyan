/* global window, document */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneApp, IPHONE_APP_USER_AGENT } from './ios-safari-emulation.js';

test.use({ hasTouch: true, isMobile: true, serviceWorkers: 'block', reducedMotion: 'reduce' });

async function openChat(page) {
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Start the layout check only after the app's boot overlay has been removed.
    await page.waitForFunction(() => !document.querySelector('.neconyan-home-booting, #preloader, #loader') && window.NeconyanShell);
    await page.evaluate(() => {
        document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]')?.click();
        document.querySelector('#nn-update-toast')?.remove();
        document.querySelector('button.openTemporaryChat').click();
    });
    await expect(page.locator('#send_textarea')).toBeVisible();
    await page.evaluate(() => { window.SillyTavern.getContext().executeSlashCommandsWithOptions('/sys Workspace layout test'); });
    await expect(page.locator('#chat')).toContainText('Workspace layout test');
}

for (const [width, height, typingHeight, ios] of [[320, 568, 352, false], [852, 393, 203, false], [852, 393, 203, true]]) {
    test.describe(`${width}px ${ios ? 'iPhone' : 'Android'}`, () => {
        test.use({ viewport: { width, height }, ...(ios ? { userAgent: IPHONE_APP_USER_AGENT } : {}) });
        test('keeps chat and composer above the keyboard', async ({ page, context }) => {
            if (ios) await installIPhoneApp(context);
            await openChat(page);
            if (ios) await applyIOSOnlyCss(page, { inPlace: true });
            const root = page.locator('html');
            if (width > 768) await expect(root).toHaveAttribute('data-neconyan-sidebar', 'closed');
            const composer = page.locator('#send_textarea');
            await composer.focus();
            if (ios) {
                // WKWebView can leave the layout height unchanged as the keyboard opens.
                await page.evaluate(height => {
                    Object.defineProperty(window.visualViewport, 'height', { value: height, configurable: true });
                    window.visualViewport.dispatchEvent(new Event('resize'));
                }, typingHeight);
            } else {
                await page.setViewportSize({ width, height: typingHeight });
            }
            await expect(root).toHaveClass(/sb-short-touch-composer/);
            await expect(page.locator('#sb-bottom-chat-bar')).toBeHidden();
            await expect(page.locator('#gg-action-button-container')).toBeHidden();
            const chat = await page.locator('#chat').boundingBox();
            const input = await composer.boundingBox();
            const actions = await page.locator('#options_button').boundingBox();
            expect(chat.height).toBeGreaterThanOrEqual(70);
            expect(input.y + input.height).toBeLessThanOrEqual(typingHeight);
            expect(actions.y + actions.height).toBeLessThanOrEqual(typingHeight);
            expect(actions.height).toBeGreaterThanOrEqual(44);
            expect(actions.width).toBeGreaterThanOrEqual(44);
            await composer.blur();
            if (ios) {
                await page.evaluate(() => {
                    Reflect.deleteProperty(window.visualViewport, 'height');
                    window.visualViewport.dispatchEvent(new Event('resize'));
                });
            } else {
                await page.setViewportSize({ width, height });
            }
            await expect(root).not.toHaveClass(/sb-short-touch-composer/);
        });
    });
}

/* global window, document */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneApp, IPHONE_APP_CONTEXT, IPHONE_APP_USER_AGENT } from './ios-safari-emulation.js';

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
    // Opening a temporary chat can focus the composer, which already enters
    // the short editing layout in landscape. Start with the keyboard closed.
    await page.locator('#send_textarea').blur();
    await expect(page.locator('html')).not.toHaveClass(/sb-short-touch-composer/);
    await page.waitForFunction(() => Array.from(document.styleSheets).some(sheet => sheet.href?.includes('/neconyan-touch-layout.css')));
}

test.describe('portrait iPhone composer', () => {
    test.use(IPHONE_APP_CONTEXT);

    for (const [scale, personaSize, actionSize] of [[100, 34, 38], [85, 29, 34]]) {
        test(`keeps the compact layout at ${scale}% Bottom Bar Size`, async ({ page, context }) => {
            await installIPhoneApp(context);
            await page.addInitScript(value => window.localStorage.setItem('sb-bottom-bar-scale', String(value)), scale);
            await openChat(page);
            await applyIOSOnlyCss(page, { inPlace: true });

            await expect(page.locator('.stih--menuTrigger')).toBeVisible();
            const persona = await page.locator('#sb-persona-bubble').boundingBox();
            const picker = await page.locator('#sb-bottom-chat-picker-button').boundingBox();
            const options = await page.locator('#options_button').boundingBox();
            const history = await page.locator('.stih--menuTrigger').boundingBox();
            const guided = await page.locator('.gg-regular-buttons-container button').first().boundingBox();
            expect(Math.round(persona.height)).toBe(personaSize);
            expect(Math.round(picker.height)).toBe(personaSize);
            expect(options.height).toBe(actionSize);
            expect(history.height).toBe(32);
            expect(guided.height).toBe(32);
            expect(guided.y).toBeCloseTo(history.y, 0);
        });
    }
});

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
            const chatBar = page.locator('#sb-bottom-chat-bar');
            const guidedActions = page.locator('#gg-action-button-container');
            await expect(chatBar).toBeVisible();
            await expect(guidedActions).toBeVisible();
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
            await expect(chatBar).toBeHidden();
            await expect(guidedActions).toBeHidden();
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
            await expect(chatBar).toBeVisible();
            await expect(guidedActions).toBeVisible();
        });
    });
}

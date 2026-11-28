/* global window, document, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneApp, IPHONE_APP_CONTEXT, IPHONE_APP_USER_AGENT } from './ios-safari-emulation.js';

test.use({ hasTouch: true, isMobile: true, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

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
    // Opening a temporary chat can focus the composer. Start with the keyboard closed.
    await page.locator('#send_textarea').blur();
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

async function openKeyboard(page, { ios, width, typingHeight, offsetTop = 0 }) {
    await page.locator('#send_textarea').focus();
    if (ios) {
        // WKWebView leaves the layout height unchanged as the keyboard opens and
        // scrolls the page underneath it instead.
        await page.evaluate(({ height, top }) => {
            Object.defineProperty(window.visualViewport, 'height', { value: height, configurable: true });
            Object.defineProperty(window.visualViewport, 'offsetTop', { value: top, configurable: true });
            window.visualViewport.dispatchEvent(new Event('resize'));
        }, { height: typingHeight, top: offsetTop });
    } else {
        await page.setViewportSize({ width, height: typingHeight });
    }
}

async function closeKeyboard(page, { ios, width, height }) {
    await page.locator('#send_textarea').blur();
    if (ios) {
        await page.evaluate(() => {
            Reflect.deleteProperty(window.visualViewport, 'height');
            Reflect.deleteProperty(window.visualViewport, 'offsetTop');
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
    } else {
        await page.setViewportSize({ width, height });
    }
}

for (const [width, height, typingHeight, ios, offsetTop] of [
    [320, 568, 352, false, 0], [393, 852, 400, true, 0], [393, 852, 400, true, 300],
    [852, 393, 203, false, 0], [852, 393, 203, true, 0], [852, 393, 203, true, 150],
]) {
    test.describe(`${width}x${height} ${ios ? `iPhone, page scrolled ${offsetTop}px` : 'Android'}`, () => {
        test.use({ viewport: { width, height }, ...(ios ? { userAgent: IPHONE_APP_USER_AGENT } : {}) });
        test('keeps the normal layout while typing', async ({ page, context }) => {
            if (ios) await installIPhoneApp(context);
            await openChat(page);
            if (ios) await applyIOSOnlyCss(page, { inPlace: true });
            const chatBar = page.locator('#sb-bottom-chat-bar');
            const guidedActions = page.locator('#gg-action-button-container');
            const sheldHeight = () => page.locator('#sheld').evaluate(element => element.getBoundingClientRect().height);
            const before = await sheldHeight();
            await openKeyboard(page, { ios, width, typingHeight, offsetTop });
            // Let the viewport sync run before checking that nothing changed.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await expect(chatBar).toBeVisible();
            await expect(guidedActions).toBeVisible();
            if (ios) expect(Math.abs(await sheldHeight() - before)).toBeLessThanOrEqual(1);
            await closeKeyboard(page, { ios, width, height });
            await expect(chatBar).toBeVisible();
        });
    });
}

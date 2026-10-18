/* global document, Element, requestAnimationFrame, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const ANDROID_CONTEXT = {
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36',
};

function trackChatListRequests(page) {
    const requests = [];
    const pending = new Set();
    let lastRequest = 0;
    const record = request => {
        if (!/\/api\/(?:characters\/chats|chats\/group\/info)$/.test(new URL(request.url()).pathname)) return;
        requests.push(request.url());
        pending.add(request);
        lastRequest = Date.now();
    };
    const finish = request => pending.delete(request);
    page.on('request', record);
    page.on('requestfinished', finish);
    page.on('requestfailed', finish);
    return {
        requests,
        settled: () => pending.size === 0 && Date.now() - lastRequest >= 500,
        stop() {
            page.off('request', record);
            page.off('requestfinished', finish);
            page.off('requestfailed', finish);
        },
    };
}

for (const platform of ['iOS', 'Android']) {
    const prepareContext = platform === 'iOS' ? installIPhoneSafari : async () => {};
    const preparePage = platform === 'iOS' ? applyIOSOnlyCss : async () => {};
    const heights = platform === 'Android' ? [700, 500, 700, 852] : [];
    test.describe(`${platform} viewport work`, () => {
        test.use({ serviceWorkers: 'block', ...(platform === 'iOS' ? IPHONE_SAFARI_CONTEXT : ANDROID_CONTEXT) });
        test.setTimeout(120_000);

        test('keyboard movement leaves chat lists and closed menu anchors alone', async ({ page, context }) => {
            await prepareContext(context);
            const chatLists = trackChatListRequests(page);
            await page.addInitScript(() => {
                window.addEventListener('neconyan:ready', () => { window.mobilePerformanceAppReady = true; }, { once: true });
            });
            await isolateSettingsSaves(page);
            await openReadyChat(page);
            await preparePage(page);
            await page.waitForFunction(() => window.mobilePerformanceAppReady === true, null, { timeout: 90_000 });
            await expect.poll(chatLists.settled, { timeout: 15_000 }).toBe(true);
            await waitForAnimationFrames(page, 3);
            chatLists.requests.length = 0;
            await page.evaluate(() => {
                const original = Element.prototype.getBoundingClientRect;
                const anchors = new Set(['options_button', 'export_button', 'extensionsMenuButton']);
                window.mobileMenuAnchorReads = [];
                Element.prototype.getBoundingClientRect = function (...args) {
                    if (anchors.has(this.id)) window.mobileMenuAnchorReads.push(this.id);
                    return original.apply(this, args);
                };
                window.restoreMobileMenuProbe = () => { Element.prototype.getBoundingClientRect = original; };
            });

            try {
                await page.evaluate(async () => {
                    for (let frame = 0; frame < 12; frame++) {
                        window.visualViewport.dispatchEvent(new Event('scroll'));
                        window.visualViewport.dispatchEvent(new Event('resize'));
                        await new Promise(resolve => requestAnimationFrame(resolve));
                    }
                });
                // Android's adjustResize changes the layout height as its keyboard moves.
                // The iOS branch separately exercises visual viewport events above.
                for (const height of heights) {
                    await page.setViewportSize({ width: 393, height });
                    await waitForAnimationFrames(page, 2);
                }
                // Include delayed refreshes, rather than checking only the dispatch frame.
                await waitForAnimationFrames(page, 40);
                expect(chatLists.requests).toEqual([]);
                expect(await page.evaluate(() => window.mobileMenuAnchorReads)).toEqual([]);
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
            } finally {
                chatLists.stop();
                await page.evaluate(() => window.restoreMobileMenuProbe());
            }
        });

        test('widening an open phone drawer restores chat interaction on desktop', async ({ page, context }) => {
            await prepareContext(context);
            await isolateSettingsSaves(page);
            await openReadyChat(page);
            await preparePage(page);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            await expect(page.locator('#sheld')).toHaveAttribute('inert', '');
            await page.setViewportSize({ width: 1280, height: 900 });
            await expect(page.locator('#sheld')).not.toHaveAttribute('inert', '');
            await expect(page.locator('body')).not.toHaveClass(/sb-mobile-modal-open/);
            await expect(page.locator('#send_textarea')).toBeEditable();
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
        });
    });
}

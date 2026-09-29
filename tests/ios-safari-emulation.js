/* global CSSSupportsRule, document, Navigator, window */

/**
 * Chromium stand-in for iPhone Safari. It spoofs what the app's JS reads
 * (user agent, navigator.platform, touch points, optionally home-screen mode)
 * and re-applies the CSS that only WebKit parses: rules inside @supports
 * blocks testing -webkit-touch-callout or -webkit-overflow-scrolling, which
 * Chromium drops. It is still Blink rendering, so WebKit paint bugs are not
 * reproduced; label results as inferred for iOS.
 *
 * Usage (Playwright):
 *   const context = await browser.newContext(IPHONE_SAFARI_CONTEXT);
 *   await installIPhoneSafari(context, { standalone: false });
 *   const page = await context.newPage();
 *   await page.goto(url);
 *   // after the panel you are testing has loaded its late stylesheets:
 *   await applyIOSOnlyCss(page);
 */

export const IPHONE_SAFARI_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

export const IPHONE_SAFARI_CONTEXT = Object.freeze({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_SAFARI_USER_AGENT,
});

export const IOS_ONLY_SUPPORTS_PATTERN = /-webkit-touch-callout|-webkit-overflow-scrolling/;

/**
 * Makes isIOSWebKitPlatform(), the body.safari class and, optionally,
 * body.PWA behave as they would on an iPhone.
 * @param {import('playwright').BrowserContext} context
 * @param {{ standalone?: boolean }} [options] standalone: pretend to be a home-screen web app
 */
export async function installIPhoneSafari(context, { standalone = false } = {}) {
    await context.addInitScript(({ standalone }) => {
        Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'iPhone' });
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
        Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => standalone });
        if (standalone) {
            const matchMedia = window.matchMedia.bind(window);
            window.matchMedia = query => /display-mode:\s*standalone/.test(query)
                ? { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }
                : matchMedia(query);
        }
    }, { standalone });
}

/**
 * Copies every rule from WebKit-only @supports blocks into one <style> at the
 * end of <head>. Call it again after late stylesheets load; it replaces its
 * previous copy. Being last in the document, the copies can win ties they
 * would lose on a real iPhone, so double-check any result that hinges on order.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ rules: number, skippedSheets: string[] }>}
 */
export async function applyIOSOnlyCss(page) {
    return page.evaluate((pattern) => {
        const matcher = new RegExp(pattern);
        const collected = [];
        const skippedSheets = [];
        const walk = (rules) => {
            for (const rule of rules) {
                if (rule instanceof CSSSupportsRule && matcher.test(rule.conditionText)) {
                    for (const inner of rule.cssRules) collected.push(inner.cssText);
                } else if (rule.cssRules) {
                    walk(rule.cssRules);
                }
            }
        };
        for (const sheet of document.styleSheets) {
            if (sheet.ownerNode?.id === 'nn-ios-only-css') continue;
            try {
                walk(sheet.cssRules);
            } catch {
                skippedSheets.push(sheet.href || 'inline');
            }
        }
        document.getElementById('nn-ios-only-css')?.remove();
        const style = document.createElement('style');
        style.id = 'nn-ios-only-css';
        style.textContent = collected.join('\n');
        document.head.append(style);
        return { rules: collected.length, skippedSheets };
    }, IOS_ONLY_SUPPORTS_PATTERN.source);
}

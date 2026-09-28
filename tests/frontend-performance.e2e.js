/* global globalThis */
import { expect, test } from '@playwright/test';

const coreAssetPaths = [
    '/script.js',
    '/scripts/neconyan-tabs.js',
    '/style.css',
    '/css/neconyan-mobile-shell.css',
];

async function waitForResourceStability(page) {
    let previousCount = -1;
    let stableSamples = 0;

    await expect.poll(async () => {
        // Retained jobs keep polling after startup; only static assets settle.
        const resourceCount = await page.evaluate(() => globalThis.performance.getEntriesByType('resource')
            .filter(entry => !new globalThis.URL(entry.name).pathname.startsWith('/api/')).length);
        stableSamples = resourceCount > 0 && resourceCount === previousCount ? stableSamples + 1 : 0;
        previousCount = resourceCount;
        return stableSamples;
    }, {
        timeout: 15000,
        intervals: [250, 250, 500, 500],
    }).toBeGreaterThanOrEqual(3);
}

test.describe('frontend performance smoke', () => {
    test('mobile shell exposes core performance marks and bounded assets', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(() => globalThis.performance.setResourceTimingBufferSize(2000));
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('load', { timeout: 60000 });
        await page.waitForFunction(() => {
            const browserGlobal = globalThis;
            return browserGlobal.document.readyState === 'complete'
                && browserGlobal.document.getElementById('preloader') === null
                && typeof browserGlobal.SillyTavern?.getContext === 'function'
                && Boolean(browserGlobal.NeconyanShell);
        }, null, { timeout: 60000 });
        await waitForResourceStability(page);

        const snapshot = await page.evaluate((expectedCoreAssetPaths) => {
            const browserGlobal = globalThis;
            const resources = browserGlobal.performance.getEntriesByType('resource');
            const jsBytes = resources
                .filter(entry => /\.m?js(?:\?|$)/i.test(entry.name))
                .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0);
            const cssBytes = resources
                .filter(entry => /\.css(?:\?|$)/i.test(entry.name))
                .reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), 0);
            const fontRequests = resources.filter(entry => /\.(?:woff2?|ttf)(?:\?|$)/i.test(entry.name)).length;
            const coreAssetBytes = Object.fromEntries(expectedCoreAssetPaths.map(assetPath => [assetPath, 0]));

            for (const resource of resources) {
                const assetPath = new browserGlobal.URL(resource.name).pathname;
                if (Object.prototype.hasOwnProperty.call(coreAssetBytes, assetPath)) {
                    coreAssetBytes[assetPath] = Math.max(
                        coreAssetBytes[assetPath],
                        resource.transferSize || resource.encodedBodySize || resource.decodedBodySize || 0,
                    );
                }
            }

            return {
                title: browserGlobal.document.title,
                hasShell: Boolean(browserGlobal.NeconyanShell),
                assetCount: resources.filter(entry => !new browserGlobal.URL(entry.name).pathname.startsWith('/api/')).length,
                jsBytes,
                cssBytes,
                fontRequests,
                coreAssetBytes,
                optionalSpeechRequests: resources.filter(entry => /\/tts\/(?:kokoro-worker|lib\/kokoro.web)\.js/.test(entry.name)).length,
                extensionPrefetches: browserGlobal.document.querySelectorAll('link[rel="prefetch"][href*="/scripts/extensions/"]').length,
            };
        }, coreAssetPaths);

        expect(snapshot.title).toBe('Neconyan');
        expect(snapshot.hasShell).toBe(true);
        // Native tools now include more modules than the old Neconyan fixture.
        // Keep the measured cold start bounded without truncating its timing buffer.
        expect(snapshot.assetCount).toBeLessThan(1000);
        expect(snapshot.optionalSpeechRequests).toBe(0);
        expect(snapshot.extensionPrefetches).toBe(0);
        expect(snapshot.jsBytes).toBeGreaterThan(0);
        expect(snapshot.jsBytes).toBeLessThan(12 * 1024 * 1024);
        expect(snapshot.cssBytes).toBeGreaterThan(0);
        expect(snapshot.cssBytes).toBeLessThan(2 * 1024 * 1024);
        expect(snapshot.fontRequests).toBeLessThan(18);
        for (const assetPath of coreAssetPaths) {
            expect(snapshot.coreAssetBytes[assetPath]).toBeGreaterThan(0);
        }
    });
});

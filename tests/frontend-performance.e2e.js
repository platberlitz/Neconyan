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
    test('mobile shell exposes core performance marks and bounded assets', async ({ page }, testInfo) => {
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
                resources: resources.filter(entry => !new browserGlobal.URL(entry.name).pathname.startsWith('/api/'))
                    .map(({ name, initiatorType, transferSize, encodedBodySize, decodedBodySize }) =>
                        ({ name, initiatorType, transferSize, encodedBodySize, decodedBodySize })),
            };
        }, coreAssetPaths);

        await testInfo.attach('startup-resources', { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' });
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

        const startupResourceNames = snapshot.resources.map(entry => entry.name);
        expect(startupResourceNames.some(name => name.includes('/Neconyan-BotSearcher/client/browser.js'))).toBe(false);
        expect(startupResourceNames.some(name => name.includes('/Neconyan-Prompting-Lab/src/ui/cases-tab.js'))).toBe(false);

        const activeTabSelector = [
            '.sbpl-cases-tab', '.sbpl-presets-tab', '.sbpl-prompts-tab', '.sbpl-run-tab',
            '.sbpl-ledger-tab', '.sbpl-diff-tab', '.sbpl-experiment-tab', '.sbpl-ab-tab',
            '.sbpl-scenes-tab', '.sbpl-settings-tab',
        ].join(', ');

        // First-use Prompting Lab via the Extensions → Built-in settings page, then open/close full-page mode.
        await page.evaluate(() => globalThis.document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]')?.click());
        await page.evaluate(() => globalThis.NeconyanShell.openTab('right', 'extensions'));
        await page.locator('[data-extensions-scope="built-in"]').click();
        await page.locator('.sb-extensions-tool').filter({ hasText: 'Prompting Lab' }).click();
        const drawerToggle = page.locator('#sbpl-settings .inline-drawer-toggle');
        await expect(drawerToggle).toBeVisible();
        if (await drawerToggle.getAttribute('aria-expanded') !== 'true') {
            await drawerToggle.click();
        }
        await expect(page.locator('#sbpl-settings #sbpl-workbench')).toBeVisible();
        await expect(page.locator(`#sbpl-settings #sbpl-panel > :is(${activeTabSelector})`)).toBeVisible();
        await expect(page.locator('#sbpl-settings #sbpl-panel')).not.toContainText('still being built');
        expect(await page.evaluate(() => globalThis.performance.getEntriesByType('resource')
            .some(entry => entry.name.includes('/Neconyan-Prompting-Lab/src/ui/cases-tab.js')))).toBe(true);

        await page.locator('#sbpl-open-page').click();
        await expect(page.locator('#sbpl-page')).toBeVisible();
        await expect(page.locator(`#sbpl-page #sbpl-panel > :is(${activeTabSelector})`)).toBeVisible();
        await expect(page.locator('#sbpl-page #sbpl-panel')).not.toContainText('still being built');
        await page.locator('#sbpl-page .sbpl-page-close').click();
        await expect(page.locator('#sbpl-page')).toBeHidden();
        await expect(page.locator('#sbpl-settings #sbpl-workbench')).toBeInViewport();
        await expect(page.locator(`#sbpl-settings #sbpl-panel > :is(${activeTabSelector})`)).toBeInViewport();

        // First-use BotSearcher via /botsearch slash command and reuse via the import panel button.
        expect(await page.evaluate(() => globalThis.performance.getEntriesByType('resource')
            .some(entry => entry.name.includes('/Neconyan-BotSearcher/client/browser.js')))).toBe(false);
        await page.evaluate(() => globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions('/botsearch moon'));
        const botSearcherDialog = page.locator('dialog.popup[open] :is(.sbbs-root, .sbbs-install)');
        await expect(botSearcherDialog).toBeVisible();
        if (await page.locator('dialog.popup[open] .sbbs-root').isVisible()) {
            await expect(page.locator('#sbbs_query')).toHaveValue('moon');
        }
        await page.locator('dialog.popup[open] .popup-button-close').click();
        await expect(botSearcherDialog).toBeHidden();

        await page.evaluate(() => globalThis.document.getElementById('sbbs_import_action')?.click());
        await expect(botSearcherDialog).toBeVisible();
        await page.locator('dialog.popup[open] .popup-button-close').click();
        await expect(botSearcherDialog).toBeHidden();
        expect(await page.evaluate(() => globalThis.performance.getEntriesByType('resource')
            .filter(entry => entry.name.includes('/Neconyan-BotSearcher/client/browser.js')).length)).toBe(1);
    });
});

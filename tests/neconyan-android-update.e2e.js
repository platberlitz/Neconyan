/* global window, getComputedStyle */
import { expect, test } from '@playwright/test';

const status = {
    runtime: 'Node.js (Android)', version: { pkgVersion: '1.2.9' },
    repository: { supported: false, isRepo: false },
    androidRelease: { supported: true, checked: true, currentVersion: '1.2.9', latestVersion: '1.3.0', architecture: 'arm64',
        assetAvailable: true, canUpdate: true, message: 'Neconyan v1.3.0 is available from GitHub. Android will ask before installing it. Your saved data stays on this device.' },
};

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} Android APK updates`, () => {
        test.setTimeout(90000);
        test.use({ serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });

        async function openServer(page, response = status, bridge = true) {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
            if (bridge) await page.addInitScript(() => {
                window.NeconyanAndroid = { bridgeRequiresToken: () => true, installUpdate: (token, version) => {
                    if (token !== 'a'.repeat(64)) return false;
                    window.apkRequestedVersion = version; return true;
                } };
            });
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: response }));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.NeconyanShell?.openTab, { timeout: 60000 });
            if (bridge) await page.evaluate(async () => {
                const module = await import('/scripts/android-native-bridge.js');
                module.installAndroidNativeBridge('a'.repeat(64), window.location.origin);
            });
            await expect(page.locator('#loader')).toBeHidden({ timeout: 60000 });
            const skipTour = page.locator('[data-tour-coach-skip]');
            if (await skipTour.isVisible()) await skipTour.click();
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'server'));
            const panel = page.locator('#sb-shell-panel-right-server');
            await expect(panel.getByRole('button', { name: 'Update APK', exact: true })).toBeVisible({ timeout: 30000 });
            return panel;
        }

        test('shows the release and sends only its version to the native updater', async ({ page }) => {
            const forbidden = [];
            page.on('request', request => {
                if (/\/api\/server-admin\/(?:update|zip-update)$/.test(request.url())) forbidden.push(request.url());
            });
            const panel = await openServer(page);
            await expect(panel).toContainText('GitHub APK');
            await expect(panel).toContainText('Latest APK');
            await expect(panel.getByText('Auto-stash local changes before pulling', { exact: true })).toBeHidden();
            const button = panel.getByRole('button', { name: 'Update APK', exact: true });
            await expect(button).toBeEnabled();
            await button.scrollIntoViewIfNeeded();
            const geometry = await button.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, height: rect.height, width: window.innerWidth };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            if (phone) expect(geometry.height).toBeGreaterThanOrEqual(44);
            const defaultAccent = await page.evaluate(() => getComputedStyle(window.document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim());
            for (const accent of [defaultAccent, 'rgba(249, 232, 199, 1)', 'rgba(66, 40, 16, 1)']) {
                // Use the real colour control so its matching label colour updates too.
                await page.locator('#quote-color-picker').evaluate((element, colour) => {
                    element.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { rgba: colour } }));
                }, accent);
                const contrast = await button.evaluate(element => {
                    const style = getComputedStyle(element);
                    const canvas = window.document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d');
                    const luminance = value => {
                        // Computed colours can use color(srgb ...), not just rgb(...).
                        context.fillStyle = value;
                        context.fillRect(0, 0, 1, 1);
                        const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(x => x / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
                        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
                    };
                    const a = luminance(style.color), b = luminance(style.backgroundColor);
                    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), foreground: style.color, background: style.backgroundColor };
                });
                expect(contrast.ratio, JSON.stringify({ accent, ...contrast })).toBeGreaterThanOrEqual(4.5);
            }
            await button.click();
            expect(await page.evaluate(() => window.apkRequestedVersion)).toBe('1.3.0');
            expect(forbidden).toEqual([]);
        });

        test('does not offer a downgrade or installation outside the Android app', async ({ page }) => {
            const panel = await openServer(page, status, false);
            await expect(panel.getByRole('button', { name: 'Update APK', exact: true })).toBeDisabled();
            await expect(panel).toContainText('Open the Neconyan Android app to install this APK update.');
            await page.unroute('**/api/server-admin/status');
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: {
                ...status, androidRelease: { ...status.androidRelease, canUpdate: false, message: 'No newer APK is available on GitHub.' },
            } }));
            await panel.getByRole('button', { name: 'Check for updates', exact: true }).click();
            await expect(panel).toContainText('No newer APK is available on GitHub.');
            await expect(panel.getByRole('button', { name: 'Update APK', exact: true })).toBeDisabled();
        });
    });
}

/* global window */
import { expect, test } from '@playwright/test';

const releaseUrl = 'https://github.com/platberlitz/Neconyan/releases/tag/v1.3.0';
const status = {
    runtime: 'Node.js (iOS)', version: { pkgVersion: '1.2.9' },
    repository: { supported: false, isRepo: false },
    release: null, androidRelease: null, host: 'ios', canRestart: false,
    iosRelease: { supported: true, checked: true, currentVersion: '1.2.9', latestVersion: '1.3.0', releaseUrl,
        assetName: 'Neconyan-1.3.0-ios-unsigned.ipa', assetAvailable: true, canUpdate: true,
        message: 'Neconyan v1.3.0 is available from GitHub. Download the IPA from the release page and install it over this copy with the same sideloading tool you used before.' },
};

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} iPhone app updates`, () => {
        test.setTimeout(90000);
        test.use({ serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });

        async function openServer(page, response = status) {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
            await page.addInitScript(() => {
                window.openedUrls = [];
                window.open = (url) => { window.openedUrls.push(String(url)); return null; };
            });
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: response }));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.NeconyanShell?.openTab, { timeout: 60000 });
            await expect(page.locator('#loader')).toBeHidden({ timeout: 60000 });
            const skipTour = page.locator('[data-tour-coach-skip]');
            if (await skipTour.isVisible()) await skipTour.click();
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'server'));
            const panel = page.locator('#sb-shell-panel-right-server');
            await expect(panel.getByRole('button', { name: 'Get the IPA', exact: true })).toBeVisible({ timeout: 30000 });
            return panel;
        }

        test('points at the IPA and never offers a restart the app cannot do', async ({ page }) => {
            const forbidden = [];
            page.on('request', request => {
                if (/\/api\/server-admin\/(?:update|zip-update|restart)$/.test(request.url())) forbidden.push(request.url());
            });
            const panel = await openServer(page);
            await expect(panel).toContainText('GitHub IPA');
            await expect(panel).toContainText('Latest IPA');
            await expect(panel).toContainText('IPA update available');
            await expect(panel.getByText('Auto-stash local changes before pulling', { exact: true })).toBeHidden();
            await expect(panel.getByRole('button', { name: 'Restart server', exact: true })).toHaveCount(1);
            await expect(panel.getByRole('button', { name: 'Restart server', exact: true })).toBeHidden();
            await expect(panel.getByRole('button', { name: 'Save & Restart', exact: true })).toBeHidden();
            const button = panel.getByRole('button', { name: 'Get the IPA', exact: true });
            await expect(button).toBeEnabled();
            await button.scrollIntoViewIfNeeded();
            const geometry = await button.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, height: rect.height, width: window.innerWidth };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            if (phone) expect(geometry.height).toBeGreaterThanOrEqual(44);
            await button.click();
            expect(await page.evaluate(() => window.openedUrls)).toEqual([releaseUrl]);
            await expect(panel).toContainText('Download the IPA from the release page');
            expect(forbidden).toEqual([]);
        });

        test('stays quiet when there is no newer IPA', async ({ page }) => {
            const panel = await openServer(page, {
                ...status, iosRelease: { ...status.iosRelease, canUpdate: false, message: 'No newer IPA is available on GitHub.' },
            });
            await expect(panel).toContainText('No newer IPA is available on GitHub.');
            await expect(panel.getByRole('button', { name: 'Get the IPA', exact: true })).toBeDisabled();
            await expect(page.locator('#nn-update-toast')).toHaveCount(0);
        });
    });
}

/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} update notice`, () => {
        test.setTimeout(90000);
        test.use({ serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            hasTouch: phone, isMobile: phone });

        test('fits on screen and stops covering controls after eight seconds', async ({ page }) => {
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: {
                repository: { isRepo: true, remoteCommit: 'release-toast-fixture', behind: 2 },
            } }));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            const toast = page.locator('#nn-update-toast');
            await expect(toast).toBeVisible({ timeout: 60000 });
            const geometry = await toast.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                    width: window.innerWidth, height: window.innerHeight, position: getComputedStyle(element).position };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            expect(geometry.top).toBeGreaterThanOrEqual(0);
            expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
            expect(geometry.position).toBe('fixed');
            await page.mouse.move(0, 0);
            await expect(toast).toHaveCount(0, { timeout: 12000 });
            expect(await page.evaluate(() => document.getElementById('nn-update-toast'))).toBeNull();
        });

        test('announces an APK release, opens Server, and stays dismissed on reload', async ({ page }) => {
            await page.addInitScript(() => { window.NeconyanAndroid = { installUpdate() {} }; });
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: {
                version: { pkgVersion: '1.2.9' }, repository: { isRepo: false },
                androidRelease: { supported: true, checked: true, assetAvailable: true, canUpdate: true,
                    latestVersion: '1.3.0', architecture: 'arm64', message: 'An APK update is available.' },
            } }));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            const toast = page.locator('#nn-update-toast');
            await expect(toast).toBeVisible({ timeout: 60000 });
            await expect(toast).toContainText('APK v1.3.0 is ready. Open Server to update.');
            const bounds = await toast.boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(phone ? 852 : 900);
            await toast.locator('.nn-update-toast-open').click();
            await expect(toast).toHaveCount(0);
            await expect(page.locator('#sb-shell-panel-right-server').getByRole('button', { name: 'Update APK', exact: true })).toBeVisible();
            expect(await page.evaluate(() => window.localStorage.getItem('neconyan:update-toast-commit'))).toBe('apk:arm64:1.3.0');
            await page.reload({ waitUntil: 'networkidle' });
            await expect(page.locator('#nn-update-toast')).toHaveCount(0);
        });

        for (const phase of ['metadata', 'stylesheet']) {
            test(`keeps an APK notice unread when backgrounded during ${phase}`, async ({ page }) => {
                let release;
                let requested;
                const held = new Promise(resolve => { release = resolve; });
                const started = new Promise(resolve => { requested = resolve; });
                await page.addInitScript(heldPhase => {
                    if (heldPhase !== 'metadata') return;
                    const readText = Response.prototype.text;
                    Response.prototype.text = async function (...args) {
                        const text = await readText.apply(this, args);
                        if (this.url.endsWith('/api/server-admin/status')) {
                            window.setTimeout(() => { window.updateNoticeSettled = true; }, 0);
                        }
                        return text;
                    };
                }, phase);
                await page.route('**/api/server-admin/status', async route => {
                    if (phase === 'metadata') { requested(); await held; }
                    await route.fulfill({ json: {
                        repository: { isRepo: false },
                        androidRelease: { supported: true, checked: true, assetAvailable: true, canUpdate: true,
                            latestVersion: '1.3.0', architecture: 'arm64' },
                    } });
                });
                if (phase === 'stylesheet') await page.route('**/neconyan-update-toast.css*', async route => {
                    requested();
                    await held;
                    await route.continue();
                });
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                await started;
                // Simulate leaving the app while the real response or stylesheet is in flight.
                await page.evaluate(heldPhase => {
                    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                    if (heldPhase === 'stylesheet') {
                        document.querySelector('link[href*="neconyan-update-toast.css"]').addEventListener('load', () => {
                            window.setTimeout(() => { window.updateNoticeSettled = true; }, 0);
                        }, { once: true });
                    }
                }, phase);
                release();
                await page.waitForFunction(() => window.updateNoticeSettled);
                await expect(page.locator('#nn-update-toast')).toHaveCount(0);
                expect(await page.evaluate(() => window.localStorage.getItem('neconyan:update-toast-commit'))).toBeNull();
                await page.evaluate(() => {
                    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
                    document.dispatchEvent(new Event('visibilitychange'));
                });
                await expect(page.locator('#nn-update-toast')).toContainText('APK v1.3.0 is ready. Open Server to update.');
                expect(await page.evaluate(() => window.localStorage.getItem('neconyan:update-toast-commit'))).toBe('apk:arm64:1.3.0');
            });
        }
    });
}

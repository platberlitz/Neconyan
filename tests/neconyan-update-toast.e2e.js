/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} update notice`, () => {
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
    });
}

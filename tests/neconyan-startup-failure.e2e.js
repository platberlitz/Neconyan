/* global window, localStorage, getComputedStyle */
import { chromium, expect, test, webkit } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, applyIOSOnlyCss, installIPhoneSafari } from './ios-safari-emulation.js';

const base = process.env.NECONYAN_TEST_BASE_URL;
test.skip(!base, 'Requires this worktree\'s disposable preview.');
test.setTimeout(180000);
test.describe.configure({ mode: 'serial' });

for (const browserType of [chromium, webkit]) {
    for (const phone of [false, true]) {
        test(`${browserType.name()} ${phone ? 'phone' : 'desktop'} settings failure stays readable and retries without a reload loop`, async () => {
            const browser = await browserType.launch();
            const context = await browser.newContext(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
            if (phone) await installIPhoneSafari(context, { standalone: false });
            await context.addInitScript(() => {
                window.__startupReady = false;
                window.addEventListener('neconyan:ready', () => { window.__startupReady = true; });
            });
            let requests = 0;
            let failing = true;
            await context.route('**/api/settings/get', route => {
                requests++;
                return failing ? route.fulfill({ status: 500, json: { error: 'Fixture account unavailable' } }) : route.continue();
            });
            const page = await context.newPage();
            let navigations = 0;
            page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
            try {
                await page.goto(base, { waitUntil: 'domcontentloaded' });
                const panel = page.locator('#neconyan-startup-failure');
                await expect(panel).toBeVisible({ timeout: 60000 });
                if (phone) await applyIOSOnlyCss(page);
                await expect(panel.getByRole('heading')).toHaveText('Neconyan could not finish loading');
                await panel.locator('summary').click();
                await expect(panel.locator('pre')).toContainText('POST /api/settings/get failed (HTTP 500).');
                // Allow delayed loader cleanup and the former automatic navigation to run.
                await page.waitForTimeout(1500);
                expect(requests).toBe(1);
                expect(navigations).toBe(1);
                await expect(panel).toBeVisible();
                expect(await page.evaluate(() => window.__startupReady)).toBe(false);

                for (const colours of [null, ['#f9e7ce', '#141514'], ['#492a35', '#ffffff']]) {
                    const contrast = await panel.evaluate((element, colours) => {
                        if (colours) {
                            element.style.setProperty('--neco-ginger', colours[0]);
                            element.style.setProperty('--neco-on-accent', colours[1]);
                        }
                        const style = getComputedStyle(element.querySelector('button'));
                        const luminance = colour => colour.match(/[\d.]+/g).slice(0, 3).map(Number)
                            .map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
                            .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
                        const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
                        return (values[0] + 0.05) / (values[1] + 0.05);
                    }, colours);
                    expect(contrast).toBeGreaterThanOrEqual(4.5);
                }

                await panel.getByRole('button', { name: 'Read report', exact: true }).click();
                const report = page.getByRole('textbox', { name: 'Saved crash reports' });
                await expect(report).toBeVisible();
                expect(await report.inputValue()).toContain('HTTP 500');
                await page.getByRole('button', { name: 'Close', exact: true }).click();
                await page.evaluate(() => localStorage.setItem('startup-preservation-fixture', 'keep this saved value'));
                failing = false;
                await panel.getByRole('button', { name: 'Retry startup', exact: true }).click();
                await page.waitForFunction(() => window.__startupReady, null, { timeout: 120000 });
                await expect(page.locator('#neconyan-startup-failure')).toHaveCount(0);
                // Extensions also request settings sections once startup succeeds.
                expect(requests).toBeGreaterThan(1);
                expect(navigations).toBe(2);
                expect(await page.evaluate(() => localStorage.getItem('startup-preservation-fixture'))).toBe('keep this saved value');
            } finally {
                await context.close();
                await browser.close();
            }
        });
    }
}

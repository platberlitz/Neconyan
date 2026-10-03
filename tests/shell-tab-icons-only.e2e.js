/* global document, window, NeconyanShell */
import { expect, test } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} shell tabs honour icons-only and restore labels`, async ({ browser }, info) => {
        test.setTimeout(120000);
        const context = await browser.newContext({
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            serviceWorkers: 'block', reducedMotion: 'reduce',
        });
        if (phone) await installIPhoneSafari(context, { standalone: true });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell);
            await page.locator('#preloader').waitFor({ state: 'detached' });
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            await page.evaluate(() => NeconyanShell.openTab('right', 'settings'));
            await page.locator('#sb-settings-tabs [data-tab="system-device"]').click();
            const input = page.locator(`#sb-${phone ? 'mobile' : 'desktop'}-nav-icon-only-input`);
            const section = page.locator(`#${phone ? 'Mobile' : 'Desktop'}Section > .inline-drawer-header`);
            if (!(await input.isVisible())) {
                await section.scrollIntoViewIfNeeded();
                if (phone) await section.tap(); else await section.click();
            }
            for (const style of ['calico', 'windows-98']) {
                await page.evaluate(style => NeconyanShell.applyTheme(style), style);
                await page.waitForFunction(style => style === 'calico'
                    ? !document.querySelector('link[data-sb-shell-style]')
                    : document.querySelector(`link[data-sb-shell-style="${style}"]`)?.sheet, style);
                if (phone) await applyIOSOnlyCss(page);
                for (const enabled of [false, true, false]) {
                    await input.setChecked(enabled);
                    const tabs = page.locator('#top-settings-holder .sb-shell-nav > .sb-shell-tab:visible');
                    expect(await tabs.count()).toBeGreaterThan(1);
                    for (const tab of await tabs.all()) {
                        const label = tab.locator('.sb-shell-tab-copy');
                        if (enabled) await expect(label).toBeHidden(); else await expect(label).toBeVisible();
                        await expect(tab.locator('i').first()).toBeVisible();
                        expect(await tab.getAttribute('aria-label') || await tab.getAttribute('title')).toBeTruthy();
                        const box = await tab.boundingBox();
                        expect(box.height).toBeGreaterThanOrEqual(44);
                        expect(box.width).toBeGreaterThanOrEqual(44);
                    }
                    if (enabled && style === 'windows-98') {
                        await page.locator('#top-settings-holder .sb-shell-nav:visible').screenshot({ path: info.outputPath('icons-only.png') });
                    }
                }
            }
            await input.check();
            await page.reload();
            await page.waitForFunction(() => window.NeconyanShell);
            await page.locator('#preloader').waitFor({ state: 'detached' });
            await page.evaluate(() => NeconyanShell.openTab('right', 'settings'));
            if (phone) await applyIOSOnlyCss(page);
            for (const tab of await page.locator('#top-settings-holder .sb-shell-nav > .sb-shell-tab:visible').all()) {
                await expect(tab.locator('.sb-shell-tab-copy')).toBeHidden();
            }
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });
}

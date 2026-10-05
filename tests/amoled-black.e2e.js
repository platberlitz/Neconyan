/* global document, window, getComputedStyle, NeconyanShell */
import { test, expect } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });

const shellStyles = ['calico', 'kittyless', 'windows-aero', 'windows-xp', 'windows-98', 'clean-minimal', 'macos-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat'];

for (const phone of [false, true]) {
    test(`AMOLED Black in every shell style on ${phone ? 'iPhone stand-in' : 'desktop'}`, async ({ browser }, testInfo) => {
        test.setTimeout(180000);
        const context = await browser.newContext(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
        if (phone) await installIPhoneSafari(context, { standalone: true });
        const page = await context.newPage();
        await page.goto('/');
        await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
        const skip = page.getByRole('button', { name: 'Skip', exact: true });
        if (await skip.isVisible()) await skip.click();
        await expect(page.locator('#themes option[value="AMOLED Black"]')).toHaveCount(1);
        await page.locator('#themes').evaluate(el => window.jQuery(el).val('AMOLED Black').trigger('change'));
        for (const shellStyle of shellStyles) {
            await page.evaluate(id => NeconyanShell.applyTheme(id), shellStyle);
            await page.waitForFunction(id => id === 'calico' || document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet, shellStyle);
            if (phone) await applyIOSOnlyCss(page);
            await page.evaluate(() => document.fonts.ready);
            await page.locator('#toast-container').evaluateAll(elements => elements.forEach(el => el.remove()));
            await page.screenshot({ path: testInfo.outputPath(`${phone ? 'phone' : 'desktop'}-${shellStyle}.png`), animations: 'disabled', scale: 'css' });
            const paint = await page.evaluate(phone => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const sample = selector => {
                    const element = document.querySelector(selector);
                    if (!element) return null;
                    const style = getComputedStyle(element);
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = style.backgroundColor;
                    ctx.fillRect(0, 0, 1, 1);
                    return { rgba: [...ctx.getImageData(0, 0, 1, 1).data], image: style.backgroundImage };
                };
                return {
                    wallpaper: getComputedStyle(document.body, '::before').display,
                    background: getComputedStyle(document.querySelector('#bg1')).visibility,
                    surfaces: Object.fromEntries(['body', '#top-bar', '#neconyan-workspace-rail', '.neconyan-rail-new', '.neconyan-home-intro', '.neconyan-home-primary', '.neconyan-home-layout button', phone ? '#form_sheld' : '#send_form'].map(selector => [selector, sample(selector)])),
                };
            }, phone);
            expect(paint.wallpaper).toBe('none');
            expect(paint.background).toBe('hidden');
            for (const [selector, surface] of Object.entries(paint.surfaces)) {
                expect(surface.rgba, `${shellStyle}: ${selector} must be opaque black`).toEqual([0, 0, 0, 255]);
                expect(surface.image, `${shellStyle}: ${selector} must not have a tinted gradient`).toBe('none');
            }
        }
        await page.reload();
        await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
        await expect(page.locator('#themes')).toHaveValue('AMOLED Black');
        await expect(page.locator('#bg1')).toHaveCSS('visibility', 'hidden');
        await page.locator('#themes').evaluate(el => window.jQuery(el).val('Neconyan Calico').trigger('change'));
        await expect(page.locator('#bg1')).toHaveCSS('visibility', 'visible');
        expect(await page.evaluate(() => getComputedStyle(document.body, '::before').display)).not.toBe('none');
        await context.close();
    });
}

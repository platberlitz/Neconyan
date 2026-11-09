/* global document, getComputedStyle, window */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { isolateSettingsSaves, openQuietChatForSmoke, settleCssTransitions } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const layout of ['phone', 'desktop', 'iphone']) {
    test(`background selection controls fit at ${layout} size`, async ({ browser }, info) => {
        test.setTimeout(120000);
        const isPhone = layout !== 'desktop';
        const context = await browser.newContext({
            ...(layout === 'iphone' ? IPHONE_SAFARI_CONTEXT : {
                viewport: isPhone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
                hasTouch: isPhone,
            }),
            baseURL: info.project.use.baseURL,
            serviceWorkers: 'block',
        });
        try {
            if (layout === 'iphone') await installIPhoneSafari(context);
            const page = await context.newPage();
            await isolateSettingsSaves(page);
            await openQuietChatForSmoke(page);
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
            if (await dismiss.isVisible()) await dismiss.click();
            await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
            const notNow = page.getByRole('button', { name: 'Not now', exact: true });
            if (await notNow.isVisible()) await notNow.click();
            const tile = page.locator('#bg_menu_content .bg_example').first();
            await expect(tile).toBeVisible({ timeout: 60000 });
            if (layout === 'iphone') await applyIOSOnlyCss(page, { inPlace: true });
            const select = page.locator('#bg_selection_mode_button');
            const zoomOut = page.locator('#bg_thumb_zoom_out');
            const zoomIn = page.locator('#bg_thumb_zoom_in');
            await expect(select).toBeVisible();
            await select.scrollIntoViewIfNeeded();
            await page.evaluate(() => window.toastr?.clear());
            const directory = process.env.NECONYAN_BACKGROUND_SIZE_SHOTS;
            if (directory) {
                fs.mkdirSync(directory, { recursive: true });
                await page.screenshot({ path: path.join(directory, `${layout}-${process.env.NECONYAN_BACKGROUND_SIZE_PHASE || 'check'}.png`) });
            }
            const sizes = await Promise.all([select, zoomOut, zoomIn].map(control => control.boundingBox()));
            if (isPhone) {
                for (const zoom of sizes.slice(1)) {
                    expect(Math.abs(sizes[0].width - zoom.width)).toBeLessThan(1);
                    expect(Math.abs(sizes[0].height - zoom.height)).toBeLessThan(1);
                }
                await expect(select.locator('span[data-i18n="Select"]')).toBeHidden();
            } else {
                await expect(select.locator('span[data-i18n="Select"]')).toBeVisible();
            }
            if (layout === 'phone') {
                for (const profile of [null, 'Mint Glass', 'Plum Wine']) {
                    if (profile) {
                        await page.evaluate(() => window.jQuery('#themes').val('Neconyan Calico').trigger('change'));
                        await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(element => element.click());
                    }
                    for (const pressed of [false, true]) {
                        if (pressed) await select.click();
                        await settleCssTransitions(page);
                        const colours = await select.evaluate(element => ({
                            foreground: getComputedStyle(element.querySelector('i')).color,
                            background: getComputedStyle(element).backgroundColor,
                        }));
                        expect(contrastRatio(colours.foreground, colours.background), `${profile || 'default'}, pressed: ${pressed}`).toBeGreaterThanOrEqual(4.5);
                    }
                    await select.click();
                }
            }
            await select.click();
            await expect(select).toHaveAttribute('aria-pressed', 'true');
            await tile.click();
            const count = page.locator('#bg_group_select_count');
            await expect(count).toContainText('1');
            await expect(count).toBeVisible();
            const selected = await select.boundingBox();
            const countBox = await count.boundingBox();
            expect(selected.width).toBeGreaterThanOrEqual(sizes[1].width - 1);
            expect(countBox.x + countBox.width).toBeLessThanOrEqual(selected.x + selected.width + 1);
            expect(countBox.y + countBox.height).toBeLessThanOrEqual(selected.y + selected.height + 1);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        } finally {
            await context.close();
        }
    });
}

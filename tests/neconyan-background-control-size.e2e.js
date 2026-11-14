/* global document, getComputedStyle, window */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
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
            await page.evaluate(() => window.toastr?.clear());
            await select.scrollIntoViewIfNeeded();
            const sizes = await Promise.all([select, zoomOut, zoomIn].map(control => control.boundingBox()));
            const tabs = await page.locator('#bg_tabs .bg_tabs_list').boundingBox();
            expect(Math.abs((sizes[2].x + sizes[2].width) - (tabs.x + tabs.width))).toBeLessThan(1);
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
                        const colours = await select.evaluate(element => {
                            const icon = element.querySelector('i');
                            const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
                            context.fillStyle = getComputedStyle(icon).color;
                            context.fillRect(0, 0, 1, 1);
                            const foreground = [...context.getImageData(0, 0, 1, 1).data];
                            let opacity = foreground[3] / 255;
                            for (let node = icon; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
                            const buttonBox = element.getBoundingClientRect(), iconBox = icon.getBoundingClientRect();
                            return { foreground: foreground.slice(0, 3), opacity,
                                points: [0.25, 0.5, 0.75].map(ratio => ({ x: iconBox.left - buttonBox.left + iconBox.width / 2, y: iconBox.top - buttonBox.top + iconBox.height * ratio })),
                                shell: document.documentElement.dataset.sbTheme,
                                background: getComputedStyle(element).backgroundColor, image: getComputedStyle(element).backgroundImage };
                        });
                        // Gradient controls have a transparent backgroundColor; sample
                        // their actual paint beneath the hidden icon instead of black.
                        const image = PNG.sync.read(await select.screenshot({ scale: 'css', animations: 'disabled',
                            style: '#toast-container, #bg_selection_mode_button i { visibility: hidden !important; }' }));
                        const ratios = colours.points.map(({ x, y }) => {
                            const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
                            const background = [...image.data.subarray(offset, offset + 3)];
                            const ink = colours.foreground.map((value, index) => value * colours.opacity + background[index] * (1 - colours.opacity));
                            return contrastRatio(ink, background);
                        });
                        await info.attach(`selection-${profile || 'default'}-${pressed}`, { body: JSON.stringify({ ...colours, ratios }), contentType: 'application/json' });
                        expect(Math.min(...ratios), `${profile || 'default'}, pressed: ${pressed}`).toBeGreaterThanOrEqual(4.5);
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
            const selectedZoomIn = await zoomIn.boundingBox();
            expect(Math.abs((selectedZoomIn.x + selectedZoomIn.width) - (tabs.x + tabs.width))).toBeLessThan(1);
            expect(selected.width).toBeGreaterThanOrEqual(sizes[1].width - 1);
            expect(countBox.x + countBox.width).toBeLessThanOrEqual(selected.x + selected.width + 1);
            expect(countBox.y + countBox.height).toBeLessThanOrEqual(selected.y + selected.height + 1);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        } finally {
            await context.close();
        }
    });

    test(`background toolbar stays on one row below its heading at ${layout} size`, async ({ browser }, info) => {
        test.setTimeout(120000);
        const isPhone = layout !== 'desktop';
        const context = await browser.newContext({
            ...(layout === 'iphone' ? IPHONE_SAFARI_CONTEXT : {
                viewport: isPhone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
                hasTouch: isPhone,
            }),
            baseURL: info.project.use.baseURL,
            serviceWorkers: 'block',
            reducedMotion: 'reduce',
        });
        try {
            if (layout === 'iphone') await installIPhoneSafari(context);
            const page = await context.newPage();
            await isolateSettingsSaves(page);
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
            const notNow = page.getByRole('button', { name: 'Not now', exact: true });
            if (await notNow.isVisible()) await notNow.click();
            await expect(page.locator('#bg_menu_content .bg_example').first()).toBeVisible();
            if (layout === 'iphone') await applyIOSOnlyCss(page, { inPlace: true });
            await page.evaluate(() => window.toastr?.clear());
            const directory = process.env.NECONYAN_BACKGROUND_SIZE_SHOTS;
            for (const theme of ['windows-98', 'calico']) {
                await page.evaluate(theme => window.NeconyanShell.applyTheme(theme), theme);
                if (theme === 'windows-98') await page.waitForFunction(() => document.querySelector('link[data-sb-shell-style="windows-98"]')?.sheet);
                await page.locator('#bg-header-fixed h3').scrollIntoViewIfNeeded();
                if (directory) {
                    fs.mkdirSync(directory, { recursive: true });
                    await page.screenshot({ path: path.join(directory, `${theme}-${layout}-${process.env.NECONYAN_BACKGROUND_SIZE_PHASE || 'check'}.png`), style: '#toast-container { visibility: hidden !important; }' });
                }
                const heading = await page.locator('#bg-header-fixed h3').boundingBox();
                const controls = page.locator('#background_fitting, #background_position, #auto_background, #bg_add_folder_button, #bg_restore_defaults_button, #add_background_button_top');
                const boxes = await controls.evaluateAll(elements => elements.map(element => {
                    const { x, y, width, height } = element.getBoundingClientRect();
                    return { x, y, width, height };
                }));
                expect(boxes).toHaveLength(6);
                for (const [index, box] of boxes.entries()) {
                    expect(box.y).toBeGreaterThanOrEqual(heading.y + heading.height);
                    expect(Math.abs(box.y - boxes[0].y)).toBeLessThanOrEqual(1);
                    expect(box.height).toBeGreaterThanOrEqual(44);
                    if (index) expect(box.x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
                }
                const row = page.locator('#bg-header-fixed .bg-header-row-1');
                const chrome = page.locator('#bg-header-fixed > .sb-mobile-rail-chrome');
                const left = chrome.locator('.sb-mobile-rail-left');
                const right = chrome.locator('.sb-mobile-rail-right');
                const thumbOffset = () => chrome.evaluate(element => parseFloat(element.style.getPropertyValue('--sb-rail-thumb-left')));
                if (isPhone) {
                    await expect(row).toHaveCSS('touch-action', 'pan-x');
                    await expect(chrome.locator('.sb-mobile-rail-track')).toBeVisible();
                    await expect(left).toBeHidden();
                    await expect(right).toBeVisible();
                    await expect.poll(thumbOffset).toBe(0);
                    const arrow = await right.boundingBox();
                    expect(arrow.width).toBeGreaterThanOrEqual(44);
                    expect(arrow.height).toBeGreaterThanOrEqual(44);
                    await right.tap();
                    await expect.poll(thumbOffset).toBeGreaterThan(0);
                    await expect(right).toBeHidden();
                    await expect(page.locator('#add_background_button_top')).toBeInViewport();
                    await left.tap();
                    await expect.poll(thumbOffset).toBe(0);
                    const box = await row.boundingBox();
                    const touch = await context.newCDPSession(page);
                    const start = { x: box.x + box.width - 65, y: box.y + box.height / 2 };
                    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
                    for (let step = 1; step <= 6; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x - step * 35, y: start.y }] });
                    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
                    await expect.poll(thumbOffset).toBeGreaterThan(0);
                    await expect(page.locator('#add_background_button_top')).toBeInViewport();
                    await touch.detach();
                    await left.tap();
                    await expect.poll(thumbOffset).toBe(0);
                } else {
                    await expect(chrome).toBeHidden();
                }
            }
            if (!isPhone) {
                await page.setViewportSize({ width: 393, height: 852 });
                await expect(page.locator('#bg-header-fixed > .sb-mobile-rail-chrome')).toBeVisible();
                await page.setViewportSize({ width: 1280, height: 900 });
                await expect(page.locator('#bg-header-fixed > .sb-mobile-rail-chrome')).toBeHidden();
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        } finally {
            await context.close();
        }
    });
}

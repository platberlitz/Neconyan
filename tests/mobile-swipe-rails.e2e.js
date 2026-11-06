/* global document, window, getComputedStyle, MutationObserver, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat, settleCssTransitions } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

function chromeFor(page, selector) {
    return page.locator(selector).locator('..').locator(':scope > .sb-mobile-rail-chrome');
}

test.describe('phone discovery cues', () => {
    test.use(IPHONE_SAFARI_CONTEXT);

    test('compact composer tools remain tappable and scroll in both directions', async ({ context, page }) => {
        await installIPhoneSafari(context, { standalone: true });
        await isolateSettingsSaves(page, settings => {
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            settings.power_user.compact_input_area = true;
        });
        await openReadyChat(page);
        await applyIOSOnlyCss(page, { inPlace: true });
        const rail = page.locator('#leftSendForm');
        const chrome = chromeFor(page, '#leftSendForm');
        await expect(chrome.locator('.sb-mobile-rail-track')).toBeVisible();
        await expect(chrome.locator('.sb-mobile-rail-arrow')).toHaveCount(0);
        expect(await chrome.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
        const thumbOffset = () => chrome.evaluate(el => parseFloat(el.style.getPropertyValue('--sb-rail-thumb-left')));
        expect(await thumbOffset()).toBe(0);
        expect(await rail.locator('.sb-mobile-rail-chrome').count()).toBe(0);
        // The two original tool centres remain available, including the narrow composer.
        const centres = await rail.evaluate(el => [...el.children].filter(child => child.getBoundingClientRect().width > 0).map(child => {
            const r = child.getBoundingClientRect();
            const visible = r.left >= el.getBoundingClientRect().left && r.right <= el.getBoundingClientRect().right + 1;
            return !visible || child.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }));
        expect(centres.every(Boolean)).toBe(true);
        // A native touch swipe over the actual tools still reaches the hidden control.
        const box = await rail.boundingBox();
        const client = await context.newCDPSession(page);
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width - 20, y: box.y + box.height / 2 }] });
        for (let x = box.x + box.width - 25; x > box.x + 5; x -= 8) {
            await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: box.y + box.height / 2 }] });
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await expect.poll(thumbOffset).toBeGreaterThan(0);
        await client.detach();
        await rail.evaluate(el => el.scrollTo({ left: 0, behavior: 'instant' }));
        await expect.poll(thumbOffset).toBe(0);
        await page.evaluate(() => window.NeconyanShell.openCharacters());
        await applyIOSOnlyCss(page, { inPlace: true });
        const nav = page.locator('#right-nav-panel .sb-character-shell-nav');
        const navChrome = chromeFor(page, '#right-nav-panel .sb-character-shell-nav');
        await expect(navChrome.locator('.sb-mobile-rail-right')).toBeVisible();
        // The sibling decoration must not cover the tabs or the swipe surface.
        expect(await navChrome.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
        const tab = nav.locator('[role="tab"]').nth(1);
        await tab.tap();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        const navBox = await nav.boundingBox();
        const swipe = await context.newCDPSession(page);
        const before = await nav.evaluate(el => el.scrollLeft);
        await swipe.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: navBox.x + navBox.width - 65, y: navBox.y + navBox.height / 2 }] });
        for (let x = navBox.x + navBox.width - 70; x > navBox.x + 65; x -= 10) {
            await swipe.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: navBox.y + navBox.height / 2 }] });
        }
        await swipe.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => nav.evaluate(el => el.scrollLeft)).toBeGreaterThan(before);
        await swipe.detach();
        await nav.evaluate(el => el.scrollTo({ left: 0, behavior: 'instant' }));
        await navChrome.locator('.sb-mobile-rail-right').tap();
        await expect.poll(() => nav.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        const alignment = await navChrome.locator('.sb-mobile-rail-left > span').evaluate(el => {
            const pill = el.getBoundingClientRect();
            const icon = el.querySelector('svg').getBoundingClientRect();
            const rail = el.closest('.sb-mobile-rail-chrome').getBoundingClientRect();
            return [Math.abs(pill.y + pill.height / 2 - icon.y - icon.height / 2), Math.abs(pill.y + pill.height / 2 - rail.y - rail.height / 2)];
        });
        expect(alignment.every(offset => offset < 1)).toBe(true);
        // Use the real accent controls, which also select readable foreground colours.
        for (const colour of [null, 'rgba(245, 235, 200, 1)', 'rgba(45, 20, 70, 1)']) {
            await page.evaluate(value => {
                if (!value) return;
                for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) {
                    document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: value } }));
                }
            }, colour);
            await settleCssTransitions(page);
            const contrast = await navChrome.locator('.sb-mobile-rail-left > span').evaluate(el => {
                const ctx = document.createElement('canvas').getContext('2d');
                const luminance = colour => {
                    ctx.fillStyle = colour;
                    ctx.fillRect(0, 0, 1, 1);
                    const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(c => {
                        const value = c / 255;
                        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                    });
                    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                };
                const style = getComputedStyle(el);
                const a = luminance(style.color);
                const b = luminance(style.backgroundColor);
                return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
    });

    test('late rails update on content, resize, RTL, hide and removal without observer loops', async ({ page }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Real controller and phone stylesheet, isolated from unrelated app startup.
        await page.route('**/swipe-rail-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="stylesheet" href="/css/neconyan-mobile-shell.css">
            <style>body{--neco-ginger:#d28c64;--neco-on-accent:#111;--neco-ginger-hover:#d28c64}
            #host{position:relative;width:240px;margin:30px;transform:scale(.9)}
            .scratchpad-quick{display:flex;overflow-x:auto;gap:4px;height:44px;white-space:nowrap}
            .scratchpad-quick button{flex:0 0 90px}</style><div id="host"></div>
            <script type="module">import {initMobileSwipeRails} from '/scripts/mobile-swipe-rails.js';
            initMobileSwipeRails({leftLabel:'Scroll left',rightLabel:'Scroll right'});window.ready=true;</script>` }));
        await page.goto('/swipe-rail-fixture');
        await page.waitForFunction(() => window.ready);
        await page.evaluate(() => {
            const rail = document.createElement('nav');
            rail.className = 'scratchpad-quick';
            rail.innerHTML = Array.from({ length: 8 }, (_, i) => `<button role="tab">Option ${i}</button>`).join('');
            document.getElementById('host').append(rail);
        });
        const rail = page.locator('.scratchpad-quick');
        const chrome = chromeFor(page, '.scratchpad-quick');
        await expect(chrome).toBeVisible();
        await rail.locator('button').first().evaluate(el => {
            el.innerHTML = '<svg aria-hidden="true" width="8" height="8"><path d="M0 0L1 1" /></svg>Option 0';
            el.querySelector('svg').setAttribute('class', 'loaded-icon');
        });
        await chrome.locator('.sb-mobile-rail-right').click();
        await expect(chrome.locator('.sb-mobile-rail-left')).toBeVisible();
        await expect(chrome.locator('.sb-mobile-rail-right')).toBeVisible();
        const position = await chrome.evaluate(el => parseFloat(el.style.getPropertyValue('--sb-rail-thumb-left')));
        expect(position).toBeGreaterThan(0);
        await rail.locator('button').last().focus();
        await expect(chrome.locator('.sb-mobile-rail-right')).toBeHidden();
        await rail.locator('button').first().evaluate(el => el.setAttribute('aria-selected', 'true'));
        await expect(chrome.locator('.sb-mobile-rail-left')).toBeHidden();
        await rail.evaluate(el => { el.style.direction = 'rtl'; el.scrollLeft = 0; });
        await expect(chrome.locator('.sb-mobile-rail-left')).toBeVisible();
        await expect(chrome.locator('.sb-mobile-rail-right')).toBeHidden();
        await chrome.locator('.sb-mobile-rail-left').click();
        await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBeLessThan(0);
        const boxes = await page.evaluate(() => ['.scratchpad-quick', '.sb-mobile-rail-chrome'].map(s => {
            const b = document.querySelector(s).getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
        }));
        for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(boxes[0][key] - boxes[1][key])).toBeLessThan(1);
        // Selecting a tab above the viewport must only move its horizontal rail.
        for (const direction of ['ltr', 'rtl']) {
            await rail.evaluate((el, direction) => {
                el.style.direction = direction;
                el.scrollLeft = 0;
                document.body.style.minHeight = '2500px';
                el.querySelectorAll('button').forEach(tab => tab.setAttribute('aria-selected', 'false'));
                window.scrollTo(0, 600);
            }, direction);
            await rail.locator('button').last().evaluate(el => el.setAttribute('aria-selected', 'true'));
            await expect.poll(() => rail.evaluate(el => Math.abs(el.scrollLeft))).toBeGreaterThan(0);
            expect(await page.evaluate(() => window.scrollY)).toBe(600);
            const visible = await rail.evaluate(el => {
                const outer = el.getBoundingClientRect();
                const tab = el.lastElementChild.getBoundingClientRect();
                return tab.left >= outer.left - 1 && tab.right <= outer.right + 1;
            });
            expect(visible).toBe(true);
            // Refreshing the same selection must leave both scroll positions alone.
            await rail.evaluate(el => {
                el.scrollLeft = 0;
                el.lastElementChild.setAttribute('aria-selected', 'true');
            });
            await page.evaluate(async () => {
                for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
            });
            expect(await rail.evaluate(el => el.scrollLeft)).toBe(0);
            expect(await page.evaluate(() => window.scrollY)).toBe(600);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(chrome).toBeHidden();
        await page.setViewportSize({ width: 393, height: 852 });
        await expect(chrome).toBeVisible();
        await rail.evaluate(el => { el.hidden = true; el.style.display = 'none'; });
        await expect(chrome).toBeHidden();
        await rail.evaluate(el => { el.hidden = false; el.style.display = 'flex'; });
        await expect(chrome).toBeVisible();
        await rail.evaluate(el => { while (el.children.length > 2) el.lastElementChild.remove(); });
        await expect(chrome).toBeHidden();
        // Quiescent controller: no repeated class/style writes on an unchanged page.
        const changes = await page.evaluate(async () => {
            let count = 0;
            const observer = new MutationObserver(records => { count += records.length; });
            observer.observe(document.body, { subtree: true, attributes: true, childList: true });
            for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
            observer.disconnect();
            return count;
        });
        expect(changes).toBe(0);
        await rail.evaluate(el => el.remove());
        await expect(page.locator('.sb-mobile-rail-chrome')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    // Scratchpad and the compact composer put the rail beside the growing box;
    // Conversation mode wraps it in a fixed-height toolbar that the box pushes.
    for (const toolbar of [false, true]) {
        test(`rail chrome follows the rail when a growing sibling pushes it up${toolbar ? ' through a fixed toolbar' : ''}`, async ({ page }) => {
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const chips = `<div class="scratchpad-quick">${Array.from({ length: 6 }, (_, i) => `<button>Chip ${i}</button>`).join('')}</div>`;
            await page.route('**/swipe-rail-sibling-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href="/css/neconyan-mobile-shell.css">
                <style>body{margin:0;--neco-ginger:#d28c64;--neco-on-accent:#111;--neco-ginger-hover:#d28c64}
                #panel{position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end}
                #compose{display:flex;flex-direction:column;gap:8px;padding:8px}
                #toolbar{height:52px}
                .scratchpad-quick{display:flex;overflow-x:auto;gap:4px;height:44px;white-space:nowrap}
                .scratchpad-quick button{flex:0 0 120px}
                #grow{height:40px;overflow:hidden}</style>
                <div id="panel"><div id="compose">${toolbar ? `<div id="toolbar">${chips}</div>` : chips}<div id="grow"></div></div></div>
                <script type="module">import {initMobileSwipeRails} from '/scripts/mobile-swipe-rails.js';
                initMobileSwipeRails({leftLabel:'Scroll left',rightLabel:'Scroll right'});window.ready=true;</script>` }));
            await page.goto('/swipe-rail-sibling-fixture');
            await page.waitForFunction(() => window.ready);
            const chrome = chromeFor(page, '.scratchpad-quick');
            await expect(chrome).toBeVisible();
            const offset = () => page.evaluate(() => {
                const rail = document.querySelector('.scratchpad-quick').getBoundingClientRect();
                const cue = document.querySelector('.sb-mobile-rail-chrome').getBoundingClientRect();
                return Math.abs(rail.top - cue.top) + Math.abs(rail.height - cue.height);
            });
            expect(await offset()).toBeLessThan(1);
            const railTop = () => page.locator('.scratchpad-quick').evaluate(el => el.getBoundingClientRect().top);
            const before = await railTop();
            // A style change outside the rail, with no scroll event, as WebKit does it.
            for (const height of ['120px', '64px']) {
                await page.locator('#grow').evaluate((el, value) => { el.style.height = value; }, height);
                await expect.poll(offset).toBeLessThan(1);
            }
            expect(await railTop()).toBeLessThan(before);
            const changes = await page.evaluate(async () => {
                let count = 0;
                const observer = new MutationObserver(records => { count += records.length; });
                observer.observe(document.body, { subtree: true, attributes: true, childList: true });
                for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
                observer.disconnect();
                return count;
            });
            expect(changes).toBe(0);
            expect(errors).toEqual([]);
        });
    }
});

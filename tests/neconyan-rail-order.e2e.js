/* global document, window, getComputedStyle */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const key = 'NeconyanWorkspaceRailOrder.v1';
const groups = {
    primary: ['home', 'characters', 'model', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'extensions'],
    advanced: ['presets', 'sampling', 'formatting', 'regex', 'expressions', 'persona', 'pathfinder', 'dialogue-colors', 'quick-image-gen', 'background'],
    modes: ['roleplay', 'conversation', 'meower', 'story'],
};
const selector = name => `[data-neconyan-${name === 'modes' ? 'mode' : name}-nav]`;
const order = (page, name) => page.locator(`${selector(name)} > button`).evaluateAll(buttons => buttons.map(button => button.dataset.neconyanRoute || button.dataset.neconyanChatMode));

async function ready(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
}

async function settings(page, phone) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.getByRole('button', { name: 'System & Device', exact: true }).click();
    const section = page.locator(phone ? '#MobileSection' : '#DesktopSection');
    const checkbox = section.locator('[data-sb-rail-reorder-input]');
    if (!await checkbox.isVisible()) await section.locator(':scope > .inline-drawer-header').click();
    await checkbox.scrollIntoViewIfNeeded();
    return checkbox;
}

async function rail(page, phone) {
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    if (phone && !await page.locator('body').evaluate(body => body.classList.contains('neconyan-rail-drawer-open'))) {
        await page.locator('#sb-hamburger').click();
    }
}

async function drag(page, name, phone) {
    const host = page.locator(selector(name));
    await host.scrollIntoViewIfNeeded();
    const grip = host.locator('button .neconyan-rail-grip').first();
    await grip.scrollIntoViewIfNeeded();
    const source = await grip.boundingBox();
    const target = await host.locator('button').nth(1).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const end = target.y + target.height * 0.8;
    if (phone) {
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        // The real shared sortable delay is 750ms on phones.
        await new Promise(resolve => setTimeout(resolve, 850));
        for (let step = 1; step <= 8; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (end - y) * step / 8 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
    } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await new Promise(resolve => setTimeout(resolve, 100));
        await page.mouse.move(x, end, { steps: 12 });
        await page.mouse.up();
    }
}

async function checkPhoneScrolling(page, phone) {
    if (!phone) return;
    const scroller = page.locator('.neconyan-rail-scroll');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    const row = await page.locator('[data-neconyan-primary-nav] > button').nth(3).boundingBox();
    const session = await page.context().newCDPSession(page);
    const x = row.x + 60;
    const y = row.y + row.height / 2;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 15 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(30);
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-drawer-open/);
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} sidebar order`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test('settings, drag, keyboard, saved order and reset', async ({ page }, info) => {
            test.setTimeout(240000);
            let stored = JSON.stringify({ enabled: false, primary: ['model', 'model', 'removed', 'home', 'story'] });
            // Exercise the real account save/load flow without changing the preview account.
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const body = await response.json();
                if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
                const data = JSON.parse(body.settings);
                data.accountStorage = { ...data.accountStorage, 'NeconyanWorkspaceRailCollapsed.v1': 'false', [key]: stored };
                await route.fulfill({ response, json: { ...body, settings: JSON.stringify(data) } });
            });
            await page.route('**/api/settings/save', async route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const payload = JSON.parse(bytes.toString());
                stored = payload.accountStorage[key] ?? stored;
                await route.fulfill({ json: {
                    result: 'ok',
                    version: Number(payload._version || 0) + 1,
                    settingsRevision: Number(payload._settingsRevision || 0) + 1,
                } });
            });
            await ready(page);
            expect(await order(page, 'primary')).toEqual(['model', 'home', 'characters', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'extensions']);
            let checkbox = await settings(page, phone);
            const reset = page.locator(`[data-sb-rail-order-reset="${phone ? 'mobile' : 'desktop'}"]`);
            await expect(checkbox).not.toBeChecked();
            await expect(reset).toBeVisible();
            const resetLayout = await reset.evaluate(button => {
                const text = document.createRange();
                text.selectNodeContents(button);
                return { lines: text.getClientRects().length, width: button.clientWidth, height: button.getBoundingClientRect().height, textWidth: text.getBoundingClientRect().width };
            });
            expect(resetLayout.lines).toBe(1);
            expect(resetLayout.width).toBeGreaterThan(resetLayout.textWidth);
            expect(resetLayout.height).toBeGreaterThanOrEqual(44);
            await reset.click();
            await checkbox.check();
            await expect(page.locator('[data-sb-rail-reorder-input]:checked')).toHaveCount(2);
            await page.screenshot({ path: info.outputPath('settings.png') });
            await rail(page, phone);
            for (const [name, defaults] of Object.entries(groups)) {
                await drag(page, name, phone);
                await expect.poll(() => order(page, name)).toEqual([defaults[1], defaults[0], ...defaults.slice(2)]);
                const first = page.locator(`${selector(name)} > button[data-neconyan-${name === 'modes' ? 'chat-mode' : 'route'}="${defaults[1]}"]`);
                await first.focus();
                await first.press('Alt+ArrowUp');
                expect(await order(page, name)).toEqual([defaults[1], defaults[0], ...defaults.slice(2)]);
                await first.press('Alt+ArrowDown');
                expect(await order(page, name)).toEqual(defaults);
                await expect(first).toBeFocused();
                await first.press('Alt+ArrowUp');
                expect(await order(page, name)).toEqual([defaults[1], defaults[0], ...defaults.slice(2)]);
            }
            const geometry = await page.locator('[data-neconyan-mode-nav]').evaluate(mode => ({
                modesTop: mode.getBoundingClientRect().top,
                advancedBottom: document.querySelector('[data-neconyan-advanced-nav]').getBoundingClientRect().bottom,
                grip: (() => { const grip = mode.querySelector('.neconyan-rail-grip'); const box = grip.getBoundingClientRect(); return { width: box.width, height: box.height, touchAction: getComputedStyle(grip).touchAction }; })(),
            }));
            expect(geometry.modesTop).toBeGreaterThan(geometry.advancedBottom);
            expect(geometry.grip).toEqual({ width: 44, height: 44, touchAction: 'none' });
            await page.screenshot({ path: info.outputPath('reordering.png') });
            await checkPhoneScrolling(page, phone);
            checkbox = await settings(page, phone);
            await checkbox.uncheck();
            await expect(page.locator('[data-sb-rail-reorder-input]:checked')).toHaveCount(0);
            await expect.poll(() => JSON.parse(stored).enabled).toBe(false);
            await expect.poll(() => JSON.parse(stored).modes?.[0]).toBe('conversation');
            await ready(page);
            await rail(page, phone);
            for (const [name, defaults] of Object.entries(groups)) {
                expect(await order(page, name)).toEqual([defaults[1], defaults[0], ...defaults.slice(2)]);
                const first = page.locator(`${selector(name)} > button`).first();
                await expect(first.locator('.neconyan-rail-grip')).toBeHidden();
                await first.press('Alt+ArrowDown');
                expect(await order(page, name)).toEqual([defaults[1], defaults[0], ...defaults.slice(2)]);
            }
            await page.locator('[data-neconyan-primary-nav] [data-neconyan-route="characters"] > span').first().click();
            await expect(page.locator('#character_search_bar')).toBeVisible();
            checkbox = await settings(page, phone);
            await reset.click();
            await expect(checkbox).not.toBeChecked();
            for (const [name, defaults] of Object.entries(groups)) expect(await order(page, name)).toEqual(defaults);
            await checkbox.check();
            await expect.poll(() => JSON.parse(stored).enabled).toBe(true);
            await ready(page);
            checkbox = await settings(page, phone);
            await expect(checkbox).toBeChecked();
            await reset.click();
            await expect(checkbox).toBeChecked();
            await rail(page, phone);
            await page.locator('[data-neconyan-primary-nav] [data-neconyan-route="characters"] > span').first().click();
            await expect(page.locator('#character_search_bar')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
            // A late settings load can still be in flight when the page closes.
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        });
    });
}

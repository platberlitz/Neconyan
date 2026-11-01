/* global document, window, getComputedStyle */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari } from './ios-safari-emulation.js';

const key = 'NeconyanWorkspaceRailOrder.v1';
const groups = {
    primary: ['home', 'characters', 'model', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'chat-archive', 'extensions'],
    advanced: ['presets', 'sampling', 'formatting', 'regex', 'preset-tools', 'chat-completion-tabs', 'prompt-tags', 'macro-enhanced', 'prompting-lab', 'deep-swipe'],
    lore: ['persona', 'expressions', 'quick-image-gen', 'botsearcher', 'pathfinder', 'world-info-lab', 'lorebook-distiller', 'time-machine'],
    appearance: ['background', 'dialogue-colors', 'termeownal-ui', 'css-snippets', 'regex-agent-themes'],
    finer: ['server', 'console-logs', 'debugger', 'report-issue'],
    modes: ['roleplay', 'conversation', 'meower', 'story'],
};
const previousGroup = { advanced: 'primary', lore: 'advanced', appearance: 'lore', finer: 'appearance' };
const selector = name => `[data-neconyan-${name === 'modes' ? 'mode' : name}-nav]`;
const order = (page, name) => page.locator(`${selector(name)} > button`).evaluateAll(buttons => buttons.map(button => button.dataset.neconyanRoute || button.dataset.neconyanChatMode));

async function ready(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    // The intercepted settings carry no Quick Image Gen cache id, so its legacy import prompt can cover the page.
    const legacy = page.locator('dialog.popup[open]').filter({ hasText: 'Quick Image Gen found legacy browser-only settings' });
    await legacy.waitFor({ state: 'visible', timeout: 3000 }).then(() => legacy.getByRole('button', { name: 'Cancel', exact: true }).click(), () => {});
    // Tour progress saves are intercepted below, so a fresh preview offers the tour on every load.
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    await skip.waitFor({ state: 'visible', timeout: 3000 }).then(() => skip.click(), () => {});
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

async function dragTo(page, grip, target, phone) {
    const source = await grip.boundingBox();
    const box = await target.boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const end = box.y + box.height * 0.3;
    if (phone) {
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await new Promise(resolve => setTimeout(resolve, 850));
        for (let step = 1; step <= 16; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (end - y) * step / 16 }] });
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
    } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await new Promise(resolve => setTimeout(resolve, 100));
        await page.mouse.move(x, end, { steps: 20 });
        await page.mouse.up();
    }
}

async function storeOrder(page, initial, collapsed = false) {
    const state = { stored: JSON.stringify(initial) };
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
        const data = JSON.parse(body.settings);
        data.accountStorage = { ...data.accountStorage, 'NeconyanWorkspaceRailCollapsed.v1': String(collapsed), 'NeconyanWorkspaceRailSections.v1': '{}', [key]: state.stored };
        await route.fulfill({ response, json: { ...body, settings: JSON.stringify(data) } });
    });
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        const payload = JSON.parse(bytes.toString());
        state.stored = payload.accountStorage[key] ?? state.stored;
        await route.fulfill({ json: {
            result: 'ok',
            version: Number(payload._version || 0) + 1,
            settingsRevision: Number(payload._settingsRevision || 0) + 1,
        } });
    });
    return state;
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
        test('collapsed desktop preference preserves phone editing', async ({ page }, info) => {
            if (phone) await installIPhoneSafari(page.context(), { standalone: true });
            await storeOrder(page, { enabled: false }, true);
            await ready(page);
            if (phone) await applyIOSOnlyCss(page, { inPlace: true });
            await rail(page, phone);
            const toggle = page.locator('[data-neconyan-rail-reorder-toggle="primary"]');
            const bar = page.locator('[data-neconyan-rail-reorder-bar]');
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-sidebar', 'closed');
            await page.screenshot({ path: info.outputPath('saved-collapsed-sidebar.png') });
            if (!phone) {
                await expect(toggle).toBeHidden();
                await page.locator('#neconyan-sidebar-toggle').click();
            }
            await expect(toggle).toBeVisible();
            if (phone) {
                const box = await toggle.boundingBox();
                expect(box.width).toBeGreaterThanOrEqual(44);
                expect(box.height).toBeGreaterThanOrEqual(44);
                await toggle.tap();
            } else {
                await toggle.click();
            }
            await expect(toggle).toHaveAttribute('aria-pressed', 'true');
            await expect(bar).toBeVisible();
            await bar.locator('.neconyan-rail-reorder-done').click();
            await expect(bar).toBeHidden();
            await expect(toggle).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-pressed', 'false');
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        });

        test('settings, drag, keyboard, saved order and reset', async ({ page }, info) => {
            test.setTimeout(240000);
            // Exercise the real account save/load flow without changing the preview account.
            const state = await storeOrder(page, { enabled: false, primary: ['model', 'model', 'removed', 'home', 'story'] });
            await ready(page);
            expect(await order(page, 'primary')).toEqual(['model', 'home', 'characters', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'chat-archive', 'extensions']);
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
                const first = page.locator(`#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-${name === 'modes' ? 'chat-mode' : 'route'}="${defaults[1]}"]`);
                await first.focus();
                await first.press('Alt+ArrowUp');
                const previous = previousGroup[name];
                if (previous) {
                    // At the top of a section, Alt+Up hands the button to the end of the section above.
                    expect(await order(page, name)).toEqual([defaults[0], ...defaults.slice(2)]);
                    expect((await order(page, previous)).at(-1)).toBe(defaults[1]);
                    await expect(first).toBeFocused();
                    await first.press('Alt+ArrowDown');
                }
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
            await expect.poll(() => JSON.parse(state.stored).enabled).toBe(false);
            await expect.poll(() => JSON.parse(state.stored).modes?.[0]).toBe('conversation');
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
            await expect.poll(() => JSON.parse(state.stored).enabled).toBe(true);
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

        test('sidebar reorder button, moves between sections, Done and Reset', async ({ page }, info) => {
            test.setTimeout(180000);
            // Every Troubleshooting button already sits in Appearance, so that section starts empty.
            const state = await storeOrder(page, { enabled: false, appearance: [...groups.appearance, ...groups.finer], finer: [] });
            await ready(page);
            await rail(page, phone);
            const toggle = page.locator('[data-neconyan-rail-reorder-toggle="primary"]');
            const bar = page.locator('[data-neconyan-rail-reorder-bar]');
            const troubleshooting = page.locator('section:has(> [data-neconyan-finer-nav])');
            // Every section that holds sidebar buttons has its own pen.
            expect(await page.locator('[data-neconyan-rail-reorder-toggle]').evaluateAll(pens => pens.map(pen => pen.dataset.neconyanRailReorderToggle)))
                .toEqual(Object.keys(groups));
            await expect(toggle).toHaveAttribute('aria-label', 'Edit sidebar');
            await expect(toggle).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-pressed', 'false');
            await expect(bar).toBeHidden();
            await expect(troubleshooting).toBeHidden();
            const toggleBox = await toggle.boundingBox();
            expect(toggleBox.width).toBeGreaterThanOrEqual(phone ? 44 : 28);

            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-pressed', 'true');
            await expect(bar).toBeVisible();
            await expect(page.locator('body')).toHaveClass(phone ? /neconyan-rail-drawer-open/ : /neconyan-rail-ready/);
            await expect(page.locator('[data-sb-rail-reorder-input]:checked')).toHaveCount(2);
            await expect.poll(() => JSON.parse(state.stored).enabled).toBe(true);
            await expect(troubleshooting).toBeVisible();
            expect((await page.locator('[data-neconyan-finer-nav]').boundingBox()).height).toBeGreaterThanOrEqual(44);
            for (const button of [bar.locator('.neconyan-rail-reorder-reset'), bar.locator('.neconyan-rail-reorder-done')]) {
                expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
            }
            await page.screenshot({ path: info.outputPath('reorder-bar.png') });

            // Drag Persona from Characters & Lore up into Workspace.
            const fine = page.locator('[data-neconyan-section-toggle="advanced"]');
            if (await fine.getAttribute('aria-expanded') === 'true') await fine.click();
            const lore = page.locator('[data-neconyan-section-toggle="lore"]');
            if (await lore.getAttribute('aria-expanded') === 'false') await lore.click();
            const target = page.locator('[data-neconyan-primary-nav] > [data-neconyan-route="agents"]');
            const persona = page.locator('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="persona"]');
            await persona.evaluate(element => element.scrollIntoView({ block: 'end' }));
            const grip = persona.locator('.neconyan-rail-grip');
            await expect(grip).toBeInViewport();
            await expect(target).toBeInViewport();
            await dragTo(page, grip, target, phone);
            await expect.poll(() => order(page, 'primary')).toEqual(['home', 'characters', 'model', 'persona', ...groups.primary.slice(3)]);
            expect(await order(page, 'lore')).toEqual(groups.lore.slice(1));
            await expect(page.locator('#neconyan-workspace-rail > [role="status"]')).toHaveText('Persona moved to position 4 of 11 in Workspace.');
            await expect.poll(() => JSON.parse(state.stored).primary?.[3]).toBe('persona');
            await page.screenshot({ path: info.outputPath('persona-in-workspace.png') });

            // Collapsed sections never catch a drop.
            await expect(page.locator('[data-neconyan-advanced-nav]')).toBeHidden();
            expect(await order(page, 'advanced')).toEqual(groups.advanced);

            await bar.locator('.neconyan-rail-reorder-done').click();
            await expect(bar).toBeHidden();
            await expect(toggle).toHaveAttribute('aria-pressed', 'false');
            await expect(toggle).toBeFocused();
            await expect(page.locator('#neconyan-workspace-rail .neconyan-rail-grip').first()).toBeHidden();
            await expect(troubleshooting).toBeHidden();
            await expect.poll(() => JSON.parse(state.stored).enabled).toBe(false);

            await ready(page);
            await rail(page, phone);
            expect(await order(page, 'primary')).toEqual(['home', 'characters', 'model', 'persona', ...groups.primary.slice(3)]);
            await page.locator('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="persona"] > span').first().click();
            await expect(page.locator('#persona-management-block')).toBeVisible();
            if (phone) await expect(page.locator('body')).not.toHaveClass(/neconyan-rail-drawer-open/);

            await rail(page, phone);
            await toggle.click();
            await bar.locator('.neconyan-rail-reorder-reset').click();
            for (const [name, defaults] of Object.entries(groups)) expect(await order(page, name)).toEqual(defaults);
            await expect(bar).toBeVisible();
            await expect.poll(() => JSON.parse(state.stored).lore).toEqual(groups.lore);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        });

        test('pens on every section, remove with X, add back and Restore defaults', async ({ page }, info) => {
            test.setTimeout(180000);
            const state = await storeOrder(page, { enabled: false });
            await ready(page);
            await rail(page, phone);
            const bar = page.locator('[data-neconyan-rail-reorder-bar]');
            const status = page.locator('#neconyan-workspace-rail > [role="status"]');
            const route = id => page.locator(`#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-route="${id}"]`);
            const lorebooks = route('lorebooks');
            await expect(lorebooks.locator('.neconyan-rail-remove')).toBeHidden();

            // A pen on a collapsed section opens it and starts editing.
            const lore = page.locator('[data-neconyan-section-toggle="lore"]');
            await lore.evaluate(toggle => toggle.getAttribute('aria-expanded') === 'true' && toggle.click());
            await expect(page.locator('[data-neconyan-lore-nav]')).toBeHidden();
            const lorePen = page.locator('[data-neconyan-rail-reorder-toggle="lore"]');
            await lorePen.scrollIntoViewIfNeeded();
            const penTop = (await lorePen.boundingBox()).y;
            await lorePen.click();
            await expect(bar).toBeVisible();
            await expect(lore).toHaveAttribute('aria-expanded', 'true');
            await expect(page.locator('[data-neconyan-rail-reorder-toggle]')).toHaveCount(6);
            for (const pen of await page.locator('[data-neconyan-rail-reorder-toggle]').all()) await expect(pen).toHaveAttribute('aria-pressed', 'true');
            // The bar appears above the list without pushing the pressed pen away.
            expect(Math.abs((await lorePen.boundingBox()).y - penTop)).toBeLessThanOrEqual(2);
            await expect(bar.locator('.neconyan-rail-reorder-reset')).toHaveText('Restore defaults');
            await expect(bar.locator('p')).toHaveText('Drag the grips to move buttons, even into another section. Press X to remove one.');

            // Remove Lorebooks with its X. The drawer stays open on phones and nothing navigates.
            await lorebooks.scrollIntoViewIfNeeded();
            const remove = lorebooks.locator('.neconyan-rail-remove');
            await expect(remove).toBeVisible();
            const removeBox = await remove.boundingBox();
            expect(removeBox.width).toBeGreaterThanOrEqual(44);
            expect(removeBox.height).toBeGreaterThanOrEqual(44);
            const gripBox = await lorebooks.locator('.neconyan-rail-grip').boundingBox();
            expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(gripBox.x + 1);
            const lorebooksBox = await lorebooks.boundingBox();
            expect(gripBox.x + gripBox.width).toBeLessThanOrEqual(lorebooksBox.x + lorebooksBox.width + 1);
            await remove.click();
            await expect(lorebooks).toHaveAttribute('data-neconyan-rail-removed', '');
            await expect(remove).toHaveClass(/fa-plus/);
            await expect(lorebooks).toBeVisible();
            await expect(status).toHaveText('Lorebooks removed from the sidebar.');
            await expect.poll(() => JSON.parse(state.stored).removed).toEqual(['lorebooks']);
            await expect(page.locator('body')).toHaveClass(phone ? /neconyan-rail-drawer-open/ : /neconyan-rail-ready/);
            await expect(page.locator('#world_popup')).toBeHidden();

            // Delete removes the focused button too, and every button in a section can go.
            for (const id of groups.finer) {
                await route(id).focus();
                await route(id).press('Delete');
            }
            await expect.poll(() => JSON.parse(state.stored).removed).toEqual(['lorebooks', ...groups.finer]);
            await page.screenshot({ path: info.outputPath('editing-removed.png') });

            await bar.locator('.neconyan-rail-reorder-done').click();
            await expect(lorePen).toBeFocused();
            await expect(lorebooks).toBeHidden();
            await expect(page.locator('section:has(> [data-neconyan-finer-nav])')).toBeHidden();
            await expect(route('notes')).toBeVisible();
            await expect.poll(() => JSON.parse(state.stored).enabled).toBe(false);

            // Removal survives a reload.
            await ready(page);
            await rail(page, phone);
            await expect(lorebooks).toBeHidden();
            await expect(page.locator('section:has(> [data-neconyan-finer-nav])')).toBeHidden();
            await page.screenshot({ path: info.outputPath('after-removal.png') });

            // While editing, a removed button can be added back with +.
            await page.locator('[data-neconyan-rail-reorder-toggle="primary"]').click();
            await expect(lorebooks).toBeVisible();
            await lorebooks.locator('.neconyan-rail-remove').click();
            await expect(lorebooks).not.toHaveAttribute('data-neconyan-rail-removed', '');
            await expect(status).toHaveText('Lorebooks added back to the sidebar.');
            await expect.poll(() => JSON.parse(state.stored).removed).toEqual(groups.finer);

            // Restore defaults brings back every button and the default order.
            await route('lorebooks').focus();
            await route('lorebooks').press('Alt+ArrowDown');
            await bar.locator('.neconyan-rail-reorder-reset').click();
            await expect.poll(() => JSON.parse(state.stored).removed).toEqual([]);
            for (const [name, defaults] of Object.entries(groups)) expect(await order(page, name)).toEqual(defaults);
            await expect(page.locator('#neconyan-workspace-rail [data-neconyan-rail-removed]')).toHaveCount(0);
            await bar.locator('.neconyan-rail-reorder-done').click();
            await expect(page.locator('section:has(> [data-neconyan-finer-nav])')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        });
    });
}

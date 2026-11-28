/* global document, window, getComputedStyle, PointerEvent, MouseEvent */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari } from './ios-safari-emulation.js';

const key = 'NeconyanWorkspaceRailOrder.v1';
const groups = {
    primary: ['home', 'characters', 'model', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'gallery', 'chat-archive', 'extensions'],
    advanced: ['presets', 'sampling', 'formatting', 'regex', 'preset-tools', 'chat-completion-tabs', 'prompt-tags', 'macro-enhanced', 'prompting-lab', 'deep-swipe'],
    lore: ['persona', 'expressions', 'quick-image-gen', 'botsearcher', 'pathfinder', 'world-info-lab', 'lorebook-distiller', 'time-machine'],
    appearance: ['background', 'dialogue-colors', 'termeownal-ui', 'css-snippets', 'regex-agent-themes'],
    finer: ['server', 'console-logs', 'debugger', 'reload-workspace', 'report-issue'],
    modes: ['roleplay', 'conversation', 'meower', 'story'],
};
const previousGroup = { advanced: 'primary', lore: 'advanced', appearance: 'lore', finer: 'appearance' };
const selector = name => `[data-neconyan-${name === 'modes' ? 'mode' : name}-nav]`;
const primaryOf = stored => JSON.parse(stored).primary ?? groups.primary;
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
    // primarySaves counts the saves that changed the Workspace order.
    const state = { stored: JSON.stringify(initial), primarySaves: 0 };
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
        const data = JSON.parse(body.settings);
        // These checks need every section, regardless of what an earlier file saved.
        data.firstRun = false;
        data.accountStorage = {
            ...data.accountStorage,
            'NeconyanSimpleMode.v1': 'off',
            'NeconyanTutorialStatus.v1': 'skipped',
            'NeconyanWorkspaceRailCollapsed.v1': String(collapsed),
            'NeconyanWorkspaceRailSections.v1': '{}',
            [key]: state.stored,
        };
        await route.fulfill({ response, json: { ...body, settings: JSON.stringify(data) } });
    });
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        const payload = JSON.parse(bytes.toString());
        const before = primaryOf(state.stored);
        state.stored = payload.accountStorage[key] ?? state.stored;
        if (primaryOf(state.stored).join() !== before.join()) state.primarySaves++;
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
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
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
                const box = await toggle.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return { width: rect.width, height: rect.height, cssWidth: parseFloat(style.width), cssHeight: parseFloat(style.height) };
                });
                expect(box.cssWidth).toBeGreaterThanOrEqual(44);
                expect(box.cssHeight).toBeGreaterThanOrEqual(44);
                expect(box.width).toBeCloseTo(box.cssWidth, 3);
                expect(box.height).toBeCloseTo(box.cssHeight, 3);
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
            expect(await order(page, 'primary')).toEqual(['model', 'home', 'characters', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'gallery', 'chat-archive', 'extensions']);
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
                // Scroll anchoring is off only while a grip is held.
                expect(await page.locator('.neconyan-rail-scroll').evaluate(element => element.style.overflowAnchor)).toBe('');
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
            const toggleWidth = await toggle.evaluate(element => parseFloat(getComputedStyle(element).width));
            expect(toggleWidth).toBeGreaterThanOrEqual(phone ? 44 : 28);
            // Chromium's translated drawer can report 43.9999847 for a 44px box.
            // Keep the exact CSS minimum and check that the rendered target matches it.
            expect(toggleBox.width).toBeCloseTo(toggleWidth, 3);

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
            await expect(page.locator('#neconyan-workspace-rail > [role="status"]')).toHaveText('Persona moved to position 4 of 12 in Workspace.');
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

// Presses the first Workspace grip and, when asked, drags it part-way down
// without letting go, so the press can be interrupted in the middle.
async function hold(page, phone, moving) {
    const grip = page.locator('[data-neconyan-primary-nav] button .neconyan-rail-grip').first();
    await grip.scrollIntoViewIfNeeded();
    const source = await grip.boundingBox();
    const target = await page.locator('[data-neconyan-primary-nav] > button').nth(2).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const end = target.y + target.height / 2;
    if (phone) {
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await new Promise(resolve => setTimeout(resolve, moving ? 850 : 300));
        for (let step = 1; moving && step <= 6; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (end - y) * step / 6 }] });
        }
        return {
            cancel: () => session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }),
            release: () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
            detach: () => session.detach(),
        };
    }
    await page.mouse.move(x, y);
    await page.mouse.down();
    await new Promise(resolve => setTimeout(resolve, moving ? 120 : 20));
    if (moving) await page.mouse.move(x, end, { steps: 6 });
    return { release: () => page.mouse.up(), detach: async () => {} };
}

async function pressState(page) {
    return page.evaluate(() => {
        const instances = [...document.querySelectorAll('[data-neconyan-rail-group]')]
            .map(host => window.jQuery(host).sortable('instance'))
            .filter(Boolean);
        return {
            helpers: document.querySelectorAll('.ui-sortable-helper').length,
            placeholders: document.querySelectorAll('.neconyan-rail-placeholder').length,
            // jQuery UI can leave an empty style attribute behind; only real inline styles count.
            styled: [...document.querySelectorAll('[data-neconyan-rail-group] > .neconyan-rail-button[style]')].map(button => button.getAttribute('style')).filter(Boolean),
            overflowAnchor: document.querySelector('.neconyan-rail-scroll').style.overflowAnchor,
            dragging: instances.filter(instance => instance.dragging || instance._mouseStarted).length,
            // jQuery UI keeps its document mouseup listener only while it thinks a press is down.
            pending: (window.jQuery._data(document, 'events')?.mouseup || []).filter(handler => handler.namespace === 'sortable').length,
        };
    });
}

const putBack = { helpers: 0, placeholders: 0, styled: [], overflowAnchor: '', dragging: 0, pending: 0 };
const swapFirstTwo = list => [list[1], list[0], ...list.slice(2)];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const describePress = (kind, moving) => `${kind} ${moving ? 'mid-drag' : 'during the hold'}`;

async function openEditing(page, phone) {
    if (phone) await installIPhoneSafari(page.context(), { standalone: true });
    const state = await storeOrder(page, { enabled: true });
    await ready(page);
    if (phone) await applyIOSOnlyCss(page, { inPlace: true });
    await rail(page, phone);
    return state;
}

// Ends a held press the way the browser or the app would, without the
// finger's own touchend.
async function interrupt(page, kind, press) {
    if (kind === 'touchcancel') return press.cancel();
    return page.evaluate(kind => {
        if (kind === 'blur') window.dispatchEvent(new Event('blur'));
        if (kind === 'pointercancel') document.querySelector('.neconyan-rail-grip').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
        if (kind === 'Edit off') {
            window.NeconyanWelcome.setRailReordering(false);
            window.NeconyanWelcome.setRailReordering(true);
        }
    }, kind);
}

async function checkInterruption(page, phone, kind, moving, info) {
    const label = describePress(kind, moving);
    const press = await hold(page, phone, moving);
    const held = await pressState(page);
    expect(held.overflowAnchor, label).toBe('none');
    expect(held.helpers, label).toBe(Number(moving));
    if (moving && kind === 'touchcancel') await page.screenshot({ path: info.outputPath('touchcancel-mid-drag.png') });
    await interrupt(page, kind, press);
    expect(await pressState(page), label).toEqual(putBack);
    expect(await order(page, 'primary'), label).toEqual(groups.primary);
    // Lifting the finger or the mouse button afterwards must not drop the row anywhere.
    if (kind !== 'touchcancel') await press.release();
    await press.detach();
    expect(await pressState(page), `${label}, after letting go`).toEqual(putBack);
    expect(await order(page, 'primary'), `${label}, after letting go`).toEqual(groups.primary);
}

for (const phone of [false, true]) {
    const interruptions = [
        ...(phone ? [['touchcancel', true]] : []),
        ['pointercancel', false],
        ['pointercancel', true],
        ['blur', false],
        ['blur', true],
    ];
    for (const reducedMotion of ['reduce', 'no-preference']) {
        test.describe(`${phone ? 'phone' : 'desktop'} interrupted sidebar drags, ${reducedMotion} motion`, () => {
            test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', contextOptions: { reducedMotion } });
            test('touchcancel, pointercancel and blur put the row back', async ({ page }, info) => {
                test.setTimeout(180000);
                const state = await openEditing(page, phone);
                const saved = state.stored;
                for (const [kind, moving] of interruptions) await checkInterruption(page, phone, kind, moving, info);
                await page.screenshot({ path: info.outputPath('after-interruptions.png') });
                // Saves are debounced, so give a stray one time to arrive.
                await pause(1500);
                expect(state.stored).toBe(saved);

                await drag(page, 'primary', phone);
                await expect.poll(() => order(page, 'primary')).toEqual(swapFirstTwo(groups.primary));
                await expect.poll(() => primaryOf(state.stored)).toEqual(swapFirstTwo(groups.primary));
                expect(await pressState(page)).toEqual(putBack);
                await page.unrouteAll({ behavior: 'ignoreErrors' });
            });
        });
    }
}

// Plays touches inside the page. Linux WebKit cannot build Touch objects and
// Playwright has no touch driver for it, and Touch Punch only reads the touch
// lists, so plain events carrying them are enough.
async function touch(page, type, x, y) {
    await page.evaluate(([type, x, y]) => {
        if (type === 'touchstart') window.railTestTouchTarget = document.elementFromPoint(x, y);
        const target = window.railTestTouchTarget;
        const point = { identifier: 1, target, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY, screenX: x, screenY: y };
        const active = type === 'touchend' ? [] : [point];
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: active }, targetTouches: { value: active }, changedTouches: { value: [point] } });
        target.dispatchEvent(event);
    }, [type, x, y]);
}

// Puts a finger on the first Workspace grip and, when asked, drags it towards
// the next row, then leaves it there: its touchend never reaches the page, as
// when the app loses focus or the browser takes the touch for itself.
async function strandTouch(page, moving) {
    const grip = page.locator('[data-neconyan-primary-nav] button .neconyan-rail-grip').first();
    await grip.scrollIntoViewIfNeeded();
    const source = await grip.boundingBox();
    const target = await page.locator('[data-neconyan-primary-nav] > button').nth(2).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const end = target.y + target.height / 2;
    await touch(page, 'touchstart', x, y);
    await pause(moving ? 850 : 300);
    for (let step = 1; moving && step <= 6; step++) await touch(page, 'touchmove', x, y + (end - y) * step / 6);
}

// A whole one-finger drag of the first row below the second. Chromium gets
// real touches; WebKit gets page touches.
async function nextTouchDrag(page, browserName) {
    if (browserName === 'chromium') return drag(page, 'primary', true);
    const grip = page.locator('[data-neconyan-primary-nav] button .neconyan-rail-grip').first();
    const source = await grip.boundingBox();
    const target = await page.locator('[data-neconyan-primary-nav] > button').nth(1).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const end = target.y + target.height * 0.8;
    await touch(page, 'touchstart', x, y);
    await pause(850);
    for (let step = 1; step <= 8; step++) await touch(page, 'touchmove', x, y + (end - y) * step / 8);
    await touch(page, 'touchend', x, end);
}

test.describe('phone touch that never gets its touchend', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
    const strandings = [['blur', true], ['blur', false], ['pointercancel', true], ['Edit off', true]];
    test('the next one-finger drag moves the row first time', async ({ page, browserName }) => {
        test.setTimeout(180000);
        const state = await openEditing(page, true);
        let expected = groups.primary;
        for (const [kind, moving] of strandings) {
            const label = describePress(kind, moving);
            await strandTouch(page, moving);
            expect((await pressState(page)).helpers, label).toBe(Number(moving));
            await interrupt(page, kind);
            expect(await pressState(page), label).toEqual(putBack);
            expect(await order(page, 'primary'), label).toEqual(expected);

            // The stranded finger never lifts; the next touch is a new drag.
            const saves = state.primarySaves;
            await nextTouchDrag(page, browserName);
            expected = swapFirstTwo(expected);
            await expect.poll(() => order(page, 'primary'), `${label}, next drag`).toEqual(expected);
            await expect.poll(() => primaryOf(state.stored), `${label}, next drag saved`).toEqual(expected);
            await pause(1500);
            expect(state.primarySaves, `${label}, saved once`).toBe(saves + 1);
            expect(await pressState(page), `${label}, next drag`).toEqual(putBack);
        }
        await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
});

// Grip and row boxes on staging before grips refused menus and selection,
// as [x offset from the row, y offset from the row, width, height].
const railGeometry = {
    phone: { off: [295, 44], on: [295, 46], grip: [250, 1, 44, 44] },
    desktop: { off: [219, 36.8], on: [219, 46], grip: [174, 1, 44, 44] },
};

// Measures the first Workspace row and grip, and the styles that decide
// whether a long press scrolls, selects text or opens the phone's menu.
async function gripLook(page) {
    return page.evaluate(() => {
        const row = document.querySelector('[data-neconyan-primary-nav] > .neconyan-rail-button');
        const grip = row.querySelector('.neconyan-rail-grip');
        const look = element => {
            const style = getComputedStyle(element);
            return { touchAction: style.touchAction, userSelect: style.userSelect || style.webkitUserSelect, webkitUserSelect: style.webkitUserSelect };
        };
        const round = value => Math.round(value * 10) / 10;
        const rowBox = row.getBoundingClientRect();
        const gripBox = grip.getBoundingClientRect();
        return {
            grip: look(grip),
            row: look(row),
            label: look(row.querySelector('span:not([class])')),
            scroller: look(document.querySelector('.neconyan-rail-scroll')),
            row_box: [round(rowBox.width), round(rowBox.height)],
            grip_box: [round(gripBox.left - rowBox.left), round(gripBox.top - rowBox.top), round(gripBox.width), round(gripBox.height)],
        };
    });
}

// Sends the menu and selection events a phone sends after a long press, at
// the point under the finger, and says whether the page refused each one.
async function phoneMenuAt(page, target) {
    await page.locator(target).first().scrollIntoViewIfNeeded();
    return page.locator(target).first().evaluate(element => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const under = document.elementFromPoint(x, y);
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
        const select = new Event('selectstart', { bubbles: true, cancelable: true });
        under.dispatchEvent(menu);
        under.dispatchEvent(select);
        return { under: under === element || element.contains(under), menu: menu.defaultPrevented, select: select.defaultPrevented };
    });
}

// Holds the first Workspace grip well past the 750 ms phone delay, lets the
// phone ask for its menu and selection, then drags the row below the next.
async function longPressDrag(page, phone, browserName) {
    const grip = page.locator('[data-neconyan-primary-nav] button .neconyan-rail-grip').first();
    await grip.scrollIntoViewIfNeeded();
    const source = await grip.boundingBox();
    const target = await page.locator('[data-neconyan-primary-nav] > button').nth(1).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const end = target.y + target.height * 0.8;
    const cdp = phone && browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    const move = async (type, pointY) => {
        if (cdp) return cdp.send('Input.dispatchTouchEvent', { type: { touchstart: 'touchStart', touchmove: 'touchMove', touchend: 'touchEnd' }[type], touchPoints: type === 'touchend' ? [] : [{ x, y: pointY }] });
        if (phone) return touch(page, type, x, pointY);
        if (type === 'touchstart') {
            await page.mouse.move(x, pointY);
            return page.mouse.down();
        }
        if (type === 'touchmove') return page.mouse.move(x, pointY);
        return page.mouse.up();
    };
    await move('touchstart', y);
    await pause(1000);
    const menu = await phoneMenuAt(page, '[data-neconyan-primary-nav] button .neconyan-rail-grip');
    const selection = await page.evaluate(() => window.getSelection().toString());
    for (let step = 1; step <= 8; step++) await move('touchmove', y + (end - y) * step / 8);
    await move('touchend', end);
    await cdp?.detach();
    return { menu, selection };
}

for (const phone of [false, true]) {
    for (const reducedMotion of ['reduce', 'no-preference']) {
        test.describe(`${phone ? 'phone' : 'desktop'} grip long press, ${reducedMotion} motion`, () => {
            test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', contextOptions: { reducedMotion } });
            test('a long press on a grip opens no menu or selection and still drags', async ({ page, browserName }, info) => {
                test.setTimeout(120000);
                const expected = railGeometry[phone ? 'phone' : 'desktop'];
                const state = await openEditing(page, phone);
                await page.evaluate(() => {
                    window.railGripCancels = [];
                    for (const type of ['touchcancel', 'pointercancel', 'dragstart']) window.addEventListener(type, () => window.railGripCancels.push(type), true);
                });

                // -webkit-touch-callout only takes effect on iPhones and Android,
                // so neither test browser keeps it; check the shipped rule instead.
                const css = await page.evaluate(async () => (await fetch(document.querySelector('link[href*="css/neconyan.css"]').href)).text());
                const rule = css.match(/body\.neconyan \.neconyan-rail-reordering \.neconyan-rail-grip \{([^}]*)\}/)?.[1] ?? '';
                expect(rule).toMatch(/touch-action: none;/);
                expect(rule).toMatch(/(^|[\s;])user-select: none;/);
                expect(rule).toMatch(/-webkit-user-select: none;/);
                expect(rule).toMatch(/-webkit-touch-callout: none;/);

                const editing = await gripLook(page);
                expect(editing.grip).toEqual({ touchAction: 'none', userSelect: 'none', webkitUserSelect: 'none' });
                for (const part of ['row', 'label', 'scroller']) {
                    expect(editing[part].touchAction, part).not.toBe('none');
                    expect(editing[part].userSelect, part).not.toBe('none');
                }
                expect(editing.row_box).toEqual(expected.on);
                expect(editing.grip_box).toEqual(expected.grip);

                const press = await longPressDrag(page, phone, browserName);
                expect(press.menu).toEqual({ under: true, menu: true, select: true });
                expect(press.selection).toBe('');
                await expect.poll(() => order(page, 'primary')).toEqual(swapFirstTwo(groups.primary));
                await expect.poll(() => primaryOf(state.stored)).toEqual(swapFirstTwo(groups.primary));
                expect(await pressState(page)).toEqual(putBack);
                expect(await page.evaluate(() => window.railGripCancels)).toEqual([]);
                expect(await page.evaluate(() => window.getSelection().toString())).toBe('');
                await page.screenshot({ path: info.outputPath('after-long-press.png') });

                // Rows themselves still offer their menu, and the list still scrolls.
                expect(await phoneMenuAt(page, '[data-neconyan-primary-nav] > button > span:not([class])')).toEqual({ under: true, menu: false, select: false });
                if (browserName === 'chromium') await checkPhoneScrolling(page, phone);

                await page.evaluate(() => window.NeconyanWelcome.setRailReordering(false));
                const browsing = await gripLook(page);
                expect(browsing.row_box).toEqual(expected.off);
                expect(browsing.row.touchAction).not.toBe('none');
                expect(await phoneMenuAt(page, '[data-neconyan-primary-nav] > button > span:not([class])')).toEqual({ under: true, menu: false, select: false });
                const hiddenGrip = await page.evaluate(() => {
                    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
                    document.querySelector('[data-neconyan-primary-nav] .neconyan-rail-grip').dispatchEvent(menu);
                    return menu.defaultPrevented;
                });
                expect(hiddenGrip).toBe(false);
                await page.unrouteAll({ behavior: 'ignoreErrors' });
            });
        });
    }
}

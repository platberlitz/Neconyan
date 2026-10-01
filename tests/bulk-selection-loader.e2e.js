/* global document, window, getComputedStyle, NeconyanShell */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const STYLES = ['calico', 'kittyless', 'windows-98', 'windows-aero', 'clean-minimal', 'macos-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat'];
const CARDS = ['Selection Alpha', 'Selection Beta', 'Selection Gamma'].map(name => ({
    name, avatar: `${name}.png`, description: 'A selection test character.',
    data: { name, description: 'A selection test character.', extensions: {} },
}));
const GROUPS = ['Selection Group Alpha', 'Selection Group Beta'].map((name, index) => ({
    id: `selection-${index}`, name, members: [CARDS[0].avatar], chat_id: `selection-chat-${index}`, chats: [],
}));

async function prepare(browser, phone) {
    const context = await browser.newContext({
        ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
        serviceWorkers: 'block', reducedMotion: 'reduce',
    });
    if (phone) await installIPhoneSafari(context, { standalone: true });
    const page = await context.newPage();
    await page.addInitScript(() => window.addEventListener('neconyan:ready', () => { window.bulkTestReady = true; }));
    page.on('pageerror', error => console.error(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.route('**/api/characters/all', route => route.fulfill({ json: CARDS }));
    const storage = createMockRoleplayStore(() => page.evaluate(async () =>
        (await import('/scripts/roleplay-save-chain.js')).roleplayAccountStamp().account));
    await page.route('**/api/groups/all', route => storage.readGroups(route, GROUPS));
    await page.route('**/api/extensions/discover', route => route.fulfill({ json: [] }));
    await page.route('**/thumbnail?*', route => route.fulfill({ path: '../public/img/neconyan-icon-192.png', contentType: 'image/png' }));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response });
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.goto('/');
    await page.waitForFunction(() => window.NeconyanShell);
    await expect(page.locator('#preloader')).toHaveCount(0, { timeout: 90000 });
    await page.waitForFunction(() => window.bulkTestReady, null, { timeout: 90000 });
    await page.waitForLoadState('networkidle'); // eslint-disable-line playwright/no-networkidle
    await page.evaluate(() => document.fonts.ready);
    return { context, page };
}

async function applyStyle(page, id, phone) {
    await page.evaluate(id => NeconyanShell.applyTheme(id), id);
    await page.waitForFunction(id => id === 'calico'
        ? !document.querySelector('link[data-sb-shell-style]')
        : document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet, id);
    if (phone) await applyIOSOnlyCss(page);
    await page.evaluate(() => document.fonts.ready);
}

function appearance(locator) {
    return locator.evaluate(el => {
        const css = getComputedStyle(el);
        const tick = getComputedStyle(el, '::after');
        const rect = el.getBoundingClientRect();
        const avatar = el.querySelector('.avatar').getBoundingClientRect();
        return {
            background: css.backgroundColor, outline: css.outlineStyle, outlineWidth: css.outlineWidth,
            tick: tick.content, tickDisplay: tick.display,
            width: rect.width, height: rect.height, avatarWidth: avatar.width, avatarHeight: avatar.height,
        };
    });
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} bulk selections stay visible across every Shell Style`, async ({ browser }, info) => {
        test.setTimeout(240000);
        const { context, page } = await prepare(browser, phone);
        try {
            for (const style of STYLES) {
                await applyStyle(page, style, phone);
                for (const view of ['characters', 'groups']) {
                    await page.evaluate(view => NeconyanShell.openTab('characters', view), view);
                    const rows = page.locator(`#rm_print_characters_block > .${view === 'characters' ? 'character' : 'group'}_select`);
                    await expect(rows.first()).toBeVisible({ timeout: 15000 });
                    await expect(rows.first().locator('[data-entity-action="open-chat"]')).toBeVisible({ timeout: 15000 });
                    await page.locator('#right-nav-panel').evaluate(async el => {
                        await Promise.allSettled(el.getAnimations()
                            .filter(animation => animation.effect.getTiming().iterations !== Infinity)
                            .map(animation => animation.finished));
                    });
                    await page.locator('#bulkEditButton').click();
                    await expect(page.locator('#rm_print_characters_block')).toHaveClass(/group_overlay_mode_select/);
                    await page.evaluate(() => document.fonts.ready);
                    await rows.first().hover();
                    await rows.first().evaluate(async el => {
                        await Promise.allSettled(el.getAnimations()
                            .filter(animation => animation.effect.getTiming().iterations !== Infinity)
                            .map(animation => animation.finished));
                    });
                    const before = await appearance(rows.first());
                    await rows.first().click({ position: { x: 5, y: 5 } });
                    await expect(page.locator('#bulkSelectedCount')).toHaveText('1');
                    await expect(rows.first()).toHaveClass(/character_selected/);
                    const selected = await appearance(rows.first());
                    const unselected = await appearance(rows.nth(1));
                    await page.screenshot({ path: info.outputPath(`${style}-${view}-selected.png`) });
                    expect(selected.outline, JSON.stringify({ style, view, selected, unselected })).toBe('solid');
                    expect(selected.outlineWidth).toBe('2px');
                    expect(selected.tick).not.toBe('none');
                    expect(selected.tickDisplay).not.toBe('none');
                    expect(unselected.tick).toBe('none');
                    expect(selected.background).not.toBe(unselected.background);
                    expect([selected.width, selected.height, selected.avatarWidth, selected.avatarHeight], JSON.stringify({ style, view, before, selected }))
                        .toEqual([before.width, before.height, before.avatarWidth, before.avatarHeight]);
                    if (phone) expect([selected.avatarWidth, selected.avatarHeight]).toEqual([56, 56]);
                    await rows.first().hover();
                    expect((await appearance(rows.first())).outline).toBe('solid');
                    await rows.first().click({ position: { x: 5, y: 5 } });
                    await expect(page.locator('#bulkSelectedCount')).toHaveText('0');
                    expect((await appearance(rows.first())).tick).toBe('none');
                    await page.locator('#bulkSelectAllButton').click();
                    await expect(page.locator('#bulkSelectedCount')).toHaveText(String(await rows.count()));
                    await expect(page.locator('#rm_print_characters_block > .character_selected')).toHaveCount(await rows.count());
                    await page.locator('#bulkSelectAllButton').click();
                    await expect(page.locator('#bulkSelectedCount')).toHaveText('0');
                    await page.locator('#bulkEditButton').click();
                    await expect(page.locator('#rm_print_characters_block > .character_selected')).toHaveCount(0);
                }
            }
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
        }
    });

    for (const view of ['characters', 'groups']) {
        test(`${phone ? 'iPhone stand-in' : 'desktop'} ${view} deletion uses the correct ID and clears its mascot loader`, async ({ browser }) => {
            test.setTimeout(120000);
            const { context, page } = await prepare(browser, phone);
            let release;
            const deletionAllowed = new Promise(resolve => { release = resolve; });
            const requests = [];
            try {
                await applyStyle(page, 'windows-98', phone);
                await page.route(`**/api/${view}/delete`, async route => {
                    requests.push(route.request().postDataJSON());
                    await deletionAllowed;
                    await route.fulfill({ json: {} });
                });
                await page.route(`**/api/${view === 'groups' ? 'characters' : 'groups'}/delete`, route => {
                    requests.push({ unexpectedDeletion: true });
                    return route.fulfill({ status: 400, json: {} });
                });
                await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
                await page.evaluate(view => NeconyanShell.openTab('characters', view), view);
                const row = page.locator(`#rm_print_characters_block > .${view === 'groups' ? 'group' : 'character'}_select`).first();
                await expect(row.locator('[data-entity-action="open-chat"]')).toBeVisible({ timeout: 15000 });
                await page.locator('#bulkEditButton').click();
                await row.click({ position: { x: 5, y: 5 } });
                await expect(page.locator('#bulkSelectedCount')).toHaveText('1');
                await page.locator('#bulkDeleteButton').click();
                await expect(page.locator('.popup h3')).toHaveText(`Delete 1 ${view}?`);
                await page.locator('.popup-button-ok').click();
                const mascot = page.locator('#load-spinner img');
                await expect(mascot).toBeVisible();
                await expect(mascot).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
                expect(await mascot.evaluate(el => getComputedStyle(el).content)).toContain('win98/startup-cat-rest.webp');
                await expect.poll(() => requests.length, { timeout: 15000 }).toBe(1);
                expect(view === 'groups' ? requests[0].id : requests[0].avatar_url).toBe(view === 'groups' ? 'selection-0' : CARDS[0].avatar);
                release();
                await expect(page.locator('#loader')).toHaveCount(0, { timeout: 15000 });
                await expect(page.locator('#rm_print_characters_block')).not.toHaveClass(/group_overlay_mode_select/);
            } finally {
                release();
                await page.unrouteAll({ behavior: 'ignoreErrors' });
                await context.close();
            }
        });
    }

    test(`${phone ? 'iPhone stand-in' : 'desktop'} action loader follows Shell Style and reduced motion`, async ({ browser }, info) => {
        test.setTimeout(240000);
        const { context, page } = await prepare(browser, phone);
        try {
            for (const style of STYLES) {
                await applyStyle(page, style, phone);
                await page.evaluate(async () => {
                    const { loader } = await import('/scripts/action-loader.js');
                    window.bulkTestLoader = loader.show({ slug: 'bulk-delete', toastMode: loader.ToastMode.NONE });
                });
                const mascot = page.locator('#load-spinner img');
                await expect(mascot).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
                if (style === 'kittyless') {
                    await expect(mascot).toBeHidden();
                    await expect(page.locator('#load-spinner .action-loader-progress')).toBeVisible();
                    await expect(page.locator('#load-spinner .action-loader-progress')).toHaveCSS('animation-name', 'none');
                } else {
                    await expect(mascot).toBeVisible();
                    await expect(page.locator('#load-spinner .action-loader-progress')).toBeHidden();
                    const replacement = await mascot.evaluate(el => getComputedStyle(el).content);
                    if (style === 'windows-98') expect(replacement).toContain('win98/startup-cat-rest.webp');
                    else expect(replacement).toBe('normal');
                }
                await expect(page.locator('#loader')).toHaveAttribute('role', 'status');
                await page.screenshot({ path: info.outputPath(`${style}-loader.png`) });
                await page.evaluate(async () => { await window.bulkTestLoader.hide(); });
                await expect(page.locator('#loader')).toHaveCount(0);
            }
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await applyStyle(page, 'calico', phone);
            await page.evaluate(async () => {
                const { loader } = await import('/scripts/action-loader.js');
                window.bulkTestLoader = loader.show({ toastMode: loader.ToastMode.NONE });
            });
            await expect(page.locator('#load-spinner img')).toHaveAttribute('src', /neconyan-pixel-cat-running\.webp/);
            await applyStyle(page, 'windows-98', phone);
            expect(await page.locator('#load-spinner img').evaluate(el => getComputedStyle(el).content)).toContain('win98/startup-cat.webp');
            await page.locator('#load-spinner img').evaluate(async el => { await el.decode(); });
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                power_user.reduced_motion = true;
                document.querySelector('#reduced_motion').checked = true;
                document.querySelector('#reduced_motion').dispatchEvent(new Event('input', { bubbles: true }));
            });
            await expect(page.locator('#load-spinner img')).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
            await page.evaluate(async () => { await window.bulkTestLoader.hide(); });
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
        }
    });
}

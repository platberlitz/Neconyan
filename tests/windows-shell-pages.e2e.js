/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions shared by Chromium and WebKit fixtures. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const chromiumTest = test.extend({ browserName: 'chromium' });
const webkitTest = test.extend({ browserName: 'webkit' });
const windows = ['windows-xp', 'windows-98', 'windows-aero'];
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const styles = [...source.match(/const NN_THEMES = Object.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
const roots = { characters: '#right-nav-panel', left: '#left-nav-panel', right: '#user-settings-block' };
const outerNavPaths = {
    '#right-nav-panel': ' > .sb-character-shell-nav-wrapper > .sb-shell-nav',
    '#left-nav-panel': ' > .sb-shell-frame > .sb-shell-main > .sb-model-native-nav-wrapper > .sb-shell-nav',
    '#user-settings-block': ' > .sb-shell-frame > .sb-shell-nav-wrapper > .sb-shell-nav',
};
const outerNav = root => root + outerNavPaths[root];
const referenceRoutes = [['characters', 'characters'], ['characters', 'creator'], ['left', 'api'], ['right', 'settings']];

async function setup(app, { phone = false, ios = false, vertical = false } = {}) {
    const account = await app.account({ phone, contextOptions: ios ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
        saved.firstRun = false;
        saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
    } });
    if (ios) await installIPhoneSafari(account.context, { standalone: false });
    if (vertical) await account.context.addInitScript(() => window.localStorage.setItem('sb-desktop-nav-layout', 'vertical'));
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: phone ? 393 : 1280, height: phone ? 852 : 900 });
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.jQuery('#themes').val('Neconyan Calico').trigger('change'));
    return { page, account, ios };
}

async function applyStyle(page, id) {
    await page.evaluate(value => window.NeconyanShell.applyTheme(value), id);
    await page.waitForFunction(value => document.documentElement.dataset.sbTheme === value
        && (value === 'calico' || Boolean(document.querySelector(`link[data-sb-shell-style="${value}"]`)?.sheet)), id);
}

async function stable(page, selector) {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
        window.toastr?.remove();
        document.querySelectorAll('.neconyan-tour-invite-dismiss').forEach(node => node.click());
    });
    await page.waitForFunction(({ selector, navSelector }) => {
        const root = document.querySelector(selector);
        const nodes = [root, root.querySelector('.sb-shell-header'), document.querySelector(navSelector)];
        const boxes = JSON.stringify(nodes.map(node => node?.getBoundingClientRect().toJSON()));
        if (root.dataset.windowsPageBoxes === boxes) root.dataset.windowsPageStable = String(Number(root.dataset.windowsPageStable || 0) + 1);
        else { root.dataset.windowsPageBoxes = boxes; root.dataset.windowsPageStable = '0'; }
        return Number(root.dataset.windowsPageStable) >= 3;
    }, { selector, navSelector: outerNav(selector) });
}

async function open(page, side, tab, { ios = false } = {}) {
    if (tab === 'included-tool') await page.evaluate(() => window.NeconyanShell.openIncludedTool('quick-image-gen'));
    else await page.evaluate(([s, t]) => window.NeconyanShell.openTab(s, t), [side, tab]);
    const selector = roots[side];
    const root = page.locator(selector);
    await expect(root).toBeVisible();
    await expect(root).toHaveClass(/openDrawer/);
    await expect(root).toHaveAttribute(side === 'characters' ? 'data-menu-type' : 'data-sb-active-tab', tab === 'editor' ? 'character_edit' : tab);
    if (tab === 'creator') await page.getByText('Private character studio', { exact: true }).waitFor({ state: 'visible' });
    if (tab === 'world-info') await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.includes('world-info.css')));
    if (ios) await applyIOSOnlyCss(page);
    await stable(page, selector);
    return selector;
}

// Keep this measurement compatible with the retained d7 Before manifests. Text is
// excluded only from comparison because character and generated account names vary.
async function measure(page, selector) {
    return page.locator(selector).evaluate((root, navPath) => {
        const m = node => {
            if (!node) return null;
            const c = getComputedStyle(node);
            return { box: node.getBoundingClientRect().toJSON(), display: c.display, visibility: c.visibility,
                opacity: c.opacity, color: c.color, backgroundColor: c.backgroundColor, backgroundImage: c.backgroundImage,
                margin: c.margin, padding: c.padding, flexDirection: c.flexDirection, overflowX: c.overflowX, overflowY: c.overflowY,
                text: node.textContent.trim().slice(0, 160) };
        };
        const nav = root.querySelector(':scope' + navPath), header = root.querySelector('.sb-shell-header');
        const active = root.querySelector('.sb-settings-nav-column .sb-settings-tab-btn.active');
        return { root: m(root), header: m(header), title: m(header?.querySelector('.sb-shell-title')),
            help: m(header?.querySelector('.sb-shell-subtitle')), description: m(header?.querySelector('.sb-shell-description')),
            wrapper: m(nav?.parentElement), nav: m(nav), orientation: nav?.getAttribute('aria-orientation'),
            tabs: [...(nav?.querySelectorAll('.sb-shell-tab') || [])].map(m), selected: m(active), selectedIcon: m(active?.querySelector('i')),
            overflow: document.documentElement.scrollWidth - window.innerWidth };
    }, outerNavPaths[selector]);
}
const displayed = node => node && node.display !== 'none' && node.visibility === 'visible' && node.box.width > 0 && node.box.height > 0;

function railAboveCaption(g, label) {
    expect(displayed(g.header), label + ' displayed caption').toBe(true);
    expect(displayed(g.wrapper), label + ' displayed wrapper').toBe(true);
    expect(g.tabs.filter(displayed).length, label + ' nonempty rail').toBeGreaterThan(0);
    expect(g.nav.flexDirection, label + ' row').toBe('row');
    expect(g.wrapper.box.bottom, label + ' rail above caption').toBeLessThanOrEqual(g.header.box.top + 1);
    for (const edge of ['left', 'right']) expect(Math.abs(g.wrapper.box[edge] - g.header.box[edge]), label + ' full wrapper width').toBeLessThanOrEqual(1);
    expect(g.header.margin, label + ' edge-to-edge caption').toBe('0px');
    expect(g.overflow, label + ' document overflow').toBeLessThanOrEqual(1);
}

async function settingsSidebar(page, root, tab, label) {
    await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', tab);
    const g = await measure(page, root);
    const { frame, main } = await page.locator(root).evaluate(element => ({
        frame: element.querySelector(':scope > .sb-shell-frame').getBoundingClientRect().toJSON(),
        main: element.querySelector(':scope > .sb-shell-frame > .sb-shell-main').getBoundingClientRect().toJSON(),
    }));
    expect(displayed(g.wrapper), label + ' displayed sidebar').toBe(true);
    expect(displayed(g.header), label + ' displayed caption').toBe(true);
    expect(g.tabs.filter(displayed).length, label + ' nonempty sidebar').toBeGreaterThan(0);
    expect(g.nav.flexDirection, label + ' column').toBe('column');
    expect(g.orientation, label + ' native vertical ARIA').toBe('vertical');
    expect(Math.abs(g.wrapper.box.width - 208), label + ' original sidebar width').toBeLessThanOrEqual(1);
    for (const edge of ['top', 'bottom']) expect(Math.abs(g.wrapper.box[edge] - frame[edge]), label + ' full frame height').toBeLessThanOrEqual(1);
    expect(main.left, label + ' adjacent content').toBeGreaterThanOrEqual(g.wrapper.box.right - 1);
    expect(g.header.box.left, label + ' caption beside sidebar').toBeGreaterThanOrEqual(g.wrapper.box.right - 1);
    expect(g.header.box.right, label + ' caption within main').toBeLessThanOrEqual(main.right + 1);
    expect(g.overflow, label + ' document overflow').toBeLessThanOrEqual(1);
    const nav = page.locator(outerNav(root));
    const selected = nav.locator(':scope > .sb-shell-tab[aria-selected="true"]');
    await expect(selected, label + ' one selected route').toHaveCount(1);
    await expect(selected).toHaveAttribute('data-sb-tab', tab);
    const selectedBox = await selected.boundingBox();
    expect(selectedBox.y, label + ' selected tab top containment').toBeGreaterThanOrEqual(g.wrapper.box.top - 1);
    expect(selectedBox.y + selectedBox.height, label + ' selected tab bottom containment').toBeLessThanOrEqual(g.wrapper.box.bottom + 1);
    await expect(selected, label + ' controlled panel').toHaveAttribute('aria-controls', /\S+/);
    const panelId = await selected.getAttribute('aria-controls');
    await expect(page.locator(`[id="${panelId}"]`), label + ' visible selected panel').toBeVisible();
    for (const button of await nav.locator(':scope > .sb-shell-tab:visible').all()) {
        const box = await button.boundingBox();
        expect(box.height, label + ' outer target height').toBeGreaterThanOrEqual(44);
        expect(box.x, label + ' tab left containment').toBeGreaterThanOrEqual(g.wrapper.box.left - 1);
        expect(box.x + box.width, label + ' tab right containment').toBeLessThanOrEqual(g.wrapper.box.right + 1);
    }
}

async function familyGlyphEdges(page, label) {
    const geometry = await page.locator('#right-nav-panel > .sb-character-shell-header').evaluate(header => {
        const style = getComputedStyle(header), box = header.getBoundingClientRect();
        const parts = ['.sb-shell-title', '.sb-shell-subtitle'].map(selector => {
            const element = header.querySelector(selector);
            const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT);
            const rects = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent.trim()) continue;
                const range = document.createRange();
                range.setStart(node, node.textContent.search(/\S/));
                range.setEnd(node, node.textContent.trimEnd().length);
                rects.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.toJSON()));
            }
            const elementBox = element.getBoundingClientRect(), elementStyle = getComputedStyle(element);
            return { text: element.textContent.trim(), visible: elementBox.width > 0 && elementBox.height > 0
                && elementStyle.display !== 'none' && elementStyle.visibility === 'visible', rects };
        });
        return { left: box.left, padding: style.padding, align: style.alignItems, gap: style.gap, parts };
    });
    for (const [index, part] of geometry.parts.entries()) {
        expect(part.visible, `${label}/${index} displayed text`).toBe(true);
        expect(part.text.length, `${label}/${index} nonempty text`).toBeGreaterThan(0);
        expect(part.rects.length, `${label}/${index} nonempty glyph bounds`).toBeGreaterThan(0);
        const glyphLeft = Math.min(...part.rects.map(rect => rect.left));
        expect(Math.abs(glyphLeft - (geometry.left + 18)), `${label}/${index} glyph left content edge`).toBeLessThanOrEqual(1);
    }
    expect(geometry.padding, label + ' caption padding').toBe('16px 116px 16px 18px');
    expect(geometry.align, label + ' stretched caption content').toBe('stretch');
    expect(geometry.gap, label + ' caption gap').toBe('2px');
}

const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

// Sample the actual composited paint after hiding only the glyphs. This includes
// gradients, backdrop layers and subtitle opacity, rather than assuming a token fill.
async function visibleContrast(page, selector) {
    const node = typeof selector === 'string' ? page.locator(selector) : selector;
    await expect(node).toBeVisible();
    const info = await node.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = getComputedStyle(element).color;
        context.fillRect(0, 0, 1, 1);
        const rgba = [...context.getImageData(0, 0, 1, 1).data];
        let opacity = rgba[3] / 255;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
        const box = element.getBoundingClientRect();
        return { foreground: rgba.slice(0, 3), opacity, style: element.getAttribute('style'),
            points: [0.1, 0.5, 0.9].map(position => ({ x: Math.floor(box.left + box.width * position), y: Math.floor(box.top + box.height / 2) })) };
    });
    const saved = await node.evaluateHandle(element => {
        const entries = [element, ...element.querySelectorAll('*')].map(child => [child, child.getAttribute('style'), getComputedStyle(child).color]);
        for (const [child] of entries) { child.style.setProperty('color', 'transparent', 'important'); child.style.setProperty('text-shadow', 'none', 'important'); }
        return entries;
    });
    try {
        const png = PNG.sync.read(await page.screenshot({ animations: 'disabled', scale: 'css' }));
        return info.points.map(point => {
            const index = (point.y * png.width + point.x) * 4;
            const background = [...png.data.subarray(index, index + 3)];
            const foreground = info.foreground.map((value, channel) => value * info.opacity + background[channel] * (1 - info.opacity));
            return contrast(foreground, background);
        });
    } finally {
        try {
            await saved.evaluate(entries => { for (const [child, style] of entries) style === null ? child.removeAttribute('style') : child.setAttribute('style', style); });
            await expect.poll(() => saved.evaluate(entries => entries.every(([child, , color]) => getComputedStyle(child).color === color)),
                { message: 'Sampled glyph colours return to their original computed values' }).toBe(true);
        } finally {
            await saved.dispose();
        }
    }
}

async function readable(page, selector, label) {
    for (const ratio of await visibleContrast(page, selector)) expect(ratio, label).toBeGreaterThanOrEqual(4.5);
}

async function genericCaptionReadable(page, root, context) {
    await readable(page, root + ' .sb-shell-header .sb-shell-title', context + '/title');
    let displayedHelp = 0;
    for (const role of ['sb-shell-subtitle', 'sb-shell-description', 'neconyan-tool-page-description']) {
        const nodes = await page.locator(root + ' .sb-shell-header .' + role).all();
        for (const [index, node] of nodes.entries()) {
            if (!await node.isVisible()) continue;
            displayedHelp += 1;
            await readable(page, node, `${context}/${role}/${index}`);
        }
    }
    expect(displayedHelp, context + '/displayed generic help').toBeGreaterThan(0);
}

chromiumTest('red-proof character-family order', async ({ app }) => {
    const { page } = await setup(app);
    await applyStyle(page, 'windows-xp');
    railAboveCaption(await measure(page, await open(page, 'characters', 'creator')), 'Catelier');
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('Settings sidebar preserves original desktop geometry', async ({ app }) => {
    const { page } = await setup(app);
    await applyStyle(page, 'windows-98');
    await settingsSidebar(page, await open(page, 'right', 'settings'), 'settings', 'Settings');
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('red-proof XP and 98 caption contrast', async ({ app }) => {
    const { page } = await setup(app);
    for (const id of ['windows-xp', 'windows-98']) {
        await applyStyle(page, id);
        const root = await open(page, 'right', 'settings');
        await readable(page, root + ' .sb-shell-header .sb-shell-title', id + ' caption');
    }
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('red-proof 98 active category contrast', async ({ app }) => {
    const { page } = await setup(app);
    await applyStyle(page, 'windows-98');
    const root = await open(page, 'right', 'settings');
    await readable(page, root + ' .sb-settings-nav-column .sb-settings-tab-btn.active', '98 selected category');
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('Windows desktop routes keep full page rails, exclusions and clickable tabs', async ({ app }) => {
    chromiumTest.setTimeout(420000);
    const { page, account } = await setup(app);
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        if (!await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false })) throw new Error('Fixture character selection failed');
    }, account.avatar);
    for (const id of windows) {
        await applyStyle(page, id);
        for (const collapsed of [false, true]) {
            const closed = await page.locator('html').getAttribute('data-neconyan-sidebar') === 'closed';
            if (closed !== collapsed) await page.locator('#neconyan-sidebar-toggle').click();
            for (const [side, tabs] of [
                ['characters', ['characters', 'groups', 'persona', 'creator', 'import', 'editor', 'world-info']],
                ['left', ['api', 'presets', 'sampling', 'advanced-formatting', 'mewmory', 'agents']],
                ['right', ['settings', 'extensions', 'background', 'server', 'console-logs', 'included-tool']],
            ]) {
                for (const tab of tabs) {
                    const root = await open(page, side, tab);
                    const g = await measure(page, root);
                    if (['world-info', 'agents', 'included-tool'].includes(tab)) expect(displayed(g.wrapper), `${id}/${tab} intentionally hidden rail`).toBe(false);
                    else if (side === 'right') await settingsSidebar(page, root, tab, `${id}/${tab}/${collapsed}`);
                    else railAboveCaption(g, `${id}/${tab}/${collapsed}`);
                    if (side === 'characters') await familyGlyphEdges(page, `${id}/${tab}/${collapsed}`);
                    if (displayed(g.wrapper)) {
                        const buttons = page.locator(outerNav(root) + ' > .sb-shell-tab:visible');
                        for (const button of await buttons.all()) {
                            const box = await button.boundingBox();
                            expect(box.height).toBeGreaterThanOrEqual(44);
                            expect(box.x).toBeGreaterThanOrEqual(g.wrapper.box.left);
                            expect(box.x + box.width).toBeLessThanOrEqual(g.wrapper.box.right + 1);
                        }
                    }
                }
            }
        }
        const root = await open(page, 'right', 'settings');
        const settings = page.locator(outerNav(root) + ' > [data-sb-tab="settings"]');
        const extensions = page.locator(outerNav(root) + ' > [data-sb-tab="extensions"]');
        await settings.focus();
        await page.keyboard.press('ArrowDown');
        await expect(extensions).toBeFocused();
        await settingsSidebar(page, root, 'extensions', `${id}/Down to Extensions`);
        await page.keyboard.press('ArrowUp');
        await expect(settings).toBeFocused();
        await settingsSidebar(page, root, 'settings', `${id}/Up to Settings`);
        await page.locator(outerNav(root) + ' > [data-sb-tab="background"]').click();
        await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', 'background');
        await settingsSidebar(page, root, 'background', `${id}/visible Background route`);
        await page.locator(outerNav(root) + ' > [data-sb-tab="background"]').focus();
        await page.keyboard.press('Home');
        await expect(settings).toBeFocused();
        await settingsSidebar(page, root, 'settings', `${id}/Home to Settings`);
    }
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('mounted Settings keeps native vertical navigation across style and width', async ({ app }) => {
    // Fifteen stylesheet changes share this test; individual assertions retain their normal deadline.
    chromiumTest.setTimeout(180000);
    const { page } = await setup(app, { vertical: true });
    const root = await open(page, 'right', 'settings');
    const nav = page.locator(outerNav(root));
    for (const width of [1280, 393, 1280]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        for (const id of ['windows-xp', 'calico', 'windows-98', 'windows-aero', 'calico']) {
            await applyStyle(page, id);
            await expect(nav).toHaveAttribute('aria-orientation', 'vertical');
            if (width > 768) await settingsSidebar(page, root, 'settings', id);
            else await expect(nav).toHaveCSS('flex-direction', 'row');
        }
    }
    await applyStyle(page, 'windows-xp');
    const settings = nav.locator('[data-sb-tab="settings"]');
    const extensions = nav.locator('[data-sb-tab="extensions"]');
    await settings.focus();
    for (const key of ['ArrowLeft', 'ArrowRight']) {
        await page.keyboard.press(key);
        await expect(settings).toBeFocused();
        await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', 'settings');
    }
    await page.keyboard.press('ArrowDown');
    await expect(extensions).toBeFocused();
    await settingsSidebar(page, root, 'extensions', 'native Down');
    await page.keyboard.press('ArrowUp');
    await expect(settings).toBeFocused();
    await settingsSidebar(page, root, 'settings', 'native Up');
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('mounted Windows Settings stays vertical through bodyclass-only Terminal transitions', async ({ app }) => {
    const { page } = await setup(app);
    const root = await open(page, 'right', 'settings');
    const nav = page.locator(outerNav(root));
    for (const id of windows) {
        await applyStyle(page, id);
        await expect(nav).toHaveAttribute('aria-orientation', 'vertical');
        await expect(nav).toHaveCSS('flex-direction', 'column');
        try {
            await page.evaluate(() => document.body.classList.add('sbterm'));
            await expect(nav).toHaveAttribute('aria-orientation', 'vertical');
            await expect(nav).toHaveCSS('flex-direction', 'column');
        } finally {
            await page.evaluate(() => document.body.classList.remove('sbterm'));
        }
        await expect(nav).toHaveAttribute('aria-orientation', 'vertical');
        await expect(nav).toHaveCSS('flex-direction', 'column');
        expect(await page.evaluate(() => window.innerWidth)).toBe(1280);
    }
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('pinned family captions and a narrow-panel Settings sidebar preserve their actual panels', async ({ app }) => {
    chromiumTest.setTimeout(180000);
    const { page, account } = await setup(app);
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    for (const id of windows) {
        await applyStyle(page, id);
        await page.setViewportSize({ width: 900, height: 900 });
        for (const tab of ['characters', 'persona', 'editor']) {
            const root = await open(page, 'characters', tab);
            await page.locator(root + ' #sb_character_dock_toggle').click();
            await expect(page.locator(root)).toHaveClass(/pinnedOpen/);
            await stable(page, root);
            railAboveCaption(await measure(page, root), `${id}/${tab}/pinned`);
            const panel = await page.locator(root).boundingBox(), chat = await page.locator('#sheld').boundingBox();
            expect(chat.x + chat.width).toBeLessThanOrEqual(panel.x + 1);
            if (tab === 'editor') {
                const tabs = page.locator(root + ' .sb-character-editor-subtab:visible');
                await expect(tabs).toHaveCount(4);
                const boxes = await tabs.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
                expect(Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top))).toBeLessThanOrEqual(1);
                await expect(page.locator(root + ' .sb-shell-subtitle')).toBeHidden();
            }
            await page.locator(root + ' #sb_character_dock_toggle').click();
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        const root = await open(page, 'right', 'settings');
        const original = await page.locator(root).getAttribute('style');
        try {
            // Test-owned outer boundary only. Neconyan has no enabled Settings
            // resize handle; this is panel-size stress, not control verification.
            await page.locator(root).evaluate(node => {
                for (const [key, value] of [['left', 'auto'], ['width', '440px'], ['max-width', '440px']]) node.style.setProperty(key, value, 'important');
            });
            await stable(page, root);
            const narrow = await measure(page, root);
            expect(narrow.root.box.width).toBeLessThanOrEqual(441);
            expect(await page.evaluate(() => window.innerWidth)).toBe(1280);
            await settingsSidebar(page, root, 'settings', `${id}/narrow Settings stress`);
            const last = page.locator(outerNav(root) + ' > .sb-shell-tab:visible').last();
            const lastId = await last.getAttribute('data-sb-tab');
            await last.click();
            await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', lastId);
            await page.evaluate(() => { document.documentElement.dataset.sbDesktopNavMode = 'icon-only'; });
            const iconBox = await page.locator(outerNav(root) + ' > .sb-shell-tab:visible').first().boundingBox();
            expect(iconBox.width).toBeGreaterThanOrEqual(44);
            await expect(page.locator(outerNav(root) + ' .sb-shell-tab-copy').first()).toBeHidden();
            await page.evaluate(() => { document.documentElement.dataset.sbDesktopNavMode = 'labeled'; });
            await expect(page.locator(outerNav(root) + ' .sb-shell-tab-copy').first()).toBeVisible();
        } finally {
            await page.locator(root).evaluate((node, value) => value === null ? node.removeAttribute('style') : node.setAttribute('style', value), original);
        }
    }
    expect(app.provider.calls).toHaveLength(0);
});

for (const [browserTest, browser] of [[chromiumTest, 'Chromium'], [webkitTest, 'WebKit']]) {
    for (const phone of [false, true]) browserTest(`${browser} Windows representative pages ${phone ? 'phone, inferred iOS' : 'desktop'}`, async ({ app }, info) => {
        browserTest.setTimeout(240000);
        const { page } = await setup(app, { phone, ios: phone });
        for (const id of windows) {
            await applyStyle(page, id);
            const routes = browser === 'Chromium'
                ? [['characters', 'characters'], ['characters', 'creator'], ['characters', 'persona'], ['left', 'api'], ['right', 'settings']]
                : [['characters', 'persona'], ['left', 'api'], ['right', 'settings']];
            for (const [side, tab] of routes) {
                const root = await open(page, side, tab, { ios: phone });
                const g = await measure(page, root);
                if (!phone) {
                    if (side === 'right') {
                        for (const route of ['settings', 'extensions', 'background', 'server', 'console-logs']) {
                            await page.locator(outerNav(root) + ` > [data-sb-tab="${route}"]`).click();
                            await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', route);
                            await stable(page, root);
                            await settingsSidebar(page, root, route, `${browser}/${id}/${route}`);
                        }
                        await page.locator(outerNav(root) + ' > [data-sb-tab="settings"]').click();
                        await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', 'settings');
                        await stable(page, root);
                        await settingsSidebar(page, root, 'settings', `${browser}/${id}/ordinary Settings`);
                    } else railAboveCaption(g, `${browser}/${id}/${tab}`);
                }
                else {
                    expect(g.nav.flexDirection).toBe('row');
                    const rows = g.tabs.filter(displayed);
                    expect(rows.length).toBeGreaterThan(0);
                    expect(Math.max(...rows.map(row => row.box.top)) - Math.min(...rows.map(row => row.box.top))).toBeLessThanOrEqual(1);
                    const nav = page.locator(outerNav(root));
                    await nav.evaluate(node => { node.scrollLeft = node.scrollWidth; });
                    expect(await nav.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
                    const close = page.locator(root + ' .sb-shell-close');
                    const box = await close.boundingBox();
                    expect(box.width).toBeGreaterThanOrEqual(44);
                    expect(box.height).toBeGreaterThanOrEqual(44);
                    expect(await close.evaluate(node => { const b = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })).toBe(true);
                }
                expect(g.overflow).toBeLessThanOrEqual(1);
                if (browser === 'Chromium') {
                    const directory = path.resolve('screenshots/xp-secondary-rail/after-r5-sidebar');
                    await fs.mkdir(directory, { recursive: true });
                    await page.screenshot({ path: path.join(directory, `${id}-${tab}-${phone ? 'phone' : 'desktop'}.png`), animations: 'disabled', scale: 'css' });
                }
            }
        }
        await fs.writeFile(info.outputPath('browser-label.json'), JSON.stringify({ browser, phone, inferredIOS: phone }));
        expect(app.provider.calls).toHaveLength(0);
    });
}

for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) for (const accent of [null, 'Mint Glass', 'Plum Wine']) for (const id of windows) chromiumTest(`Windows desktop displayed captions and category states keep paired paint and ink: ${theme}/${accent || 'default'}/${id}`, async ({ app }) => {
    chromiumTest.setTimeout(180000);
    const { page } = await setup(app);
    await page.evaluate(name => window.jQuery('#themes').val(name).trigger('change'), theme);
    if (accent) await page.evaluate(name => {
        const button = [...document.querySelectorAll('.sb-accent-profile-apply')].find(node => node.textContent.trim() === name);
        if (!button) throw new Error('Missing accent profile ' + name);
        button.click();
    }, accent);
    await chromiumTest.step(id, async () => {
        await applyStyle(page, id);
        const context = `${theme}/${accent || 'theme default'}/${id}`;
        const root = await open(page, 'right', 'settings');
        await genericCaptionReadable(page, root, context + '/settings');
        const category = page.locator(root + ' .sb-settings-nav-column .sb-settings-tab-btn.active');
        for (const state of ['rest', 'hover', 'focus']) {
            if (state === 'hover') await category.hover();
            if (state === 'focus') { await page.mouse.move(0, 0); await category.focus(); }
            expect(await category.locator('i').evaluate(node => getComputedStyle(node).color), `${context}/settings/selected category/${state}/original icon ink`).toBe(await category.evaluate(node => getComputedStyle(node).color));
            await readable(page, root + ' .sb-settings-nav-column .sb-settings-tab-btn.active', `${context}/settings/selected category/${state}`);
            expect(await category.locator('i').evaluate(node => getComputedStyle(node).color), `${context}/settings/selected category/${state}/icon ink`).toBe(await category.evaluate(node => getComputedStyle(node).color));
        }
        for (const tab of ['characters', 'persona', 'creator']) {
            const family = await open(page, 'characters', tab);
            await readable(page, family + ' > .sb-character-shell-header .sb-shell-title', `${context}/${tab}/title`);
            await readable(page, family + ' > .sb-character-shell-header .sb-shell-subtitle', `${context}/${tab}/help`);
        }
        await genericCaptionReadable(page, await open(page, 'left', 'api'), context + '/api');
    });
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('Windows XP Olive Green desktop captions keep paired paint and ink', async ({ app }) => {
    chromiumTest.setTimeout(120000);
    const { page } = await setup(app);
    await page.evaluate(() => window.jQuery('#themes').val('Windows XP Olive Green').trigger('change'));
    await expect(page.locator('html')).toHaveAttribute('data-neconyan-ui-theme', 'windows-xp-olive-green');
    await applyStyle(page, 'windows-xp');
    for (const tab of ['characters', 'persona', 'creator']) {
        const root = await open(page, 'characters', tab);
        const context = `Windows XP Olive Green/theme default/windows-xp/${tab}`;
        await readable(page, root + ' > .sb-character-shell-header .sb-shell-title', context + '/title');
        await readable(page, root + ' > .sb-character-shell-header .sb-shell-subtitle', context + '/help');
    }
    for (const [side, tab] of [['left', 'api'], ['right', 'settings']]) {
        await genericCaptionReadable(page, await open(page, side, tab), `Windows XP Olive Green/theme default/windows-xp/${tab}/desktop`);
    }
    expect(app.provider.calls).toHaveLength(0);
});

for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) for (const accent of [null, 'Mint Glass', 'Plum Wine']) chromiumTest(`Windows phone displayed captions keep paired paint and ink, inferred iOS: ${theme}/${accent || 'default'}`, async ({ app }) => {
    chromiumTest.setTimeout(180000);
    const { page: phonePage } = await setup(app, { phone: true, ios: true });
    await phonePage.evaluate(name => window.jQuery('#themes').val(name).trigger('change'), theme);
    if (accent) await phonePage.evaluate(name => {
        const button = [...document.querySelectorAll('.sb-accent-profile-apply')].find(node => node.textContent.trim() === name);
        if (!button) throw new Error('Missing accent profile ' + name);
        button.click();
    }, accent);
    for (const id of windows) {
        await applyStyle(phonePage, id);
        for (const [side, tab] of [['left', 'api'], ['right', 'settings']]) {
            const root = await open(phonePage, side, tab, { ios: true });
            await genericCaptionReadable(phonePage, root, `${theme}/${accent || 'theme default'}/${id}/${tab}/phone inferred iOS`);
        }
    }
    expect(app.provider.calls).toHaveLength(0);
});

chromiumTest('Windows XP Olive Green phone displayed captions keep paired paint and ink, inferred iOS', async ({ app }) => {
    chromiumTest.setTimeout(120000);
    const { page: phonePage } = await setup(app, { phone: true, ios: true });
    await phonePage.evaluate(() => window.jQuery('#themes').val('Windows XP Olive Green').trigger('change'));
    await expect(phonePage.locator('html')).toHaveAttribute('data-neconyan-ui-theme', 'windows-xp-olive-green');
    await applyStyle(phonePage, 'windows-xp');
    for (const [side, tab] of [['left', 'api'], ['right', 'settings']]) {
        const root = await open(phonePage, side, tab, { ios: true });
        await genericCaptionReadable(phonePage, root, `Windows XP Olive Green/theme default/windows-xp/${tab}/phone inferred iOS`);
    }
    expect(app.provider.calls).toHaveLength(0);
});

for (const phone of [false, true]) chromiumTest(`other styles retain d7 computed page contracts ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
    chromiumTest.setTimeout(360000);
    const { page } = await setup(app, { phone, ios: phone });
    const records = [];
    // The parent supplies the retained Before directory for independent comparison;
    // ordinary CI also emits the complete manifest without requiring local files.
    const before = process.env.NECONYAN_WINDOWS_PAGES_BEFORE
        ? JSON.parse(await fs.readFile(path.join(process.env.NECONYAN_WINDOWS_PAGES_BEFORE, `baseline-d7-${phone ? 'phone' : 'desktop'}.json`), 'utf8')) : null;
    const comparable = value => JSON.parse(JSON.stringify(value), (key, item) => key === 'text' ? undefined : item);
    for (const style of styles.filter(id => !windows.includes(id))) {
        await applyStyle(page, style);
        for (const [side, tab] of referenceRoutes) {
            const record = { style, side, tab, phone, ...await measure(page, await open(page, side, tab, { ios: phone })) };
            records.push(record);
            if (before) {
                const baseline = before.find(row => row.style === style && row.side === side && row.tab === tab && row.phone === phone);
                expect(baseline, `${style}/${tab} retained d7 record`).toBeDefined();
                expect(comparable(record), `${style}/${tab} unchanged geometry, paint and semantics`).toEqual(comparable(baseline));
            }
        }
    }
    expect(records).toHaveLength(36);
    await fs.writeFile(info.outputPath(`candidate-${phone ? 'phone' : 'desktop'}.json`), JSON.stringify(records, null, 2));
    expect(app.provider.calls).toHaveLength(0);
});

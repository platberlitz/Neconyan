/* global document, getComputedStyle, window */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { test } from './neconyan-conversation-durable-fixture.js';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const catalogue = source.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
const styles = [...catalogue.matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);

async function applyStyle(page, style) {
    await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
    await page.waitForFunction(id => document.documentElement.dataset.sbTheme === id
        && (id === 'calico' || Boolean(document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet)), style);
}

async function surfaceGeometry(page) {
    return page.evaluate(() => {
        const root = document.querySelector('#right-nav-panel');
        const inner = root.querySelector(':scope > .scrollableInner');
        const box = inner.getBoundingClientRect();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(root).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return { alpha: context.getImageData(0, 0, 1, 1).data[3], height: box.height,
            overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
}

async function expectXPCaption(page) {
    const caption = await page.locator('#right-nav-panel > .sb-character-shell-header').evaluate(header => {
        const title = header.querySelector('.sb-shell-title');
        const subtitle = header.querySelector('.sb-shell-subtitle');
        const pin = header.querySelector('#sb_character_dock_toggle');
        const probe = document.createElement('span');
        probe.style.color = 'var(--xp-caption-ink)';
        header.append(probe);
        const result = { image: getComputedStyle(header).backgroundImage,
            ink: getComputedStyle(probe).color, title: getComputedStyle(title).color,
            subtitle: getComputedStyle(subtitle).color, pin: getComputedStyle(pin).color,
            pinIcon: getComputedStyle(pin.querySelector('i')).color };
        probe.remove();
        return result;
    });
    expect(caption.image).toContain('gradient');
    expect(caption.title).toBe(caption.ink);
    expect(caption.subtitle).toBe(caption.ink);
    expect(caption.pinIcon).toBe(caption.pin);
}

async function expectDesktopChrome(page, tab) {
    await expect(page.locator('#right-nav-panel > .sb-character-shell-header > .sb-shell-title')).toBeVisible();
    await expect(page.locator('#right-nav-panel > .sb-character-shell-header > .sb-shell-subtitle')).toBeVisible();
    const geometry = await page.locator('#right-nav-panel').evaluate(root => {
        const header = root.querySelector(':scope > .sb-character-shell-header');
        const nav = root.querySelector(':scope > .sb-character-shell-nav-wrapper');
        const title = header.querySelector('.sb-shell-title');
        const subtitle = header.querySelector('.sb-shell-subtitle');
        const pin = header.querySelector('#sb_character_dock_toggle');
        const close = header.querySelector('.sb-shell-close');
        const measure = node => ({ box: node.getBoundingClientRect().toJSON(), display: getComputedStyle(node).display,
            visibility: getComputedStyle(node).visibility });
        const hit = node => {
            const box = node.getBoundingClientRect();
            const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return target === node || node.contains(target);
        };
        return { root: measure(root), header: measure(header), nav: measure(nav), title: measure(title), subtitle: measure(subtitle),
            pin: measure(pin), close: measure(close), margin: getComputedStyle(header).margin,
            titleFont: getComputedStyle(title).fontSize, titleLine: getComputedStyle(title).lineHeight,
            titleWeight: getComputedStyle(title).fontWeight, subtitleFont: getComputedStyle(subtitle).fontSize, subtitleLine: getComputedStyle(subtitle).lineHeight,
            subtitleWeight: getComputedStyle(subtitle).fontWeight, pinHit: hit(pin), closeHit: hit(close),
            navFirst: Boolean(nav.compareDocumentPosition(header) & window.Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(geometry.header.box.width).toBeGreaterThan(100);
    expect(geometry.header.box.height).toBeGreaterThan(44);
    expect(geometry.margin).toBe('0px');
    expect(Math.abs(geometry.header.box.left - geometry.root.box.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.root.box.right - geometry.header.box.right)).toBeLessThanOrEqual(1);
    for (const content of [geometry.title, geometry.subtitle]) {
        expect(content.display).not.toBe('none');
        expect(content.visibility).toBe('visible');
        expect(content.box.width).toBeGreaterThan(0);
        expect(content.box.height).toBeGreaterThan(0);
    }
    expect(geometry.titleFont).toBe('16.8px');
    expect(geometry.titleLine).toBe('19.32px');
    expect(geometry.titleWeight).toBe('600');
    expect(geometry.subtitleFont).toBe('12px');
    expect(geometry.subtitleLine).toBe('18px');
    expect(geometry.subtitleWeight).toBe('400');
    expect(geometry.title.box.right).toBeLessThanOrEqual(geometry.pin.box.left);
    expect(geometry.subtitle.box.right).toBeLessThanOrEqual(geometry.pin.box.left);
    for (const control of [geometry.pin, geometry.close]) {
        expect(control.box.width).toBe(44);
        expect(control.box.height).toBe(44);
        expect(control.box.top - geometry.header.box.top).toBe(4);
    }
    expect(geometry.pinHit).toBe(true);
    expect(geometry.closeHit).toBe(true);
    if (tab === 'characters') {
        expect(geometry.navFirst).toBe(true);
        expect(Math.abs(geometry.nav.box.bottom - geometry.header.box.top)).toBeLessThanOrEqual(1);
    } else {
        expect(geometry.nav.display).toBe('none');
        expect(Math.abs(geometry.header.box.top - geometry.root.box.top)).toBeLessThanOrEqual(1);
    }
}

async function expectPaintCoversUnderlay(page) {
    const root = page.locator('#right-nav-panel');
    const scratch = page.locator('#neconyan-scratchpad');
    const originalRootStyle = await root.getAttribute('style');
    const originalScratchStyle = await scratch.getAttribute('style');
    const saved = await page.evaluateHandle(() => {
        const styles = new Map();
        for (const node of document.querySelectorAll('#right-nav-panel *, #neconyan-scratchpad *')) {
            styles.set(node, node.getAttribute('style'));
            node.style.setProperty('visibility', 'hidden', 'important');
        }
        return styles;
    });
    try {
        const box = await root.boundingBox();
        const scratchBox = await scratch.boundingBox();
        const point = { x: Math.floor(Math.max(box.x, scratchBox.x) + 40), y: Math.floor(Math.max(box.y, scratchBox.y) + 100), width: 1, height: 1 };
        for (const bounds of [box, scratchBox]) {
            expect(point.x).toBeGreaterThan(bounds.x);
            expect(point.x).toBeLessThan(bounds.x + bounds.width);
            expect(point.y).toBeGreaterThan(bounds.y);
            expect(point.y).toBeLessThan(bounds.y + bounds.height);
        }
        const sample = async colour => {
            await scratch.evaluate((node, value) => { node.style.setProperty('background', value, 'important'); }, colour);
            const png = PNG.sync.read(await page.screenshot({ clip: point, animations: 'disabled', scale: 'css' }));
            return [...png.data.subarray(0, 3)];
        };
        const first = await sample('rgb(255, 0, 255)');
        const second = await sample('rgb(0, 255, 0)');
        expect(first, 'The real panel surface must cover changes behind it').toEqual(second);
        await root.evaluate(node => node.style.setProperty('background', 'transparent', 'important'));
        const exposedFirst = await sample('rgb(255, 0, 255)');
        const exposedSecond = await sample('rgb(0, 255, 0)');
        expect(exposedFirst, 'The underlay must be visible when the panel is transparent').not.toEqual(exposedSecond);
    } finally {
        await root.evaluate((node, value) => value === null ? node.removeAttribute('style') : node.setAttribute('style', value), originalRootStyle);
        await scratch.evaluate((node, value) => value === null ? node.removeAttribute('style') : node.setAttribute('style', value), originalScratchStyle);
        await saved.evaluate(styles => {
            for (const [node, value] of styles) value === null ? node.removeAttribute('style') : node.setAttribute('style', value);
        });
        await saved.dispose();
    }
}

for (const phone of [false, true]) {
    test(`Characters and Lorebooks keep an opaque surface in every shell (${phone ? 'phone' : 'desktop'})`, async ({ app }) => {
        test.setTimeout(360000);
        const account = await app.account({ phone, configureSettings(saved) {
            saved.firstRun = false;
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        } });
        const longName = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
            ch_name: 'A character with a long name for the library layout', description: 'A long description for a visible character card.', first_mes: 'Hello.',
        } });
        expect(longName.ok()).toBe(true);
        await fs.writeFile(path.join(app.dataRoot, 'default-user', 'worlds', 'Surface Test.json'), JSON.stringify({ entries: {
            0: { uid: 0, key: ['surface'], keysecondary: [], content: 'A fixture entry.', comment: 'Surface fixture', constant: true,
                selective: true, order: 100, position: 0, disable: false, probability: 100, useProbability: true },
        } }));
        const page = await account.open({ workspace: false });
        await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
        for (const style of styles) {
            await applyStyle(page, style);
            for (const tab of ['characters', 'world-info']) {
                const checkUnderlay = !phone && ['windows-xp', 'windows-aero', 'macos-minimal', 'hypr-glow'].includes(style);
                if (checkUnderlay) await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad());
                await page.evaluate(id => window.NeconyanShell.openTab('characters', id), tab);
                const panel = page.locator('#right-nav-panel');
                await expect(panel).toHaveAttribute('data-menu-type', tab);
                await expect(panel).toBeVisible();
                if (tab === 'world-info') await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.includes('world-info.css')));
                await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
                await page.evaluate(() => window.toastr?.remove());
                const geometry = await surfaceGeometry(page);
                expect(geometry.alpha, `${style} ${tab} panel background`).toBe(255);
                expect(geometry.height, `${style} ${tab} has usable scrolling space`).toBeGreaterThan(100);
                expect(geometry.overflow, `${style} ${tab} document overflow`).toBeLessThanOrEqual(1);
                const close = panel.locator('#sb_character_shell_close');
                await expect(close).toBeVisible();
                await expect(close).toHaveAccessibleName(/close/i);
                if (!phone) await expectDesktopChrome(page, tab);
                if (!phone && style === 'windows-xp') await expectXPCaption(page);
                if (checkUnderlay) await expectPaintCoversUnderlay(page);
            }
        }
        expect(app.provider.calls).toHaveLength(0);
    });
}

test('desktop library captions fit expanded, collapsed and pinned panels', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ configureSettings(saved) {
        saved.firstRun = false;
        saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
    } });
    const page = await account.open({ workspace: false });
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        if (!await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false })) {
            throw new Error('Fixture character selection failed');
        }
    }, account.avatar);
    await applyStyle(page, 'windows-xp');
    for (const tab of ['characters', 'world-info']) {
        for (const state of ['expanded', 'collapsed', 'pinned']) {
            await page.setViewportSize({ width: state === 'pinned' ? 900 : 1280, height: 900 });
            const closed = await page.locator('html').getAttribute('data-neconyan-sidebar') === 'closed';
            if ((state === 'collapsed') !== closed) await page.locator('#neconyan-sidebar-toggle').click();
            await page.evaluate(id => window.NeconyanShell.openTab('characters', id), tab);
            const panel = page.locator('#right-nav-panel');
            await expect(panel).toHaveAttribute('data-menu-type', tab);
            if (tab === 'world-info') await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.includes('world-info.css')));
            if (state === 'pinned') {
                await panel.locator('#sb_character_dock_toggle').click();
                await expect(panel).toHaveClass(/pinnedOpen/);
            }
            await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
            await page.evaluate(() => window.toastr?.remove());
            await expectDesktopChrome(page, tab);
            if (state === 'pinned') {
                const chat = page.locator('#sheld');
                await expect(chat).toBeVisible();
                const chatBox = await chat.boundingBox();
                const panelBox = await panel.boundingBox();
                expect(chatBox.width).toBeGreaterThan(0);
                expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(panelBox.x + 1);
                await panel.locator('#sb_character_dock_toggle').click();
                await expect(panel).not.toHaveClass(/pinnedOpen/);
            }
        }
    }
    expect(app.provider.calls).toHaveLength(0);
});

test('XP caption subtitles stay readable with Mint and fixed Olive accents', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ configureSettings(saved) {
        saved.firstRun = false;
        saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
    } });
    const page = await account.open({ workspace: false });
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (first, second) => (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);
    const measure = async () => {
        const info = await page.locator('#right-nav-panel > .sb-character-shell-header').evaluate(header => {
            const subtitle = header.querySelector('.sb-shell-subtitle');
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d');
            context.fillStyle = getComputedStyle(subtitle).color;
            context.fillRect(0, 0, 1, 1);
            const rgba = [...context.getImageData(0, 0, 1, 1).data];
            let opacity = rgba[3] / 255;
            const filters = [];
            for (let node = subtitle; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                opacity *= Number(style.opacity);
                if (style.filter !== 'none') filters.push(style.filter);
            }
            const h = header.getBoundingClientRect();
            const s = subtitle.getBoundingClientRect();
            return { foreground: rgba.slice(0, 3), opacity, filters, x: Math.floor(h.left + 8), y: Math.floor(s.top + s.height / 2) };
        });
        const png = PNG.sync.read(await page.screenshot({ animations: 'disabled', scale: 'css' }));
        const index = (info.y * png.width + info.x) * 4;
        const background = [...png.data.subarray(index, index + 3)];
        const foreground = info.foreground.map((value, channel) => value * info.opacity + background[channel] * (1 - info.opacity));
        expect(info.filters).toEqual([]);
        return { ...info, background, ratio: contrast(foreground, background) };
    };
    for (const { theme, accent, slug } of [
        { theme: 'Neconyan Calico', accent: 'Mint Glass', slug: 'neconyan-calico' },
        { theme: 'Windows XP Olive Green', accent: 'Plum Wine', slug: 'windows-xp-olive-green' },
    ]) {
        await page.evaluate(name => window.$('#themes').val(name).trigger('change'), theme);
        await page.evaluate(name => {
            const button = [...document.querySelectorAll('.sb-accent-profile-apply')].find(node => node.textContent.trim() === name);
            if (!button) throw new Error(`Missing accent profile ${name}`);
            button.click();
        }, accent);
        await applyStyle(page, 'windows-xp');
        await expect(page.locator('html')).toHaveAttribute('data-neconyan-ui-theme', slug);
        for (const tab of ['characters', 'world-info']) {
            await page.evaluate(id => window.NeconyanShell.openTab('characters', id), tab);
            const panel = page.locator('#right-nav-panel');
            await expect(panel).toHaveAttribute('data-menu-type', tab);
            if (tab === 'world-info') await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.includes('world-info.css')));
            await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
            const header = panel.locator(':scope > .sb-character-shell-header');
            const subtitle = header.locator('.sb-shell-subtitle');
            await expect(subtitle).toBeVisible();
            const actual = await measure();
            expect(actual.opacity).toBe(1);
            expect(actual.ratio, `${theme}/${accent}/${tab} subtitle contrast`).toBeGreaterThanOrEqual(4.5);
            if (slug === 'windows-xp-olive-green') expect(actual.background).toEqual([79, 95, 46]);
            const headerStyle = await header.getAttribute('style');
            const subtitleStyle = await subtitle.getAttribute('style');
            try {
                await header.evaluate(node => node.style.setProperty('background', 'var(--xp-caption)', 'important'));
                await subtitle.evaluate(node => node.style.setProperty('opacity', '0.9', 'important'));
                const previous = await measure();
                expect(previous.ratio, 'The original caption treatment must fail this fixture').toBeLessThan(4.5);
            } finally {
                await header.evaluate((node, value) => value === null ? node.removeAttribute('style') : node.setAttribute('style', value), headerStyle);
                await subtitle.evaluate((node, value) => value === null ? node.removeAttribute('style') : node.setAttribute('style', value), subtitleStyle);
            }
        }
    }
    expect(app.provider.calls).toHaveLength(0);
});

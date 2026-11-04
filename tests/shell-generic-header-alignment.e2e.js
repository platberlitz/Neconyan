/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in fixture helpers and the WebKit test alias. */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const webkitTest = test.extend({ browserName: 'webkit' });

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const catalogue = source.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
const styles = [...catalogue.matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
const sizes = { calico: [40, 40], kittyless: [40, 40], 'windows-xp': [40, 40], 'windows-98': [40, 40],
    'windows-aero': [44, 40], 'clean-minimal': [44, 40], 'macos-minimal': [44, 44], 'cozy-warm': [44, 40],
    'hypr-glow': [44, 40], 'slate-flat': [44, 40], 'starlight-conservatory': [44, 40] };

async function setup(app, options = {}) {
    const { ios = false, ...accountOptions } = options;
    const account = await app.account({ ...accountOptions, configureSettings(saved) {
        saved.firstRun = false;
        saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
    } });
    if (ios) await installIPhoneSafari(account.context, { standalone: false });
    const page = await account.open({ workspace: false });
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    return { page, account };
}
async function style(page, id) {
    await page.evaluate(value => window.NeconyanShell.applyTheme(value), id);
    await page.waitForFunction(value => document.documentElement.dataset.sbTheme === value
        && (value === 'calico' || document.querySelector(`link[data-sb-shell-style="${value}"]`)?.sheet), id);
}
async function open(page, side, tab) {
    if (tab === 'included-tool') await page.evaluate(() => window.NeconyanShell.openIncludedTool('quick-image-gen'));
    else await page.evaluate(([s, t]) => window.NeconyanShell.openTab(s, t), [side, tab]);
    const root = side === 'left' ? '#left-nav-panel' : '#user-settings-block';
    await expect(page.locator(root)).toHaveAttribute('data-sb-active-tab', tab);
    await expect(page.locator(root + '.openDrawer')).toBeVisible();
    if (!['settings', 'extensions'].includes(tab)) await expect(page.locator(root + ' .sb-shell-header .neconyan-page-intro-header')).toBeVisible();
    await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    return root + ' .sb-shell-header';
}
async function geometry(page, selector) {
    return page.locator(selector).evaluate(header => {
        const box = node => node.getBoundingClientRect().toJSON();
        const visible = node => { const b = node.getBoundingClientRect(), s = getComputedStyle(node); return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const nodes = [...header.querySelectorAll(':scope > .sb-shell-title, .neconyan-tool-tour-button, .neconyan-tool-page-description')].filter(visible);
        const parts = nodes.map(node => { const range = document.createRange(); range.selectNodeContents(node); return { className: node.className, text: node.textContent.trim(), box: box(node), lines: [...range.getClientRects()].map(rect => rect.toJSON()) }; });
        const close = header.querySelector('.sb-shell-close'), c = box(close), h = box(header), hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
        const top = Math.min(...parts.map(part => part.box.top)), bottom = Math.max(...parts.map(part => part.box.bottom));
        return { parts, close: c, header: h, paint: [getComputedStyle(header).backgroundImage, getComputedStyle(header).backgroundColor, getComputedStyle(close).backgroundImage, getComputedStyle(close).color], delta: c.y + c.height / 2 - (top + bottom) / 2, hit: hit === close || close.contains(hit), intro: Boolean(header.querySelector('.neconyan-page-intro-header')), overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
}
async function oldRules(page, enabled) {
    await page.evaluate(on => {
        const sheet = [...document.styleSheets].find(item => item.href?.includes('/css/neconyan.css?'));
        const rules = [...sheet.cssRules];
        const parent = rules.find(rule => rule.selectorText === 'body.neconyan :is(.sb-shell-header, #right-nav-panel.openDrawer > .sb-character-shell-header)');
        const nested = [...(parent.cssRules || [])].find(rule => rule.selectorText === '&:has(.neconyan-page-intro-header)');
        const intro = rules.find(rule => rule.selectorText === 'body.neconyan .sb-shell-header:has(.neconyan-page-intro-header)');
        if (on) {
            window.headerRuleSnapshot = { padding: nested?.style.paddingRight, top: intro.style.getPropertyValue('--neco-shell-close-top') };
            if (nested) nested.style.paddingRight = '';
            intro.style.setProperty('--neco-shell-close-top', '26px');
        } else {
            if (nested) nested.style.paddingRight = window.headerRuleSnapshot.padding;
            if (window.headerRuleSnapshot.top) intro.style.setProperty('--neco-shell-close-top', window.headerRuleSnapshot.top);
            else intro.style.removeProperty('--neco-shell-close-top');
        }
    }, enabled);
}

function aligned(g, dimensions, label, tolerance = 1) {
    expect(g.parts, label + ' visible title, Tour and help').toHaveLength(3);
    expect(g.parts.every(part => part.text.length > 0), label).toBe(true);
    expect(Math.abs(g.delta), label + ' visible union centre').toBeLessThanOrEqual(tolerance);
    expect([g.close.width, g.close.height], label + ' control size').toEqual(dimensions);
    expect(g.close.width * g.close.height, label + ' usable target').toBeGreaterThan(0);
    expect(g.hit, label + ' centre hit').toBe(true);
    expect(g.close.top).toBeGreaterThanOrEqual(g.header.top);
    expect(g.close.bottom).toBeLessThanOrEqual(g.header.bottom);
    expect(g.close.left).toBeGreaterThanOrEqual(g.header.left);
    expect(g.close.right).toBeLessThanOrEqual(g.header.right);
    for (const part of g.parts) {
        expect(part.box.right, label + ' content clearance').toBeLessThanOrEqual(g.close.left - 8);
        for (const rect of part.lines) expect(rect.right <= g.close.left || rect.left >= g.close.right || rect.bottom <= g.close.top || rect.top >= g.close.bottom, label + ' text does not intersect close').toBe(true);
    }
    expect(g.overflow).toBeLessThanOrEqual(1);
}

test('generic geometry covers native routes, included tool, styles and ordinary wrapping', async ({ app }) => {
    test.setTimeout(360000);
    const { page } = await setup(app);
    await style(page, 'windows-xp');
    for (const [side, tab] of [['right', 'server'], ['left', 'api'], ['left', 'presets'], ['left', 'sampling'], ['left', 'advanced-formatting'], ['left', 'mewmory'], ['left', 'agents'], ['right', 'background'], ['right', 'console-logs'], ['right', 'included-tool']]) {
        const selector = await open(page, side, tab);
        aligned(await geometry(page, selector), sizes['windows-xp'], tab);
    }
    expect(styles).toHaveLength(11);
    for (const id of styles) {
        await style(page, id);
        const selector = await open(page, 'right', 'server');
        const candidate = await geometry(page, selector);
        aligned(candidate, sizes[id], id);
        await oldRules(page, true);
        const baseline = await geometry(page, selector);
        await oldRules(page, false);
        expect(candidate.paint, id + ' desktop paint').toEqual(baseline.paint);
        expect(candidate.parts.map(part => part.text), id + ' desktop text').toEqual(baseline.parts.map(part => part.text));
    }
    await style(page, 'windows-xp');
    await page.setViewportSize({ width: 900, height: 900 });
    const selector = await open(page, 'right', 'server');
    const narrow = await geometry(page, selector);
    aligned(narrow, sizes['windows-xp'], 'narrow');
    await oldRules(page, true);
    await page.locator(selector).evaluate(header => header.style.setProperty('--neco-shell-close-top', '50%'));
    const centredWithoutGutter = await geometry(page, selector);
    expect(centredWithoutGutter.parts.find(part => part.className.includes('description')).box.right).toBeGreaterThan(centredWithoutGutter.close.left - 8);
    await page.locator(selector).evaluate(header => header.style.removeProperty('--neco-shell-close-top'));
    await oldRules(page, false);
    expect(narrow.parts.find(part => part.className.includes('description')).box.height).toBeGreaterThan(20);
    expect(app.provider.calls).toHaveLength(0);
});

test('phone preservation retains existing intro anchor', async ({ app }) => {
    test.setTimeout(120000);
    const { page } = await setup(app, { phone: true });
    for (const id of styles) {
        await style(page, id);
        const selector = await open(page, 'right', 'server');
        const candidate = await geometry(page, selector);
        await oldRules(page, true);
        const baseline = await geometry(page, selector);
        await oldRules(page, false);
        expect(candidate, id + ' phone boxes, text and paint').toEqual(baseline);
        expect(candidate.parts).toHaveLength(3);
        expect([candidate.close.width, candidate.close.height]).toEqual([44, 44]);
        expect(candidate.delta).toBe(-20);
        expect(candidate.hit).toBe(true);
    }
    expect(app.provider.calls).toHaveLength(0);
});

test('exclusions retain non-intro headers', async ({ app }) => {
    test.setTimeout(120000);
    const { page } = await setup(app);
    for (const id of styles) {
        await style(page, id);
        for (const tab of ['settings', 'extensions']) {
            const selector = await open(page, 'right', tab);
            const candidate = await geometry(page, selector);
            await oldRules(page, true);
            const baseline = await geometry(page, selector);
            await oldRules(page, false);
            expect(candidate, id + ' ' + tab + ' boxes, text and paint').toEqual(baseline);
            expect(candidate.intro, tab).toBe(false);
            expect(candidate.hit, tab).toBe(true);
        }
    }
    await style(page, 'windows-xp');
    const selector = await open(page, 'right', 'settings');
    const mounted = await page.evaluate(async () => {
        const header = document.querySelector('#user-settings-block .sb-shell-header');
        const heading = document.createElement('div');
        const host = header.querySelector('.neconyan-shell-page-intro');
        document.body.append(heading);
        const result = (await import('/scripts/neconyan-tool-tour.js')).mountToolPage('macro-enhanced', heading, heading, host);
        return { result, headerIntro: Boolean(host.querySelector('.neconyan-page-intro-header')), bodyIntro: Boolean(heading.querySelector('.neconyan-tool-page-intro')) };
    });
    expect(mounted).toEqual({ result: true, headerIntro: false, bodyIntro: true });
    const compactCandidate = await geometry(page, selector);
    await oldRules(page, true);
    const compactBaseline = await geometry(page, selector);
    await oldRules(page, false);
    expect(compactCandidate).toEqual(compactBaseline);
    expect(app.provider.calls).toHaveLength(0);
});

test('header states and accents preserve interaction and geometry', async ({ app }) => {
    test.setTimeout(180000);
    const { page } = await setup(app);
    await style(page, 'windows-xp');
    const selector = await open(page, 'right', 'server');
    const close = page.locator(selector + ' .sb-shell-close');
    await close.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    expect(await close.evaluate(node => node.matches(':focus-visible'))).toBe(true);
    aligned(await geometry(page, selector), sizes['windows-xp'], 'focus');
    await close.hover();
    aligned(await geometry(page, selector), sizes['windows-xp'], 'hover', 1.5);
    await page.mouse.down();
    aligned(await geometry(page, selector), sizes['windows-xp'], 'active');
    await page.mouse.up();
    await expect(page.locator('#user-settings-block.openDrawer')).toHaveCount(0);
    await open(page, 'right', 'server');
    await page.locator(selector + ' .neconyan-tool-tour-button').click();
    await expect(page.locator('#neconyan-tool-tour')).toBeVisible();
    await page.locator('#neconyan-tool-tour .neconyan-tool-tour-close').click();
    await expect(page.locator('#neconyan-tool-tour')).toHaveCount(0);
    expect(app.provider.calls).toHaveLength(0);
});

webkitTest.describe('bounded WebKit and iPhone helpers', () => {
    webkitTest('desktop and inferred iPhone preserve their respective anchors', async ({ app, browser, browserName }) => {
        expect(browserName).toBe('webkit');
        expect(browser.browserType().name()).toBe('webkit');
        test.setTimeout(180000);
        const desktop = await setup(app);
        await style(desktop.page, 'windows-xp');
        const desktopSelector = await open(desktop.page, 'right', 'server');
        aligned(await geometry(desktop.page, desktopSelector), sizes['windows-xp'], 'WebKit desktop');
        const phone = await setup(app, { handle: 'default-user', phone: true, ios: true, contextOptions: IPHONE_SAFARI_CONTEXT });
        await style(phone.page, 'windows-xp');
        const phoneSelector = await open(phone.page, 'right', 'server');
        await applyIOSOnlyCss(phone.page);
        const g = await geometry(phone.page, phoneSelector);
        expect(g.parts).toHaveLength(3);
        expect([g.close.width, g.close.height]).toEqual([44, 44]);
        expect(g.delta).toBe(-20);
        expect(g.hit).toBe(true);
        expect(app.provider.calls).toHaveLength(0);
    });
});

for (const phone of [false, true]) {
    test(`header states and accents retain paint and report contrast (${phone ? 'phone' : 'desktop'})`, async ({ app }, info) => {
        test.setTimeout(240000);
        const { page } = await setup(app, { phone });
        const records = [];
        for (const [theme, slug] of [['Neconyan Calico', 'neconyan-calico'], ['Neconyan Calico Dark', 'neconyan-calico-dark'], ['Windows XP Olive Green', 'windows-xp-olive-green']]) {
            await page.evaluate(name => window.$('#themes').val(name).trigger('change'), theme);
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-ui-theme', slug);
            await style(page, 'windows-xp');
            for (const accent of [null, 'Mint Glass', 'Plum Wine']) {
                if (accent) {
                    await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(node => node.click());
                    await expect(page.locator('html')).toHaveAttribute('data-neconyan-accent', 'custom');
                    const expected = accent === 'Mint Glass' ? 'rgb(110, 231, 183)' : 'rgb(126, 34, 206)';
                    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--SmartThemeQuoteColor').trim())).toContain(expected.slice(4, -1));
                }
                const selector = await open(page, 'right', 'server');
                const close = page.locator(selector + ' .sb-shell-close');
                for (const state of ['rest', 'focus', 'hover', 'active']) {
                    await page.mouse.move(0, 0);
                    await close.evaluate(node => node.blur());
                    if (state === 'focus') await close.focus();
                    if (state === 'hover' || state === 'active') await close.hover();
                    if (state === 'active') await page.mouse.down();
                    const colours = await close.evaluate(node => {
                        const css = getComputedStyle(node), canvas = document.createElement('canvas');
                        canvas.width = canvas.height = 1;
                        const context = canvas.getContext('2d');
                        const rgb = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})`; };
                        return { ink: rgb(css.color), stops: (css.backgroundImage.match(/(?:rgba?|color)\([^)]+\)/g) || [css.backgroundColor]).map(rgb) };
                    });
                    const candidate = await geometry(page, selector);
                    await oldRules(page, true);
                    const baseline = await geometry(page, selector);
                    await oldRules(page, false);
                    expect(candidate.paint, `${theme}/${accent}/${state} paint`).toEqual(baseline.paint);
                    const ratios = colours.stops.map(stop => contrastRatio(colours.ink, stop));
                    expect(ratios.every(Number.isFinite)).toBe(true);
                    records.push({ phone, theme, accent: accent || 'theme default', state, ratios });
                    if (state === 'active') await page.mouse.up();
                }
            }
        }
        console.log('contrast-records ' + JSON.stringify(records));
        await info.attach('contrast-records', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
        expect(app.provider.calls).toHaveLength(0);
    });
}

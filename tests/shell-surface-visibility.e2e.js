/* global document, getComputedStyle, window */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const styles = [...source.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
const routes = [
    ['right', 'settings', '#user-settings-block'],
    ['right', 'extensions', '#user-settings-block'],
    ['left', 'api', '#left-nav-panel'],
    ['characters', 'characters', '#right-nav-panel'],
];

async function visibility(page, value) {
    await page.locator('#sb-surface-transparency-input').evaluate((input, next) => {
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.documentElement)
        .getPropertyValue('--sb-shell-surface-opacity')))).toBeCloseTo(1 - value / 100, 5);
}

async function surfaces(page, selector) {
    return page.locator(selector).evaluate(root => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const measure = node => {
            const style = getComputedStyle(node);
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return { name: node.id || node.className, alpha: context.getImageData(0, 0, 1, 1).data[3],
                image: style.backgroundImage, backdrop: style.backdropFilter, box: node.getBoundingClientRect().toJSON() };
        };
        const children = [...root.querySelectorAll('.sb-shell-frame, .sb-shell-main, .sb-shell-nav-wrapper, .sb-model-native-nav-wrapper, .sb-character-shell-nav-wrapper, .sb-shell-nav, .sb-character-shell-nav, .sb-shell-panel-scroller, .scrollableInner, .scrollableInnerFull')]
            .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        return { root: measure(root), children: children.map(measure),
            tabs: [...root.querySelectorAll('.sb-shell-tab')].filter(node => node.getClientRects().length)
                .map(node => ({ name: node.textContent.trim(), height: node.getBoundingClientRect().height })),
            overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
}

async function readableSurfaces(page, selectors) {
    for (const selector of selectors) await expect(page.locator(selector)).toBeVisible();
    const saved = await page.evaluateHandle(selectors => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        return selectors.map(selector => {
            const element = document.querySelector(selector);
            const box = element.getBoundingClientRect();
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(element).color;
            context.fillRect(0, 0, 1, 1);
            const colour = [...context.getImageData(0, 0, 1, 1).data];
            let opacity = colour[3] / 255;
            for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
            const children = [element, ...element.querySelectorAll('*')].map(node => [node, node.getAttribute('style')]);
            for (const [node] of children) {
                node.style.setProperty('color', 'transparent', 'important');
                node.style.setProperty('text-shadow', 'none', 'important');
            }
            return { selector, colour, opacity, children, points: [0.2, 0.5, 0.8].map(x => ({
                x: Math.floor(box.left + box.width * x), y: Math.floor(box.top + box.height / 2),
            })) };
        });
    }, selectors);
    try {
        const samples = await saved.evaluate(entries => entries.map(({ children, ...sample }) => sample));
        const png = PNG.sync.read(await page.screenshot({ animations: 'disabled', scale: 'css',
            style: '#toast-container { visibility: hidden !important; }' }));
        const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        return samples.map(sample => ({ selector: sample.selector, ratios: sample.points.map(point => {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThan(png.width);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThan(png.height);
            const index = (point.y * png.width + point.x) * 4;
            const background = [...png.data.subarray(index, index + 3)];
            const ink = sample.colour.slice(0, 3).map((value, channel) => value * sample.opacity + background[channel] * (1 - sample.opacity));
            const a = luminance(ink), b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }) }));
    } finally {
        await saved.evaluate(entries => {
            for (const { children } of entries) for (const [node, style] of children) {
                if (style === null) node.removeAttribute('style');
                else node.setAttribute('style', style);
            }
        });
        await saved.dispose();
    }
}

for (const phone of [false, true]) for (const style of styles) {
    test(`${style} reading panels and categories share background visibility (${phone ? 'phone, inferred iOS' : 'desktop'})`, async ({ app }, testInfo) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.firstRun = false;
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: false });
        const page = await account.open({ workspace: false });
        await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
        await page.waitForFunction(id => document.documentElement.dataset.sbTheme === id
            && (id === 'calico' || document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet), style);
        const measurements = [];
        for (const [side, tab, selector] of routes) {
            await page.evaluate(([side, tab]) => window.NeconyanShell.openTab(side, tab), [side, tab]);
            await expect(page.locator(selector)).toBeVisible();
            await expect(page.locator(selector)).toHaveAttribute(side === 'characters' ? 'data-menu-type' : 'data-sb-active-tab', tab);
            if (phone) await applyIOSOnlyCss(page);
            for (const value of [0, 50, 95, 100]) {
                await visibility(page, value);
                const state = await surfaces(page, selector);
                measurements.push({ tab, value, ...state });
                const label = `${style}/${tab}/${value}%`;
                expect(Math.abs(state.root.alpha - Math.round(255 * (1 - value / 100))), `${label}: one backing layer`).toBeLessThanOrEqual(1);
                expect(state.root.image, `${label}: no fixed opaque layer`).toBe('none');
                if (value === 100) expect(state.root.backdrop, `${label}: no remaining blur`).toBe('none');
                expect(state.children.length).toBeGreaterThan(0);
                for (const child of state.children) {
                    expect(child.alpha, `${label}: ${child.name} uses the same backing`).toBe(0);
                    expect(child.image, `${label}: ${child.name} has no independent paint`).toBe('none');
                }
                for (const control of state.tabs) expect(control.height, `${label}: ${control.name}`).toBeGreaterThanOrEqual(44);
                expect(state.overflow, label).toBeLessThanOrEqual(1);
            }
        }
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        await visibility(page, 0);
        for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) for (const accent of [null, 'Mint Glass', 'Plum Wine']) {
            await page.evaluate(({ theme, accent }) => {
                window.jQuery('#themes').val(theme).trigger('change');
                if (accent) {
                    const button = [...document.querySelectorAll('.sb-accent-profile-apply')].find(node => node.textContent.trim() === accent);
                    if (!button) throw new Error('Missing accent profile ' + accent);
                    button.click();
                }
            }, { theme, accent });
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
            const contrast = await readableSurfaces(page, [
                '#user-settings-block .sb-shell-nav .sb-shell-tab.is-active .sb-shell-tab-copy strong',
                '#AppearanceSection > .inline-drawer-header b span',
            ]);
            for (const sample of contrast) for (const ratio of sample.ratios) {
                expect(ratio, `${style}/${theme}/${accent || 'default'}/${sample.selector}`).toBeGreaterThanOrEqual(4.5);
            }
            measurements.push({ theme, accent, contrast });
        }
        await testInfo.attach('surface-visibility', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
        expect(app.provider.calls).toHaveLength(0);
    });
}

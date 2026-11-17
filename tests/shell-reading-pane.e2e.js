/* global document, getComputedStyle, window, localStorage */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// Reading pages keep a backing behind their text at the default Background visibility (100%), in every shell style.
// The glass shells (Windows Aero, macOS Minimal, Hypr Glow) keep their frame, header and rail clear, so their
// reading pane (.sb-shell-panel-scroller) carries the backing itself and must not follow the slider.
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const styles = [...source.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
const glass = ['windows-aero', 'macos-minimal', 'hypr-glow'];
if (styles.length !== 12 || glass.some(style => !styles.includes(style))) throw new Error('Unexpected shell style list: ' + styles.join(', '));
const pages = [
    ['right', 'settings', '#user-settings-block'],
    ['right', 'extensions', '#user-settings-block'],
    ['left', 'api', '#left-nav-panel'],
    ['left', 'mewmory', '#left-nav-panel'],
];

async function useStyle(page, style) {
    await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
    await page.waitForFunction(id => document.documentElement.dataset.sbTheme === id
        && (id === 'calico' || id === 'kittyless' || Boolean(document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet)), style);
}

async function openPage(page, [side, tab, selector]) {
    await page.evaluate(([side, tab]) => { window.NeconyanShell.closeWorkspace(); window.NeconyanShell.openTab(side, tab); }, [side, tab]);
    await expect(page.locator(selector)).toBeVisible();
}

async function setVisibility(page, value) {
    await page.locator('#sb-surface-transparency-input').evaluate((slider, value) => {
        slider.value = value;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBe(String(value));
}

// Backing behind the visible reading pane: its own fill stacked with every ancestor fill up to the drawer root
// (blur and the ::before layers are not counted), plus the canvas the Home and chat surfaces follow.
function measure(page, selector) {
    return page.locator(selector).evaluate(root => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const alpha = element => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(element).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
        };
        const scroller = [...root.querySelectorAll('.sb-shell-panel-scroller')].find(element => element.clientHeight > 0);
        let clear = 1;
        for (let node = scroller; node; node = node.parentElement) {
            clear *= 1 - alpha(node);
            if (node === root) break;
        }
        return { scroller: alpha(scroller), backing: 1 - clear, canvas: alpha(document.querySelector('#sheld')) };
    });
}

for (const style of styles) {
    // Glass shells must reach their own pane fill (92%); the others keep the 85% frame floor.
    const floor = glass.includes(style) ? 0.9 : 0.85;
    test(`${style} reading panes keep a backing at the default Background visibility`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account();
        const page = await account.open({ workspace: false, timeout: 60000 });
        await expect(page.locator('#sb-surface-transparency-input')).toHaveValue('100');
        await useStyle(page, style);
        for (const route of pages) {
            await openPage(page, route);
            await expect.poll(async () => (await measure(page, route[2])).backing, { message: `${style}/${route[1]}` }).toBeGreaterThanOrEqual(floor);
        }
    });
}

for (const style of glass) {
    test(`${style} keeps a fixed reading pane while Home and chat follow Background visibility`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account();
        const page = await account.open({ workspace: false, timeout: 60000 });
        await useStyle(page, style);
        await openPage(page, pages[0]);
        const fills = [];
        for (const value of [0, 50, 100]) {
            await setVisibility(page, value);
            await expect.poll(async () => (await measure(page, pages[0][2])).canvas, { message: `${style} canvas at ${value}%` }).toBeCloseTo(1 - value / 100, 2);
            const sample = await measure(page, pages[0][2]);
            expect(sample.scroller, `${style} pane at ${value}%`).toBeGreaterThanOrEqual(0.9);
            fills.push(sample.scroller);
        }
        expect(Math.max(...fills) - Math.min(...fills), `${style} pane fill at 0, 50 and 100%`).toBeLessThan(0.01);
    });
}

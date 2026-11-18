/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Fixed viewport and shell matrix. */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// Side panels (Settings > Appearance > Panels): behind drawer text exactly one layer paints the side backing, and
// at the defaults it equals the shell's resolved side opacity. On desktop that layer is the frame (Calico and the
// flat styles), the glass shells' reading pane, or the Characters and Lorebooks root; on phones it is always the root.
// Side panels start solid on desktop except in the frosted glass shells (0.92), and always solid on phones.
const glass = ['windows-aero', 'macos-minimal', 'hypr-glow'];
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const styles = [...source.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
if (styles.length !== 12) throw new Error('Unexpected shell style list: ' + styles.join(', '));
const pages = [
    ['right', 'settings', '#user-settings-block'],
    ['right', 'extensions', '#user-settings-block'],
    ['left', 'api', '#left-nav-panel'],
    ['characters', 'characters', '#right-nav-panel'],
    ['characters', 'world-info', '#right-nav-panel'],
];

async function useStyle(page, style) {
    await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
    await page.waitForFunction(id => document.documentElement.dataset.sbTheme === id
        && (id === 'calico' || Boolean(document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet)), style);
}

async function openPage(page, [side, tab, selector]) {
    await page.evaluate(([side, tab]) => { window.NeconyanShell.closeWorkspace(); window.NeconyanShell.openTab(side, tab); }, [side, tab]);
    await expect(page.locator(`${selector}.openDrawer`)).toBeVisible();
}

// Every painted fill between the page's own area (the reading pane, or the Characters and Lorebooks scroller) and the
// drawer root: what sits behind text written directly on the page. Blur, images and pseudo-elements are not counted.
function measure(page, selector) {
    return page.locator(`${selector}.openDrawer`).evaluate(root => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const alpha = element => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(element).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
        };
        const area = [...root.querySelectorAll('.sb-shell-panel-scroller')].find(element => element.clientHeight > 0) || root.querySelector(':scope > .scrollableInner');
        if (!area) return { missing: true };
        const layers = [];
        for (let node = area; node; node = node.parentElement) {
            const value = alpha(node);
            if (value > 0) layers.push({ node: `${node.tagName.toLowerCase()}#${node.id}.${[...node.classList].slice(0, 2).join('.')}`, alpha: value });
            if (node === root) break;
        }
        const backing = 1 - layers.reduce((clear, layer) => clear * (1 - layer.alpha), 1);
        return { layers, backing, side: window.NeconyanShell.getPanelLook().resolved.side.opacity };
    });
}

// The same walk for the drawer header (title and description), which sits beside the page area, not inside it: from the
// header element itself (the Characters and Lorebooks root's own header there; on phones its title can be hidden) up to
// the drawer root. Also reports where the header ends and the page area starts, so a header fill cannot overlap the pane.
function measureHeader(page, selector) {
    return page.locator(`${selector}.openDrawer`).evaluate(root => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const alpha = element => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(element).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
        };
        const header = root.id === 'right-nav-panel'
            ? root.querySelector(':scope > .sb-character-shell-header')
            : [...root.querySelectorAll('.sb-shell-header')].find(element => element.getClientRects().length);
        const area = [...root.querySelectorAll('.sb-shell-panel-scroller')].find(element => element.clientHeight > 0) || root.querySelector(':scope > .scrollableInner');
        if (!header || !area) return { missing: true };
        const layers = [];
        for (let node = header; node; node = node.parentElement) {
            const value = alpha(node);
            if (value > 0) layers.push({ node: `${node.tagName.toLowerCase()}#${node.id}.${[...node.classList].slice(0, 2).join('.')}`, alpha: value });
            if (node === root) break;
        }
        const backing = 1 - layers.reduce((clear, layer) => clear * (1 - layer.alpha), 1);
        return { layers, backing, side: window.NeconyanShell.getPanelLook().resolved.side.opacity, ownLayer: alpha(header) > 0,
            headerBottom: header.getBoundingClientRect().bottom, areaTop: area.getBoundingClientRect().top };
    });
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    for (const style of styles) {
        test(`${style} drawers show one side backing at the default on ${viewport}`, async ({ app }) => {
            test.setTimeout(150000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false, timeout: 60000 });
            await useStyle(page, style);
            for (const route of pages) {
                await openPage(page, route);
                await expect.poll(async () => (await measure(page, route[2])).layers?.length, { message: `${style}/${route[1]} layers` }).toBe(1);
                const sample = await measure(page, route[2]);
                expect(sample.side, `${style} ${viewport} side default`).toBe(phone || !glass.includes(style) ? 1 : 0.92);
                expect(sample.backing, `${style}/${route[1]} ${JSON.stringify(sample)}`).toBeCloseTo(sample.side, 2);
                // The header carries exactly one layer too, equal to the side backing, and ends where the page area starts.
                await expect.poll(async () => (await measureHeader(page, route[2])).layers?.length, { message: `${style}/${route[1]} header layers` }).toBe(1);
                await expect.poll(async () => {
                    const sample = await measureHeader(page, route[2]);
                    return Math.abs(sample.backing - sample.side);
                }, { message: `${style}/${route[1]} header backing against the side opacity` }).toBeLessThan(0.005);
                const header = await measureHeader(page, route[2]);
                // Only a header with its own fill can double up with the pane; upstream's absolutely positioned phone Lorebooks header sits over an unpainted area on the root's one layer, so it cannot.
                if (header.ownLayer) expect(header.headerBottom, `${style}/${route[1]} header overlaps the page area`).toBeLessThanOrEqual(header.areaTop + 1);
            }
        });
    }
}

// In the glass shells the desktop header is backed by its own fill, which follows Panel opacity like the pane.
for (const style of glass) {
    for (const route of pages.slice(0, 3)) {
        test(`${style} ${route[1]} header follows Panel opacity from clear to solid on desktop`, async ({ app }) => {
            test.setTimeout(120000);
            const account = await app.account();
            const page = await account.open({ workspace: false, timeout: 60000 });
            await useStyle(page, style);
            await openPage(page, route);
            for (const [position, backing, count] of [[100, 1, 1], [-100, 0, 0]]) {
                await page.evaluate(position => window.NeconyanShell.setPanelLook(null, { position }), position);
                await expect.poll(() => page.evaluate(() => window.NeconyanShell.getPanelLook().resolved.side.opacity), { message: `side at ${position}` }).toBe(backing);
                // Fills can still be transitioning when the resolved value has changed, so the painted values are polled.
                await expect.poll(async () => (await measureHeader(page, route[2])).layers?.length, { message: `${style}/${route[1]} header layers at ${position}` }).toBe(count);
                await expect.poll(async () => (await measureHeader(page, route[2])).backing, { message: `${style}/${route[1]} header at ${position}` }).toBeCloseTo(backing, 2);
                await expect.poll(async () => (await measure(page, route[2])).backing, { message: `${style}/${route[1]} pane at ${position}` }).toBeCloseTo(backing, 2);
            }
            await page.evaluate(() => window.NeconyanShell.resetPanelLook(null, 'opacity'));
        });
    }
}

test('a glass shell on a phone keeps one side layer at Side panels 60%', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account({ phone: true });
    const page = await account.open({ workspace: false, timeout: 60000 });
    await useStyle(page, 'windows-aero');
    await page.evaluate(() => window.NeconyanShell.setPanelLook('side', { opacity: 60 }));
    for (const route of pages.slice(0, 3)) {
        await openPage(page, route);
        await expect.poll(async () => (await measure(page, route[2])).backing, { message: route[1] }).toBeCloseTo(0.6, 2);
        expect((await measure(page, route[2])).layers).toHaveLength(1);
    }
    await page.evaluate(() => window.NeconyanShell.resetPanelLook('side', null));
});

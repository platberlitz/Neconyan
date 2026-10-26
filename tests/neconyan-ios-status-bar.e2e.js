/* global document, getComputedStyle, innerWidth */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const surfaceMarkup = html.match(/<div id="nn-ios-status-bar"[^>]*><\/div>/)?.[0];
const mobileCss = readFileSync(new URL('../public/css/neconyan-mobile-shell.css', import.meta.url), 'utf8');

async function mount(page, classes = 'neconyan safari PWA', inset = 62) {
    expect(surfaceMarkup).toBeTruthy();
    await page.setContent(`<body class="${classes}">${surfaceMarkup}<button id="underneath">Tap</button></body>`);
    await page.addStyleTag({ content: `body { margin: 0; --sb-z-shell: 1000; --neco-canvas: rgba(34, 42, 28, .2); }
        #underneath { position: fixed; inset: 0 auto auto 0; width: 100%; height: 62px; }` });
    // Linux browsers have no physical notch. Substitute only that device input,
    // leaving the production selectors, stacking and colour rules intact.
    await page.addStyleTag({ content: mobileCss.replaceAll('env(safe-area-inset-top, 0px)', `${inset}px`) });
}

test('home-screen status surface is opaque, edge-to-edge and lets taps through', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mount(page);
    const surface = page.locator('#nn-ios-status-bar');
    await expect(surface).toBeVisible();
    await expect(surface).toHaveAttribute('aria-hidden', 'true');
    await expect(surface).toHaveCSS('position', 'fixed');
    await expect(surface).toHaveCSS('pointer-events', 'none');
    await expect(surface).toHaveCSS('backdrop-filter', 'none');
    await expect(surface).toHaveCSS('background-image', 'none');
    await expect(surface).toHaveCSS('box-shadow', 'none');
    await expect(surface).toHaveCSS('border-radius', '0px');
    expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: 393, height: 62 });
    for (const colour of ['rgba(34, 42, 28, .2)', 'rgba(250, 240, 230, .1)', 'rgba(12, 16, 24, 0)']) {
        await page.evaluate(value => document.body.style.setProperty('--neco-canvas', value), colour);
        const result = await surface.evaluate(element => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = getComputedStyle(element).backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
            const rgba = Array.from(ctx.getImageData(0, 0, 1, 1).data);
            const tapTarget = document.elementFromPoint(innerWidth / 2, 4)?.id;
            // WebKit's fixed-edge sampling ignores pointer-events on its first pass.
            element.style.pointerEvents = 'auto';
            const sampleTarget = document.elementFromPoint(innerWidth / 2, 4)?.id;
            element.style.removeProperty('pointer-events');
            return { rgba, tapTarget, sampleTarget };
        });
        expect(result.rgba).toEqual([...colour.match(/[\d.]+/g).slice(0, 3).map(Number), 255]);
        expect(result.tapTarget).toBe('underneath');
        expect(result.sampleTarget).toBe('nn-ios-status-bar');
    }
    // A shorter keyboard viewport must not turn the strip into a page overlay.
    await page.setViewportSize({ width: 393, height: 480 });
    expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: 393, height: 62 });
    await page.setViewportSize({ width: 700, height: 393 });
    await mount(page, 'neconyan safari PWA', 0);
    expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: 700, height: 0 });
});

test('Safari tabs, Android installs and desktop keep the surface hidden', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    for (const classes of ['neconyan safari', 'neconyan PWA', 'neconyan']) {
        await mount(page, classes);
        await expect(page.locator('#nn-ios-status-bar')).toBeHidden();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await mount(page);
    await expect(page.locator('#nn-ios-status-bar')).toBeHidden();
});

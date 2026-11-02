/* global document, getComputedStyle, innerWidth, innerHeight */
import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari } from './ios-safari-emulation.js';

const publicRoot = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', publicRoot), 'utf8');
const sheets = [...html.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) => ({ tag, href: tag.match(/href="([^"]+)"/)?.[1]?.split('?')[0] }))
    .filter(({ tag, href }) => tag.includes('rel="stylesheet"') && href !== 'css/user.css' && (href === 'style.css' || href?.startsWith('css/')))
    .map(({ tag, href }) => ({ media: tag.match(/media="([^"]+)"/)?.[1] || 'all', css: readFileSync(new URL(href, publicRoot), 'utf8') }));
const shellStyles = readdirSync(new URL('css/shell-styles/', publicRoot)).filter(name => name.endsWith('.css'));

async function mount(page, { classes = 'neconyan safari PWA', inset = 34 } = {}) {
    await page.setContent(`<body class="${classes}"><main id="fixture"><div id="form_sheld" class="neconyan-cat-panel"><div id="sb-bottom-chat-bar" style="height:48px"></div><form id="send_form" class="neconyan-cat-panel"><div style="height:52px"></div><button type="button" id="tap">Chat tools</button></form></div></main></body>`);
    for (const { media, css } of sheets) {
        await page.addStyleTag({ content: `@media ${media} { ${css.replaceAll(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g, `${inset}px`)} }` });
    }
    await page.addStyleTag({ content: '#fixture { position: fixed; bottom: 0; left: 2px; right: 2px; } #tap { height: 38px; margin: 4px 24px; }' });
}

async function geometry(page) {
    return page.locator('#form_sheld').evaluate(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { gap: innerHeight - rect.bottom, left: rect.left, right: rect.right, viewport: innerWidth,
            padding: parseFloat(style.paddingBottom), radius: parseFloat(style.borderBottomLeftRadius),
            overflow: style.overflow, cornerHit: document.elementFromPoint(rect.left + 1, rect.bottom - 1)?.id };
    });
}

for (const inset of [0, 34]) {
    test(`installed iPhone composer keeps its painted corners clear with a ${inset}px safe area`, async ({ page, context }) => {
        await installIPhoneSafari(context, { standalone: true });
        await page.setViewportSize({ width: 393, height: 852 });
        await mount(page, { inset });
        const check = async () => {
            const box = await geometry(page);
            expect(box.gap).toBe(Math.max(12, inset / 2));
            expect(box.radius).toBe(36);
            expect(box.padding).toBe(6);
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(box.viewport);
            expect(box.overflow).toBe('visible'); // Do not crop cat ears or floating controls.
            expect(box.cornerHit).not.toBe('form_sheld');
            // A square inner glass layer paints beyond the rounded outer panel and blurs its accent.
            for (const selector of ['#send_form', '#sb-bottom-chat-bar']) {
                const paint = await page.locator(selector).evaluate(el => {
                    const style = getComputedStyle(el);
                    return { filter: style.backdropFilter || style.webkitBackdropFilter, background: style.backgroundColor, shadow: style.boxShadow };
                });
                expect.soft(paint, `${await page.locator('html').getAttribute('data-sb-theme')}: ${selector}`).toEqual({ filter: 'none', background: 'rgba(0, 0, 0, 0)', shadow: 'none' });
            }
        };
        await check();
        for (const name of shellStyles) {
            await page.evaluate(theme => document.documentElement.dataset.sbTheme = theme, name.replace('.css', ''));
            const style = await page.addStyleTag({ content: readFileSync(new URL(`css/shell-styles/${name}`, publicRoot), 'utf8') });
            await applyIOSOnlyCss(page, { inPlace: true });
            await check();
            if (name === 'cozy-warm.css') {
                for (const side of ['top', 'right', 'bottom', 'left']) {
                    await expect(page.locator('#form_sheld')).toHaveCSS(`border-${side}-style`, 'dashed');
                    await expect(page.locator('#form_sheld')).toHaveCSS(`border-${side}-width`, '2px');
                }
            }
            await style.evaluate(el => el.remove());
        }
        await page.evaluate(() => delete document.documentElement.dataset.sbTheme);
        await page.locator('#tap').evaluate(el => { el.onclick = () => { el.textContent = 'Tapped'; }; });
        await page.locator('#tap').click();
        await expect(page.locator('#tap')).toHaveText('Tapped');
        await page.setViewportSize({ width: 393, height: 480 });
        await page.evaluate(() => document.documentElement.classList.add('sb-ios-composer-keyboard-controls-active'));
        expect(await geometry(page)).toMatchObject({ gap: 0, padding: 0, radius: 0 });
        await page.evaluate(() => document.documentElement.classList.remove('sb-ios-composer-keyboard-controls-active'));
        await page.setViewportSize({ width: 700, height: 393 });
        await check();
    });
}

test('Safari tabs, Android installs and desktop retain their composer spacing', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    for (const classes of ['neconyan safari', 'neconyan PWA']) {
        await mount(page, { classes });
        expect(await geometry(page)).toMatchObject({ gap: 0, padding: 34, radius: 0 });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await mount(page);
    expect(await geometry(page)).toMatchObject({ gap: 0, padding: 34, radius: 0 });
});

test('glass and stitched composer edges follow pale and dark secondary accents', async ({ page }) => {
    for (const width of [393, 1280]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        await mount(page);
        for (const theme of ['windows-aero', 'hypr-glow', 'cozy-warm']) {
            await page.evaluate(theme => { document.documentElement.dataset.sbTheme = theme; }, theme);
            const sheet = await page.addStyleTag({ content: readFileSync(new URL(`css/shell-styles/${theme}.css`, publicRoot), 'utf8') });
            for (const colour of ['rgb(245, 225, 195)', 'rgb(35, 55, 70)']) {
                const state = await page.evaluate(({ colour, phone }) => {
                    document.documentElement.dataset.neconyanAccent = 'custom';
                    document.documentElement.style.setProperty('--SmartThemeUnderlineColor', colour);
                    document.querySelector('#send_form').classList.add('sb-generating-controls');
                    const style = getComputedStyle(document.querySelector(phone ? '#form_sheld' : '#send_form'));
                    return { border: style.borderTopColor, shadow: style.boxShadow };
                }, { colour, phone: width === 393 });
                expect(state.border).toBe(colour);
                expect(state.shadow).toContain('12px');
                expect(state.shadow.includes('1.5px inset')).toBe(theme !== 'cozy-warm');
            }
            await sheet.evaluate(el => el.remove());
        }
    }
});

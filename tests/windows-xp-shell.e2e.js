/* global document, window, getComputedStyle, NeconyanShell, Image, jQuery */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const SCHEMES = [
    ['Windows XP Blue', 'windows-xp-blue'],
    ['Windows XP Olive Green', 'windows-xp-olive-green'],
    ['Windows XP Silver', 'windows-xp-silver'],
    ['Windows XP Royale', 'windows-xp-royale'],
    ['Windows XP Zune', 'windows-xp-zune'],
    ['Windows XP Royale Noir', 'windows-xp-royale-noir'],
];

async function expand(page, selector) {
    const header = page.locator(selector);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
}

async function prepareContext(browser, phone) {
    const context = await browser.newContext({
        ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
        serviceWorkers: 'block', reducedMotion: 'reduce',
    });
    if (phone) await installIPhoneSafari(context, { standalone: true });
    return context;
}

async function useUiTheme(page, name, slug) {
    await page.evaluate(name => jQuery('#themes').val(name).trigger('change'), name);
    await expect(page.locator('html')).toHaveAttribute('data-neconyan-ui-theme', slug);
}

function captionOf(locator) {
    return locator.evaluate(el => getComputedStyle(el).backgroundImage);
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Windows XP Luna windows and colour schemes`, async ({ browser }, info) => {
        test.setTimeout(120000);
        const context = await prepareContext(browser, phone);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/characters/all', route => route.fulfill({ json: [] }));
        await page.route('**/api/settings/get', async route => {
            const response = await route.fetch();
            const data = await response.json();
            if (typeof data.settings !== 'string') return route.fulfill({ response });
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WelcomePage_PanelMode: 'full' };
            await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
        });
        await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
        await page.goto('/');
        await page.waitForFunction(() => window.NeconyanShell && document.querySelector('.neconyan-home'));
        await expect(page.locator('#preloader')).toHaveCount(0);

        await page.evaluate(() => NeconyanShell.openTab('right', 'settings'));
        await expand(page, '#AppearanceSection > .inline-drawer-header');
        await expand(page, '#sb-shell-style-drawer > .inline-drawer-header');
        await page.locator('[data-sb-theme-option="windows-xp"]').click();
        await expect(page.locator('[data-sb-theme-option="windows-xp"]')).toHaveAttribute('aria-pressed', 'true');
        await page.waitForFunction(() => document.querySelector('link[data-sb-shell-style="windows-xp"]')?.sheet);
        await page.evaluate(() => NeconyanShell.showHome());
        if (phone) await applyIOSOnlyCss(page);

        const wallpaper = await page.evaluate(async () => {
            const url = getComputedStyle(document.body, '::before').backgroundImage;
            const image = new Image();
            image.src = url.slice(5, -2);
            await image.decode();
            return { url, width: image.naturalWidth, height: image.naturalHeight };
        });
        expect(wallpaper.url).toContain('shell-windows-xp.webp');
        expect([wallpaper.width, wallpaper.height]).toEqual([1536, 1024]);

        // Home panels are rounded Luna windows with a caption strip.
        const intro = page.locator('.neconyan-home-intro');
        await expect(intro).toHaveCSS('border-top-left-radius', '8px');
        expect(await captionOf(intro)).toContain('linear-gradient');
        await expect(page.locator('.neconyan-home-actions > button').first()).not.toHaveCSS('border-radius', '0px');

        // Each bundled colour scheme repaints the caption strip.
        const captions = new Set();
        for (const [name, slug] of SCHEMES) {
            await useUiTheme(page, name, slug);
            captions.add(await captionOf(intro));
        }
        expect(captions.size).toBe(SCHEMES.length);

        // Silver keeps dark caption text on its light title bar; the others use white.
        await useUiTheme(page, 'Windows XP Silver', 'windows-xp-silver');
        const silverInk = await page.locator('#sb-topbar-title').evaluate(el => getComputedStyle(el).color);
        await useUiTheme(page, 'Windows XP Blue', 'windows-xp-blue');
        await expect(page.locator('#sb-topbar-title')).toHaveCSS('color', 'rgb(255, 255, 255)');
        expect(silverInk).not.toBe('rgb(255, 255, 255)');
        await page.screenshot({ path: info.outputPath('windows-xp-home.png') });

        const geometry = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);

        await page.reload();
        await page.waitForFunction(() => window.NeconyanShell && document.querySelector('.neconyan-home'));
        await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'windows-xp');
        expect(await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).toContain('shell-windows-xp.webp');
        expect(errors).toEqual([]);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
    });
}

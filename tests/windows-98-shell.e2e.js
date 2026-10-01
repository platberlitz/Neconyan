/* global document, window, getComputedStyle, NeconyanShell, Image */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const REDRAWS = [
    ['img/neconyan/cat-head.webp', 'img/neconyan/win98/cat-head.webp'],
    ['img/neconyan/cat-tail.webp', 'img/neconyan/win98/cat-tail.webp'],
    ['img/neconyan/cozy-library.webp', 'img/neconyan/win98/cozy-library.webp'],
    ['img/neconyan/curious-search.webp', 'img/neconyan/win98/curious-search.webp'],
    ['img/neconyan/sleepy-chat.webp', 'img/neconyan/win98/sleepy-chat.webp'],
    ['img/neconyan/ear-left.webp', 'img/neconyan/win98/ear-left.webp'],
    ['img/neconyan/ear-right.webp', 'img/neconyan/win98/ear-right.webp'],
    ['img/neconyan/sleeping-calico-left.webp', 'img/neconyan/win98/sleeping-calico-left.webp'],
    ['img/neconyan/sleeping-calico-left-twitch.webp', 'img/neconyan/win98/sleeping-calico-left-twitch.webp'],
    ['img/neconyan/sleeping-tiger-right.webp', 'img/neconyan/win98/sleeping-tiger-right.webp'],
    ['img/neconyan/sleeping-tiger-right-twitch.webp', 'img/neconyan/win98/sleeping-tiger-right-twitch.webp'],
    ['img/neconyan-pixel-cat-running.webp', 'img/neconyan/win98/startup-cat.webp'],
    ['img/neconyan-pixel-cat-rest.webp', 'img/neconyan/win98/startup-cat-rest.webp'],
    ['img/neconyan-pixel-cat.webp', 'img/neconyan/win98/home-cat.webp'],
    ['img/neconyan-icon-192.png', 'img/neconyan/win98/badge-calico.webp'],
    ...['miso', 'taro', 'nori'].flatMap(person => ['male', 'female', 'neutral'].flatMap(gender => [
        [`img/neconyan/assistant-icons/${person}-${gender}.png`, `img/neconyan/win98/icon-${person}-${gender}.webp`],
        [`api/characters/assistants/${person}-${gender}/portrait`, `img/neconyan/win98/portrait-${person}-${gender}.webp`],
    ])),
];

async function applyStyle(page, id) {
    await page.evaluate(id => NeconyanShell.applyTheme(id), id);
    await page.waitForFunction(id => id === 'calico'
        ? !document.querySelector('link[data-sb-shell-style]')
        : document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet, id);
}

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

async function syncPhoneCss(page, phone) {
    if (phone) await applyIOSOnlyCss(page);
}

function contentOf(locator, pseudo) {
    return locator.evaluate((el, pseudo) => getComputedStyle(el, pseudo).content, pseudo);
}

test('Windows 98 redraws keep the aspect ratio of the art they replace', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.NeconyanShell);
    const sizes = await page.evaluate(async pairs => {
        const measure = async src => {
            const image = new Image();
            image.src = `/${src}`;
            await image.decode();
            return image.naturalWidth / image.naturalHeight;
        };
        return Promise.all(pairs.map(async ([original, redraw]) => ({
            redraw, original: await measure(original), replacement: await measure(redraw),
        })));
    }, REDRAWS);
    for (const size of sizes) {
        expect(Math.abs(size.replacement - size.original), size.redraw).toBeLessThan(0.02);
    }
});

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Windows 98 bevels, pixel art and installed assistant avatars`, async ({ browser }, info) => {
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
        await page.locator('[data-sb-theme-option="windows-98"]').click();
        await expect(page.locator('[data-sb-theme-option="windows-98"]')).toHaveAttribute('aria-pressed', 'true');
        await page.waitForFunction(() => document.querySelector('link[data-sb-shell-style="windows-98"]')?.sheet);
        await page.evaluate(() => NeconyanShell.showHome());
        await syncPhoneCss(page, phone);

        const wallpaper = await page.evaluate(async () => {
            const url = getComputedStyle(document.body, '::before').backgroundImage;
            const image = new Image();
            image.src = url.slice(5, -2);
            await image.decode();
            return { url, width: image.naturalWidth, height: image.naturalHeight };
        });
        expect(wallpaper.url).toContain('shell-windows-98.webp');
        expect([wallpaper.width, wallpaper.height]).toEqual([1536, 1024]);

        // Square, bevelled windows with a caption strip on the Home panels.
        const intro = page.locator('.neconyan-home-intro');
        await expect(intro).toHaveCSS('border-radius', '0px');
        expect(await intro.evaluate(el => getComputedStyle(el).boxShadow)).toContain('inset');
        expect(await intro.evaluate(el => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
        await expect(page.locator('.neconyan-home-actions > button').first()).toHaveCSS('border-radius', '0px');

        // Bundled art is swapped for its pixel-art redraw.
        expect(await contentOf(page.locator('.neconyan-cat-head').first())).toContain('win98/cat-head.webp');
        expect(await contentOf(page.locator('.neconyan-assistant-row img[src*="/portrait"]').first())).toMatch(/win98\/portrait-(miso|taro|nori)-(male|female|neutral)\.webp/);
        expect(await contentOf(page.locator('.neconyan-cat-panel').first(), '::before')).not.toBe('none');
        expect(await page.locator('.neconyan-cat-panel').first().evaluate(el => getComputedStyle(el, '::before').backgroundImage)).toContain('win98/ear-left.webp');

        // Message sleepers and an installed assistant card use the redraws; user-made characters do not.
        await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            context.characters.push(
                { name: 'Miso (Neutral)', avatar: 'Miso (Neutral).png', data: { extensions: { neconyan_assistant: { id: 'miso-neutral' } } } },
                { name: 'Someone', avatar: 'Someone.png', data: { extensions: {} } },
            );
            context.eventSource.emit('character_page_loaded');
            const message = document.createElement('div');
            message.id = 'w98-test-message';
            message.className = 'mes';
            message.setAttribute('mesid', '999999');
            message.innerHTML = '<img class="neconyan-message-sleeper" src="/img/neconyan/sleeping-calico-left.webp">'
                + '<img class="w98-installed" src="/thumbnail?type=avatar&file=Miso%20(Neutral).png&preset=mobile">'
                + '<img class="w98-full" src="/characters/Miso%20(Neutral).png?t=1">'
                + '<img class="w98-user" src="/thumbnail?type=avatar&file=Someone.png">';
            document.querySelector('#chat').append(message);
        });
        const message = page.locator('#w98-test-message');
        await expect.poll(() => contentOf(message.locator('.w98-installed'))).toContain('win98/portrait-miso-neutral.webp');
        expect(await contentOf(message.locator('.w98-full'))).toContain('win98/portrait-miso-neutral.webp');
        expect(await contentOf(message.locator('.w98-user'))).toBe('normal');
        expect(await contentOf(message.locator('.neconyan-message-sleeper'))).toContain('win98/sleeping-calico-left.webp');
        await page.screenshot({ path: info.outputPath('windows-98-home.png') });

        // Switching away drops every swap, including the runtime assistant rules.
        await applyStyle(page, 'calico');
        await expect(page.locator('#sb-shell-style-assistant-art')).toHaveCount(0);
        expect(await contentOf(message.locator('.w98-installed'))).toBe('normal');
        expect(await contentOf(page.locator('.neconyan-cat-head').first())).toBe('normal');
        await expect(intro).not.toHaveCSS('border-radius', '0px');
        await applyStyle(page, 'windows-98');
        await expect.poll(() => contentOf(message.locator('.w98-installed'))).toContain('win98/portrait-miso-neutral.webp');

        // Custom accents recolour the caption strip instead of the navy default.
        const captions = [];
        captions.push(await intro.evaluate(el => getComputedStyle(el).backgroundImage));
        await page.evaluate(() => {
            document.documentElement.dataset.neconyanAccent = 'custom';
            document.body.style.setProperty('--neco-ginger', 'rgb(40, 160, 90)');
            document.body.style.setProperty('--neco-accent-secondary', 'rgb(200, 60, 160)');
        });
        captions.push(await intro.evaluate(el => getComputedStyle(el).backgroundImage));
        expect(captions[1]).not.toBe(captions[0]);
        await page.evaluate(() => {
            delete document.documentElement.dataset.neconyanAccent;
            for (const token of ['--neco-ginger', '--neco-accent-secondary']) document.body.style.removeProperty(token);
            document.querySelector('#w98-test-message').remove();
        });

        const geometry = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);

        await page.reload();
        await page.waitForFunction(() => window.NeconyanShell && document.querySelector('.neconyan-home'));
        await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'windows-98');
        expect(await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).toContain('shell-windows-98.webp');
        expect(await contentOf(page.locator('.neconyan-cat-head').first())).toContain('win98/cat-head.webp');
        expect(errors).toEqual([]);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
    });
}

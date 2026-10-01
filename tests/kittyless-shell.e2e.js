/* global document, window, getComputedStyle, NeconyanShell, Image */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function expand(page, selector) {
    const header = page.locator(selector);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
}

async function applyStyle(page, id) {
    await page.evaluate(id => NeconyanShell.applyTheme(id), id);
    await page.waitForFunction(id => id === 'calico'
        ? !document.querySelector('link[data-sb-shell-style]')
        : document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet, id);
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

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Kittyless, disclosure, wallpaper and style restoration`, async ({ browser }, info) => {
        test.setTimeout(240000);
        const context = await prepareContext(browser, phone);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/characters/all', route => route.fulfill({ json: [] }));
        await page.route('**/api/settings/get', async route => {
            const response = await route.fetch({ maxRetries: 2 });
            const data = await response.json();
            if (typeof data.settings !== 'string') return route.fulfill({ response });
            const settings = JSON.parse(data.settings);
            settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
            settings.firstRun = false;
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WelcomePage_PanelMode: 'full' };
            await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
        });
        await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
        await page.goto('/');
        await page.waitForFunction(() => window.NeconyanShell && document.querySelector('.neconyan-home'));
        await expect(page.locator('#preloader')).toHaveCount(0);
        const version = await (await page.request.get('/version')).json();
        await expect(page.locator('#version_display')).toHaveText(`Neconyan v${version.pkgVersion}`);

        // Select the new option through the real appearance controls.
        await page.evaluate(() => NeconyanShell.openTab('right', 'settings'));
        await expand(page, '#AppearanceSection > .inline-drawer-header');
        await expand(page, '#sb-shell-style-drawer > .inline-drawer-header');
        await page.locator('[data-sb-theme-option="kittyless"]').click();
        await expect(page.locator('[data-sb-theme-option="kittyless"]')).toHaveAttribute('aria-pressed', 'true');
        await page.waitForFunction(() => document.querySelector('link[data-sb-shell-style="kittyless"]')?.sheet);
        await page.evaluate(() => NeconyanShell.showHome());
        await syncPhoneCss(page, phone);

        const primary = page.locator('.neconyan-home-actions > .neconyan-home-primary');
        await expect(primary).toHaveCSS('border-radius', '999px');
        await expect(primary).toHaveCSS('padding-left', '20px');
        const primaryColour = await primary.evaluate(() => {
            const sample = document.createElement('span');
            sample.style.color = document.documentElement.dataset.neconyanAccent === 'custom'
                ? 'var(--neco-ginger)' : 'var(--neco-cream)';
            document.body.append(sample);
            const colour = getComputedStyle(sample).color;
            sample.remove();
            return colour;
        });
        await expect(primary).toHaveCSS('background-color', primaryColour);
        const image = await page.evaluate(async () => {
            const url = getComputedStyle(document.body, '::before').backgroundImage;
            const image = new Image();
            image.src = url.slice(5, -2);
            await image.decode();
            return { url, width: image.naturalWidth, height: image.naturalHeight };
        });
        expect(image.url).toContain('shell-kittyless.webp');
        expect([image.width, image.height]).toEqual([1536, 1024]);
        const hiddenDecorations = await page.evaluate(() => [...document.querySelectorAll('.neconyan-whiskers,.neconyan-home-cat,.neconyan-cat-mark,.neconyan-empty-illustration')]
            .filter(element => getComputedStyle(element).display !== 'none').length);
        expect(hiddenDecorations).toBe(0);
        expect(await page.locator('.neconyan-home-intro').evaluate(el => getComputedStyle(el, '::before').display)).toBe('none');

        const disclosure = page.locator('.neconyan-assistant-disclosure');
        await expect(disclosure).toHaveText('Show assistants');
        await expect(page.locator('.neconyan-assistant-choices')).toBeHidden();
        await disclosure.click();
        await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
        await expect(disclosure).toHaveText('Hide assistants');
        await expect(page.locator('.neconyan-assistant-row').first()).toBeVisible();
        await expect(page.locator('.neconyan-assistant-row img').first()).toBeVisible();
        await disclosure.click();
        await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
        const geometry = await primary.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return { width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right, height: rect.height };
        });
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: info.outputPath('kittyless-home.png') });

        // The same spacing policy covers all message layouts, not just Home.
        await page.evaluate(() => {
            const message = document.createElement('div');
            message.id = 'kittyless-test-message';
            message.className = 'mes';
            message.setAttribute('mesid', '999999');
            const sleeper = document.createElement('img');
            sleeper.className = 'neconyan-message-sleeper';
            message.append(sleeper);
            document.querySelector('#chat').append(message);
        });
        const message = page.locator('#kittyless-test-message');
        await expect(message.locator('.neconyan-message-sleeper')).toHaveCSS('display', 'none');
        await expect(message).toHaveCSS('margin-top', '16px');
        await applyStyle(page, 'calico');
        await expect(message).toHaveCSS('margin-top', '44px');
        await expect(message.locator('.neconyan-message-sleeper')).not.toHaveCSS('display', 'none');
        await expect(page.locator('.neconyan-home-cat')).toBeVisible();
        await expect(disclosure).toBeHidden();
        await expect(page.locator('.neconyan-assistant-row').first()).toBeVisible();
        await page.evaluate(() => document.querySelector('#kittyless-test-message').remove());
        await applyStyle(page, 'kittyless');

        // Changing light/dark and custom accents never reintroduces paw textures.
        for (const tone of ['light', 'dark']) {
            const samples = [];
            for (const secondary of ['rgb(32, 196, 224)', 'rgb(224, 64, 160)']) {
                await page.evaluate(({ tone, secondary }) => {
                    document.documentElement.dataset.neconyanCalicoTone = tone;
                    document.documentElement.dataset.neconyanAccent = 'custom';
                    document.body.style.setProperty('--neco-ginger', 'rgb(100, 180, 160)');
                    document.body.style.setProperty('--neco-on-accent', 'rgb(10, 20, 15)');
                    document.body.style.setProperty('--neco-accent-secondary', secondary);
                }, { tone, secondary });
                await expect(primary).toHaveCSS('background-color', 'rgb(100, 180, 160)');
                await expect(primary).toHaveCSS('color', 'rgb(10, 20, 15)');
                await expect(page.locator('.neconyan-home-intro')).toHaveCSS('background-image', 'none');
                samples.push(await page.locator('.neconyan-home-intro').evaluate(el => getComputedStyle(el).borderTopColor));
            }
            expect(samples[1]).not.toBe(samples[0]);
        }
        await page.evaluate(() => {
            document.documentElement.dataset.neconyanCalicoTone = 'dark';
            delete document.documentElement.dataset.neconyanAccent;
            for (const token of ['--neco-ginger', '--neco-on-accent', '--neco-accent-secondary']) document.body.style.removeProperty(token);
        });

        // Late-loaded mode sheets must not bring their own mascots back.
        await page.evaluate(() => NeconyanShell.activateMode('conversation'));
        await syncPhoneCss(page, phone);
        await expect(page.locator('#sb_conversation_stage')).toBeVisible();
        await expect(page.locator('.sb-conversation-empty-illustration').first()).toHaveCSS('display', 'none');
        await page.evaluate(() => NeconyanShell.activateMode('meower'));
        await syncPhoneCss(page, phone);
        await expect(page.locator('.sbtw-empty-art').first()).toHaveCSS('display', 'none');
        expect(await page.locator('.sbtw-bunny img').first().evaluate(el => getComputedStyle(el).content)).toContain('kittyless-avatar.svg');
        expect(await page.locator('.sbtw-post-row img[src*="user-default.png"]').first().evaluate(el => getComputedStyle(el).content)).toContain('kittyless-avatar.svg');
        await applyStyle(page, 'calico');
        await expect(page.locator('.sbtw-empty-art').first()).toBeVisible();
        await expect(page.locator('.sbtw-bunny img').first()).toHaveCSS('content', 'normal');
        await applyStyle(page, 'kittyless');
        await page.evaluate(() => NeconyanShell.activateMode('roleplay'));
        await page.evaluate(() => NeconyanShell.showHome());

        // A genuinely selected wallpaper paints over the default and survives switching.
        await page.evaluate(() => NeconyanShell.openTab('right', 'background'));
        await syncPhoneCss(page, phone);
        await page.locator('.bg_example[bgfile="Neconyan - Amber Train.jpg"]').click();
        const selected = await page.locator('#bg1').evaluate(el => el.style.backgroundImage);
        expect(selected).toContain('Amber');
        await applyStyle(page, 'calico');
        expect(await page.locator('#bg1').evaluate(el => el.style.backgroundImage)).toBe(selected);
        await applyStyle(page, 'kittyless');
        expect(await page.locator('#bg1').evaluate(el => el.style.backgroundImage)).toBe(selected);

        // The saved style is restored on a fresh page, including its default layer.
        await page.reload();
        await page.waitForFunction(() => window.NeconyanShell && document.querySelector('.neconyan-home'));
        await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'kittyless');
        await expect(page.locator('.neconyan-home-cat')).toBeHidden();
        expect(await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).toContain('shell-kittyless.webp');
        expect(errors).toEqual([]);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
    });
}

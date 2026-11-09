/* global document, window, getComputedStyle, DOMParser, Image */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test('every cat and neutral SVG loads, paints and follows its compatible class', async ({ page }) => {
    test.setTimeout(120000);
    await page.route('**/catline-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
    await page.goto('/catline-test');
    const results = await page.evaluate(async () => {
        const catalogue = await (await fetch('/img/icons/catline/catalogue.json')).json();
        document.body.replaceChildren();
        for (const href of ['/css/neconyan-icons-map.css', '/css/neconyan-icons.css']) {
            const link = document.createElement('link');
            link.rel = 'stylesheet'; link.href = href;
            await new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; document.head.append(link); });
        }
        const failures = [];
        const paints = [];
        for (const plain of [false, true]) {
            document.documentElement.dataset.sbKittyless = String(plain);
            for (const aliases of catalogue) {
                const expected = `${aliases[0].slice(3)}${plain ? '-plain' : ''}.svg`;
                for (const alias of aliases) {
                    const icon = document.createElement('i');
                    icon.className = `fa-solid ${alias}`; document.body.append(icon);
                    const style = getComputedStyle(icon, '::before');
                    if (!style.maskImage.includes(expected) || parseFloat(style.width) <= 0) failures.push(alias);
                    icon.remove();
                }
                const url = `/img/icons/catline/${expected}`;
                paints.push(async () => {
                    const response = await fetch(url);
                    const text = await response.text();
                    if (!response.ok || new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror')) failures.push(url);
                    const image = new Image(); image.src = `data:image/svg+xml,${encodeURIComponent(text)}`;
                    await image.decode();
                    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
                    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 24, 24);
                    if (!ctx.getImageData(0, 0, 24, 24).data.some((value, index) => index % 4 === 3 && value > 0)) failures.push(`empty: ${url}`);
                });
            }
        }
        for (let index = 0; index < paints.length; index += 16) {
            document.title = `Checking SVGs ${index + 1}-${Math.min(index + 16, paints.length)}`;
            await Promise.all(paints.slice(index, index + 16).map(paint => paint()));
        }
        return failures;
    });
    expect(results).toEqual([]);
});

test('the selection badge appears only in character group selection', async ({ page }) => {
    await page.route('**/catline-selection-test', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><link rel="stylesheet" href="/css/neconyan-icons-map.css"><link rel="stylesheet" href="/css/neconyan-icons.css"><link rel="stylesheet" href="/css/neconyan.css"></head><body class="neconyan"><div id="right-nav-panel"><div id="rm_print_characters_block"><div class="character_select flex-container character_selected">Character</div></div></div></body></html>',
    }));
    await page.goto('/catline-selection-test');
    const card = page.locator('.character_selected');
    const mask = () => card.evaluate(node => getComputedStyle(node, '::after').maskImage);
    expect(await mask()).toBe('none');
    await page.locator('#rm_print_characters_block').evaluate(node => node.classList.add('group_overlay_mode_select'));
    expect(await mask()).toContain('/square-check.svg');
    await page.locator('#rm_print_characters_block').evaluate(node => node.classList.remove('group_overlay_mode_select'));
    expect(await mask()).toBe('none');
});

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} picker, state changes and shell use SVGs without icon fonts`, async ({ browser }, info) => {
        test.setTimeout(120000);
        const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const fontRequests = [];
        page.on('request', request => { if (/fa-(solid|brands)-|fontawesome|nanogallery2.*\.(?:woff|ttf)/.test(request.url())) fontRequests.push(request.url()); });
        try {
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell);
            await page.locator('#preloader').waitFor({ state: 'detached' });
            const skip = page.getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'creator'));
            const catelier = page.locator('#sb_character_tab_creator');
            await expect(catelier).toBeVisible();
            expect(await catelier.locator('i').evaluate(node => getComputedStyle(node, '::before').maskImage)).toContain('/pen-nib.svg');
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
            const icon = page.locator('#top-settings-holder .sb-shell-tab:visible i').first();
            await expect(icon).toBeVisible();
            expect(await icon.evaluate(node => getComputedStyle(node, '::before').maskImage)).toContain('/img/icons/catline/');
            await page.evaluate(async () => {
                const { showFontAwesomePicker } = await import('/scripts/utils.js');
                window.catlinePickerResult = undefined;
                void showFontAwesomePicker().then(result => window.catlinePickerResult = result);
            });
            await page.locator('.faQuery').fill('magnifying-glass');
            const choice = page.locator('.faPicker button:not(.hidden)');
            await expect(choice).toHaveCount(1);
            await expect(choice).toHaveAccessibleName(/magnifying-glass/);
            await choice.press('Enter');
            await expect.poll(() => page.evaluate(() => window.catlinePickerResult)).toBe('fa-magnifying-glass');
            const states = await page.evaluate(() => {
                const button = document.createElement('button');
                document.body.append(button);
                const result = [];
                for (const classes of ['fa-solid fa-paper-plane', 'fa-solid fa-stop', 'fa-solid fa-spinner fa-spin', 'menu_button toggleable toggled', 'menu_button toggleable', 'fa-solid fa-unavailable-extension-icon']) {
                    button.className = classes;
                    result.push(getComputedStyle(button, '::before').maskImage);
                }
                document.documentElement.dataset.sbKittyless = 'true';
                button.className = 'fa-solid fa-paper-plane';
                result.push(getComputedStyle(button, '::before').maskImage);
                button.remove();
                return result;
            });
            ['paper-plane.svg', 'stop.svg', 'spinner.svg', 'check.svg', 'xmark.svg', 'circle-question.svg', 'paper-plane-plain.svg'].forEach((name, index) => expect(states[index]).toContain(name));
            expect(fontRequests).toEqual([]);
        } finally {
            await context.close();
        }
    });
}

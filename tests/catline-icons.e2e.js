/* global document, window, getComputedStyle, DOMParser, Image */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

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
                    const pixels = ctx.getImageData(0, 0, 24, 24).data;
                    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) failures.push(`empty: ${url}`);
                    if (/^chevron-(up|down|left|right)(-plain)?\.svg$/.test(expected)) {
                        const painted = [];
                        for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
                            if (pixels[(y * 24 + x) * 4 + 3] > 128) painted.push([x, y]);
                        }
                        for (const axis of [0, 1]) {
                            const positions = painted.map(point => point[axis]);
                            const centre = (Math.min(...positions) + Math.max(...positions) + 1) / 2;
                            if (Math.abs(centre - 12) > 0.5) failures.push(`off-centre: ${url}, axis ${axis}: ${centre}`);
                        }
                    }
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
    test(`${phone ? 'phone' : 'desktop'} Thinking chevron stays centred when opened and closed`, async ({ browser }, info) => {
        const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        try {
            const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
            const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(match => match[0]).filter(link => !link.includes('data-sb-deferred-style')).join('\n');
            const template = html.match(/<details class="mes_reasoning_details">[\s\S]*?<\/details>/)[0];
            await page.route('**/catline-thinking-test', route => route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head><base href="/"><meta name="viewport" content="width=device-width,initial-scale=1">${links}</head><body class="neconyan"><div id="chat" data-show-hidden-reasoning="true"><div class="mes reasoning">${template}</div></div></body></html>`,
            }));
            await page.goto('/catline-thinking-test');
            const details = page.locator('.mes_reasoning_details');
            const header = page.locator('.mes_reasoning_header');
            const arrow = page.locator('.mes_reasoning_arrow');
            await page.locator('.mes_reasoning').evaluate(node => node.textContent = 'A retained thought.');
            // Isolate the arrow colour so the screenshot measures painted pixels, not just its box.
            await arrow.evaluate(node => node.style.color = 'rgb(255, 0, 255)');
            for (const plain of [false, true]) {
                await page.evaluate(plain => document.documentElement.dataset.sbKittyless = String(plain), plain);
                for (const open of [false, true]) {
                    await details.evaluate((node, open) => node.open = open, open);
                    await expect(arrow).toBeVisible();
                    const headerBox = await header.boundingBox();
                    const arrowBox = await arrow.boundingBox();
                    expect(Math.abs(arrowBox.y + arrowBox.height / 2 - headerBox.y - headerBox.height / 2)).toBeLessThan(0.1);
                    const png = PNG.sync.read(await arrow.screenshot());
                    const painted = [];
                    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
                        const i = (y * png.width + x) * 4;
                        if (png.data[i] > 180 && png.data[i + 1] < 100 && png.data[i + 2] > 180) painted.push([x, y]);
                    }
                    expect(painted.length).toBeGreaterThan(0);
                    for (const axis of [0, 1]) {
                        const positions = painted.map(point => point[axis]);
                        const centre = (Math.min(...positions) + Math.max(...positions) + 1) / 2;
                        expect(Math.abs(centre - (axis === 0 ? png.width : png.height) / 2)).toBeLessThanOrEqual(1);
                    }
                }
            }
            await page.locator('.mes_reasoning').evaluate(node => node.textContent = '');
            await expect(header).toBeVisible();
            await expect(arrow).toBeHidden();
        } finally {
            await context.close();
        }
    });

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

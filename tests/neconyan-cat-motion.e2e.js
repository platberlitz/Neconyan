/* global document, window, MouseEvent */
import { acknowledgeSettingsSave, isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' });
test.setTimeout(60000);
test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
});

test('generated mascot rasters keep their recorded frame timing and dimensions', async ({ page }, testInfo) => {
    const artwork = JSON.parse(readFileSync(new URL('../public/img/neconyan/artwork-provenance.json', import.meta.url), 'utf8'));
    const output = path => artwork.outputs.find(entry => entry.path === `public/${path}`);
    expect(output('img/neconyan-pixel-cat.webp')).toMatchObject({ size: [208, 192], frames: 29, loop_ms: 4500 });
    expect(output('img/neconyan-pixel-cat-running.webp')).toMatchObject({ size: [384, 192], frames: 4, loop_ms: 440 });
    expect(output('img/neconyan-pixel-cat-rest.webp')).toMatchObject({ size: [208, 192], frames: 1 });
    await page.goto('/img/neconyan-pixel-cat.webp?v=20260913g', { waitUntil: 'domcontentloaded' });
    const image = page.locator('img').first();
    await expect(image).toHaveJSProperty('naturalWidth', 208);
    await expect(image).toHaveJSProperty('naturalHeight', 192);
    await page.screenshot({ path: testInfo.outputPath('mascot-raster.png') });
});

test('Home paints the backflip and keeps OS and app motion preferences separate', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    let settings;
    const savedSettings = [];
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch({ maxRetries: 2 });
        const envelope = await response.json();
        if (!settings) {
            settings = JSON.parse(envelope.settings);
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            settings.power_user.reduced_motion = false;
        }
        await route.fulfill({ response, json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        settings = JSON.parse(bytes.toString());
        savedSettings.push(structuredClone(settings));
        settings._version = Math.max(Date.now(), Number(settings._version || 0) + 1);
        settings._settingsRevision = Number(settings._settingsRevision || 0) + 1;
        await route.fulfill({ json: { result: 'ok', version: settings._version, settingsRevision: settings._settingsRevision } });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const cat = page.locator('[data-neconyan-cat]');
    await expect(cat).toBeVisible({ timeout: 45000 });
    await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat\.webp/);

    const frame = () => cat.screenshot({ animations: 'allow', caret: 'hide' });
    const movingFrames = [await frame()];
    for (let index = 0; index < 5; index++) {
        await page.waitForTimeout(1000);
        movingFrames.push(await frame());
    }
    writeFileSync(testInfo.outputPath('cat-moving-frame.png'), movingFrames[0]);
    expect(new Set(movingFrames.map(buffer => buffer.toString('base64'))).size).toBeGreaterThan(1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
    await cat.evaluate(image => image.decode());
    const stillFrame = await frame();
    await page.waitForTimeout(1000);
    expect((await frame()).equals(stillFrame)).toBe(true);
    writeFileSync(testInfo.outputPath('cat-os-reduced-frame.png'), stillFrame);

    savedSettings.length = 0;
    await page.locator('#compact_input_area').evaluate(input => {
        input.checked = !input.checked;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => savedSettings.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(savedSettings.at(-1).power_user.reduced_motion).toBe(false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(cat).toBeVisible({ timeout: 45000 });
    await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat\.webp/);
    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
});

test('kitty clouds remain visible behind Home and Conversation, while Characters uses a solid sheet', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const modelRequests = [];
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => {
        modelRequests.push(route.request().url());
        return route.fulfill({ status: 503, json: { error: 'No model calls during appearance checks.' } });
    });
    await isolateSettingsSaves(page, settings => {
        settings.power_user ??= {};
        settings.power_user['customCSS-bg-opacity'] = 1;
    });
    const asset = await page.request.get('/img/neconyan/kitty-clouds.webp?v=20260913g');
    expect(asset.status()).toBe(200);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    const layer = await page.locator('body').evaluate(body => {
        const style = window.getComputedStyle(body, '::before');
        return { image: style.backgroundImage, opacity: style.opacity, pointerEvents: style.pointerEvents,
            tone: document.documentElement.dataset.neconyanCalicoTone };
    });
    expect(layer.image).toContain(layer.tone === 'dark' ? 'kitty-clouds-dark.webp' : 'kitty-clouds.webp');
    expect(Number(layer.opacity)).toBe(0.67);
    expect(layer.pointerEvents).toBe('none');
    await expect(page.locator('#top-bar')).toHaveCSS('background-color', /(?:,\s*|\/\s*)0\.9\)$/);
    await expect(page.locator('#sb-topbar-inner')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.neconyan-home-intro')).toHaveCSS('background-color', /(?:,\s*|\/\s*)0\.9\)$/);
    await expect(page.locator('[data-neconyan-cat]')).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
    await expect(page.locator('#qig-input-btn')).toBeAttached();

    // Cloud visibility follows the Background Visibility control rather than
    // forcing the canvas transparent at every setting.
    await page.locator('#sb-surface-transparency-input').evaluate(input => {
        input.value = '100';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() =>
        window.getComputedStyle(document.documentElement).getPropertyValue('--sb-shell-surface-opacity').trim(),
    )).toBe('0.00');

    const checkCanvas = async (name, selectors) => {
        const backgrounds = await page.locator(selectors).evaluateAll(elements => elements
            .filter(element => element.getClientRects().length)
            .map(element => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                context.fillStyle = window.getComputedStyle(element).backgroundColor;
                context.fillRect(0, 0, 1, 1);
                return {
                    id: element.id, alpha: context.getImageData(0, 0, 1, 1).data[3],
                    colour: window.getComputedStyle(element).backgroundColor,
                    shellOpacity: window.getComputedStyle(element).getPropertyValue('--sb-shell-surface-opacity'),
                    bodyClasses: document.body.className,
                };
            }));
        expect(backgrounds.length).toBeGreaterThan(0);
        for (const background of backgrounds) expect(background.alpha, JSON.stringify(background)).toBe(0);
        const clip = await page.locator(selectors).first().boundingBox();
        expect(clip).not.toBeNull();
        const visible = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
        const hideCloud = await page.addStyleTag({ content: 'body.neconyan::before { opacity: 0 !important; }' });
        const hidden = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
        await hideCloud.evaluate(element => element.remove());
        expect(visible.equals(hidden), `${name}: the cloud layer must change visible pixels`).toBe(false);
        writeFileSync(testInfo.outputPath(`${name}-clouds.png`), visible);
    };

    await checkCanvas('home', '#sheld, #neconyan-home-host');
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await expect(page.locator('#sheld')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('#right-nav-panel')).toHaveCSS('background-color', layer.tone === 'dark' ? 'rgb(27, 28, 26)' : 'rgb(255, 250, 240)');
    await expect(page.locator('#right-nav-panel > .scrollableInner')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Close Characters', exact: true }).click();
    await expect(page.locator('#sheld')).toHaveCSS('visibility', 'visible');

    const miso = page.locator('[data-assistant-personality="miso"]');
    await miso.locator('input[value="miso-male"]').check();
    await miso.locator('[data-assistant-open]').click();
    await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
    await page.locator('#send_textarea').fill('Keep this draft while checking the background.');
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
    await page.locator('#neconyan-workspace-rail [data-neconyan-chat-mode="conversation"]').click();
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await expect(page.locator('#sb_conversation_stage')).toBeVisible();
    await expect(page.locator('.sb-conversation-composer')).toHaveClass(/neconyan-cat-panel/);
    // The stage is intentionally transparent so the clouds read through it. The
    // translucent message surface lives on the timeline pane at 82% opacity.
    await expect(page.locator('#sb_conversation_stage')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.sb-conversation-timeline')).toHaveCSS('background-color', /(?:,\s*|\/\s*)0\.82\)$/);
    await checkCanvas('conversation', '#sheld');
    await expect(page.locator('#send_textarea')).toHaveValue('Keep this draft while checking the background.');
    expect(modelRequests).toEqual([]);
});

for (const tone of ['Dark', 'Light']) {
    test(`${tone} native controls and cat motion preferences`, async ({ page }, testInfo) => {
        const filename = tone === 'Dark' ? 'Neconyan Calico Dark.json' : 'Neconyan Calico.json';
        const { name, ...theme } = JSON.parse(readFileSync(new URL(`../default/content/themes/${filename}`, import.meta.url), 'utf8'));
        await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
        await page.route('**/api/settings/get', async route => {
            const response = await route.fetch({ maxRetries: 2 });
            const data = await response.json();
            if (typeof data.settings !== 'string') return route.fulfill({ response });
            const settings = JSON.parse(data.settings);
            settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            Object.assign(settings.power_user, theme, { theme: name, reduced_motion: false });
            data.settings = JSON.stringify(settings);
            await route.fulfill({ response, json: data });
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        const cat = page.locator('[data-neconyan-cat]');
        const toggle = page.locator('[data-neconyan-cat-toggle]');
        await expect(cat).toBeVisible({ timeout: 45000 });
        await expect(page.locator('body')).toHaveCSS('color-scheme', tone.toLowerCase());
        await expect(page.locator('#themes')).toHaveCSS('color-scheme', tone.toLowerCase());
        if (tone === 'Dark') await expect(page.locator('#neconyan-workspace-rail')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.68)');
        await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat\.webp/);
        const earPanel = page.locator('.neconyan-home-intro').first();
        await expect(earPanel).toBeVisible();
        const earPoint = await earPanel.evaluate(element => {
            const box = element.getBoundingClientRect();
            const style = window.getComputedStyle(element, '::before');
            const width = Number.parseFloat(style.width);
            const height = Number.parseFloat(style.height);
            return {
                x: box.left + box.width * 0.1 + width / 2,
                y: box.top - height / 2,
                top: style.top,
                pointerEvents: style.pointerEvents,
            };
        });
        expect(earPoint.top).toBe('0px');
        expect(earPoint.pointerEvents).toBe('auto');
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.neconyan-home-intro') !== null, earPoint)).toBe(true);
        await page.mouse.move(earPoint.x, earPoint.y);
        await expect.poll(() => earPanel.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('neconyan-ear-twitch-left');
        await page.mouse.down();
        await expect.poll(() => earPanel.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('neconyan-ear-press-left');
        await page.mouse.up();
        await page.mouse.move(0, 0);
        const action = page.locator('.neconyan-home-primary').first();
        const head = action.locator('.neconyan-cat-head');
        const whisker = action.locator('.neconyan-whisker-left');
        const restingHead = await head.evaluate(element => window.getComputedStyle(element).transform);
        await action.hover();
        await expect(whisker).toHaveCSS('animation-name', 'neconyan-whisker-twitch');
        await page.mouse.down();
        await expect(head).not.toHaveCSS('transform', restingHead);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await toggle.click();
        await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
        await toggle.click();
        await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat\.webp/);

        await page.locator('#reduced_motion').evaluate(input => {
            input.checked = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(toggle).toBeHidden();
        await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
        await expect.poll(() => earPanel.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('none');
        await action.hover();
        await page.mouse.down();
        await expect(head).toHaveCSS('transform', 'none');
        await expect(whisker).toHaveCSS('animation-name', 'none');
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await toggle.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
        await page.locator('#reduced_motion').evaluate(input => {
            input.checked = false;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(toggle).toBeVisible();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(toggle).toBeHidden();
        await expect(cat).toHaveAttribute('src', /neconyan-pixel-cat-rest\.webp/);
        await expect.poll(() => earPanel.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('none');
        await action.hover();
        await expect(head).toHaveCSS('transform', 'none');
        await expect(whisker).toHaveCSS('animation-name', 'none');
        await page.screenshot({ path: testInfo.outputPath(`${tone.toLowerCase()}-home.png`) });
    });
}

test('one loading cat remains visible through the early-to-popup handoff', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    let releaseScript;
    let releaseSettings;
    const scriptGate = new Promise(resolve => { releaseScript = resolve; });
    const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
    await page.route(/\/script\.js(?:\?|$)/, async route => { await scriptGate; await route.continue(); });
    await page.route('**/api/settings/get', async route => { await settingsGate; await route.continue(); });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    try {
        await page.goto('/', { waitUntil: 'commit' });
        await expect(page.locator('#preloader .neconyan-startup-cat')).toBeVisible();
        // WebKit's main execution context waits on the gated deferred script.
        // Built-in assertions can inspect the early document without that deadlock.
        await expect(page.locator('#preloader')).toHaveCSS('z-index', '9000');
        await expect(page.locator('#preloader')).toHaveCSS('background-color', 'rgb(20, 21, 20)');
        await expect(page.locator('.neconyan-startup-cat:visible')).toHaveCount(1);
        releaseScript();
        await expect(page.locator('.splash-screen .splash-logo.neconyan-startup-cat')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#preloader')).toBeHidden();
        await expect(page.locator('.neconyan-startup-cat:visible')).toHaveCount(1);
        await expect(page.locator('.splash-screen #load-spinner')).toBeHidden();
        await expect(page.locator('.splash-screen')).toHaveText('');
        await expect(page.locator('.popup:has(.splash-screen)')).toHaveCSS('background-color', 'rgb(20, 21, 20)');
        releaseSettings();
        await expect(page.locator('#preloader')).toHaveCount(0, { timeout: 45000 });
        await expect(page.locator('.splash-screen')).toHaveCount(0);
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('after-loading-home.png') });
    } finally {
        releaseScript();
        releaseSettings();
    }
});

for (const width of [320, 390]) {
    test.describe(`touch navigation at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, isMobile: true, hasTouch: true });
        for (const tone of ['Dark', 'Light']) {
            test(`${tone} navigation contrast and held ear press`, async ({ page, context, browserName }, testInfo) => {
                test.skip(browserName !== 'chromium', 'Held touch input is checked through Chromium.');
                const filename = tone === 'Dark' ? 'Neconyan Calico Dark.json' : 'Neconyan Calico.json';
                const { name, ...theme } = JSON.parse(readFileSync(new URL(`../default/content/themes/${filename}`, import.meta.url), 'utf8'));
                await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
                // The update toast would cover the ear this test presses.
                await page.route('**/api/server-admin/status', async route => {
                    const response = await route.fetch({ maxRetries: 2 });
                    const data = await response.json();
                    await route.fulfill({ response, json: { ...data, repository: { ...data.repository, behind: 0 } } });
                });
                await page.route('**/api/settings/get', async route => {
                    const response = await route.fetch({ maxRetries: 2 });
                    const data = await response.json();
                    if (typeof data.settings !== 'string') return route.fulfill({ response });
                    const settings = JSON.parse(data.settings);
                    settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
                    settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                    Object.assign(settings.power_user, theme, { theme: name, reduced_motion: false });
                    data.settings = JSON.stringify(settings);
                    await route.fulfill({ response, json: data });
                });
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
                const panel = page.locator('.neconyan-home-intro');
                const point = await panel.evaluate(element => {
                    const box = element.getBoundingClientRect();
                    const ear = window.getComputedStyle(element, '::before');
                    return { x: box.left + box.width * 0.1 + parseFloat(ear.width) / 2, y: box.top - Math.min(3, parseFloat(ear.height) / 3) };
                });
                expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.neconyan-home-intro') !== null, point)).toBe(true);
                const input = await context.newCDPSession(page);
                try {
                    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
                    await expect.poll(() => panel.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('neconyan-ear-press-left');
                    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await page.emulateMedia({ reducedMotion: 'reduce' });
                    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
                    await expect.poll(() => panel.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('none');
                } finally {
                    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await input.detach();
                }
                await page.locator('#sb-hamburger').tap();
                const mobileRail = page.locator('#neconyan-workspace-rail');
                await expect(mobileRail).toBeVisible();
                const contrasts = await mobileRail.locator('.neconyan-rail-button').evaluateAll(items => items.map(item => {
                    const foreground = window.getComputedStyle(item).color;
                    const layer = window.getComputedStyle(item, '::before');
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d');
                    const luminance = bytes => [...bytes].slice(0, 3).map(value => value / 255)
                        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
                        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
                    const gradientStops = image => {
                        if (image === 'none') return [];
                        if (!/^linear-gradient\(/.test(image)) throw new Error(`Unsupported contrast background: ${image}`);
                        let depth = 0; let start = 0;
                        const stops = []; const contents = image.slice(image.indexOf('(') + 1, -1);
                        for (let index = 0; index <= contents.length; index++) {
                            if (contents[index] === '(') depth++;
                            if (contents[index] === ')') depth--;
                            if (index === contents.length || (contents[index] === ',' && depth === 0)) {
                                const colour = contents.slice(start, index).trim().replace(/(?:\s+-?[\d.]+(?:%|px)){1,2}$/, '');
                                if (window.CSS.supports('color', colour)) stops.push(colour);
                                start = index + 1;
                            }
                        }
                        if (!stops.length) throw new Error(`Missing contrast gradient colours: ${image}`);
                        return stops;
                    };
                    const ancestors = [];
                    for (let node = item; node; node = node.parentElement) ancestors.unshift(window.getComputedStyle(node));
                    if (layer.display !== 'none' && layer.content !== 'none') ancestors.push(layer);
                    // Transparent buttons inherit the painted surface. Check every gradient stop,
                    // rather than interpreting transparency as an opaque black background.
                    let surfaces = ['#fff'];
                    for (const style of ancestors) {
                        const stops = gradientStops(style.backgroundImage);
                        surfaces = surfaces.flatMap(surface => (stops.length ? stops : [null]).map(stop => {
                            context.fillStyle = surface; context.fillRect(0, 0, 1, 1);
                            context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
                            if (stop) { context.fillStyle = stop; context.fillRect(0, 0, 1, 1); }
                            return `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',')})`;
                        }));
                        surfaces = [...new Set(surfaces)];
                    }
                    const ratios = surfaces.map(surface => {
                        context.fillStyle = surface; context.fillRect(0, 0, 1, 1);
                        const background = luminance(context.getImageData(0, 0, 1, 1).data);
                        context.fillStyle = foreground; context.fillRect(0, 0, 1, 1);
                        const ink = luminance(context.getImageData(0, 0, 1, 1).data);
                        return (Math.max(ink, background) + .05) / (Math.min(ink, background) + .05);
                    });
                    return { label: item.textContent, foreground, surfaces, ratio: Math.min(...ratios), opacity: layer.opacity };
                }));
                await testInfo.attach('navigation-contrast', { contentType: 'application/json', body: JSON.stringify(contrasts) });
                expect(contrasts.length).toBeGreaterThan(0);
                for (const contrast of contrasts) {
                    expect(contrast.opacity).toBe('1');
                    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
                }
                const railPaint = await mobileRail.evaluate(element => {
                    const style = window.getComputedStyle(element);
                    return { background: style.backgroundColor, image: style.backgroundImage };
                });
                expect(railPaint.background !== 'rgba(0, 0, 0, 0)' || railPaint.image !== 'none').toBe(true);
                await page.screenshot({ path: testInfo.outputPath(`${tone.toLowerCase()}-navigation-${width}.png`) });
            });
        }
    });
}

test('Starlight Conservatory animates fireflies, lantern sheen and cat glow and pauses under reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch({ maxRetries: 2 });
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response });
        const settings = JSON.parse(data.settings);
        settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.neconyan_shell_style = 'starlight-conservatory';
        settings.power_user.reduced_motion = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'starlight-conservatory');

    const activeMotion = await page.evaluate(() => ({
        wallpaper: window.getComputedStyle(document.body, '::before').backgroundImage,
        fireflies: window.getComputedStyle(document.body, '::after').animationName,
        topBarLantern: window.getComputedStyle(document.querySelector('#top-bar')).animationName,
        homeCatGlow: window.getComputedStyle(document.querySelector('.neconyan-home-cat')).animationName,
        bottomBarGlow: window.getComputedStyle(document.querySelector('#sb-bottom-chat-bar')).animationName,
    }));

    expect(activeMotion.wallpaper).toContain('shell-starlight-conservatory.webp');
    expect(activeMotion.fireflies).toBe('starlight-conservatory-fireflies');
    expect(activeMotion.topBarLantern).toBe('starlight-conservatory-lantern-pulse');
    expect(activeMotion.homeCatGlow).toBe('starlight-conservatory-cat-glow');
    expect(activeMotion.bottomBarGlow).toBe('starlight-conservatory-composer-glow');

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect.poll(() => page.evaluate(() => ({
        fireflies: window.getComputedStyle(document.body, '::after').animationName,
        topBarLantern: window.getComputedStyle(document.querySelector('#top-bar')).animationName,
        homeCatGlow: window.getComputedStyle(document.querySelector('.neconyan-home-cat')).animationName,
        bottomBarGlow: window.getComputedStyle(document.querySelector('#sb-bottom-chat-bar')).animationName,
    }))).toEqual({
        fireflies: 'none',
        topBarLantern: 'none',
        homeCatGlow: 'none',
        bottomBarGlow: 'none',
    });

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = false;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect.poll(() => page.evaluate(() => ({
        fireflies: window.getComputedStyle(document.body, '::after').animationName,
        topBarLantern: window.getComputedStyle(document.querySelector('#top-bar')).animationName,
        homeCatGlow: window.getComputedStyle(document.querySelector('.neconyan-home-cat')).animationName,
        bottomBarGlow: window.getComputedStyle(document.querySelector('#sb-bottom-chat-bar')).animationName,
    }))).toEqual({
        fireflies: 'none',
        topBarLantern: 'none',
        homeCatGlow: 'none',
        bottomBarGlow: 'none',
    });
});


test('Starlight Conservatory paints constellations, sparkles and a pointer trail and freezes them for reduced motion', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch({ maxRetries: 2 });
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response });
        const settings = JSON.parse(data.settings);
        settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.neconyan_shell_style = 'starlight-conservatory';
        settings.power_user.reduced_motion = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.neconyan-home-intro')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'starlight-conservatory');

    const snapshot = () => page.evaluate(() => window.NeconyanStarlightConservatory.snapshot());
    const stage = page.locator('#sb-starlight-conservatory-stage');
    await expect(stage).toHaveCount(1);
    await expect(stage).toHaveAttribute('data-starlight-motion', 'active');

    // Wait until at least one figure has finished drawing itself, not just started to glint.
    await expect.poll(async () => (await snapshot()).constellations.filter(item => item.visible && item.progress > 0.3).length, { timeout: 45000 }).toBeGreaterThan(0);

    const initial = await snapshot();
    expect(initial.motion).toBe('active');
    expect(initial.sparkles).toBeGreaterThan(10);
    expect(initial.layers).toEqual({ sky: true, overlay: true, trail: true });
    expect(initial.constellations.map(item => item.id)).toEqual([
        'corona-felis', 'stellata-palma', 'horologium-muris', 'lyra-mystax', 'felis-somnus', 'caelum-caudae',
    ]);

    const geometry = await page.evaluate(() => {
        const stageElement = document.getElementById('sb-starlight-conservatory-stage');
        const canvases = [...stageElement.querySelectorAll('canvas')];
        return {
            display: window.getComputedStyle(stageElement).display,
            pointerEvents: canvases.map(canvas => window.getComputedStyle(canvas).pointerEvents),
            sizes: canvases.map(canvas => [canvas.width, canvas.height]),
            positions: canvases.map(canvas => window.getComputedStyle(canvas).position),
        };
    });
    expect(geometry.display).toBe('contents');
    expect(geometry.pointerEvents).toEqual(['none', 'none', 'none']);
    expect(geometry.positions).toEqual(['fixed', 'fixed', 'fixed']);
    for (const [width, height] of geometry.sizes) {
        expect(width).toBeGreaterThanOrEqual(1280);
        expect(height).toBeGreaterThanOrEqual(900);
    }

    await page.screenshot({ path: testInfo.outputPath('starlight-sky.png') });

    // A pointer sweep leaves a wake of stars with a companion star riding along.
    for (let step = 0; step <= 26; step += 1) {
        const angle = (step / 26) * Math.PI;
        await page.mouse.move(420 + Math.cos(angle) * 240, 520 - Math.sin(angle) * 180);
        await page.waitForTimeout(16);
    }
    await expect.poll(async () => (await snapshot()).trail, { timeout: 10000 }).toBeGreaterThan(0);
    expect((await snapshot()).companion).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('starlight-sky-trail.png') });

    // Custom accents repaint the sparkles and constellation threads without a reload.
    const before = (await snapshot()).palette;
    await page.evaluate(async () => {
        document.body.style.setProperty('--neco-accent-secondary', '#ff2d95');
        document.body.style.setProperty('--neco-ginger', '#38f5c8');
        document.documentElement.dataset.neconyanAccent = 'custom';
        await new Promise(resolve => setTimeout(resolve, 500));
    });
    const after = (await snapshot()).palette;
    expect(after.secondary).not.toBe(before.secondary);
    expect(after.brass).not.toBe(before.brass);

    // Reduced Motion stops the frame loop and leaves a still sky.
    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(stage).toHaveAttribute('data-starlight-motion', 'still');
    const still = await snapshot();
    expect(still.motion).toBe('still');
    expect(still.trail).toBe(0);
    expect(still.companion).toBe(false);
    const overlay = page.locator('#sb-starlight-conservatory-overlay');
    const frozenA = await overlay.screenshot();
    await page.waitForTimeout(700);
    const frozenB = await overlay.screenshot();
    expect(Buffer.compare(frozenA, frozenB)).toBe(0);

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = false;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(stage).toHaveAttribute('data-starlight-motion', 'active');
});

test('Sunken Reef animates caustic sunbeams, tide sheen and cat buoyancy and pauses under reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch({ maxRetries: 2 });
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response });
        const settings = JSON.parse(data.settings);
        settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.neconyan_shell_style = 'sunken-reef';
        settings.power_user.reduced_motion = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'sunken-reef');

    const activeMotion = await page.evaluate(() => ({
        wallpaper: window.getComputedStyle(document.body, '::before').backgroundImage,
        caustics: window.getComputedStyle(document.body, '::after').animationName,
        topBarTide: window.getComputedStyle(document.querySelector('#top-bar')).animationName,
        homeCatBuoyancy: window.getComputedStyle(document.querySelector('.neconyan-home-cat')).animationName,
        bottomBarTrench: window.getComputedStyle(document.querySelector('#sb-bottom-chat-bar')).animationName,
    }));

    expect(activeMotion.wallpaper).toContain('shell-sunken-reef.webp');
    expect(activeMotion.caustics).toBe('sunken-reef-caustics');
    expect(activeMotion.topBarTide).toBe('sunken-reef-tide-pulse');
    expect(activeMotion.homeCatBuoyancy).toBe('sunken-reef-cat-buoyancy');
    expect(activeMotion.bottomBarTrench).toBe('sunken-reef-trench-composer');

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect.poll(() => page.evaluate(() => ({
        caustics: window.getComputedStyle(document.body, '::after').animationName,
        topBarTide: window.getComputedStyle(document.querySelector('#top-bar')).animationName,
        homeCatBuoyancy: window.getComputedStyle(document.querySelector('.neconyan-home-cat')).animationName,
        bottomBarTrench: window.getComputedStyle(document.querySelector('#sb-bottom-chat-bar')).animationName,
    }))).toEqual({
        caustics: 'none',
        topBarTide: 'none',
        homeCatBuoyancy: 'none',
        bottomBarTrench: 'none',
    });

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = false;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect.poll(() => page.evaluate(() => ({
        caustics: window.getComputedStyle(document.body, '::after').animationName,
        topBarTide: window.getComputedStyle(document.querySelector('#top-bar')).animationName,
        homeCatBuoyancy: window.getComputedStyle(document.querySelector('.neconyan-home-cat')).animationName,
        bottomBarTrench: window.getComputedStyle(document.querySelector('#sb-bottom-chat-bar')).animationName,
    }))).toEqual({
        caustics: 'none',
        topBarTide: 'none',
        homeCatBuoyancy: 'none',
        bottomBarTrench: 'none',
    });
});

test('Sunken Reef paints manta ray, swordfish, axolotl, rising bubbles and a pointer wake and freezes them for reduced motion', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch({ maxRetries: 2 });
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response });
        const settings = JSON.parse(data.settings);
        settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.neconyan_shell_style = 'sunken-reef';
        settings.power_user.reduced_motion = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.neconyan-home-intro')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('html')).toHaveAttribute('data-sb-theme', 'sunken-reef');

    const snapshot = () => page.evaluate(() => window.NeconyanSunkenReef.snapshot());
    const stage = page.locator('#sb-sunken-reef-stage');
    await expect(stage).toHaveCount(1);
    await expect(stage).toHaveAttribute('data-reef-motion', 'active');

    const initial = await snapshot();
    expect(initial.motion).toBe('active');
    expect(initial.bubbles).toBeGreaterThan(20);
    expect(initial.causticBeams).toBeGreaterThanOrEqual(4);
    expect(initial.schoolSize).toBeGreaterThanOrEqual(6);
    expect(initial.layers).toEqual({ backdrop: true, creatures: true, wake: true });
    expect(initial.creatures.map(item => item.id)).toEqual(['manta-ray', 'swordfish', 'axolotl']);

    const geometry = await page.evaluate(() => {
        const stageElement = document.getElementById('sb-sunken-reef-stage');
        const canvases = [...stageElement.querySelectorAll('canvas')];
        return {
            display: window.getComputedStyle(stageElement).display,
            pointerEvents: canvases.map(canvas => window.getComputedStyle(canvas).pointerEvents),
            sizes: canvases.map(canvas => [canvas.width, canvas.height]),
            positions: canvases.map(canvas => window.getComputedStyle(canvas).position),
        };
    });
    expect(geometry.display).toBe('contents');
    expect(geometry.pointerEvents).toEqual(['none', 'none', 'none']);
    expect(geometry.positions).toEqual(['fixed', 'fixed', 'fixed']);
    for (const [width, height] of geometry.sizes) {
        expect(width).toBeGreaterThanOrEqual(1280);
        expect(height).toBeGreaterThanOrEqual(900);
    }

    // The creatures sit below #sheld (30) so message cards and their text stay readable.
    const layering = await page.evaluate(() => ({
        creatures: Number(window.getComputedStyle(document.getElementById('sb-sunken-reef-creatures')).zIndex),
        chat: Number(window.getComputedStyle(document.getElementById('sheld')).zIndex),
        wake: Number(window.getComputedStyle(document.getElementById('sb-sunken-reef-wake')).zIndex),
    }));
    expect(layering.creatures).toBeLessThan(layering.chat);
    expect(layering.wake).toBeGreaterThan(layering.chat);

    await page.screenshot({ path: testInfo.outputPath('sunken-reef-ocean.png') });

    for (let step = 0; step <= 26; step += 1) {
        const angle = (step / 26) * Math.PI;
        await page.mouse.move(420 + Math.cos(angle) * 240, 520 - Math.sin(angle) * 180);
        await page.waitForTimeout(16);
    }
    await expect.poll(async () => (await snapshot()).wakeBubbles, { timeout: 10000 }).toBeGreaterThan(0);
    expect((await snapshot()).wakeRipples).toBeGreaterThan(0);
    expect((await snapshot()).companion).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('sunken-reef-wake.png') });

    const before = (await snapshot()).palette;
    await page.evaluate(async () => {
        document.body.style.setProperty('--neco-accent-secondary', '#00ffd5');
        document.body.style.setProperty('--neco-ginger', '#ff4fa3');
        document.documentElement.dataset.neconyanAccent = 'custom';
        await new Promise(resolve => setTimeout(resolve, 500));
    });
    const after = (await snapshot()).palette;
    expect(after.lagoon).not.toBe(before.lagoon);
    expect(after.coral).not.toBe(before.coral);

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(stage).toHaveAttribute('data-reef-motion', 'still');
    const still = await snapshot();
    expect(still.motion).toBe('still');
    expect(still.wakeBubbles).toBe(0);
    expect(still.wakeRipples).toBe(0);
    expect(still.companion).toBe(false);
    const creaturesCanvas = page.locator('#sb-sunken-reef-creatures');
    const frozenA = await creaturesCanvas.screenshot();
    await page.waitForTimeout(700);
    const frozenB = await creaturesCanvas.screenshot();
    expect(Buffer.compare(frozenA, frozenB)).toBe(0);

    await page.locator('#reduced_motion').evaluate(input => {
        input.checked = false;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(stage).toHaveAttribute('data-reef-motion', 'active');
});

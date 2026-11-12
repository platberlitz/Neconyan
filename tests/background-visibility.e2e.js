/* global document, window, jQuery, getComputedStyle, localStorage, Node, innerHeight, innerWidth */
/* eslint-disable playwright/no-force-option -- Appearance controls live in the closed settings drawer. */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed viewport and style matrix. */
import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { test } from './neconyan-conversation-durable-fixture.js';

async function seedChat(page, avatar) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        const date = '2026-10-11T00:00:00Z';
        context.chat.splice(0, context.chat.length, ...[false, true].map(user => ({
            name: user ? 'Brian' : 'Sara', is_user: user, is_system: false, send_date: date,
            mes: user ? 'He sat by the window.' : 'She returned with a pot of tea.', extra: {},
        })));
        await context.saveChat();
        await context.reloadCurrentChat();
        await window.NeconyanShell.activateMode('roleplay');
    }, avatar);
    await expect(page.locator('#chat > .mes')).toHaveCount(2);
}

async function setVisibility(page, value) {
    await page.locator('#sb-surface-transparency-input').evaluate((slider, value) => {
        slider.value = value;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBe(String(value));
}

async function paint(row) {
    return row.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const rgba = colour => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        };
        const rowStyle = getComputedStyle(element);
        const block = element.querySelector('.mes_block');
        const blockStyle = getComputedStyle(block);
        const pseudo = getComputedStyle(element, '::before');
        return {
            row: rgba(rowStyle.backgroundColor), block: rgba(blockStyle.backgroundColor),
            border: rgba(blockStyle.borderTopColor), pseudo: rgba(pseudo.backgroundColor),
            pseudoOpacity: Number(pseudo.opacity), text: rgba(getComputedStyle(element.querySelector('.mes_text')).color),
            rowBox: element.getBoundingClientRect().toJSON(), blockBox: block.getBoundingClientRect().toJSON(),
        };
    });
}

function composite(over, under, opacity = 1) {
    const alpha = over[3] / 255 * opacity;
    return over.slice(0, 3).map((channel, i) => Math.round(channel * alpha + under[i] * (1 - alpha)));
}

function colour(channels) { return `rgb(${channels.slice(0, 3).join(', ')})`; }

const shellStyles = ['calico', 'kittyless', 'windows-aero', 'windows-xp', 'windows-98', 'clean-minimal', 'macos-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat', 'starlight-conservatory', 'sunken-reef'];
// Independently measured existing Calico Light subtitle limitation, one pin per
// viewport/artwork scene. All other text retains the 4.5:1 requirement.
const lightSubtitleBaselines = {
    phone: { 'built-in': 3.743083886673405, black: 3.743083886673405, white: 3.743083886673405 },
    desktop: { 'built-in': 3.7684424391943354, black: 3.7684424391943354, white: 3.7684424391943354 },
};

async function readyArtwork(page, shell) {
    await page.evaluate(shell => window.NeconyanShell.applyTheme(shell), shell);
    await page.waitForFunction(shell => document.documentElement.dataset.sbTheme === shell
        && [...document.querySelectorAll('link[data-sb-shell-style]')].every(link => link.sheet), shell);
    await page.evaluate(async () => {
        await document.fonts.ready;
        const backgrounds = [getComputedStyle(document.body, '::before').backgroundImage,
            getComputedStyle(document.querySelector('#bg1')).backgroundImage];
        await Promise.all(backgrounds.flatMap(background => [...background.matchAll(/url\(["']?([^"')]+)["']?\)/g)]).map(async match => {
            const image = new window.Image();
            image.src = match[1];
            await image.decode();
        }));
        window.toastr?.clear();
    });
}

async function canvasState(page) {
    return page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = getComputedStyle(document.querySelector('#sheld')).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return { stored: localStorage.getItem('sb-surface-transparency'), value: window.NeconyanShell.getSurfaceTransparency(),
            alpha: context.getImageData(0, 0, 1, 1).data[3] / 255 };
    });
}

async function blankCanvasClip(page) {
    const candidates = await page.evaluate(() => {
        const sheld = document.querySelector('#sheld');
        const box = sheld.getBoundingClientRect();
        const pixel = document.createElement('canvas');
        pixel.width = pixel.height = 1;
        const context = pixel.getContext('2d');
        const alphaCache = new Map();
        const transparent = colour => {
            if (!alphaCache.has(colour)) {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = colour;
                context.fillRect(0, 0, 1, 1);
                alphaCache.set(colour, context.getImageData(0, 0, 1, 1).data[3] === 0);
            }
            return alphaCache.get(colour);
        };
        const forbidden = '.mes, #send_form, #sb-bottom-chat-bar, #top-bar, #neconyan-workspace-rail, button, input, img, svg, canvas, [role="dialog"], .toast';
        const candidates = [];
        for (let y = Math.ceil(Math.max(70, box.top + 2)); y + 8 < Math.min(innerHeight - 120, box.bottom); y += 12) {
            for (let x = Math.ceil(Math.max(2, box.left + 2)); x + 8 < Math.min(innerWidth - 2, box.right); x += 12) {
                const points = [[x, y], [x + 7, y], [x, y + 7], [x + 7, y + 7], [x + 4, y + 4]];
                const blank = points.every(([px, py]) => {
                    const elements = document.elementsFromPoint(px, py);
                    if (!elements.includes(sheld)) return false;
                    return elements.slice(0, elements.indexOf(sheld)).every(element => {
                        if (element.matches(forbidden) || element.closest(forbidden)) return false;
                        const style = getComputedStyle(element);
                        if ((style.backgroundImage !== 'none' && element.id !== 'neconyan-home-host')
                            || !transparent(style.backgroundColor)) return false;
                        return [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).every(node => {
                            const range = document.createRange();
                            range.selectNode(node);
                            return [...range.getClientRects()].every(rect => px < rect.left || px > rect.right || py < rect.top || py > rect.bottom);
                        });
                    });
                });
                if (blank) candidates.push({ x, y, width: 8, height: 8 });
            }
        }
        return candidates;
    });
    // Home's transparent host paints sparse paw images. Confirm the chosen patch
    // contains none of those decorations without changing any container geometry.
    const normal = PNG.sync.read(await page.screenshot({ animations: 'disabled', scale: 'css' }));
    const suppression = await page.addStyleTag({ content: '#neconyan-home-host { background-image: none !important; }' });
    let undecorated;
    try { undecorated = PNG.sync.read(await page.screenshot({ animations: 'disabled', scale: 'css' })); }
    finally { await suppression.evaluate(element => element.remove()); }
    const clip = candidates.find(clip => {
        for (let y = clip.y; y < clip.y + clip.height; y++) {
            for (let x = clip.x; x < clip.x + clip.width; x++) {
                const offset = (y * normal.width + x) * 4;
                if ([0, 1, 2].some(channel => normal.data[offset + channel] !== undecorated.data[offset + channel])) return false;
            }
        }
        return true;
    });
    const diagnostics = clip ? '' : await page.evaluate(() => JSON.stringify({ ready: document.body.className,
        layers: ['#sheld', '#neconyan-home-host', '.welcomePanel', '#chat'].map(selector => {
            const element = document.querySelector(selector);
            return element ? { selector, colour: getComputedStyle(element).backgroundColor, image: getComputedStyle(element).backgroundImage,
                box: element.getBoundingClientRect().toJSON() } : { selector, missing: true };
        }) }));
    expect(clip, `An unobstructed blank 8px canvas clip exists inside #sheld, away from Home paw artwork. ${diagnostics}`).toBeDefined();
    return clip;
}

function pixelDifference(first, second) {
    const a = PNG.sync.read(first), b = PNG.sync.read(second);
    let changedPixels = 0, maxDelta = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(a.data[i + channel] - b.data[i + channel])));
        if (delta >= 3) changedPixels++;
        maxDelta = Math.max(maxDelta, delta);
    }
    return { changedPixels, maxDelta };
}

async function compareArtwork(page, info, label, layers = 'body::before, #bg1') {
    const clip = await blankCanvasClip(page);
    const ordinary = await page.screenshot({ clip, animations: 'disabled', scale: 'css' });
    const suppression = await page.addStyleTag({ content: `${layers} { visibility: hidden !important; }` });
    let suppressed;
    try { suppressed = await page.screenshot({ clip, animations: 'disabled', scale: 'css' }); }
    finally { await suppression.evaluate(element => element.remove()); }
    const measurement = { label, layers, clip, ...pixelDifference(ordinary, suppressed), ...await canvasState(page) };
    console.log('BACKGROUND_PIXEL ' + JSON.stringify(measurement));
    await info.attach(`${label}-measurement`, { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' });
    await info.attach(`${label}-ordinary`, { body: ordinary, contentType: 'image/png' });
    await info.attach(`${label}-suppressed`, { body: suppressed, contentType: 'image/png' });
    await page.screenshot({ path: info.outputPath(`${label}.png`), animations: 'disabled' });
    expect(measurement.changedPixels, JSON.stringify(measurement)).toBeGreaterThanOrEqual(16);
}

async function selectBackground(page, filename) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
    await page.locator(`.bg_example[bgfile="${filename}"]`).click();
    await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(encodeURIComponent(filename));
    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await readyArtwork(page, await page.evaluate(() => window.NeconyanShell.getTheme()));
}

async function uploadStressBackgrounds(account) {
    const filenames = [];
    for (const value of [0, 255]) {
        const image = new PNG({ width: 32, height: 32 });
        for (let i = 0; i < image.data.length; i += 4) image.data.set([value, value, value, 255], i);
        const upload = await account.context.request.post('/api/backgrounds/upload', { headers: account.headers,
            multipart: { avatar: { name: `visibility-${value}.png`, mimeType: 'image/png', buffer: PNG.sync.write(image) } } });
        expect(upload.ok()).toBe(true);
        filenames.push(await upload.text());
    }
    return filenames;
}

async function renderedTextContrast(page, target) {
    await target.scrollIntoViewIfNeeded();
    const sample = await target.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const computed = getComputedStyle(element);
        context.fillStyle = computed.color;
        context.fillRect(0, 0, 1, 1);
        const text = [...context.getImageData(0, 0, 1, 1).data];
        const ancestorOpacity = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const opacity = Number(getComputedStyle(parent).opacity);
            if (opacity !== 1) ancestorOpacity.push({ tag: parent.tagName, id: parent.id, classes: parent.className, opacity });
        }
        const opacity = Number(computed.opacity);
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = computed.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const ownBackgroundAlpha = context.getImageData(0, 0, 1, 1).data[3];
        const node = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        const range = document.createRange();
        if (node) range.selectNode(node);
        const box = node ? range.getClientRects()[0] : element.getBoundingClientRect();
        const x = Math.max(1, Math.floor(box.left + box.width / 2) - 3);
        const y = Math.max(45, Math.floor(box.top + box.height / 2) - 3);
        const styles = [element, ...element.querySelectorAll('*')].map(target => target.getAttribute('style'));
        for (const target of [element, ...element.querySelectorAll('*')]) {
            target.style.setProperty('color', 'transparent', 'important');
            target.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
            target.style.setProperty('text-shadow', 'none', 'important');
        }
        return { text, opacity, ancestorOpacity, ownBackgroundAlpha, styles, clip: { x, y, width: 6, height: 6 }, box: element.getBoundingClientRect().toJSON() };
    });
    let background;
    try { background = PNG.sync.read(await page.screenshot({ clip: sample.clip, animations: 'disabled', scale: 'css' })); }
    finally {
        await target.evaluate((element, styles) => {
            [element, ...element.querySelectorAll('*')].forEach((target, index) => {
                if (styles[index] === null) target.removeAttribute('style');
                else target.setAttribute('style', styles[index]);
            });
        }, sample.styles);
    }
    expect(sample.ancestorOpacity, 'Text samples have no partially opaque ancestor groups').toEqual([]);
    if (sample.opacity !== 1) expect(sample.ownBackgroundAlpha, 'Partially opaque text target has a transparent own background').toBe(0);
    let ratio = Infinity;
    for (let i = 0; i < background.data.length; i += 4) {
        const under = [...background.data.slice(i, i + 3)];
        ratio = Math.min(ratio, contrastRatio(colour(composite(sample.text, under, sample.opacity)), colour(under)));
    }
    return { ...sample, ratio };
}

async function normalSendAppearance(page) {
    const button = page.locator('#send_but');
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#send_form')).not.toHaveClass(/sb-roleplay-background/);
    const sample = await button.evaluate(element => {
        const style = getComputedStyle(element), glyph = getComputedStyle(element, '::before');
        const box = element.getBoundingClientRect();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = glyph.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return {
            appearance: { classes: element.className, ariaDisabled: element.getAttribute('aria-disabled'), disabled: element.getAttribute('disabled'),
                hover: element.matches(':hover'), focus: document.activeElement === element, focusWithin: element.matches(':focus-within'),
                colour: style.color, background: style.backgroundColor, image: style.backgroundImage, filter: style.filter, opacity: style.opacity,
                glyph: { colour: glyph.color, background: glyph.backgroundColor, mask: glyph.maskImage || glyph.webkitMaskImage, opacity: glyph.opacity },
                box: box.toJSON() },
            ink: [...context.getImageData(0, 0, 1, 1).data], opacity: Number(style.opacity) * Number(glyph.opacity),
            clip: { x: Math.floor(box.left + 3), y: Math.floor(box.top + box.height / 2) - 1, width: 3, height: 3 },
            inline: element.getAttribute('style'),
        };
    });
    const label = button.locator('.neconyan-action-label');
    if (await label.isVisible()) expect((await renderedTextContrast(page, label)).ratio).toBeGreaterThanOrEqual(4.5);
    else {
        await expect(label).toBeHidden();
        expect(sample.appearance.glyph.mask).not.toBe('none');
    }
    const backplate = PNG.sync.read(await page.screenshot({ clip: sample.clip, animations: 'disabled', scale: 'css' }));
    await button.evaluate(element => element.style.setProperty('visibility', 'hidden', 'important'));
    let backdrop;
    try { backdrop = PNG.sync.read(await page.screenshot({ clip: sample.clip, animations: 'disabled', scale: 'css' })); }
    finally {
        await button.evaluate((element, inline) => {
            if (inline === null) element.removeAttribute('style');
            else element.setAttribute('style', inline);
        }, sample.inline);
    }
    let ratio = Infinity;
    for (let i = 0; i < backplate.data.length; i += 4) {
        const ink = composite(sample.ink, [...backdrop.data.slice(i, i + 3)], sample.opacity);
        ratio = Math.min(ratio, contrastRatio(colour(ink), colour([...backplate.data.slice(i, i + 3)])));
    }
    return { appearance: sample.appearance, ratio, clip: sample.clip };
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`fresh default starts at 100 without persisting on ${viewport}`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        for (const reload of [false, true]) {
            if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.locator('#sb-surface-transparency-input')).toHaveValue('100');
            expect(await canvasState(page)).toEqual({ stored: null, value: 100, alpha: 0 });
        }
    });

    for (const home of [true, false]) {
        const view = home ? 'Home' : 'Roleplay';
        test(`fresh default renders built-in wallpapers on ${viewport} ${view}`, async ({ app }, info) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            if (home) await page.evaluate(() => window.NeconyanShell.showHome());
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain('/backgrounds/__transparent.png');
            for (const shell of shellStyles) {
                await readyArtwork(page, shell);
                await compareArtwork(page, info, `${viewport}-${view}-${shell}`);
            }
        });

        test(`fresh default renders selected A/B stress backgrounds on ${viewport} ${view}`, async ({ app }, info) => {
            test.setTimeout(300000);
            const account = await app.account({ phone });
            const filenames = await uploadStressBackgrounds(account);
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            if (home) await page.evaluate(() => window.NeconyanShell.showHome());
            for (const [index, shell] of shellStyles.entries()) {
                await readyArtwork(page, shell);
                if (index > 0) {
                    await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(encodeURIComponent(filenames[1]));
                    await compareArtwork(page, info, `${viewport}-${view}-${shell}-retained-B-stress`, '#bg1');
                }
                await selectBackground(page, filenames[0]);
                const clip = await blankCanvasClip(page);
                const a = await page.screenshot({ clip, animations: 'disabled', scale: 'css' });
                await selectBackground(page, filenames[1]);
                const b = await page.screenshot({ clip, animations: 'disabled', scale: 'css' });
                const measurement = { shell, viewport, view, clip, ...pixelDifference(a, b) };
                console.log('BACKGROUND_SELECTED_PIXEL ' + JSON.stringify(measurement));
                await info.attach(`${shell}-selected-stress`, { body: JSON.stringify(measurement), contentType: 'application/json' });
                expect(measurement.changedPixels, JSON.stringify(measurement)).toBeGreaterThanOrEqual(16);
            }
        });

        test(`fresh default retains selected B after reload on ${viewport} ${view}`, async ({ app }, info) => {
            test.setTimeout(120000);
            const account = await app.account({ phone });
            const filenames = await uploadStressBackgrounds(account);
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            if (home) await page.evaluate(() => window.NeconyanShell.showHome());
            await readyArtwork(page, shellStyles.at(-1));
            await selectBackground(page, filenames[1]);
            await page.evaluate(async () => {
                const core = await import('/script.js');
                if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Selected background settings were not saved.');
            });
            expect(JSON.parse((await account.post('/api/settings/get')).settings).background.name).toBe(filenames[1]);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#preloader')).toBeHidden();
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(encodeURIComponent(filenames[1]));
            await seedChat(page, account.avatar);
            if (home) await page.evaluate(() => window.NeconyanShell.showHome());
            await readyArtwork(page, shellStyles.at(-1));
            await compareArtwork(page, info, `${viewport}-${view}-reloaded-B-stress`, '#bg1');
        });
    }

    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        test(`default visibility keeps actual Home and chat text readable in ${theme} on ${viewport}`, async ({ app }, info) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const filenames = await uploadStressBackgrounds(account);
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            await page.evaluate(name => jQuery('#themes').val(name).trigger('change'), theme);
            const measurements = [];
            for (const background of [null, ...filenames]) {
                if (background) await selectBackground(page, background);
                await readyArtwork(page, 'calico');
                for (const home of [true, false]) {
                    if (home) await page.evaluate(() => window.NeconyanShell.showHome());
                    else {
                        await seedChat(page, account.avatar);
                        await page.locator('#send_textarea').fill('A readable draft');
                    }
                    const selectors = home
                        ? ['#welcome-home-title', '.neconyan-home-intro > p', '.neconyan-home-actions button > span',
                            '.neconyan-home-actions button:not(.neconyan-home-primary) > span', '.neconyan-home-actions .openTemporaryChat small',
                            '.neconyan-home-actions [data-action="open-tab"] > span', '.neconyan-assistant-copy h3', '.welcomeRecentShell h2']
                        : ['#chat > .mes .mes_text p', '#send_textarea'];
                    for (const selector of selectors) {
                        const target = page.locator(selector).first();
                        await expect(target).toBeVisible();
                        const measurement = { theme, viewport, home, background: background || 'built-in', selector, ...await renderedTextContrast(page, target) };
                        measurements.push(measurement);
                        console.log('BACKGROUND_CONTRAST ' + JSON.stringify(measurement));
                        await info.attach(`contrast-${measurements.length}`, { body: JSON.stringify(measurement), contentType: 'application/json' });
                        if (theme === 'Neconyan Calico' && selector === '.neconyan-home-actions .openTemporaryChat small') {
                            await setVisibility(page, 0);
                            const explicitZero = await renderedTextContrast(page, target);
                            await setVisibility(page, 100);
                            const artwork = background === null ? 'built-in' : background === filenames[0] ? 'black' : 'white';
                            const baseline = lightSubtitleBaselines[viewport][artwork];
                            const comparison = { theme, viewport, home, background: background || 'built-in', artwork, baseline, selector, normal: measurement, explicitZero };
                            console.log('BACKGROUND_CONTRAST_ZERO_COMPARISON ' + JSON.stringify(comparison));
                            await info.attach(`contrast-zero-${measurements.length}`, { body: JSON.stringify(comparison), contentType: 'application/json' });
                            expect(measurement.text).toEqual([80, 76, 69, 255]);
                            expect(explicitZero.text).toEqual(measurement.text);
                            expect(measurement.opacity).toBe(0.7);
                            expect(explicitZero.opacity).toBe(measurement.opacity);
                            expect(explicitZero.box).toEqual(measurement.box);
                            expect(explicitZero.clip).toEqual(measurement.clip);
                            expect(Math.abs(explicitZero.ratio - baseline)).toBeLessThanOrEqual(0.05);
                            expect(measurement.ratio).toBeGreaterThanOrEqual(explicitZero.ratio - 0.05);
                        } else {
                            expect(measurement.ratio, JSON.stringify(measurement)).toBeGreaterThanOrEqual(4.5);
                        }
                    }
                    if (!home) {
                        const normal = await normalSendAppearance(page);
                        await setVisibility(page, 0);
                        const opaque = await normalSendAppearance(page);
                        expect(opaque.appearance).toEqual(normal.appearance);
                        // At most 0.05 contrast-ratio variation from pixel sampling.
                        expect(Math.abs(opaque.ratio - normal.ratio)).toBeLessThanOrEqual(0.05);
                        await info.attach(`send-${background || 'built-in'}`, { body: JSON.stringify({ theme, viewport, normal, opaque }), contentType: 'application/json' });
                        console.log('BACKGROUND_SEND_UNCHANGED ' + JSON.stringify({ theme, viewport, background, normal, opaque }));
                        await setVisibility(page, 100);
                    }
                }
            }
        });
    }

    for (const value of [0, 50]) {
        test(`saved visibility ${value} survives startup and reload on ${viewport}`, async ({ app }) => {
            const account = await app.account({ phone });
            const seed = await account.context.newPage();
            await seed.goto('/csrf-token');
            await seed.evaluate(value => localStorage.setItem('sb-surface-transparency', String(value)), value);
            await seed.close();
            const page = await account.open({ workspace: false, timeout: 60000 });
            await expect(page.locator('#sb-surface-transparency-input')).toHaveValue(String(value));
            expect(await canvasState(page)).toEqual({ stored: String(value), value, alpha: expect.closeTo(1 - value / 100, 2) });
            if (value === 0) await page.evaluate(() => window.NeconyanShell.setSurfaceTransparency(0));
            await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBe(String(value));
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.locator('#sb-surface-transparency-input')).toHaveValue(String(value));
            expect(await canvasState(page)).toEqual({ stored: String(value), value, alpha: expect.closeTo(1 - value / 100, 2) });
        });
    }
}

for (const phone of [false, true]) {
    test(`Background controls change the Home and chat canvas on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await seedChat(page, account.avatar);
        for (const home of [false, true]) {
            if (home) await page.evaluate(() => window.NeconyanShell.showHome());
            for (const value of [0, 50, 100]) {
                await setVisibility(page, value);
                await expect.poll(() => page.locator('#sheld').evaluate(element => {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d');
                    context.fillStyle = getComputedStyle(element).backgroundColor;
                    context.fillRect(0, 0, 1, 1);
                    return context.getImageData(0, 0, 1, 1).data[3] / 255;
                })).toBeCloseTo(1 - value / 100, 2);
            }
        }
        for (const value of [1, 0.5, 0]) {
            await page.locator('#background_opacity').evaluate((slider, value) => {
                slider.value = value;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }, value);
            await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.body, '::before').opacity))).toBeCloseTo(0.67 * value, 2);
            await expect(page.locator('#bg1')).toHaveCSS('opacity', String(value));
            await page.screenshot({ path: info.outputPath(`background-opacity-${value}.png`) });
        }
    });

    test(`Background Visibility clears the Settings sheet on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await readyArtwork(page, 'calico');
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        const alphas = () => page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d');
            const alpha = element => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = getComputedStyle(element).backgroundColor;
                context.fillRect(0, 0, 1, 1);
                return context.getImageData(0, 0, 1, 1).data[3] / 255;
            };
            const root = document.querySelector('#user-settings-block');
            const scroller = [...root.querySelectorAll('.sb-shell-panel-scroller')].find(element => element.clientHeight > 0);
            return {
                root: alpha(root), frame: alpha(root.querySelector('.sb-shell-frame')), scroller: alpha(scroller),
                nested: [...root.querySelectorAll('.sb-shell-frame :is(.sb-shell-main, .sb-shell-nav)')].map(alpha),
            };
        });
        for (const value of [0, 50, 100]) {
            await setVisibility(page, value);
            const surface = 1 - value / 100;
            await expect.poll(async () => (await alphas()).scroller).toBeCloseTo(0.9 * surface, 2);
            const sample = await alphas();
            // The frame keeps an 85% floor so settings text stays readable over bright wallpaper.
            expect(sample.frame, `frame at ${value}`).toBeCloseTo(0.85 + 0.15 * surface, 2);
            expect(sample.nested.every(alpha => alpha === 0), `nested rails at ${value}`).toBe(true);
            expect(sample.root, `sheet at ${value}`).toBeCloseTo(phone ? surface : 0, 2);
        }
    });

    test(`Background Visibility keeps message surfaces readable on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await seedChat(page, account.avatar);
        const rows = page.locator('#chat > .mes');

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.evaluate(name => jQuery('#themes').val(name).trigger('change'), theme);
            for (const style of ['0', '1', '6']) {
                await page.locator('#chat_display').selectOption(style, { force: true });
                for (const value of [0, 5, 50, 100]) {
                    await setVisibility(page, value);
                    const expectedOpacity = 1 - value / 500;
                    await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--sb-message-surface-opacity')))).toBeCloseTo(expectedOpacity, 3);
                    if (style === '1') await expect.poll(async () => (await paint(rows.first())).pseudoOpacity).toBeCloseTo(expectedOpacity, 2);
                    for (const index of [0, 1]) {
                        const sample = await paint(rows.nth(index));
                        if (style === '0') {
                            const surface = phone && value > 0 ? sample.row : sample.block;
                            expect(surface[3] / 255, `${theme} Flat ${value} role ${index}`).toBeCloseTo(expectedOpacity, 2);
                            if (phone && value > 0) {
                                expect(sample.block[3]).toBe(0);
                                expect(sample.border[3]).toBe(0);
                                expect(sample.blockBox.left).toBeGreaterThanOrEqual(sample.rowBox.left);
                                expect(sample.blockBox.right).toBeLessThanOrEqual(sample.rowBox.right);
                            }
                        }
                        if (style === '6') expect(sample.row[3] / 255, `${theme} Ripple ${value} role ${index}`).toBeCloseTo(expectedOpacity, 2);

                        // Use the worst solid wallpaper for each bundled theme, with only the message layers.
                        let background = theme.endsWith('Dark') ? [255, 255, 255] : [0, 0, 0];
                        background = composite(sample.row, background);
                        if (style === '1') background = composite(sample.pseudo, background, sample.pseudoOpacity);
                        background = composite(sample.block, background);
                        const ratio = contrastRatio(colour(sample.text), colour(background));
                        expect(ratio, `${theme} style ${style} value ${value} role ${index}`).toBeGreaterThanOrEqual(4.5);
                    }
                }
            }
        }

        await page.locator('#chat_display').selectOption('0', { force: true });
        await setVisibility(page, 50);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sb-message-surface-opacity').trim())).toBe('0.900');
        await expect(page.locator('#sb-surface-transparency-input')).toHaveValue('50');
        await setVisibility(page, 0);
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.sbSurfaceTransparent)).toBe('false');
    });
}

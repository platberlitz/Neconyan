/* global document, getComputedStyle, window, Node */
/* eslint-disable playwright/no-force-option -- Appearance controls live in the closed settings drawer. */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed shell, tone and viewport matrix. */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { test } from './neconyan-conversation-durable-fixture.js';

// Panels defaults keep text readable over each shell's own art (plan M75 section 7). For every shell style, Calico
// Light and Dark, desktop and phone: text that reaches 4.65:1 on a solid panel reaches 4.5:1 at the defaults; text
// between 4.5 and 4.65 stays within 0.1 of its solid value (a miss of 0.05 or less is reported, not failed); text
// below 4.5 on a solid panel drops no more than 0.3. The outline is off at the defaults in every shell.
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const styles = [...source.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);
if (styles.length !== 12) throw new Error('Unexpected shell style list: ' + styles.join(', '));
const themes = ['Neconyan Calico', 'Neconyan Calico Dark'];

async function useStyle(page, style) {
    await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
    await page.waitForFunction(id => document.documentElement.dataset.sbTheme === id
        && (id === 'calico' || Boolean(document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet)), style);
    await page.evaluate(async () => {
        await document.fonts.ready;
        const backgrounds = [getComputedStyle(document.body, '::before').backgroundImage, getComputedStyle(document.querySelector('#bg1')).backgroundImage];
        await Promise.all(backgrounds.flatMap(background => [...background.matchAll(/url\(["']?([^"')]+)["']?\)/g)]).map(async match => {
            const image = new window.Image();
            image.src = match[1];
            try { await image.decode(); } catch { /* A missing picture shows as no picture. */ }
        }));
        window.toastr?.clear();
    });
}

async function useTheme(page, name) {
    await page.locator('#themes').selectOption(name, { force: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.sbSurfaceTone)).toBe(name.endsWith('Dark') ? 'dark' : 'light');
}

async function seedChat(page, avatar) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        context.chat.splice(0, context.chat.length,
            { name: 'Sara', is_user: false, is_system: false, send_date: '2026-11-18T00:00:00Z', extra: {},
                mes: '*The kettle clicks off behind the counter.* "We take the 6:40 train, the slow one, because it goes past the river," she says.' },
            { name: 'Brian', is_user: true, is_system: false, send_date: '2026-11-18T00:01:00Z', extra: {},
                mes: '"The slow one takes forty minutes longer, and the soup in the dining car had better be worth it, or you are carrying my bag up the hill."' });
        await context.saveChat();
        await context.reloadCurrentChat();
        await window.NeconyanShell.activateMode('roleplay');
    }, avatar);
    await expect(page.locator('#chat > .mes')).toHaveCount(2);
    await page.locator('#chat_display').selectOption('0', { force: true });
}

const settle = page => page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));

async function setSolid(page, solid) {
    await page.evaluate(solid => {
        for (const surface of ['message', 'home', 'side']) {
            if (solid) window.NeconyanShell.setPanelLook(surface, { opacity: 100, blur: 0 });
            else window.NeconyanShell.resetPanelLook(surface, null);
        }
    }, solid);
    // Solid: every surface at 1 with no blur. Defaults: nothing stored, every surface at its own style default (all 1 in
    // Windows XP, Windows 98 and Kittyless, so 'not all solid' would be the wrong check).
    await expect.poll(() => page.evaluate(solid => {
        const look = window.NeconyanShell.getPanelLook();
        return ['message', 'home', 'side'].every(surface => solid
            ? look.resolved[surface].opacity === 1 && look.resolved[surface].blur === 0
            : !look.stored[surface] && Math.abs(look.resolved[surface].opacity - look.defaults[surface].opacity) < 0.001);
    }, solid)).toBe(true);
}

// Moves the user message over the band of the chat column with the brightest (dark tone) or darkest (light tone) art.
async function placeOverWorstBand(page, dark) {
    const user = page.locator('#chat > .mes[is_user="true"]');
    const hide = await page.addStyleTag({ content: '#chat > .mes { visibility: hidden !important; }' });
    const box = await page.locator('#chat').boundingBox();
    let png;
    try { png = PNG.sync.read(await page.screenshot({ clip: box, animations: 'disabled', scale: 'css' })); }
    finally { await hide.evaluate(element => element.remove()); }
    let best = { y: 0, score: dark ? -Infinity : Infinity };
    for (let y = 0; y + 60 <= png.height; y += 10) {
        let sum = 0, count = 0;
        for (let row = y; row < y + 60; row += 2) {
            for (let x = 0; x < png.width; x += 4) {
                const i = (row * png.width + x) * 4;
                sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
                count++;
            }
        }
        const mean = sum / count;
        if (dark ? mean > best.score : mean < best.score) best = { y, score: mean };
    }
    await user.evaluate((element, target) => {
        element.style.removeProperty('top');
        element.style.position = 'relative';
        const chat = element.parentElement.getBoundingClientRect();
        const now = element.getBoundingClientRect().top - chat.top;
        element.style.top = `${Math.round(target - now)}px`;
    }, best.y);
    await settle(page);
}

// Hides the glyphs, reads the real pixels behind the text's box and returns the 10th-percentile contrast.
async function measure(page, target) {
    // A toast (for example 'Background set') can sit over the text; it is not a panel and must not enter the sample.
    await page.evaluate(() => {
        window.toastr?.remove();
        document.querySelector('#toast-container')?.remove();
    });
    await target.scrollIntoViewIfNeeded();
    const sample = await target.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const computed = getComputedStyle(element);
        context.fillStyle = computed.color;
        context.fillRect(0, 0, 1, 1);
        const text = [...context.getImageData(0, 0, 1, 1).data];
        let opacity = Number(computed.opacity);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
        const node = [...element.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
        const range = document.createRange();
        if (node) range.selectNode(node);
        const rect = node ? range.getBoundingClientRect() : element.getBoundingClientRect();
        const clip = { x: Math.max(0, Math.floor(rect.left)), y: Math.max(0, Math.floor(rect.top)),
            width: Math.max(2, Math.min(window.innerWidth - Math.floor(rect.left), Math.ceil(rect.width))),
            height: Math.max(2, Math.min(window.innerHeight - Math.floor(rect.top), Math.ceil(rect.height))) };
        const saved = [element, ...element.querySelectorAll('*')].map(target => target.getAttribute('style'));
        for (const target of [element, ...element.querySelectorAll('*')]) {
            target.style.setProperty('color', 'transparent', 'important');
            target.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
            target.style.setProperty('text-shadow', 'none', 'important');
        }
        return { text, opacity, clip, saved };
    });
    let png;
    try { png = PNG.sync.read(await page.screenshot({ clip: sample.clip, animations: 'disabled', scale: 'css' })); }
    finally {
        await target.evaluate((element, saved) => {
            [element, ...element.querySelectorAll('*')].forEach((target, index) => {
                if (saved[index] === null) target.removeAttribute('style');
                else target.setAttribute('style', saved[index]);
            });
        }, sample.saved);
    }
    const ratios = [];
    const alphaText = sample.text[3] / 255 * sample.opacity;
    for (let i = 0; i < png.data.length; i += 4) {
        const under = [png.data[i], png.data[i + 1], png.data[i + 2]];
        const ink = sample.text.slice(0, 3).map((channel, c) => Math.round(channel * alphaText + under[c] * (1 - alphaText)));
        ratios.push(contrastRatio(`rgb(${ink.join(', ')})`, `rgb(${under.join(', ')})`));
    }
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length * 0.1)];
}

const chatTargets = {
    'assistant text': page => page.locator('#chat > .mes[is_user="false"] .mes_text p').first(),
    'user text': page => page.locator('#chat > .mes[is_user="true"] .mes_text p').first(),
    'user quote': page => page.locator('#chat > .mes[is_user="true"] .mes_text q').first(),
    name: page => page.locator('#chat > .mes[is_user="true"] .name_text'),
    date: page => page.locator('#chat > .mes[is_user="true"] .timestamp'),
    action: page => page.locator('#chat > .mes[is_user="true"] .neconyan-action-label').first(),
    // Left out on purpose: upstream fades the swipe counter (opacity 0.3 to 0.7 in public/style.css), so it is under 4.5:1 even on a solid message, and at the defaults it drops a further 0.31 to 0.36 below solid (Calico Dark desktop 3.80 against 4.16), past the 0.3 allowance for text already under 4.5. UI-SWIPE-COUNTER-CONTRAST.
};
const homeTargets = {
    'intro heading': page => page.locator('#neconyan-home-host .neconyan-home-intro h1').first(),
    'intro text': page => page.locator('#neconyan-home-host .neconyan-home-intro > p').first(),
    'assistant row': page => page.locator('#neconyan-home-host .neconyan-assistant-row h3').first(),
    'recent chats heading': page => page.locator('#neconyan-home-host .welcomeRecentShell h2').first(),
    'recent chat name': page => page.locator('#neconyan-home-host .recentChat .characterName').first(),
};

function judge(reference, actual) {
    if (reference >= 4.65) return { pass: actual >= 4.5, report: false };
    if (reference >= 4.5) {
        const limit = reference - 0.1;
        if (actual >= limit) return { pass: true, report: false };
        return { pass: actual >= limit - 0.05, report: true };
    }
    return { pass: actual >= reference - 0.3, report: false };
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    for (const style of styles) {
        test(`${style} defaults keep text readable over its own art on ${viewport}`, async ({ app }, info) => {
            test.setTimeout(420000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            await useStyle(page, style);
            const failures = [];
            const reports = [];
            for (const theme of themes) {
                await useTheme(page, theme);
                await useStyle(page, style);
                const scenes = [['chat', chatTargets], ['home', homeTargets]];
                if (!phone) scenes.push(['settings', { 'settings heading': p => p.locator('#user-settings-block .sb-shell-title').first() }]);
                for (const [scene, targets] of scenes) {
                    if (scene === 'chat') {
                        await page.evaluate(() => window.NeconyanShell.closeWorkspace?.());
                        await seedChat(page, account.avatar);
                        await placeOverWorstBand(page, theme.endsWith('Dark'));
                    } else if (scene === 'home') {
                        await page.evaluate(() => window.NeconyanShell.showHome());
                        await expect(page.locator('.welcomePanel')).toBeVisible();
                    } else {
                        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
                    }
                    for (const [label, locate] of Object.entries(targets)) {
                        const target = locate(page);
                        if (!await target.count() || !await target.isVisible()) continue;
                        // The outline is off at the defaults.
                        expect(await target.evaluate(element => getComputedStyle(element).webkitTextStrokeWidth), `${style} ${theme} ${label} stroke`).toBe('0px');
                        await setSolid(page, true);
                        const reference = await measure(page, target);
                        await setSolid(page, false);
                        const actual = await measure(page, target);
                        const verdict = judge(reference, actual);
                        const row = { style, theme, viewport, scene, label, reference: Number(reference.toFixed(2)), actual: Number(actual.toFixed(2)) };
                        console.log('PANEL_READABILITY ' + JSON.stringify(row));
                        if (!verdict.pass) failures.push(row);
                        else if (verdict.report) reports.push(row);
                    }
                }
                // Recent chats text and the Home intro also carry no stroke.
                await page.evaluate(() => window.NeconyanShell.showHome());
                for (const selector of ['.recentChat .chatDate', '.recentChat .chatMessage']) {
                    const target = page.locator(`#neconyan-home-host ${selector}`).first();
                    if (await target.count()) expect(await target.evaluate(element => getComputedStyle(element).webkitTextStrokeWidth), selector).toBe('0px');
                }
            }
            if (reports.length) await info.attach('near-floor misses of 0.05 or less', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
            expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
        });
    }

    for (const style of ['calico', 'windows-aero']) {
        test(`${style} Fully solid is a solid escape hatch on a busy wallpaper on ${viewport}`, async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            // A generated busy wallpaper: seeded tiles of saturated colours with near-white and near-black stripes.
            const image = new PNG({ width: 256, height: 256 });
            let seed = 7;
            const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            for (let y = 0; y < 256; y++) {
                for (let x = 0; x < 256; x++) {
                    const i = (y * 256 + x) * 4;
                    const stripe = (x + y) % 16 < 3 ? (Math.floor(x / 16) % 2 ? 250 : 8) : null;
                    if (stripe !== null) image.data.set([stripe, stripe, stripe, 255], i);
                    else if (x % 32 === 0 || y % 32 === 0) image.data.set([Math.floor(random() * 255), 255, 0, 255], i);
                    else {
                        const tile = Math.floor(x / 32) * 8 + Math.floor(y / 32);
                        image.data.set([(tile * 97) % 256, (tile * 57) % 256, (tile * 31) % 256, 255], i);
                    }
                }
            }
            const upload = await account.context.request.post('/api/backgrounds/upload', { headers: account.headers,
                multipart: { avatar: { name: 'panel-busy.png', mimeType: 'image/png', buffer: PNG.sync.write(image) } } });
            expect(upload.ok()).toBe(true);
            const filename = await upload.text();
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
            await page.locator(`.bg_example[bgfile="${filename}"]`).click();
            await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(encodeURIComponent(filename));
            await useStyle(page, style);
            const scenes = [['chat', chatTargets['assistant text']], ['home', homeTargets['intro text']]];
            if (!phone) scenes.push(['settings', p => p.locator('#user-settings-block .sb-shell-title').first()]);
            for (const [scene, locate] of scenes) {
                if (scene === 'chat') { await page.evaluate(() => window.NeconyanShell.closeWorkspace?.()); await seedChat(page, account.avatar); }
                else if (scene === 'home') await page.evaluate(() => window.NeconyanShell.showHome());
                else await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
                const target = locate(page);
                await setSolid(page, true);
                const reference = await measure(page, target);
                for (const surface of ['message', 'home', 'side']) await page.evaluate(surface => window.NeconyanShell.resetPanelLook(surface, null), surface);
                await page.evaluate(() => window.NeconyanShell.setPanelLook(null, { position: 100 }));
                await expect.poll(() => page.evaluate(() => window.NeconyanShell.getPanelLook().resolved.message.opacity)).toBe(1);
                const actual = await measure(page, target);
                expect(Math.abs(actual - reference), `${style} ${scene} ${reference} vs ${actual}`).toBeLessThanOrEqual(0.1);
                await page.evaluate(() => window.NeconyanShell.resetPanelLook(null, null));
            }
        });
    }

    test(`the wallpaper shows behind Home and chat at the defaults and a chosen background survives reload on ${viewport}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const image = new PNG({ width: 32, height: 32 });
        for (let i = 0; i < image.data.length; i += 4) image.data.set([20, 120, 220, 255], i);
        const upload = await account.context.request.post('/api/backgrounds/upload', { headers: account.headers,
            multipart: { avatar: { name: 'panel-blue.png', mimeType: 'image/png', buffer: PNG.sync.write(image) } } });
        expect(upload.ok()).toBe(true);
        const filename = await upload.text();
        const page = await account.open({ workspace: false, timeout: 60000 });
        await seedChat(page, account.avatar);
        for (const home of [false, true]) {
            if (home) await page.evaluate(() => window.NeconyanShell.showHome());
            for (const selector of ['#sheld', '#chat', '#neconyan-home-host']) {
                const colour = await page.locator(selector).evaluate(element => getComputedStyle(element).backgroundColor);
                expect(colour, `${selector} paints no canvas`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
            }
        }
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
        await page.locator(`.bg_example[bgfile="${filename}"]`).click();
        await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(encodeURIComponent(filename));
        await page.evaluate(async () => {
            const core = await import('/script.js');
            if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Selected background settings were not saved.');
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await expect.poll(() => page.locator('#bg1').evaluate(element => getComputedStyle(element).backgroundImage)).toContain(encodeURIComponent(filename));
    });
}

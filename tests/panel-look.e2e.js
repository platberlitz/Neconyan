/* global document, getComputedStyle, window, localStorage */
/* eslint-disable playwright/no-force-option -- Appearance controls live in the closed settings drawer. */
/* eslint-disable playwright/no-conditional-in-test -- Fixed viewport matrix. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// Panels (Settings > Appearance > Panels): a relative main opacity, absolute blur, per-surface values, per-style
// memory, phone side panels, the blur gate, the migration notes on Home and the opt-in Letter outline.
// Resolved values are registered properties and can animate, so every read after a change is polled.

const look = page => page.evaluate(() => window.NeconyanShell.getPanelLook());
const resolved = (page, surface) => page.evaluate(surface => window.NeconyanShell.getPanelLook().resolved[surface].opacity, surface);
const setLook = (page, surface, values) => page.evaluate(([surface, values]) => window.NeconyanShell.setPanelLook(surface, values), [surface, values]);
const reset = (page, surface = null, property = null) => page.evaluate(([surface, property]) => window.NeconyanShell.resetPanelLook(surface, property), [surface, property]);

async function useStyle(page, style) {
    await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
    await page.waitForFunction(id => document.documentElement.dataset.sbTheme === id
        && (id === 'calico' || Boolean(document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet)), style);
}

async function useTheme(page, name) {
    await page.locator('#themes').selectOption(name, { force: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.sbSurfaceTone)).toBe(name.endsWith('Dark') ? 'dark' : 'light');
}

async function seedChat(page, avatar, reply = 'She returned with a pot of tea.') {
    await page.evaluate(async ({ avatar, reply }) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        const date = '2026-11-18T00:00:00Z';
        context.chat.splice(0, context.chat.length, ...[false, true].map(user => ({
            name: user ? 'Brian' : 'Sara', is_user: user, is_system: false, send_date: date,
            mes: user ? 'He sat by the window.' : reply, extra: {},
        })));
        await context.saveChat();
        await context.reloadCurrentChat();
        await window.NeconyanShell.activateMode('roleplay');
    }, { avatar, reply });
    await expect(page.locator('#chat > .mes')).toHaveCount(2);
}

// Alpha of an element's own background colour (or a pseudo-element's), as painted.
function alpha(locator, pseudo = null) {
    return locator.evaluate((element, pseudo) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const style = getComputedStyle(element, pseudo);
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3] / 255 * Number(pseudo ? style.opacity : 1);
    }, pseudo);
}

// The combined backing behind a text element: every ancestor fill (and a ::before card) up to, not including, <body>.
function backing(locator) {
    return locator.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const alphaOf = (node, pseudo = null) => {
            const style = getComputedStyle(node, pseudo);
            if (pseudo && (style.content === 'none' || style.display === 'none')) return 0;
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255 * (pseudo ? Number(style.opacity) : 1);
        };
        const layers = [];
        for (let node = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            for (const pseudo of [null, '::before']) {
                const value = alphaOf(node, pseudo);
                if (value > 0.01) layers.push(value);
            }
        }
        return { layers, total: 1 - layers.reduce((clear, value) => clear * (1 - value), 1) };
    });
}

async function seedStorage(account, values) {
    const seed = await account.context.newPage();
    await seed.goto('/csrf-token');
    await seed.evaluate(values => {
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    }, values);
    await seed.close();
}

async function openPanels(page) {
    await page.evaluate(() => window.NeconyanShell.openPanelLookSettings());
    await expect(page.locator('#sb-panel-look-drawer .sb-theme-settings-drawer-body, #sb-panel-look-drawer .inline-drawer-content').first()).toBeVisible();
}

async function home(page) {
    await page.evaluate(() => { window.NeconyanShell.closeWorkspace?.(); window.NeconyanShell.showHome(); });
    await expect(page.locator('.welcomePanel')).toBeVisible();
    await page.evaluate(() => document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]:not(:disabled)')?.click());
    await expect(page.locator('#neconyan-tour-coachmark')).toHaveCount(0, { timeout: 20000 });
}

// Marks at the defaults (desktop light, desktop dark, phone light, phone dark), from the shell sheets' own values.
const MARKS = {
    calico: [18, 18, 18, 18],
    kittyless: [20, 20, 20, 20],
    'windows-xp': [20, 20, 20, 20],
    'windows-98': [20, 20, 20, 20],
    'windows-aero': [18, 18, 18, 18],
    'clean-minimal': [18, 18, 17, 17],
    'macos-minimal': [17, 17, 17, 17],
    'cozy-warm': [19, 18, 19, 18],
    'hypr-glow': [17, 17, 17, 16],
    'slate-flat': [19, 18, 19, 18],
    'starlight-conservatory': [19, 18, 18, 18],
    'sunken-reef': [19, 18, 18, 18],
};
const GLASS = ['windows-aero', 'macos-minimal', 'hypr-glow'];
const knobInput = page => page.locator('#sb-panel-opacity-input');
const knobReadout = page => page.locator('#sb-panel-opacity-value');
// The saved store, as it reaches localStorage (on a short flush timer, so reads of it are polled).
const storedStyle = (page, style) => page.evaluate(id => JSON.parse(localStorage.getItem('sb-panel-look') || '{}').styles?.[id] || {}, style);
const markToken = page => page.locator('#sb-panel-opacity-group').evaluate(group => group.style.getPropertyValue('--sb-panel-mark'));

// Drives the real range input, then blurs it so a later redraw from outside can write it again.
async function knob(page, index) {
    const input = knobInput(page);
    await input.fill(String(index));
    await input.blur();
    await expect.poll(async () => (await look(page)).knob.index, { message: `knob at ${index}` }).toBe(index);
    await expect(input).toHaveValue(String(index));
}

async function expectSurfaces(page, values, message, within = 0.001) {
    for (const [surface, value] of Object.entries(values)) {
        await expect.poll(async () => Math.abs(await resolved(page, surface) - value), { message: `${message} ${surface} near ${value}` }).toBeLessThanOrEqual(within);
    }
}

for (const phone of [false, true]) {
    test(`the knob starts at each style's mark on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await openPanels(page);
        const tones = phone ? [['Neconyan Calico', 2]] : [['Neconyan Calico', 0], ['Neconyan Calico Dark', 1]];
        for (const [theme, column] of tones) {
            await useTheme(page, theme);
            for (const style of Object.keys(MARKS)) {
                await useStyle(page, style);
                const mark = MARKS[style][column];
                await expect.poll(async () => (await look(page)).knob.mark, { message: `${style} ${theme} mark` }).toBe(mark);
                await expect(knobInput(page)).toHaveValue(String(mark));
                await expect(knobInput(page)).toHaveAttribute('max', '20');
                await expect(knobReadout(page)).toHaveText('Style default');
                expect(Number(await markToken(page)), `${style} --sb-panel-mark`).toBeCloseTo(mark / 20, 4);
                await expect.poll(() => storedStyle(page, style)).toEqual({});
                // At the mark every surface is at its own default; side panels are solid except the glass panes on desktop.
                const state = await look(page);
                for (const surface of ['message', 'home', 'side']) {
                    expect(Math.abs(state.resolved[surface].opacity - state.defaults[surface].opacity), `${style} ${surface}`).toBeLessThanOrEqual(0.001);
                }
                const side = phone || !GLASS.includes(style) ? 1 : 0.92;
                expect(state.defaults.side.opacity, `${style} side default`).toBe(side);
                expect(state.resolved.side.opacity, `${style} side resolved`).toBeCloseTo(side, 3);
            }
        }
        if (!phone) {
            // A solid side panel computes no blur, and Panels can still lower it.
            await useStyle(page, 'calico');
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
            const frame = page.locator('#user-settings-block .sb-shell-frame');
            await expect.poll(() => alpha(frame)).toBe(1);
            expect(await frame.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
            await setLook(page, 'side', { opacity: 60 });
            await expect.poll(() => resolved(page, 'side')).toBeCloseTo(0.6, 2);
            await reset(page, 'side');
        }
    });
}

test('the knob ends are exact, the mark is exact and steps count on each side', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account();
    const page = await account.open({ workspace: false, timeout: 60000 });
    await useStyle(page, 'calico');
    await useTheme(page, 'Neconyan Calico Dark');
    await openPanels(page);
    const readout = knobReadout(page);
    // Calico Dark on desktop: messages 0.9, Home 0.85, side 1, mark 18.
    const cases = [
        [18, 'Style default', { message: 0.9, home: 0.85, side: 1 }, {}],
        [0, 'Fully clear', { message: 0, home: 0, side: 0 }, { position: -100 }],
        [20, 'Fully solid', { message: 1, home: 1, side: 1 }, { position: 100 }],
        [10, 'Clearer, step 8 of 18', { message: 0.9 * 10 / 18, home: 0.85 * 10 / 18, side: 10 / 18 }, { position: -44 }],
        [19, 'More solid, step 1 of 2', { message: 0.95, home: 0.925, side: 1 }, { position: 50 }],
    ];
    for (const [index, phrase, values, stored] of cases) {
        await knob(page, index);
        await expect(readout).toHaveText(phrase);
        await expect(knobInput(page)).toHaveAttribute('aria-valuetext', phrase);
        await expectSurfaces(page, values, `calico ${index}`, 0.01);
        await expect.poll(() => storedStyle(page, 'calico')).toEqual(stored);
    }
    await reset(page);
    // Windows Aero (Home cards default 0.8, mark 18).
    await useStyle(page, 'windows-aero');
    await knob(page, 0);
    await expect(readout).toHaveText('Fully clear');
    await expectSurfaces(page, { message: 0, home: 0, side: 0 }, 'aero 0');
    await knob(page, 20);
    await expect(readout).toHaveText('Fully solid');
    await expectSurfaces(page, { message: 1, home: 1, side: 1 }, 'aero 20');
    await knob(page, 5);
    await expectSurfaces(page, { home: 0.8 * 5 / 18 }, 'aero 5', 0.01);
    await reset(page);
    // All-solid styles start at the right end and can only go clearer.
    for (const style of ['windows-xp', 'windows-98', 'kittyless']) {
        await useStyle(page, style);
        await expect(knobInput(page)).toHaveValue('20');
        for (let index = 0; index <= 20; index++) {
            await knob(page, index);
            await expect(readout).toHaveText(/^(Style default|Fully clear|Clearer, step \d+ of 20)$/);
        }
        await expect(readout).toHaveText('Style default');
        await expect.poll(() => storedStyle(page, style)).toEqual({});
        await expectSurfaces(page, { message: 1, home: 1, side: 1 }, `${style} 20`);
        await knob(page, 19);
        await expect(readout).toHaveText('Clearer, step 1 of 20');
        await expectSurfaces(page, { message: 0.95, home: 0.95, side: 0.95 }, `${style} 19`, 0.005);
        await knob(page, 0);
        await expect(readout).toHaveText('Fully clear');
        await expectSurfaces(page, { message: 0, home: 0, side: 0 }, `${style} 0`);
        await expect.poll(() => storedStyle(page, style)).toEqual({ position: -100 });
        await reset(page);
    }
    await useStyle(page, 'calico');
});

test('the mark follows tone and Separate surfaces while the choice stays relative', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account();
    const page = await account.open({ workspace: false, timeout: 60000 });
    await openPanels(page);
    await useTheme(page, 'Neconyan Calico Dark');
    await useStyle(page, 'cozy-warm');
    await expect.poll(async () => (await look(page)).knob.mark).toBe(18);
    await useTheme(page, 'Neconyan Calico');
    await expect.poll(async () => (await look(page)).knob.mark).toBe(19);
    await expect(knobInput(page)).toHaveValue('19');
    await useTheme(page, 'Neconyan Calico Dark');
    await knob(page, 10);
    await expect.poll(() => storedStyle(page, 'cozy-warm')).toEqual({ position: -44 });
    await useTheme(page, 'Neconyan Calico');
    await expect.poll(async () => (await look(page)).knob.index).toBe(11);
    await expect(knobInput(page)).toHaveValue('11');
    await expect.poll(() => storedStyle(page, 'cozy-warm')).toEqual({ position: -44 });
    await reset(page);
    // Light Cozy Warm with Home and side panels set separately: the slider moves only messages (1), mark 20.
    await setLook(page, 'home', { opacity: 50 });
    await setLook(page, 'side', { opacity: 50 });
    await expect.poll(async () => (await look(page)).knob.mark).toBe(20);
    await setLook(page, 'message', { opacity: 50 });
    await expect(knobInput(page)).toBeDisabled();
    await reset(page);
    await expect(knobInput(page)).toBeEnabled();
    // Desktop: Home set separately moves Windows Aero's mark one step and macOS Minimal's two.
    for (const [style, from, to] of [['windows-aero', 18, 19], ['macos-minimal', 17, 19]]) {
        await useStyle(page, style);
        await expect.poll(async () => (await look(page)).knob.mark).toBe(from);
        await setLook(page, 'home', { opacity: 50 });
        await expect.poll(async () => (await look(page)).knob.mark, { message: `${style} with Home set` }).toBe(to);
        await expect(knobInput(page)).toHaveValue(String(to));
        const toggle = page.locator('#sb-panel-surfaces-toggle');
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await page.locator('#sb-panel-home-use-main').click();
        await expect.poll(async () => (await look(page)).knob.mark).toBe(from);
        await expect(knobInput(page)).toHaveValue(String(from));
    }
    await useStyle(page, 'calico');
});

test('every knob step survives a reload in Calico', async ({ app }) => {
    test.setTimeout(420000);
    const account = await app.account();
    const page = await account.open({ workspace: false, timeout: 60000 });
    await useStyle(page, 'calico');
    for (let index = 0; index <= 20; index++) {
        await openPanels(page);
        await knob(page, index);
        const phrase = await knobReadout(page).textContent();
        const stored = (await look(page)).stored;
        if (index === 18) expect(stored).toEqual({});
        await expect.poll(() => storedStyle(page, 'calico'), { message: `saved at ${index}` }).toEqual(stored);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await openPanels(page);
        await expect(knobInput(page), `index ${index}`).toHaveValue(String(index));
        await expect(knobReadout(page)).toHaveText(phrase);
        await expect.poll(() => storedStyle(page, 'calico'), { message: `index ${index}` }).toEqual(stored);
    }
    await reset(page);
});

test('a surface set separately keeps its value while the main slider moves the others', async ({ app }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open({ workspace: false, timeout: 60000 });
    await useStyle(page, 'calico');
    await openPanels(page);
    await setLook(page, 'message', { opacity: 60 });
    for (const position of [-50, 0, 70]) {
        await setLook(page, null, { position });
        await expect.poll(() => resolved(page, 'message')).toBeCloseTo(0.6, 2);
        await expect.poll(() => resolved(page, 'home')).toBeCloseTo(position < 0 ? 0.85 * 0.5 : 0.85 + 0.15 * position / 100, 2);
    }
    const toggle = page.locator('#sb-panel-surfaces-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(page.locator('#sb-panel-message-separate')).toBeVisible();
    await expect(page.locator('#sb-panel-home-separate')).toBeHidden();
    await expect(page.locator('#sb-panel-message-use-main')).toBeEnabled();
    await expect(page.locator('#sb-panel-home-use-main')).toBeDisabled();
    await expect(page.locator('#sb-panel-opacity-caption')).toHaveText('Surfaces set separately keep their own values.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await openPanels(page);
    await expect(page.locator('#sb-panel-surfaces-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sb-panel-surfaces')).toBeVisible();
    await page.locator('#sb-panel-message-use-main').click();
    await expect.poll(() => resolved(page, 'message')).toBeCloseTo(0.9 + 0.1 * 0.7, 2);
    await expect(page.locator('#sb-panel-message-separate')).toBeHidden();
    await reset(page);
});

test('every style remembers its own Panels settings and Reset returns to the style', async ({ app }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open({ workspace: false, timeout: 60000 });
    await useStyle(page, 'windows-aero');
    await setLook(page, null, { position: -40 });
    await expect.poll(() => resolved(page, 'home')).toBeCloseTo(0.48, 2);
    await useStyle(page, 'windows-xp');
    await expect.poll(() => resolved(page, 'home')).toBe(1);
    expect((await look(page)).stored).toEqual({});
    await useStyle(page, 'windows-aero');
    await expect.poll(() => resolved(page, 'home')).toBeCloseTo(0.48, 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await useStyle(page, 'windows-aero');
    expect((await look(page)).stored).toEqual({ position: -40 });
    await expect.poll(() => resolved(page, 'home')).toBeCloseTo(0.48, 2);
    await openPanels(page);
    await page.locator('#sb-panel-opacity-reset').click();
    await expect.poll(() => resolved(page, 'home')).toBeCloseTo(0.8, 2);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sb-panel-look')).styles['windows-aero'])).toBeUndefined();
    await expect(page.locator('#sb-panel-opacity-reset')).toBeDisabled();
});

test('phone side panels start solid and follow only their own slider', async ({ app }) => {
    test.setTimeout(150000);
    const account = await app.account({ phone: true });
    const page = await account.open({ workspace: false, timeout: 60000 });
    await useStyle(page, 'windows-aero');
    await expect.poll(() => resolved(page, 'side')).toBe(1);
    await setLook(page, null, { position: -80 });
    await expect.poll(() => resolved(page, 'home')).toBeCloseTo(0.16, 2);
    expect(await resolved(page, 'side')).toBe(1);
    await setLook(page, 'side', { opacity: 60 });
    await expect.poll(() => resolved(page, 'side')).toBeCloseTo(0.6, 2);
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await expect.poll(() => alpha(page.locator('#user-settings-block'))).toBeCloseTo(0.6, 2);
    expect(await alpha(page.locator('#user-settings-block .sb-shell-frame'))).toBe(0);
    await reset(page);
    await reset(page, 'side');
});

test('blur follows the gate: never behind a solid surface, never with No Blur Effect', async ({ app }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open({ workspace: false, timeout: 60000 });
    await seedChat(page, account.avatar);
    await page.locator('#chat_display').selectOption('0', { force: true });
    await useStyle(page, 'calico');
    const block = page.locator('#chat > .mes').first().locator('.mes_block');
    await setLook(page, 'message', { opacity: 100, blur: 16 });
    await expect.poll(() => block.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
    await setLook(page, 'message', { opacity: 70 });
    await expect.poll(() => block.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('blur(16px)');
    await page.locator('#fast_ui_mode').evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.sbPanelBlur)).toBe('');
    await expect.poll(() => block.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
    await openPanels(page);
    await expect(page.locator('#sb-panel-blur-input')).toBeDisabled();
    await expect(page.locator('#sb-panel-message-blur-input')).toBeDisabled();
    await expect(page.locator('#sb-panel-blur-caption')).toHaveText('Blur is off while No Blur Effect is on.');
    await page.locator('#fast_ui_mode').evaluate(input => { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect.poll(() => block.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('blur(16px)');
    await reset(page, 'message');
});

for (const phone of [false, true]) {
    test(`one layer backs text at 40% on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await useStyle(page, 'calico');
        await seedChat(page, account.avatar);
        for (const surface of ['message', 'home', 'side']) await setLook(page, surface, { opacity: 40 });
        const styles = phone ? ['0', '1', '2'] : ['0'];
        for (const style of styles) {
            await page.locator('#chat_display').selectOption(style, { force: true });
            const text = page.locator('#chat > .mes').first().locator('.mes_text p').first();
            await expect.poll(async () => (await backing(text)).total, { message: `chat style ${style}` }).toBeCloseTo(0.4, 1);
            expect((await backing(text)).layers, `chat style ${style}`).toHaveLength(1);
        }
        if (phone) {
            for (const surface of ['message', 'home', 'side']) await reset(page, surface);
            await setLook(page, null, { position: -100 });
            for (const style of ['1', '2']) {
                await page.locator('#chat_display').selectOption(style, { force: true });
                const text = page.locator('#chat > .mes').first().locator('.mes_text p').first();
                await expect.poll(async () => (await backing(text)).total, { message: `fully clear ${style}` }).toBeLessThan(0.01);
            }
            await reset(page);
            for (const surface of ['message', 'home', 'side']) await setLook(page, surface, { opacity: 40 });
        }
        await page.locator('#chat_display').selectOption('0', { force: true });
        await home(page);
        const intro = page.locator('.neconyan-home-intro > p').first();
        await expect.poll(async () => (await backing(intro)).total).toBeCloseTo(0.4, 1);
        expect((await backing(intro)).layers).toHaveLength(1);
        if (!phone) {
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
            const settingsText = page.locator('#user-settings-block .sb-shell-title').first();
            await expect.poll(async () => (await backing(settingsText)).total).toBeCloseTo(0.4, 1);
        }
        for (const surface of ['message', 'home', 'side']) await reset(page, surface);
    });
}

test.describe('migration from Background Visibility', () => {
    test('a device that ran the previous release with no saved value gets note A', async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account();
        await seedStorage(account, { 'sb-theme': 'calico' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await expect.poll(() => resolved(page, 'message')).toBeCloseTo(0.9, 2);
        await home(page);
        const note = page.locator('.welcomePanel > .neconyan-panels-notice');
        await expect(note.getByRole('heading', { name: 'Panels now follow your shell style', exact: true })).toBeVisible();
        await note.getByRole('button', { name: 'Open Panels settings', exact: true }).click();
        await expect(page.locator('#sb-panel-opacity-input')).toBeVisible();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await home(page);
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
    });

    test('the close button answers note A', async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account();
        await seedStorage(account, { 'sb-theme': 'calico' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await home(page);
        await page.getByRole('button', { name: 'Dismiss this note', exact: true }).click();
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sb-panel-look')).notice)).toBeUndefined();
    });

    test('a new device gets no note', async ({ app }) => {
        const account = await app.account();
        const page = await account.open({ workspace: false, timeout: 60000 });
        await home(page);
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
        expect(await page.evaluate(() => window.NeconyanShell.getPanelLookNotice())).toBeNull();
    });

    test('a saved 0 keeps solid panels until Keep my setting', async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account();
        await seedStorage(account, { 'sb-theme': 'calico', 'sb-surface-transparency': '0' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        for (const [style, side] of [['calico', 1], ['windows-aero', 0.92]]) {
            await useStyle(page, style);
            await expect.poll(() => resolved(page, 'message')).toBe(1);
            // Side panels are held at the style's own default.
            await expect.poll(() => resolved(page, 'side')).toBeCloseTo(side, 3);
            await openPanels(page);
            await expect(page.locator('#sb-panel-opacity-value')).toHaveText('Fully solid');
        }
        await useStyle(page, 'calico');
        await home(page);
        await expect(page.getByRole('heading', { name: 'Panels now have their own look for each style', exact: true })).toBeVisible();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await home(page);
        await expect(page.getByRole('heading', { name: 'Panels now have their own look for each style', exact: true })).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBe('0');
        await page.getByRole('button', { name: 'Keep my setting', exact: true }).click();
        await expect.poll(() => resolved(page, 'message')).toBe(1);
        expect(await page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBeNull();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await home(page);
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
    });

    test('a saved 100 clears messages and Home cards and holds side panels at the style default', async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account();
        await seedStorage(account, { 'sb-theme': 'calico', 'sb-surface-transparency': '100' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        for (const [style, side] of [['windows-xp', 1], ['windows-aero', 0.92], ['calico', 1]]) {
            await useStyle(page, style);
            for (const surface of ['message', 'home']) await expect.poll(() => resolved(page, surface), { message: `${style} ${surface}` }).toBe(0);
            await expect.poll(() => resolved(page, 'side'), { message: `${style} side` }).toBeCloseTo(side, 3);
            await openPanels(page);
            await expect(page.locator('#sb-panel-opacity-value')).toHaveText('Fully clear');
            await expect(page.locator('#sb-panel-surfaces-toggle')).toHaveAttribute('aria-expanded', 'true');
            await expect(page.locator('#sb-panel-side-separate')).toBeVisible();
            await expect(page.locator('#sb-panel-side-use-main')).toBeEnabled();
            await expect(page.locator('#sb-panel-message-separate')).toBeHidden();
            await expect(page.locator('#sb-panel-opacity-caption')).toHaveText('Surfaces set separately keep their own values.');
        }
        // The Settings frame is as solid as Calico's default says, never clear.
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        await expect.poll(() => alpha(page.locator('#user-settings-block .sb-shell-frame'))).toBe(1);
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sb-panel-look')).styles.calico)).toEqual({ position: -100, side: { opacity: 'default' } });
        // Use main settings: side panels follow the main position, the person's own choice.
        await page.locator('#sb-panel-side-use-main').click();
        await expect.poll(() => resolved(page, 'side')).toBe(0);
        await expect(page.locator('#sb-panel-side-separate')).toBeHidden();
        // Panel opacity Reset: every default back, nothing marked.
        await setLook(page, 'side', { opacity: 40 });
        await page.locator('#sb-panel-opacity-reset').click();
        await expectSurfaces(page, { message: 0.9, home: 0.85, side: 1 }, 'calico after reset');
        await expect(page.locator('#sb-panel-opacity-value')).toHaveText('Style default');
        for (const surface of ['message', 'home', 'side']) await expect(page.locator(`#sb-panel-${surface}-separate`)).toBeHidden();
        await expect.poll(() => storedStyle(page, 'calico')).toEqual({});
    });

    test('a saved 100 goes back to every default with Try the new defaults', async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account();
        await seedStorage(account, { 'sb-theme': 'calico', 'sb-surface-transparency': '100' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await useStyle(page, 'calico');
        await home(page);
        await page.getByRole('button', { name: 'Try the new defaults', exact: true }).click();
        await expectSurfaces(page, { message: 0.9, home: 0.85, side: 1 }, 'calico defaults');
        await expect.poll(() => storedStyle(page, 'calico')).toEqual({});
        await useStyle(page, 'windows-xp');
        await expect.poll(() => resolved(page, 'message')).toBe(1);
        await openPanels(page);
        await expect(page.locator('#sb-panel-opacity-value')).toHaveText('Style default');
        await expect(page.locator('#sb-panel-side-separate')).toBeHidden();
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sb-panel-look')).styles)).toEqual({});
        expect(await page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBeNull();
        await useStyle(page, 'calico');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await home(page);
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
    });

    test('a saved 100 leaves side panels solid on a phone, Windows Aero included', async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone: true });
        await seedStorage(account, { 'sb-theme': 'calico', 'sb-surface-transparency': '100' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        // A build that read the sheet's 0.92 on a phone would fail here in Windows Aero.
        for (const style of ['calico', 'windows-aero']) {
            await useStyle(page, style);
            await expect.poll(() => resolved(page, 'message'), { message: `${style} message` }).toBe(0);
            await expect.poll(() => resolved(page, 'side'), { message: `${style} phone side` }).toBe(1);
        }
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        await expect.poll(() => alpha(page.locator('#user-settings-block'))).toBe(1);
    });

    for (const phone of [false, true]) {
        test(`a saved 70 reads Clearer, step 7 of 18 in Calico Light with side panels held on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
            test.setTimeout(150000);
            const account = await app.account({ phone });
            await seedStorage(account, { 'sb-theme': 'calico', 'sb-surface-transparency': '70' });
            const page = await account.open({ workspace: false, timeout: 60000 });
            await useStyle(page, 'calico');
            await useTheme(page, 'Neconyan Calico');
            await openPanels(page);
            await expect(knobInput(page)).toHaveValue('11');
            await expect(knobReadout(page)).toHaveText('Clearer, step 7 of 18');
            expect((await look(page)).knob).toEqual({ steps: 20, mark: 18, index: 11 });
            await expectSurfaces(page, { message: 0.54, home: 0.51, side: 1 }, 'calico light old 70', 0.005);
            await expect.poll(() => storedStyle(page, 'calico')).toEqual({ position: -40, side: { opacity: 'default' } });
            await expect(page.locator('#sb-panel-side-separate')).toBeVisible();
            // Windows Aero: its frosted pane on desktop, solid on a phone.
            await useStyle(page, 'windows-aero');
            await expect.poll(() => resolved(page, 'side')).toBeCloseTo(phone ? 1 : 0.92, 3);
            await useStyle(page, 'calico');
            if (!phone) {
                await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
                await expect.poll(() => alpha(page.locator('#user-settings-block .sb-shell-frame'))).toBe(1);
            }
        });
    }

    test('a saved 50 maps to the style default and shows note A, even on a device without sb-theme', async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account();
        await seedStorage(account, { 'sb-surface-transparency': '50' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await expect.poll(() => resolved(page, 'message')).toBeCloseTo(0.9, 2);
        await home(page);
        await expect(page.getByRole('heading', { name: 'Panels now follow your shell style', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Dismiss this note', exact: true }).click();
        expect(await page.evaluate(() => localStorage.getItem('sb-surface-transparency'))).toBeNull();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await home(page);
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
    });

    test('the note waits for the First paws tour and leads every Home layout', async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account();
        await seedStorage(account, { 'sb-theme': 'calico' });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await home(page);
        await expect(page.locator('.welcomePanel > .neconyan-panels-notice')).toBeVisible();
        await page.locator('[data-action="replay-tutorial"]').first().click();
        await expect(page.locator('#neconyan-tour-coachmark')).toBeVisible();
        await expect(page.locator('.neconyan-panels-notice')).toHaveCount(0);
        await page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]').click();
        await expect(page.locator('.welcomePanel > .neconyan-panels-notice')).toBeVisible();
        for (const mode of ['compact', 'list', 'full']) {
            await page.locator(`[data-welcome-panel-mode-target="${mode}"]`).first().click();
            await expect.poll(() => page.evaluate(() => document.querySelector('.welcomePanel')?.firstElementChild?.className)).toBe('neconyan-panels-notice');
        }
    });
});

for (const phone of [false, true]) {
    test.describe(`Letter outline on ${phone ? 'phone' : 'desktop'}`, () => {
        const stroke = locator => locator.evaluate(element => ({ width: getComputedStyle(element).webkitTextStrokeWidth, colour: getComputedStyle(element).webkitTextStrokeColor, order: getComputedStyle(element).paintOrder }));

        test('is off by default, reaches the text it names and follows thickness, colour and style', async ({ app }) => {
            test.setTimeout(240000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false, timeout: 60000 });
            await useStyle(page, 'calico');
            await useTheme(page, 'Neconyan Calico');
            await seedChat(page, account.avatar);
            await page.locator('#chat_display').selectOption('0', { force: true });
            const row = page.locator('#chat > .mes').first();
            const chatText = [row.locator('.mes_text'), row.locator('.name_text'), row.locator('.timestamp'), row.locator('.neconyan-action-label').first()];
            for (const target of chatText) expect((await stroke(target)).width).toBe('0px');
            await openPanels(page);
            await expect(page.locator('#sb-panel-outline-width-input')).toBeDisabled();
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: true, width: 1.5, colour: 'dark' }));
            await page.evaluate(() => window.NeconyanShell.closeWorkspace?.());
            await expect(page.locator('#sb-panel-outline-width-input')).toBeEnabled();
            for (const target of chatText) await expect.poll(() => stroke(target)).toMatchObject({ width: '1.5px', colour: 'rgb(0, 0, 0)' });
            await expect.poll(async () => (await stroke(row.locator('.swipes-counter').first())).width).toBe('0px');
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ colour: 'light' }));
            await expect.poll(async () => (await stroke(row.locator('.mes_text'))).colour).toBe('rgb(255, 255, 255)');
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ colour: 'auto' }));
            const auto = await row.locator('.mes_text').evaluate(element => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--neco-surface)';
                element.parentElement.append(probe);
                const colour = getComputedStyle(probe).color;
                probe.remove();
                return { probe: colour, stroke: getComputedStyle(element).webkitTextStrokeColor };
            });
            expect(auto.stroke).toBe(auto.probe);
            // Any opacity, including Fully solid.
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ colour: 'dark' }));
            await setLook(page, null, { position: 100 });
            await expect.poll(async () => (await stroke(row.locator('.mes_text'))).width).toBe('1.5px');
            await reset(page);
            // Editing keeps the textarea unstroked.
            await row.locator('.mes_edit').click({ force: true });
            await expect.poll(async () => (await stroke(row.locator('.edit_textarea'))).width).toBe('0px');
            await row.locator('.mes_edit_cancel').click({ force: true });
            // Home: intro, assistant row and a Recent chats row.
            await home(page);
            for (const selector of ['.neconyan-home-intro h1', '.neconyan-home-intro > p', '.neconyan-assistant-row h3', '.recentChat .characterName', '.recentChat .chatDate', '.recentChat .chatMessage']) {
                const target = page.locator(`#neconyan-home-host ${selector}`).first();
                if (await target.count()) expect(await stroke(target), selector).toMatchObject({ width: '1.5px', colour: 'rgb(0, 0, 0)' });
            }
            // Per style: Calico at 3 px Dark, Windows Aero untouched, back to Calico.
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ width: 3 }));
            await useStyle(page, 'windows-aero');
            await expect.poll(async () => (await stroke(page.locator('.neconyan-home-intro > p').first())).width).toBe('0px');
            expect((await look(page)).outline.effective.on).toBe(false);
            await useStyle(page, 'calico');
            await expect.poll(async () => (await stroke(page.locator('.neconyan-home-intro > p').first())).width).toBe('3px');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            await home(page);
            await expect.poll(async () => (await stroke(page.locator('.neconyan-home-intro > p').first())).width).toBe('3px');
            const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sb-panel-look')).styles);
            expect(stored.calico.outline).toEqual({ on: true, width: 3, colour: 'dark' });
            expect(stored['windows-aero']).toBeUndefined();
        });

        test('on Home, fill decides which text is outlined', async ({ app }) => {
            test.skip(phone, 'The fill rule is checked at desktop width (1280).');
            test.setTimeout(180000);
            const account = await app.account();
            const page = await account.open({ workspace: false, timeout: 60000 });
            await seedChat(page, account.avatar);
            for (const style of ['calico', 'windows-xp']) {
                await useStyle(page, style);
                await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: true, width: 1.5, colour: 'dark' }));
                await home(page);
                await page.locator('[data-welcome-panel-mode-target="full"]').first().click();
                const disclosure = page.locator('.neconyan-assistant-disclosure, .neconyan-assistant-picker [aria-expanded="false"]').first();
                if (await disclosure.isVisible()) await disclosure.click();
                await expect(page.locator('#neconyan-assistant-choices .neconyan-assistant-row').first()).toBeVisible();
                const filters = page.locator('.welcomeRecentShell details:not([open]) > summary').first();
                if (await filters.count()) await filters.click();
                await page.mouse.move(1, 1);
                const failures = await page.evaluate(() => {
                    const controls = 'button, input, select, textarea, label, .menu_button, .welcomeRecentTab';
                    const painted = element => {
                        const style = getComputedStyle(element);
                        const canvas = document.createElement('canvas');
                        canvas.width = canvas.height = 1;
                        const context = canvas.getContext('2d');
                        context.fillStyle = style.backgroundColor;
                        context.fillRect(0, 0, 1, 1);
                        return context.getImageData(0, 0, 1, 1).data[3] > 0 || style.backgroundImage !== 'none';
                    };
                    const out = [];
                    for (const card of document.querySelectorAll('#neconyan-home-host :is(.neconyan-home-intro, .neconyan-assistant-picker, .welcomeRecentShell, .neconyan-home-layout-bar)')) {
                        const walker = document.createTreeWalker(card, 4);
                        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                            const parent = node.parentElement;
                            if (!node.textContent.trim() || !parent || parent.closest('.sr-only') || !parent.getClientRects().length) continue;
                            const box = parent.getBoundingClientRect();
                            if (!box.width || !box.height) continue;
                            const control = parent.closest(controls);
                            const inside = control && card.contains(control) ? control : null;
                            let filled = false;
                            for (let element = parent; inside && element; element = element.parentElement) {
                                if (painted(element)) { filled = true; break; }
                                if (element === inside) break;
                            }
                            const width = getComputedStyle(parent).webkitTextStrokeWidth;
                            const expected = filled ? '0px' : '1.5px';
                            if (width !== expected) out.push(`${parent.tagName.toLowerCase()}.${[...parent.classList].join('.')} "${node.textContent.trim().slice(0, 24)}" ${width} (expected ${expected})`);
                        }
                    }
                    return out;
                });
                expect(failures, `${style}\n${failures.join('\n')}`).toEqual([]);
                await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: false }));
            }
            await useStyle(page, 'calico');
        });

        // Two tests on separate accounts: the Dialogue Colors one turns on the extension's DOM engine, which would also
        // colour (and so exempt) the narration of the styled-HTML message.
        test('keeps the Dialogue Colors exemption', async ({ app }) => {
            test.setTimeout(150000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false });
            await useStyle(page, 'calico');
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: true }));
            await seedChat(page, account.avatar, 'She came back with a pot of tea. "The garden is still green after all that rain," Sara said.');
            await page.evaluate(async () => {
                const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';
                const { settings, setCharacterColors } = await import(`${extension}/state.js`);
                const { buildCharacterEntry } = await import(`${extension}/palettes.js`);
                const { decorateAllMessages } = await import(`${extension}/dom-engine.js`);
                Object.assign(settings, { enabled: true, coloringEngine: 'dom', autoScanNewMessages: false, llmAttributionCheck: false });
                const { key, entry } = buildCharacterEntry('Sara', { color: '#74ffb8', origin: 'manual' });
                entry.gradient = { type: 'linear', angle: 90, primaryPosition: 0, stops: [{ color: '#baff55', baseColor: '#baff55', position: 100 }] };
                setCharacterColors({ [key]: entry });
                decorateAllMessages();
            });
            const quote = page.locator('#chat > .mes[mesid="0"] .mes_text p q');
            await expect(quote).toHaveClass(/dc-gradient-text/);
            await expect(page.locator('#chat > .mes[mesid="0"] .mes_text p')).toHaveCSS('-webkit-text-stroke-width', '2px');
            await expect(quote).toHaveCSS('-webkit-text-stroke-width', '0px');
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: false }));
        });

        test('keeps the styled-HTML exemption', async ({ app }) => {
            test.setTimeout(150000);
            const account = await app.account({ phone });
            const page = await account.open({ workspace: false });
            await useStyle(page, 'calico');
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: true }));
            await seedChat(page, account.avatar, [
                'Sara *unfolded* the handout.',
                '<style>.handout { padding: 1em; background: #f6f2e8; color: #252320; font-family: monospace; } .handout-stamp { -webkit-text-stroke: 1px #7e3c28; }</style>',
                '<div class="handout"><b>ATELIER NOTES</b><br>Cut a test pattern before touching the good linen.',
                '<table><tr><td>Waist</td><td>Measure at the natural crease</td></tr></table>',
                '<span class="handout-stamp"><span style="font-style: italic">Sample only</span></span></div>',
                'She had underlined <span style="background-color: #f6f2e8; color: #252320">test pattern</span> twice.',
            ].join('\n\n'));
            const text = page.locator('#chat > .mes[mesid="0"] .mes_text');
            const card = text.locator('.custom-handout');
            await expect(text.getByText('unfolded', { exact: true })).toHaveCSS('-webkit-text-stroke-width', '2px');
            for (const target of [card.getByText('ATELIER NOTES', { exact: true }), card.getByRole('cell', { name: 'Waist', exact: true }), text.getByText('test pattern', { exact: true })]) {
                await expect(target).toHaveCSS('-webkit-text-stroke-width', '0px');
                await expect(target).toHaveCSS('paint-order', 'normal');
            }
            await expect(card.getByText('Sample only', { exact: true })).toHaveCSS('-webkit-text-stroke-width', '1px');
            await page.evaluate(() => window.NeconyanShell.setTextOutline({ on: false }));
        });
    });
}

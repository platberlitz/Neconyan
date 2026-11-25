/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Phone and desktop, Chromium and WebKit, and the baseline capture, share one script. */
/* eslint-disable playwright/no-standalone-expect -- Shared helpers verify the visible quick prompts row. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test as base } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before && !process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
if (before) base.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });

const test = base.extend({
    readyAccount: [async ({ app }, use, testInfo) => {
        const phone = testInfo.title.startsWith('phone');
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        // The first-run tour card sits over the composer area and would take the arrow clicks.
        await page.addLocatorHandler(page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]'), async skip => {
            await skip.click();
        });
        await page.evaluate(() => document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]:not(:disabled)')?.click());
        await use({ account, page, phone });
    }, { timeout: 180000 }],
});
const webkitTest = test.extend({ browserName: 'webkit' });

const question = 'Suggest a quiet opening for the garden scene.';
const answer = 'Start with the garden gate left open.';

async function open({ page, phone }) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeVisible();
    if (phone) await applyIOSOnlyCss(page);
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function seed(ready) {
    const source = await open(ready);
    await ready.account.post('/api/scratchpad/session/import', { source, session: {
        name: 'Garden ideas', assistant: 'miso', settings: { connection: { kind: 'profile', profileId: 'durable' } },
        messages: [{ role: 'user', text: question }, { role: 'assistant', assistant: 'miso', assistantName: 'Miso', text: answer }],
    } });
    await open(ready);
    await expect(ready.page.locator('.scratchpad-reply')).toHaveText(answer);
    return source;
}

/** A roleplay chat with a linked lorebook, which gives Scratchpad its longest list of built-in prompts. */
async function openCharacterChat(ready) {
    const { account, page } = ready;
    await account.post('/api/worldinfo/edit', { name: 'Prompt Harbour', data: { entries: {
        0: { uid: 0, comment: 'Quay', key: ['quay'], constant: true, content: 'The quay is open.' },
    } } });
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
        ch_name: 'Harbour Keeper', description: 'Keeps the harbour lights.', first_mes: 'The lamps are lit.', mes_example: '', world: 'Prompt Harbour',
    } });
    expect(created.ok()).toBe(true);
    const avatar = await created.text();
    // The card carries its lorebook, so the host offers to import it; the book already exists.
    const importOffer = page.locator('dialog.popup').filter({ hasText: 'This character has an embedded World/Lorebook.' });
    await page.addLocatorHandler(importOffer, async dialog => {
        await dialog.getByRole('button', { name: 'No', exact: true }).click();
    });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
    }, avatar);
    await expect(page.locator('#chat .mes_text').first()).toBeVisible();
    const source = await open(ready);
    expect(source.kind).toBe('roleplay');
    await expect.poll(() => page.locator('.scratchpad-quick .scratchpad-chip').count()).toBeGreaterThanOrEqual(10);
    return source;
}

async function picture(page, name, phone) {
    await fs.mkdir('../screenshots', { recursive: true });
    await settleCssTransitions(page);
    await page.screenshot({ path: `../screenshots/scratchpad-${name}-${phone ? 'phone' : 'desktop'}-${before ? 'before' : 'after'}.png`,
        style: '#toast-container, #nn-update-toast { visibility: hidden; }' });
}

/** Boxes of everything in the quick prompts bar, measured in one pass. */
function measureBar(page) {
    return page.evaluate(() => {
        const box = node => {
            if (!node || !node.getClientRects().length) return null;
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const bar = document.querySelector('#neconyan-scratchpad .scratchpad-quick-bar');
        const quick = bar.querySelector('.scratchpad-quick');
        const chrome = bar.querySelector('.scratchpad-quick-rail > .sb-mobile-rail-chrome');
        const visible = node => Boolean(node && !node.hidden && node.getClientRects().length);
        return {
            bar: box(bar),
            quick: box(quick),
            toggle: box(bar.querySelector('.scratchpad-quick-toggle')),
            edit: box(bar.querySelector('.scratchpad-chip-edit')),
            chips: [...quick.querySelectorAll('.scratchpad-chip')].map(box).filter(Boolean),
            scrollLeft: quick.scrollLeft,
            scrollWidth: quick.scrollWidth,
            clientWidth: quick.clientWidth,
            wrap: getComputedStyle(quick).flexWrap,
            overflowX: getComputedStyle(quick).overflowX,
            touchAction: getComputedStyle(quick).touchAction,
            chrome: visible(chrome),
            left: visible(chrome?.querySelector('.sb-mobile-rail-left')) ? box(chrome.querySelector('.sb-mobile-rail-left')) : null,
            right: visible(chrome?.querySelector('.sb-mobile-rail-right')) ? box(chrome.querySelector('.sb-mobile-rail-right')) : null,
            page: document.documentElement.scrollWidth,
        };
    });
}

/** The element painted at the middle of a locator belongs to that locator, so nothing covers it. */
function hitsItself(locator) {
    return locator.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return node === hit || node.contains(hit);
    });
}

/** Label contrast of an element, painted through a 1x1 canvas so colour-mix and alpha resolve as drawn. */
function contrastOf(locator) {
    return locator.evaluate(node => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const paint = colours => {
            context.clearRect(0, 0, 1, 1);
            for (const colour of colours) {
                context.fillStyle = colour;
                context.fillRect(0, 0, 1, 1);
            }
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const layers = [];
        for (let element = node; element; element = element.parentElement) {
            const background = getComputedStyle(element).backgroundColor;
            if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') layers.unshift(background);
        }
        const luminance = rgb => {
            const [r, g, b] = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return r * 0.2126 + g * 0.7152 + b * 0.0722;
        };
        const fillRgb = paint(['rgb(255, 255, 255)', ...layers]);
        const fill = luminance(fillRgb);
        const ink = luminance(paint([`rgb(${fillRgb.join(', ')})`, getComputedStyle(node).color]));
        return { ratio: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05), color: getComputedStyle(node).color, background: `rgb(${fillRgb.join(', ')})` };
    });
}

/** One compact row: every chip on the same line, inside the page and clear of the pinned pencil. */
function expectOneRow(geometry, { phone, width }) {
    expect(geometry.wrap).toBe('nowrap');
    expect(geometry.overflowX).toBe('auto');
    expect(geometry.touchAction).toBe('pan-x');
    expect(geometry.bar.height).toBeLessThan(60);
    expect(geometry.bar.left).toBeGreaterThanOrEqual(0);
    expect(geometry.bar.right).toBeLessThanOrEqual(width);
    expect(geometry.page).toBe(width);
    const tops = new Set(geometry.chips.map(chip => Math.round(chip.top)));
    expect(tops.size, JSON.stringify(geometry.chips)).toBe(1);
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth + 40);
    expect(geometry.edit.left).toBeGreaterThanOrEqual(geometry.quick.right);
    expect(geometry.edit.right).toBeLessThanOrEqual(geometry.bar.right + 1);
    if (phone) {
        for (const chip of geometry.chips) expect(chip.height).toBeGreaterThanOrEqual(44);
        for (const control of [geometry.edit, geometry.toggle]) {
            expect(control.height).toBeGreaterThanOrEqual(44);
            expect(control.width).toBeGreaterThanOrEqual(44);
        }
    }
}

/** The shared rail arrows show, scroll the row both ways and never sit over the pinned pencil. */
async function checkArrows(page, geometry) {
    expect(geometry.chrome).toBe(true);
    expect(geometry.left).toBeNull();
    expect(geometry.right).not.toBeNull();
    expect(geometry.right.right).toBeLessThanOrEqual(geometry.edit.left + 1);
    const quick = page.locator('#neconyan-scratchpad .scratchpad-quick');
    const right = page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right');
    const left = page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-left');
    await right.click();
    await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBeGreaterThan(40);
    await expect(left).toBeVisible();
    await left.click();
    await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBe(0);
    await expect(left).toBeHidden();
}

for (const phone of [true, false]) {
    const size = phone ? 'phone' : 'desktop';
    const width = phone ? 393 : 1280;

    test(`${size} baseline Scratchpad quick prompts`, async ({ readyAccount }) => {
        test.skip(!before, 'Baseline capture only.');
        test.setTimeout(240000);
        const { page } = readyAccount;
        await open(readyAccount);
        await expect(page.locator('.scratchpad-quick .scratchpad-chip').first()).toBeVisible();
        const height = await page.locator('.scratchpad-quick').evaluate(node => node.getBoundingClientRect().height);
        console.log(`baseline quick prompts ${size}: ${Math.round(height)}px tall`);
        await picture(page, 'quick-empty', phone);
        await seed(readyAccount);
        await picture(page, 'quick-populated', phone);
    });

    test(`${size} baseline Scratchpad quick prompts in a roleplay chat`, async ({ readyAccount }) => {
        test.skip(!before, 'Baseline capture only.');
        test.setTimeout(240000);
        const { page } = readyAccount;
        await openCharacterChat(readyAccount);
        const height = await page.locator('.scratchpad-quick').evaluate(node => node.getBoundingClientRect().height);
        const count = await page.locator('.scratchpad-quick .scratchpad-chip').count();
        console.log(`baseline roleplay quick prompts ${size}: ${count} buttons, ${Math.round(height)}px tall`);
        await picture(page, 'quick-roleplay', phone);
    });

    test(`${size} roleplay Scratchpad keeps its long quick prompts list on one row`, async ({ readyAccount }) => {
        test.skip(before, 'Needs the new quick prompts bar.');
        test.setTimeout(240000);
        const { page, phone: isPhone } = readyAccount;
        await openCharacterChat(readyAccount);
        await expect(page.locator('.scratchpad-quick-toggle')).toHaveAttribute('aria-expanded', 'true');
        await settleCssTransitions(page);
        const geometry = await measureBar(page);
        console.log(`roleplay quick prompts ${size}: ${geometry.chips.length + 1} buttons, bar ${Math.round(geometry.bar.height)}px tall`);
        expectOneRow(geometry, { phone: isPhone, width });
        await checkArrows(page, geometry);
        await picture(page, 'quick-roleplay', isPhone);
    });

    test(`${size} empty Scratchpad session keeps quick prompts on one scrolling row`, async ({ readyAccount }) => {
        test.skip(before, 'Needs the new quick prompts bar.');
        test.setTimeout(240000);
        const { page } = readyAccount;
        await open(readyAccount);
        const toggle = page.locator('.scratchpad-quick-toggle');
        const edit = page.locator('.scratchpad-quick-bar').getByRole('button', { name: 'Edit quick prompts', exact: true });
        const quick = page.locator('#neconyan-scratchpad .scratchpad-quick');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(toggle).toHaveAttribute('title', 'Hide quick prompts');
        await expect(quick).toBeVisible();
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right')).toBeVisible();
        await settleCssTransitions(page);
        const geometry = await measureBar(page);
        expectOneRow(geometry, { phone, width });
        console.log(`quick prompts ${size} empty: bar ${Math.round(geometry.bar.height)}px tall, row ${geometry.clientWidth}/${geometry.scrollWidth}px`);
        await picture(page, 'quick-empty', phone);
        await checkArrows(page, geometry);

        if (!phone) {
            // A plain mouse wheel glides the row sideways instead of scrolling the page, even after clicking a rail arrow.
            const box = await quick.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 120);
            await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBeGreaterThan(80);
            await page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right').click();
            await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBeGreaterThan(250);
            const afterArrow = await quick.evaluate(node => node.scrollLeft);
            await page.mouse.wheel(0, 120);
            await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBeGreaterThan(afterArrow + 40);
            await page.mouse.wheel(0, -2400);
            await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBe(0);
        }

        // The pencil stays clickable with the row scrolled to its very end.
        await quick.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right')).toBeHidden();
        expect(await hitsItself(edit)).toBe(true);
        await quick.evaluate(node => { node.scrollLeft = 0; });
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right')).toBeVisible();
        expect(await hitsItself(edit)).toBe(true);
        await edit.click();
        await expect(page.getByRole('button', { name: 'Add a prompt', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Add a prompt', exact: true })).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');

        // Folding the empty session is the person's choice and sticks while it stays open.
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(quick).toBeHidden();
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(quick).toBeVisible();
    });

    test(`${size} populated Scratchpad session folds quick prompts into a slim bar`, async ({ readyAccount }) => {
        test.skip(before, 'Needs the new quick prompts bar.');
        test.setTimeout(240000);
        const { page } = readyAccount;
        await seed(readyAccount);
        const toggle = page.locator('.scratchpad-quick-toggle');
        const edit = page.locator('.scratchpad-quick-bar').getByRole('button', { name: 'Edit quick prompts', exact: true });
        const quick = page.locator('#neconyan-scratchpad .scratchpad-quick');
        const composer = page.locator('.scratchpad-composer');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toHaveAttribute('title', 'Show quick prompts');
        await expect(toggle).toHaveText('Quick prompts');
        await expect(quick).toBeHidden();
        await expect(edit).toBeVisible();
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-chrome')).toBeHidden();
        await settleCssTransitions(page);
        const folded = await measureBar(page);
        expect(folded.bar.height).toBeLessThan(phone ? 52 : 40);
        expect(folded.page).toBe(width);
        expect(folded.toggle.top).toBeGreaterThanOrEqual(folded.bar.top - 1);
        expect(folded.edit.top).toBeGreaterThanOrEqual(folded.bar.top - 1);
        expect(folded.edit.left).toBeGreaterThan(folded.toggle.right);
        // The pencil keeps its place at the right end of the bar, folded or open.
        expect(Math.abs(folded.edit.right - folded.bar.right)).toBeLessThanOrEqual(1);
        if (phone) {
            for (const control of [folded.toggle, folded.edit]) {
                expect(control.height).toBeGreaterThanOrEqual(44);
                expect(control.width).toBeGreaterThanOrEqual(44);
            }
        }
        console.log(`quick prompts ${size} folded: bar ${Math.round(folded.bar.height)}px tall`);
        await picture(page, 'quick-populated', phone);

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(quick).toBeVisible();
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right')).toBeVisible();
        await settleCssTransitions(page);
        const opened = await measureBar(page);
        expectOneRow(opened, { phone, width });
        await picture(page, 'quick-populated-open', phone);

        // Picking a chip fills the composer and leaves the row where it was.
        await page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right').click();
        await expect.poll(() => quick.evaluate(node => node.scrollLeft)).toBeGreaterThan(40);
        const scrolled = await quick.evaluate(node => node.scrollLeft);
        // Press the chip under the middle of the row, as a finger or mouse would, without Playwright scrolling it into view.
        const target = await quick.evaluate(node => {
            const rail = node.getBoundingClientRect();
            const x = rail.left + rail.width / 2;
            const y = rail.top + rail.height / 2;
            const hit = document.elementFromPoint(x, y)?.closest('.scratchpad-chip');
            return hit && node.contains(hit) ? { x, y, label: hit.textContent.trim() } : null;
        });
        expect(target).not.toBeNull();
        const label = target.label;
        await page.mouse.click(target.x, target.y);
        await expect(composer).not.toHaveValue('');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(Math.abs(await quick.evaluate(node => node.scrollLeft) - scrolled), `after ${label}`).toBeLessThanOrEqual(1);
        await composer.fill('');

        // The bar keeps its label readable on the default, a pale and a dark accent.
        const contrast = {};
        for (const [name, rgba] of [['Calico', null], ['Mint Glass', 'rgba(110,231,183,1)'], ['Plum Wine', 'rgba(126,34,206,1)']]) {
            if (rgba) {
                await page.evaluate(value => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: value } }));
                }, rgba);
            }
            await settleCssTransitions(page);
            contrast[name] = {
                toggle: await contrastOf(toggle),
                edit: await contrastOf(edit.locator('i')),
                chip: await contrastOf(quick.locator('.scratchpad-chip').first()),
                arrow: await contrastOf(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right > span')),
            };
            if (rgba) expect(contrast[name].arrow.background, `${name} accent applied`).not.toBe(contrast.Calico.arrow.background);
            for (const [part, value] of Object.entries(contrast[name])) {
                expect(value.ratio, `${name} ${part} ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(part === 'arrow' ? 3 : 4.5);
            }
            await picture(page, `quick-populated-open-${name.toLowerCase().replace(' ', '-')}`, phone);
        }
        console.log(`quick prompts ${size} contrast: ${Object.entries(contrast).map(([name, value]) => `${name} ${Object.entries(value).map(([part, sample]) => `${part} ${sample.ratio.toFixed(2)}`).join(', ')}`).join('; ')}`);

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(quick).toBeHidden();

        // A new, empty session starts with the row open again.
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        await expect(page.locator('.scratchpad-reply')).toHaveCount(0);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(quick).toBeVisible();

        // Going back to the session with messages folds the row again.
        await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
        await page.getByRole('button', { name: 'Open Garden ideas', exact: true }).click();
        await expect(page.locator('.scratchpad-reply')).toHaveText(answer);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(quick).toBeHidden();
    });

    webkitTest(`${size} WebKit draws the shared rail arrows on the quick prompts row`, async ({ readyAccount }) => {
        test.skip(before, 'Needs the new quick prompts bar.');
        test.setTimeout(300000);
        const { page } = readyAccount;
        await open(readyAccount);
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right')).toBeVisible();
        await settleCssTransitions(page);
        const geometry = await measureBar(page);
        expectOneRow(geometry, { phone, width });
        await checkArrows(page, geometry);
        expect(await hitsItself(page.locator('.scratchpad-quick-bar .scratchpad-chip-edit'))).toBe(true);

        await seed(readyAccount);
        const toggle = page.locator('.scratchpad-quick-toggle');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#neconyan-scratchpad .scratchpad-quick-rail .sb-mobile-rail-right')).toBeVisible();
        expectOneRow(await measureBar(page), { phone, width });
        await page.evaluate(() => window.toastr?.clear());
    });
}

/* global document, window */
/* eslint-disable playwright/no-force-option -- Appearance controls live in a closed drawer. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function openRoleplay(app, options = {}) {
    const account = await app.account({ activeConnection: true, ...options });
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext();
        await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await window.NeconyanShell.activateMode('roleplay');
    }, account.avatar);
    await page.locator('#chat_display').selectOption('1', { force: true });
    return { page, account };
}

async function sizes(page, pageWidth, bottomSize) {
    for (const [selector, value] of [['#chat_width_slider', pageWidth], ['#sb-bottom-bar-scale-input', bottomSize]]) {
        await page.locator(selector).evaluate((el, value) => {
            el.value = String(value);
            for (const event of ['input', 'change', 'mouseup']) el.dispatchEvent(new Event(event, { bubbles: true }));
        }, value);
    }
    await expect(page.locator('html')).toHaveCSS('--neconyanPageWidthScale', String(pageWidth / 100));
    await expect(page.locator('html')).toHaveCSS('--sb-bottom-bar-scale', String(bottomSize / 100));
}

async function geometry(page) {
    return page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        const bar = document.querySelector('#sb-bottom-chat-bar');
        return { form: box('#form_sheld'), bar: box('#sb-bottom-chat-bar'), composer: box('#send_form'),
            textarea: box('#send_textarea'), message: box('#chat > .mes'), shell: box('#sheld'),
            overflow: bar.scrollWidth - bar.clientWidth,
            missed: [...bar.querySelectorAll('button, input, select')].filter(el => {
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) return false;
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return hit !== el && !el.contains(hit);
            }).map(el => el.title || el.id) };
    });
}

async function reachableToolbar(page) {
    const bar = page.locator('#sb-bottom-chat-bar');
    const overflow = await bar.evaluate(el => el.scrollWidth - el.clientWidth);
    if (overflow > 1) {
        await expect(bar).toHaveCSS('overflow-x', 'auto');
        await bar.evaluate(el => { el.scrollLeft = 0; });
        await bar.hover(); await page.mouse.wheel(900, 0);
        await expect.poll(() => bar.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    }
    for (const control of await bar.locator('button, input, select').all()) {
        if (!await control.isVisible()) continue;
        await control.scrollIntoViewIfNeeded();
        expect(await control.evaluate(el => {
            const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit === el || el.contains(hit);
        }), await control.getAttribute('title')).toBe(true);
    }
}

async function pinForScenario(page, pinned) {
    if (!pinned) return;
    await page.locator('#sb-topbar-edit-card').click();
    await page.locator('#sb_character_dock_toggle').click();
    await expect(page.locator('#right-nav-panel')).toHaveClass(/pinnedOpen/);
}

test('bottom bar and composer widen independently of the reading column', async ({ app }) => {
    test.setTimeout(120000);
    const { page } = await openRoleplay(app);
    await sizes(page, 80, 80);
    const small = await geometry(page);
    await sizes(page, 80, 100);
    await expect.poll(async () => (await geometry(page)).form.width).toBe(860);
    const large = await geometry(page);
    expect(small.form.width).toBe(688);
    expect(large.bar.width).toBeGreaterThan(small.bar.width);
    expect(large.composer.width).toBeGreaterThan(small.composer.width);
    expect(large.textarea.width).toBeGreaterThan(small.textarea.width);
    expect(large.message.width).toBe(small.message.width);
    await sizes(page, 100, 100);
    expect((await geometry(page)).form.width).toBe(large.form.width);
});

test('maximum bottom bar size keeps controls reachable in narrow and pinned desktop workspaces', async ({ app }) => {
    test.setTimeout(120000);
    const { page } = await openRoleplay(app);
    await sizes(page, 80, 150);
    for (const pinned of [false, true]) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await pinForScenario(page, pinned);
        for (const width of [1280, 1000, 900, 769]) {
            await page.setViewportSize({ width, height: 900 });
            await reachableToolbar(page);
            const r = await geometry(page);
            expect(r.form.width).toBeLessThanOrEqual(r.shell.width + 1);
            await page.locator('#send_textarea').click();
            await page.locator('#send_textarea').fill('The composer remains usable.');
            await expect(page.locator('#send_textarea')).toHaveValue('The composer remains usable.');
            await expect(page.locator('#send_but')).toBeVisible();
            expect(await page.locator('#send_but').evaluate(el => {
                const b = el.getBoundingClientRect(), hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
                return hit === el || el.contains(hit);
            })).toBe(true);
            expect((await geometry(page)).textarea.width).toBeGreaterThan(100);
        }
    }
});

test('Echo and Whisper retain the existing lower-edge width condition', async ({ app }) => {
    test.setTimeout(120000);
    const { page } = await openRoleplay(app);
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.chat[0].mes = Array.from({ length: 24 }, () => 'A long reading panel continues beneath the toolbar. Its curved lower edge is appropriate only while the panel is wider than the toolbar.').join('\n\n');
        c.chat[0].swipes = [c.chat[0].mes]; c.chat[0].swipe_id = 0;
        await c.saveChat(); await c.reloadCurrentChat();
    });
    const cap = page.locator('#neconyan-bubbles-bottom-boundary');
    for (const style of ['3', '4']) {
        await page.locator('#chat_display').selectOption(style, { force: true });
        await sizes(page, 80, 80);
        await page.locator('#chat').evaluate(el => { el.scrollTop = 0; });
        await expect(cap).toBeVisible();
        await sizes(page, 80, 150);
        await expect(cap).toBeHidden();
    }
});

test('iPhone emulation can swipe the maximum-size secondary row to its final control', async ({ app }) => {
    test.setTimeout(120000);
    const { page, account } = await openRoleplay(app, { phone: true, contextOptions: IPHONE_SAFARI_CONTEXT });
    // Install before a reload so the app sees the platform at startup.
    await installIPhoneSafari(account.context, { standalone: false });
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await window.NeconyanShell.activateMode('roleplay');
    }, account.avatar);
    await expect(page.locator('#sb-bottom-chat-secondary-row')).toBeVisible();
    await sizes(page, 80, 150); await applyIOSOnlyCss(page);
    const row = page.locator('#sb-bottom-chat-secondary-row');
    const last = row.locator('button').last();
    expect(await last.evaluate(el => el.getBoundingClientRect().right > el.closest('#sb-bottom-chat-secondary-row').getBoundingClientRect().right)).toBe(true);
    const b = await row.boundingBox();
    const session = await account.context.newCDPSession(page);
    const y = b.y + b.height / 2;
    const point = x => ({ x, y, radiusX: 1, radiusY: 1, force: 1 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(320)] });
    for (let step = 1; step <= 16; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(320 - step * 15)] });
        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(resolve)));
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => row.evaluate(el => el.scrollLeft)).toBeGreaterThan(20);
    await expect.poll(() => last.evaluate(el => {
        const b = el.getBoundingClientRect(), rail = el.closest('#sb-bottom-chat-secondary-row').getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return b.left >= rail.left && b.right <= rail.right && (hit === el || el.contains(hit));
    }), { message: 'Touch swipes expose the final button fully and leave it reachable' }).toBe(true);
    expect((await geometry(page)).form.width).toBe(393);
});

/* global window, document, getComputedStyle, HTMLImageElement */
/* eslint-disable playwright/no-force-option -- Native Appearance controls live in a closed drawer. */
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('Whisper copies only card paint and preserves corrected geometry, native editing and export', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        c.chat[0].mes = 'WHISPER FIRST\n\n' + 'A native reading card continues through the lower edge.\n\n'.repeat(70) + 'WHISPER FINAL';
        c.chat[0].swipes = [c.chat[0].mes, c.chat[0].mes]; c.chat[0].swipe_id = 0;
        c.chat[0].extra = { reasoning: 'Native saved reasoning.', reasoning_duration: 1000 };
        await c.saveChat(); await c.reloadCurrentChat(); await window.NeconyanShell.activateMode('roleplay');
    }, account.avatar);
    await page.locator('#chat_display').selectOption('4', { force: true });
    await page.locator('#desktop_response_controls').selectOption('inside', { force: true });
    const row = page.locator('#chat > .mes[mesid="0"]'), chat = page.locator('#chat'), cap = page.locator('#neconyan-bubbles-bottom-boundary');
    const wheel = async delta => {
        const box = await chat.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, delta);
    };
    await wheel(-99999);
    await chat.evaluate(el => { el.scrollTop = 0; }); await expect(cap).toBeVisible();
    const measure = () => row.evaluate(el => {
        const chat = el.parentElement, box = element => element.getBoundingClientRect().toJSON();
        return { row: box(el), text: box(el.querySelector('.mes_text')), footer: box(el.querySelector('.nn-response-controls')),
            scrollHeight: chat.scrollHeight, clientHeight: chat.clientHeight, scrollTop: chat.scrollTop, composer: box(document.querySelector('#send_form')) };
    });
    const enabled = await measure();
    await chat.evaluate(el => { el.style.clipPath = 'inset(0px)'; }); await expect(cap).toBeHidden();
    expect(await measure()).toEqual(enabled);
    await chat.evaluate(el => el.style.removeProperty('clip-path')); await expect(cap).toBeVisible(); expect(await measure()).toEqual(enabled);
    const paint = await cap.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el.firstElementChild).backgroundImage,
        bottom: el.getBoundingClientRect().bottom, bar: document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().top, pointer: getComputedStyle(el).pointerEvents }));
    expect(paint.background).toBe(await row.evaluate(el => getComputedStyle(el).backgroundColor)); expect(paint.image).toBe('none');
    expect(paint.bottom).toBe(paint.bar + 4); expect(paint.pointer).toBe('none');
    await row.evaluate(el => el.classList.add('selected'));
    await expect.poll(() => cap.evaluate(el => getComputedStyle(el).backgroundColor === getComputedStyle(document.querySelector('#chat > .mes[mesid="0"]')).backgroundColor)).toBe(true);
    await row.evaluate(el => { el.classList.remove('selected'); el.style.opacity = '0.55'; }); await expect(cap).toHaveCSS('opacity', '0.55');
    await row.evaluate(el => el.style.removeProperty('opacity'));

    await row.locator('.mes_reasoning_details').evaluate(el => { el.open = true; });
    await row.locator('.mes_edit').dispatchEvent('click'); const editor = row.locator('.edit_textarea'); await expect(editor).toBeVisible();
    await expect(row.locator('.reasoning_edit_textarea')).toBeVisible();
    await wheel(-1);
    await editor.evaluate(el => { const chat = el.closest('.mes').parentElement; chat.scrollTop += el.getBoundingClientRect().top + el.clientHeight / 2 - chat.getBoundingClientRect().bottom + 1; });
    await expect(cap).toBeVisible();
    const editing = await editor.evaluate(el => {
        const box = el.getBoundingClientRect(), chat = el.closest('.mes').parentElement;
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, outer: chat.scrollTop, inner: el.scrollTop,
            lane: document.elementFromPoint(box.left + el.clientLeft + el.clientWidth + 2, chat.getBoundingClientRect().bottom - 2) === el };
    });
    expect(editing.scrollHeight).toBeGreaterThan(editing.clientHeight); expect(editing.lane).toBe(true);
    await editor.evaluate(el => { el.focus({ preventScroll: true }); el.setSelectionRange(0, 7); });
    await page.keyboard.press('ArrowRight'); expect(await editor.evaluate(el => el.selectionStart)).toBe(7);
    const eb = await editor.boundingBox(), cb = await chat.boundingBox();
    await page.mouse.move(eb.x + eb.width / 2, Math.min(eb.y + eb.height - 30, cb.y + cb.height - 30)); await page.mouse.wheel(0, 160);
    await expect.poll(() => editor.evaluate(el => el.scrollTop)).toBeGreaterThan(editing.inner);
    expect(await chat.evaluate(el => el.scrollTop)).toBe(editing.outer);
    await row.locator('.mes_edit_cancel').dispatchEvent('click'); await expect(editor).toHaveCount(0);
    await wheel(99999); await expect(cap).toBeHidden();

    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        const { renderCompanionResultsForMessage } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        c.chat[0].extra[COMPANION_RESULTS_EXTRA_KEY] = { footer: { agentName: 'Native Notes', status: 'done', content: 'WHISPER FINAL NOTES', collapsed: false } };
        renderCompanionResultsForMessage(0);
        const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'); window.whisperExportSvg = [];
        Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get: original.get, set(value) {
            if (/^data:image\/svg\+xml.*;base64,/.test(String(value))) window.whisperExportSvg.push(String(value)); original.set.call(this, value);
        } });
    });
    await row.locator('.mes_screenshot').dispatchEvent('click'); await expect(page.locator('.message_screenshot_popup')).toBeVisible();
    const downloading = page.waitForEvent('download', { timeout: 60000 }); await page.locator('.message_screenshot_popup .popup-button-ok').click();
    const download = await downloading, pngPath = info.outputPath('whisper-native-export.png'); await download.saveAs(pngPath);
    const png = PNG.sync.read(await fs.readFile(pngPath)); expect(png.height).toBeGreaterThan(900);
    const svgSource = await page.evaluate(() => window.whisperExportSvg.at(-1)), svg = Buffer.from(svgSource.split(',')[1], 'base64').toString('utf8');
    expect(svg).toContain('WHISPER FIRST'); expect(svg).toContain('WHISPER FINAL'); expect(svg).toContain('WHISPER FINAL NOTES'); expect(svg).not.toContain('neconyan-bubbles-bottom-boundary');
    const svgPath = info.outputPath('whisper-native-export.svg'); await fs.writeFile(svgPath, svg);
    await info.attach('Native complete Whisper export', { path: pngPath, contentType: 'image/png' }); await info.attach('Captured SVG', { path: svgPath, contentType: 'image/svg+xml' });
    await wheel(-99999);
    for (const width of [1920, 1001, 1000, 900, 769]) {
        await page.setViewportSize({ width, height: 900 }); await chat.evaluate(el => { el.scrollTop = 0; });
        const wider = await row.evaluate(el => el.getBoundingClientRect().width > document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().width + 1);
        await expect.poll(() => cap.isVisible()).toBe(wider);
    }
    for (const width of [768, 393]) { await page.setViewportSize({ width, height: 852 }); await expect(cap).toBeHidden(); }
    await page.setViewportSize({ width: 1280, height: 900 }); await wheel(-99999); await expect(cap).toBeVisible();
    await page.locator('#chat_display').selectOption('0', { force: true }); await expect(cap).toBeHidden();
    await page.locator('#chat_display').selectOption('4', { force: true }); await expect(cap).toBeVisible();
    await row.locator('.mes_hide').dispatchEvent('click'); await expect(row).toHaveAttribute('is_system', 'true'); await expect(cap).toBeHidden();
});

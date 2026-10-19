/* global window, document, getComputedStyle, HTMLImageElement */
/* eslint-disable playwright/no-force-option -- Appearance controls live in a closed native drawer. */
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test('Echo preserves native structure, cutoff exemptions, tablet paint and actual export', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext(); await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        context.chat[0].mes = 'ECHO FIRST CONTENT\n\n' + Array.from({ length: 50 }, (_, i) => `Passage ${i}: native text continues beneath the corner portrait and reaches the final edge.`).join('\n\n') + '\n\nECHO FINAL CONTENT';
        context.chat[0].extra = { reasoning: 'A retained native reasoning control.', reasoning_duration: 1000 };
        await context.saveChat(); await context.reloadCurrentChat();
    }, account.avatar);
    await page.locator('#chat_display').selectOption('3', { force: true });
    const row = page.locator('#chat > .mes[mesid="0"]'), cap = page.locator('#neconyan-bubbles-bottom-boundary');
    await expect(row).toHaveClass(/nn-echo-layout/);
    await expect(row.locator(':scope > .mesAvatarWrapper')).toHaveCount(1);
    await expect(row.locator(':scope > .mes_block > .ch_name')).toHaveCount(1);
    expect(await row.locator(':scope > .mes_block').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(100);
    await expect(row.locator('.mes_text')).toHaveCSS('padding-right', '14px');
    const wheelToTop = async () => {
        const box = await page.locator('#chat').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -99999);
    };
    await wheelToTop(); await expect(row.locator('.ch_name')).toBeVisible();
    // Give the tested row enough earlier history to cross the lower cutoff.
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext(); context.chat.unshift({ ...context.chat[0], mes: 'Earlier history.\n\n'.repeat(20) });
        await context.saveChat(); await context.reloadCurrentChat();
    });
    const message = page.locator('#chat > .mes[mesid="1"]');
    await expect(message.locator('.nn-response-controls')).toHaveCount(1);
    const chatBox = await page.locator('#chat').boundingBox();
    await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2);
    await page.mouse.wheel(0, 1); // Cancel native pending scroll restoration before placing the boundary.
    await message.evaluate(el => {
        const chat = el.parentElement, plate = el.querySelector('.nn-echo-header-plate');
        chat.scrollTop += plate.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom - 8;
    });
    await expect(message).toHaveClass(/nn-echo-cutoff/);
    await expect(message.locator('.ch_name')).toBeHidden();
    const offset = await message.evaluate(el => el.offsetTop);
    await message.evaluate(el => el.parentElement.scrollTop += 30);
    await expect(message.locator('.ch_name')).toBeVisible();
    expect(await message.evaluate(el => el.offsetTop)).toBe(offset);
    await message.locator('.mes_reasoning_details').evaluate(el => el.open = true);
    await message.evaluate(el => { el.parentElement.scrollTop += el.querySelector('.nn-echo-header-plate').getBoundingClientRect().bottom - el.parentElement.getBoundingClientRect().bottom - 8; });
    await expect(message.locator('.ch_name')).toBeVisible();
    await message.locator('.mes_reasoning_details').evaluate(el => el.open = false);
    await expect(message.locator('.ch_name')).toBeHidden();
    await message.locator('.mes_screenshot').dispatchEvent('click');
    await expect(page.locator('.message_screenshot_popup')).toBeVisible();
    const downloading = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('.message_screenshot_popup .popup-button-ok').click();
    const download = await downloading, file = info.outputPath('echo-complete-message.png'); await download.saveAs(file);
    const png = PNG.sync.read(await fs.readFile(file)); expect(png.height).toBeGreaterThan(900);
    await info.attach('Echo native downloaded image: first and final content', { path: file, contentType: 'image/png' });
    await message.locator('.mes_hide').dispatchEvent('click');
    await expect(message).toHaveAttribute('is_system', 'true');
    await expect(message).not.toHaveClass(/nn-echo-layout|nn-echo-cutoff/);
    await expect(message.locator('.nn-echo-header-plate, .nn-echo-header-bottom')).toHaveCount(0);
    await expect.poll(() => message.evaluate(el => [...el.style].some(key => key.startsWith('--nn-echo-')))).toBe(false);
    await message.locator('.mes_unhide').dispatchEvent('click');
    await expect(message).toHaveAttribute('is_system', 'false');
    await expect(message).toHaveClass(/nn-echo-layout/);
    await expect(message.locator('.nn-echo-header-plate')).toHaveCount(1);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat[1].name = 'Miso with a very long bibliographical character name that should remain within the captured message panel and retain the entire name';
        context.chat[1].extra.files = [{ name: 'export-attachment.txt', size: 200, url: '/not-downloaded.txt' }];
        await context.saveChat(); await context.reloadCurrentChat();
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        const { renderCompanionResultsForMessage } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        context.chat[1].extra[COMPANION_RESULTS_EXTRA_KEY] = { export: { agentName: 'Export Notes', status: 'done', content: 'The final Notes section must remain complete.\n\nECHO FINAL NOTES MARKER', collapsed: false } };
        renderCompanionResultsForMessage(1);
    });
    await message.locator('.mes_reasoning_details').evaluate(el => el.open = true);
    await expect(message.locator('.ica--companion-ledger')).toContainText('ECHO FINAL NOTES MARKER');
    await expect(message.locator('.name_text')).toContainText('entire name');
    await expect(message.locator('.nn-response-controls')).toHaveClass(/nn-echo-overlay-footer/);
    await page.evaluate(() => {
        const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        window.echoExportSvg = [];
        Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get: original.get, set(value) {
            if (/^data:image\/svg\+xml.*;base64,/.test(String(value))) window.echoExportSvg.push(String(value));
            original.set.call(this, value);
        } });
    });
    await message.locator('.mes_screenshot').dispatchEvent('click');
    await expect(page.locator('.message_screenshot_popup')).toBeVisible();
    const longDownloading = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('.message_screenshot_popup .popup-button-ok').click();
    const longDownload = await longDownloading, longFile = info.outputPath('echo-long-header-open-notes.png');
    await longDownload.saveAs(longFile);
    const longPng = PNG.sync.read(await fs.readFile(longFile));
    expect(longPng.width).toBe(png.width); expect(longPng.height).toBeGreaterThan(png.height);
    await info.attach('Echo complete long name, open reasoning and final Notes', { path: longFile, contentType: 'image/png' });
    const svgSource = await page.evaluate(() => window.echoExportSvg.at(-1));
    const svg = Buffer.from(svgSource.split(',')[1], 'base64').toString('utf8');
    const svgFile = info.outputPath('echo-long-header-open-notes.svg'); await fs.writeFile(svgFile, svg);
    const foreignObject = svg.match(/<foreignObject[^>]*>([\s\S]*)<\/foreignObject>/)[1];
    const artifact = await page.context().newPage();
    await artifact.setContent(`<html><body style="margin:0">${foreignObject}</body></html>`);
    const bounds = await artifact.evaluate(() => {
        const row = document.querySelector('.mes.nn-echo-layout');
        const plate = row.querySelector('.nn-echo-header-plate'), reasoning = row.querySelector('.mes_reasoning_details');
        const cat = row.querySelector('.neconyan-message-sleeper'), text = row.querySelector('.mes_text');
        const name = row.querySelector('.name_text'), range = document.createRange(); range.selectNodeContents(name);
        const box = element => element.getBoundingClientRect().toJSON();
        const finalPanel = row.querySelector('.ica--companion-ledger') || text;
        return { row: box(row), plate: box(plate), reasoning: box(reasoning), cat: box(cat), text: box(text),
            name: name.textContent, lines: [...range.getClientRects()].map(rect => rect.toJSON()),
            copiedGeometry: [...plate.style, ...cat.style].filter(property => property.startsWith('--nn-echo-')),
            liveFooterMarkers: row.querySelectorAll('.nn-echo-reading-footer, .nn-echo-footer-joined, .nn-echo-joined-end, .nn-echo-overlay-footer, .nn-echo-reserves-footer').length,
            finalRadius: getComputedStyle(finalPanel).borderBottomRightRadius };
    });
    expect(bounds.name).toContain('entire name');
    expect(bounds.lines.length).toBeGreaterThan(1);
    expect(bounds.lines.every(line => line.right <= bounds.row.right + 1)).toBe(true);
    expect(bounds.reasoning.bottom).toBeLessThanOrEqual(bounds.plate.bottom);
    expect(bounds.cat.top).toBeGreaterThanOrEqual(bounds.plate.bottom - 1);
    expect(Math.abs(bounds.cat.top + 41 - bounds.text.top)).toBeLessThan(1);
    expect(bounds.copiedGeometry).toEqual([]);
    expect(bounds.liveFooterMarkers).toBe(0); expect(bounds.finalRadius).toBe('10px');
    const boundsFile = info.outputPath('echo-export-bounds.json'); await fs.writeFile(boundsFile, JSON.stringify(bounds, null, 2));
    await info.attach('Serialized export geometry', { path: boundsFile, contentType: 'application/json' });
    await artifact.close();
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(message.locator('.nn-echo-header-plate')).toHaveCount(0);
    await expect(message).not.toHaveClass(/nn-echo-cutoff/);
    await expect.poll(() => message.evaluate(el => Math.abs(el.querySelector('.neconyan-message-sleeper').getBoundingClientRect().top + 41 - el.getBoundingClientRect().top))).toBeLessThan(1);
    const ordinary = await message.evaluate(el => getComputedStyle(el).backgroundColor);
    await message.evaluate(el => el.classList.add('selected'));
    await expect.poll(() => message.evaluate(el => getComputedStyle(el).backgroundColor !== 'rgb(102, 0, 0)')).toBe(false);
    expect(ordinary).not.toBe('rgb(102, 0, 0)');
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(message).not.toHaveClass(/nn-echo-layout/); await expect(cap).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 }); await expect(message).toHaveClass(/nn-echo-layout/);
    await page.locator('#chat_display').selectOption('0', { force: true });
    await expect(message).not.toHaveClass(/nn-echo-layout/); await expect(cap).toBeHidden();
});

test('Echo stacks the user header like the assistant header on desktop', async ({ app }, info) => {
    test.setTimeout(120000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        const date = '2026-10-18T00:00:00Z';
        const user = 'Brian took off his coat and hung it on the chair.\n\n"Then I will wait here a while. It is warmer than the bus stop."';
        context.chat.splice(0, context.chat.length,
            { name: 'Nova', is_user: false, is_system: false, send_date: date, mes: 'Nova set the ledger on the counter.', swipes: ['Nova set the ledger on the counter.'], extra: {} },
            { name: 'Brian', is_user: true, is_system: false, send_date: date, mes: user, swipes: [user, user + ' He checked the door.'], swipe_id: 0,
                swipe_info: [{ send_date: date, extra: {} }, { send_date: date, extra: {} }], extra: {} });
        await context.saveChat();
        await context.reloadCurrentChat();
    }, account.avatar);
    await page.locator('#chat_display').selectOption('3', { force: true });
    const headers = () => page.evaluate(() => [...document.querySelectorAll('#chat > .mes')].map(row => {
        const name = row.querySelector('.ch_name'), buttons = row.querySelector('.mes_buttons');
        return {
            id: row.getAttribute('mesid'), isUser: row.getAttribute('is_user') === 'true',
            width: name.getBoundingClientRect().width, direction: getComputedStyle(name).flexDirection,
            rowWidth: row.getBoundingClientRect().width, buttonsWidth: buttons.getBoundingClientRect().width,
            buttonsText: buttons.textContent.replace(/\s+/g, ' ').trim(),
        };
    }));
    await expect.poll(async () => (await headers()).length).toBe(2);
    const desktop = await headers();
    const assistant = desktop.find(entry => !entry.isUser), user = desktop.find(entry => entry.isUser);
    // The user header stacks like the assistant's instead of summing the name row and the buttons.
    expect(user.direction).toBe('column');
    expect(assistant.direction).toBe('column');
    expect(user.buttonsText).toBe(assistant.buttonsText);
    expect(Math.abs(user.width - assistant.width), JSON.stringify({ assistant, user })).toBeLessThanOrEqual(10);
    expect(user.width, 'user header hugs its content').toBeLessThan(user.rowWidth / 2);
    // The buttons keep the core full width inside the column, so they never wrap into a narrow box.
    expect(user.buttonsWidth).toBeGreaterThanOrEqual(user.width - 1);
    await info.attach('Echo header widths', { body: Buffer.from(JSON.stringify(desktop)), contentType: 'application/json' });
    // The tablet card and the phone keep their existing header layout.
    for (const [width, height] of [[900, 900], [393, 852]]) {
        await page.setViewportSize({ width, height });
        await expect.poll(async () => (await headers()).length).toBe(2);
        const sizes = await headers();
        const smaller = sizes.find(entry => !entry.isUser), larger = sizes.find(entry => entry.isUser);
        expect(Math.abs(larger.width - smaller.width), `${width} headers still match`).toBeLessThanOrEqual(10);
        expect(larger.width, `${width} header inside its row`).toBeLessThanOrEqual(larger.rowWidth);
    }
});

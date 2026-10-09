/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-force-option -- Native hidden Appearance controls avoid repeatedly opening the settings drawer. */
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test('desktop Bubbles follows stationary paint, native edits and the real lower edge', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        context.chat[0].mes = Array.from({ length: 55 }, (_, i) => `Boundary passage ${i}. The final line must survive the downloaded image.`).join('\n\n');
        await context.saveChat(); await context.reloadCurrentChat();
    }, account.avatar);
    await page.locator('#chat_display').selectOption({ label: 'Bubbles' }, { force: true });
    const row = page.locator('#chat > .mes[mesid="0"]');
    const cap = page.locator('#neconyan-bubbles-bottom-boundary');
    const diagnostic = () => row.evaluate(element => ({
        row: element.getBoundingClientRect().toJSON(), chat: element.parentElement.getBoundingClientRect().toJSON(),
        scrollTop: element.parentElement.scrollTop, scrollHeight: element.parentElement.scrollHeight,
        classes: document.body.className, style: document.querySelector('#chat_display').value,
        clip: getComputedStyle(element.parentElement).clipPath,
    }));
    const hidden = async stage => {
        try { await expect(cap, stage).toBeHidden(); }
        catch (error) {
            const details = JSON.stringify(await diagnostic(), null, 2);
            const file = info.outputPath(`${stage.replaceAll(' ', '-')}.json`);
            await fs.writeFile(file, details);
            await info.attach(stage, { path: file, contentType: 'application/json' });
            throw error;
        }
    };
    const cross = async () => row.evaluate(element => {
        const chat = element.parentElement;
        chat.scrollTop += element.getBoundingClientRect().top - chat.getBoundingClientRect().top + 150;
    });
    await cross(); await expect(cap).toBeVisible();
    const geometry = await cap.evaluate(element => ({ bottom: element.getBoundingClientRect().bottom, bar: document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().top }));
    expect(geometry.bottom).toBe(geometry.bar + 4);
    const ordinaryPaint = await row.evaluate(element => getComputedStyle(element).backgroundColor);
    await row.evaluate(async element => {
        element.classList.add('selected');
        getComputedStyle(element).getPropertyValue('background-color');
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    await expect.poll(() => row.evaluate(element => getComputedStyle(element).backgroundColor === getComputedStyle(document.querySelector('#neconyan-bubbles-bottom-boundary')).backgroundColor)).toBe(true);
    expect(await cap.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(ordinaryPaint);
    await page.evaluate(() => document.documentElement.style.setProperty('--sb-page-card-opacity', '0.37'));
    await expect.poll(() => cap.locator('div').evaluate(element => getComputedStyle(element).opacity)).toBe('0.37');
    await row.evaluate(element => element.classList.remove('selected'));
    await row.locator('.mes_edit').click({ force: true });
    await expect(row.locator('.edit_textarea')).toBeVisible();
    await hidden('native editor');
    expect(await page.locator('#chat').evaluate(element => getComputedStyle(element).clipPath)).toBe('none');
    await row.locator('.mes_edit_cancel').click({ force: true });
    await cross(); await expect(cap).toBeVisible();

    // Export through the application's native action, then decode the actual download.
    await row.locator('.mes_screenshot').dispatchEvent('click');
    await expect(page.locator('.message_screenshot_popup')).toBeVisible();
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('.message_screenshot_popup .popup-button-ok').click();
    const download = await downloadPromise;
    const file = info.outputPath('full-message.png');
    await download.saveAs(file);
    const png = PNG.sync.read(await fs.readFile(file));
    expect(png.height).toBeGreaterThan(900);
    await info.attach('actual-downloaded-message', { path: file, contentType: 'image/png' });

    await page.setViewportSize({ width: 393, height: 852 }); await hidden('phone exclusion');
    await page.setViewportSize({ width: 1280, height: 900 }); await cross(); await expect(cap).toBeVisible();
    await page.locator('#chat_display').selectOption('0', { force: true }); await hidden('Flat exclusion');
    expect(await page.locator('#chat').evaluate(element => getComputedStyle(element).clipPath)).toBe('none');
    await page.locator('#chat_display').selectOption({ label: 'Bubbles' }, { force: true }); await cross(); await expect(cap).toBeVisible();
    const chatBox = await page.locator('#chat').boundingBox();
    await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2);
    await page.mouse.wheel(0, 99999);
    await expect.poll(async () => {
        const geometry = await diagnostic();
        return geometry.row.bottom <= geometry.chat.bottom;
    }, { message: 'Native wheel exposes the actual lower edge' }).toBe(true);
    await hidden('natural lower edge');
});

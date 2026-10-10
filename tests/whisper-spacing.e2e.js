/* global window, getComputedStyle, DOMMatrixReadOnly */
/* eslint-disable playwright/no-force-option -- Native Appearance controls are in a closed drawer. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test('Whisper removes only displaced desktop space and preserves native tablet clearance', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        c.chat[0].mes = 'FIRST WHISPER\n\nA short native reply with a final paragraph.';
        c.chat[0].swipes = [c.chat[0].mes, c.chat[0].mes.replace('FIRST WHISPER', 'SECOND WHISPER')]; c.chat[0].swipe_id = 0;
        await c.saveChat(); await c.reloadCurrentChat(); await window.NeconyanShell.activateMode('roleplay');
    }, account.avatar);
    await page.locator('#chat_display').selectOption('4', { force: true });
    const row = page.locator('#chat > .mes[mesid="0"]');
    const measure = () => row.evaluate(el => {
        const block = el.querySelector(':scope > .mes_block'), footer = el.querySelector('.nn-response-controls');
        const box = el.getBoundingClientRect(), bs = getComputedStyle(block), rs = getComputedStyle(el);
        return { unused: box.bottom - block.getBoundingClientRect().bottom - parseFloat(rs.borderBottomWidth),
            padding: parseFloat(rs.paddingBottom), margin: parseFloat(bs.marginBottom), transform: new DOMMatrixReadOnly(bs.transform).m42,
            footerHeight: footer?.getBoundingClientRect().height || 0, rowHeight: box.height };
    });
    for (const width of [1280, 1001]) {
        await page.setViewportSize({ width, height: 900 });
        for (const placement of ['inside', 'below']) {
            await page.locator('#desktop_response_controls').selectOption(placement, { force: true });
            await expect(row.locator('.nn-response-controls')).toHaveCount(1);
            for (const avatarSize of [40, 72]) {
                await page.locator('#chat').evaluate((el, value) => el.style.setProperty('--custom-ChatAvatar', `${value}px`), avatarSize);
                for (const contextMarked of [false, true]) {
                    await row.evaluate((el, marked) => el.classList.toggle('lastInContext', marked), contextMarked);
                    await expect.poll(async () => Math.abs((await measure()).unused)).toBeLessThan(1);
                    const result = await measure();
                    expect(result.padding).toBe(0);
                    expect(Math.abs(result.margin - result.transform)).toBeLessThan(0.1);
                    expect(result.footerHeight).toBeGreaterThanOrEqual(36);
                    await info.attach(`spacing-${width}-${placement}-${avatarSize}-${contextMarked}`, { body: JSON.stringify(result), contentType: 'application/json' });
                }
            }
        }
    }
    await page.locator('#hideChatAvatarsEnabled').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect.poll(async () => Math.abs((await measure()).unused)).toBeLessThan(1);
    await page.locator('#hideChatAvatarsEnabled').evaluate(el => { el.checked = false; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await row.evaluate(el => el.classList.remove('lastInContext'));
    await page.locator('#chat').evaluate(el => el.style.removeProperty('--custom-ChatAvatar'));
    for (const width of [1000, 900, 769, 768, 393]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        await expect(row.locator('.nn-response-controls')).toHaveCount(0);
        const result = await measure(); expect(result.padding).toBe(40); expect(result.margin).toBe(0); expect(result.transform).toBe(0);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#desktop_response_controls').selectOption('inside', { force: true });
    await row.locator('.nn-response-controls .swipe_right').click(); await expect(row.locator('.mes_text')).toContainText('SECOND WHISPER');
    await row.locator('.nn-response-controls .swipe_left').click(); await expect(row.locator('.mes_text')).toContainText('FIRST WHISPER');
});

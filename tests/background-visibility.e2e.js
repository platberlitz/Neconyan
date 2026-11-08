/* global document, window, jQuery, getComputedStyle, localStorage */
/* eslint-disable playwright/no-force-option -- Appearance controls live in the closed settings drawer. */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed viewport and style matrix. */
import { expect } from '@playwright/test';
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

for (const phone of [false, true]) {
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

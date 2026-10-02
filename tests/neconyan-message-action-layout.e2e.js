/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(120000);

async function openAgentChat(page) {
    const storage = createMockRoleplayStore(() => page.evaluate(async () =>
        (await import('/scripts/roleplay-save-chain.js')).roleplayAccountStamp().account));
    await page.route('**/api/chats/get', route => storage.read(route));
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.route('**/api/chats/save', route => storage.save(route));
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const id = context.characters.length;
        context.characters.push({ name: 'UI Cat', avatar: 'none', chat: 'agent-ui-check', first_mes: '', mes_example: '', shallow: false, data: {} });
        await context.selectCharacterById(id, { switchMenu: false });
        context.chat.splice(0, context.chat.length, {
            name: 'UI Cat', is_user: false, is_system: false, mes: 'Changed reply', send_date: new Date().toISOString(),
            extra: { inChatAgentTransformHistory: [{ agentName: 'UI Agent', beforeText: 'Original reply', afterText: 'Changed reply' }] },
        });
        await context.printMessages();
        (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
    });
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'iPhone stand-in' : 'Desktop'} message actions`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
        test.beforeEach(async ({ context, page }) => {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            await openAgentChat(page);
            if (phone) await applyIOSOnlyCss(page);
        });

        test('keeps View agent changes compact before and after editing', async ({ page }, testInfo) => {
            const message = page.locator('#chat .mes[mesid="0"]');
            const action = message.locator('.mes_view_agent_changes');
            await message.locator('.extraMesButtonsHint').click();
            const checkSize = async () => {
                await expect(action).toBeVisible();
                await expect(action).toHaveCSS('aspect-ratio', 'auto');
                const bounds = await action.boundingBox();
                expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
                expect(bounds.height).toBeLessThanOrEqual(60);
                expect(bounds.width).toBeGreaterThan(bounds.height);
            };
            await checkSize();
            await message.locator('.mes_edit').click();
            await message.locator('.edit_textarea').fill('Edited reply');
            await message.locator('.mes_edit_done').click();
            await message.locator('.extraMesButtonsHint').click();
            await checkSize();
            await page.screenshot({ path: testInfo.outputPath('agent-action-size.png') });
            await action.click();
            await expect(page.locator('dialog[open]')).toContainText('UI Agent');
        });

        test('left-aligns the wrapped Quick Image Gen message label', async ({ page }, testInfo) => {
            const message = page.locator('#chat .mes[mesid="0"]');
            await message.locator('.extraMesButtonsHint').click();
            const action = message.locator('.qig-message-generate');
            await expect(action).toBeVisible();
            await expect(action).toHaveCSS('justify-content', 'flex-start');
            await expect(action).toHaveCSS('text-align', 'left');
            const label = action.locator('.neconyan-action-label');
            const lines = await label.evaluate(el => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right }));
            });
            expect(lines.length).toBeGreaterThan(1);
            for (const line of lines) expect(Math.abs(line.left - lines[0].left)).toBeLessThan(1);
            await action.scrollIntoViewIfNeeded();
            await page.screenshot({ path: testInfo.outputPath('image-action-alignment.png') });
        });

        test('keeps inserted and deleted agent text readable in light and dark themes', async ({ page }, testInfo) => {
            await page.locator('#chat .extraMesButtonsHint').click();
            await page.locator('#chat .mes_view_agent_changes').click();
            const diff = page.locator('dialog[open] .ica-transform-diff');
            await expect(diff).toBeVisible();
            for (const theme of ['Neconyan Calico', 'Nord Light', 'Solarized Light', 'Neconyan Calico Dark']) {
                await page.locator('#themes').evaluate((el, name) => window.jQuery(el).val(name).trigger('change'), theme);
                const highlights = await diff.locator('.ica-transform-diff-part--ins, .ica-transform-diff-part--del').evaluateAll(elements => {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d', { willReadFrequently: true });
                    const rgba = colour => {
                        context.clearRect(0, 0, 1, 1);
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data];
                    };
                    const luminance = channels => channels.slice(0, 3).map(value => {
                        const c = value / 255;
                        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
                    }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
                    return elements.map(el => {
                        const style = getComputedStyle(el);
                        const backdrop = rgba(getComputedStyle(el.parentElement).backgroundColor);
                        const tint = rgba(style.backgroundColor);
                        const background = tint.map((value, i) => i < 3 ? value * tint[3] / 255 + backdrop[i] * (1 - tint[3] / 255) : 255);
                        const ink = luminance(rgba(style.color));
                        const surface = luminance(background);
                        return { contrast: (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05), colour: style.backgroundColor, decoration: style.textDecorationLine };
                    });
                });
                expect(highlights).toHaveLength(2);
                for (const highlight of highlights) expect(highlight.contrast, `${theme} change text contrast`).toBeGreaterThanOrEqual(4.5);
                expect(highlights[0].colour).not.toBe(highlights[1].colour);
                expect(highlights.some(highlight => highlight.decoration === 'line-through')).toBe(true);
                await page.screenshot({ path: testInfo.outputPath(`agent-diff-${theme}.png`) });
            }
        });
    });
}

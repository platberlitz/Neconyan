/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';

test.setTimeout(120000);

for (const width of [393, 1280]) {
    test.describe(`Message editing at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, isMobile: width === 393 });

        for (const tone of ['light', 'dark']) {
            test(`keeps ${tone} edit actions labelled, flat and usable`, async ({ page }, testInfo) => {
                const storage = createMockRoleplayStore(() => page.evaluate(async () =>
                    (await import('/scripts/roleplay-save-chain.js')).roleplayAccountStamp().account));
                await page.route('**/api/chats/get', route => storage.read(route));
                await openQuietChatForSmoke(page, { selectCharacter: false });
                await page.route('**/api/chats/save', route => storage.save(route));
                await page.evaluate(async tone => {
                    document.documentElement.dataset.neconyanPalette = 'calico';
                    document.documentElement.dataset.neconyanCalicoTone = tone;
                    const context = window.SillyTavern.getContext();
                    const id = context.characters.length;
                    context.characters.push({ name: 'Edit Cat', avatar: 'none', chat: 'edit-check', first_mes: '', mes_example: '', shallow: false, data: {} });
                    await context.selectCharacterById(id, { switchMenu: false });
                    context.chat.splice(0, context.chat.length, ...['First message', 'Second message'].map(mes => ({
                        name: 'Edit Cat', is_user: false, is_system: false, mes, send_date: new Date().toISOString(), extra: {},
                    })));
                    await context.printMessages();
                    (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
                }, tone);
                const message = page.locator('#chat .mes[mesid="1"]');
                await message.locator('.mes_edit').click();
                const toolbar = message.locator('.mes_edit_buttons');
                await expect(toolbar.locator('button')).toHaveText(['Confirm', 'Copy', 'Reasoning', 'Delete', 'Up', 'Down', 'Cancel']);
                await expect(toolbar.locator('.mes_edit_down')).toBeHidden();
                await waitForAnimationFrames(page);

                const checkGeometry = async controls => {
                    const measurements = await controls.evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => {
                        const rect = el.getBoundingClientRect();
                        const label = el.querySelector('.neconyan-action-label').getBoundingClientRect();
                        const style = getComputedStyle(el);
                        return { width: rect.width, height: rect.height, fits: label.left >= rect.left && label.right <= rect.right,
                            onScreen: rect.left >= 0 && rect.right <= window.innerWidth, shadow: style.boxShadow, radius: style.borderRadius };
                    }));
                    expect(measurements.length).toBeGreaterThan(0);
                    for (const control of measurements) {
                        expect(control.fits && control.onScreen).toBe(true);
                        expect(control.width).toBeGreaterThanOrEqual(44);
                        expect(control.height).toBeGreaterThanOrEqual(width === 393 ? 44 : 30);
                        expect(control.shadow).toBe('none');
                        expect(control.radius).toBe('6px');
                    }
                };
                await checkGeometry(toolbar.locator('button'));
                await message.locator('.edit_textarea').fill('Saved edit');
                await page.keyboard.press('Tab');
                await toolbar.locator('.mes_edit_done').focus();
                await expect(toolbar.locator('.mes_edit_done')).toHaveCSS('outline-style', 'solid');
                await page.keyboard.press('Enter');
                await expect(message.locator('.mes_text')).toHaveText('Saved edit');
                await message.locator('.mes_edit').click();
                await message.locator('.edit_textarea').fill('Discard this');
                await toolbar.locator('.mes_edit_cancel').focus();
                await page.keyboard.press('Space');
                await expect(message.locator('.mes_text')).toHaveText('Saved edit');

                await message.locator('.mes_edit').click();
                await toolbar.locator('.mes_edit_add_reasoning').click();
                await expect(message.locator('.reasoning_edit_textarea')).toBeVisible();
                await page.screenshot({ path: testInfo.outputPath('edit-actions.png') });
                await expect(toolbar.locator('.mes_edit_add_reasoning')).toBeHidden();
                await expect(message.locator('.mes_reasoning_edit_done')).toBeHidden();
                await message.locator('.reasoning_edit_textarea').fill('Initial reasoning');
                await toolbar.locator('.mes_edit_done').click();
                await expect(message.locator('.mes_reasoning_edit_done')).toBeHidden();
                await message.locator('.mes_reasoning_edit').click();
                await checkGeometry(message.locator('.mes_reasoning_actions .edit_button'));
                await page.screenshot({ path: testInfo.outputPath('reasoning-edit-actions.png') });
                await message.locator('.reasoning_edit_textarea').fill('Saved reasoning');
                await message.locator('.mes_reasoning_edit_done').click();
                await expect(message.locator('.mes_reasoning')).toHaveText('Saved reasoning');
                await message.locator('.mes_reasoning_edit').click();
                await message.locator('.reasoning_edit_textarea').fill('Discard reasoning');
                await message.locator('.mes_reasoning_edit_cancel').click();
                await expect(message.locator('.mes_reasoning')).toHaveText('Saved reasoning');

                await message.locator('.mes_edit').click();
                await toolbar.locator('.mes_edit_up').click();
                const first = page.locator('#chat .mes[mesid="0"]');
                await expect(first.locator('.edit_textarea')).toHaveValue('Saved edit');
                await expect(first.locator('.mes_edit_up')).toBeHidden();
                await first.locator('.mes_edit_down').click();
                await expect(message.locator('.edit_textarea')).toHaveValue('Saved edit');
                await toolbar.locator('.mes_edit_copy').click();
                await page.locator('dialog[open] .popup-button-ok').click();
                await expect(page.locator('#chat .mes')).toHaveCount(3);
                await page.locator('#chat .mes[mesid="2"] .mes_edit').click();
                await page.locator('#chat .mes[mesid="2"] .mes_edit_delete').click();
                await page.locator('dialog[open] .popup-button-ok').click();
                await expect(page.locator('#chat .mes')).toHaveCount(2);
                await message.locator('.mes_reasoning_edit').click();
                await message.locator('.mes_reasoning_delete').click();
                await page.locator('dialog[open] .popup-button-ok').click();
                await expect(message.locator('.reasoning_edit_textarea')).toHaveCount(0);
                expect(await page.evaluate(() => window.SillyTavern.getContext().chat[1].extra.reasoning)).toBe('');
            });
        }
    });
}

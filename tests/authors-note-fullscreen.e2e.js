/* global document */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat, settleCssTransitions } from './chat-scroll-regression-helpers.js';

test.setTimeout(90000);

for (const phone of [true, false]) {
    test.describe(`Author's Note full screen button on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });

        test('sits at the right of Note text and opens a larger editor that writes back', async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
            });
            await openReadyChat(page);
            await page.evaluate(async () => {
                const { extension_settings } = await import('/scripts/extensions.js');
                const { chat_metadata } = await import('/script.js');
                const { user_avatar } = await import('/scripts/personas.js');
                const { openAuthorsNotePanel } = await import('/scripts/authors-note.js');
                const { getCharaFilename } = await import('/scripts/utils.js');
                extension_settings.note.default = 'Default note';
                chat_metadata.note_prompt = 'Chat note';
                chat_metadata.note_interval = 1;
                extension_settings.note.chara = [{
                    name: `individual:${getCharaFilename()}`, useChara: true,
                    profiles: [{ id: 'fullscreen-test', name: 'Character note', prompt: 'Character note', position: 1 }],
                    activeProfiles: ['fullscreen-test'], activeProfile: 'fullscreen-test',
                }];
                extension_settings.note.persona = {
                    [user_avatar]: { useNote: true, profiles: [{ id: 'default', name: 'Default', prompt: 'Persona note', position: 2 }], activeProfile: 'default' },
                };
                openAuthorsNotePanel('defaults');
            });

            for (const [tab, slot] of [['defaults', 'default'], ['chat', 'prompt'], ['character', 'chara'], ['persona', 'persona']]) {
                await page.locator(`[data-an-tab="${tab}"]`).click();
                const button = page.locator(`#floatingPrompt .an-note-fullscreen[data-for="extension_floating_${slot}"]`);
                await expect(button).toBeVisible();

                const layout = await page.evaluate((slot) => {
                    const button = document.querySelector(`.an-note-fullscreen[data-for="extension_floating_${slot}"]`);
                    const heading = button.closest('.an-field-heading');
                    const label = heading.querySelector('.an-field-label');
                    const labelBox = label.getBoundingClientRect();
                    const buttonBox = button.getBoundingClientRect();
                    const headBox = button.closest('.an-field-head').getBoundingClientRect();
                    return {
                        labelText: label.textContent.trim(),
                        sameRow: Math.abs((labelBox.top + labelBox.bottom) / 2 - (buttonBox.top + buttonBox.bottom) / 2) < 8,
                        toTheRight: buttonBox.left >= labelBox.right,
                        rightGap: headBox.right - buttonBox.right,
                        width: buttonBox.width,
                        height: buttonBox.height,
                    };
                }, slot);
                expect(layout.labelText).toBe('Note text');
                expect(layout.sameRow).toBe(true);
                expect(layout.toTheRight).toBe(true);
                expect(layout.rightGap).toBeLessThanOrEqual(1);
                if (phone) {
                    expect(layout.width).toBeGreaterThanOrEqual(44);
                    expect(layout.height).toBeGreaterThanOrEqual(44);
                }

                const source = page.locator(`#extension_floating_${slot}`);
                const initialValue = await source.inputValue();
                await button.click();
                const popup = page.locator('dialog.popup[open]:has(.maximized_textarea)');
                await expect(popup).toBeVisible();
                const expanded = popup.locator('.maximized_textarea');
                await expect(expanded).toHaveValue(initialValue);
                await settleCssTransitions(page);
                const expandedBox = await expanded.boundingBox();
                const sourceBox = await source.boundingBox();
                expect(expandedBox.width).toBeGreaterThan(sourceBox.width);
                expect(expandedBox.height).toBeGreaterThan(sourceBox.height);

                await expanded.fill(`${initialValue} expanded`);
                await expect(source).toHaveValue(`${initialValue} expanded`);
                await popup.locator('.popup-button-ok').click();
                await expect(page.locator('.maximized_textarea')).toHaveCount(0);
            }
        });
    });
}

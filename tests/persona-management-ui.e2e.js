/* global document, MutationObserver, window */
import { devices, expect, test } from '@playwright/test';
import { isolateSettingsSaves, openPersonaEditor, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.setTimeout(60000);

test.beforeEach(async ({ page }) => {
    await isolateSettingsSaves(page, settings => {
        settings.firstRun = false;
        settings.accountStorage ??= {};
        settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
        settings.accountStorage['neconyanToolTourInvite.persona'] = 'seen';
    });
});

for (const phone of [true, false]) {
    test.describe(`Persona status badges on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test('shows readable lock labels without crowding the row actions', async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, getUserAvatars, setPersonaDescription } = await import('/scripts/personas.js');
                const { chat_metadata } = await import('/script.js');
                power_user.personas[user_avatar] = 'Marina';
                power_user.persona_descriptions[user_avatar] = {
                    description: 'A long persona description that must not crowd the status labels or actions.',
                    appendices: [], activeAppendices: {},
                };
                chat_metadata.persona = user_avatar;
                await getUserAvatars();
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            });
            await expect(page.locator('#PersonaManagement')).toBeVisible();
            if (phone) await applyIOSOnlyCss(page);
            const row = page.locator('#user_avatar_block .avatar-container.selected');
            const chat = row.locator('.locked_to_chat_label');
            await expect(chat).toBeVisible();
            await expect(chat).toHaveText('Chat');
            await expect(chat).not.toHaveAttribute('role', 'button');
            await expect(chat).not.toHaveAttribute('tabindex', /.+/);
            await expect(row.locator('.locked_to_character_label')).toBeHidden();

            // Exercise all simultaneous visual states, including the narrow grid cards.
            await row.evaluate(element => element.classList.add('default_persona', 'locked_to_character'));
            for (const grid of [false, true]) {
                if (grid) await page.locator('#persona_grid_toggle').click();
                for (const selector of ['.persona-default-label', '.locked_to_chat_label', '.locked_to_character_label']) {
                    const badge = row.locator(selector);
                    await expect(badge).toBeVisible();
                    const badgeBox = await badge.boundingBox();
                    const rowBox = await row.boundingBox();
                    expect(badgeBox.height).toBeGreaterThanOrEqual(20);
                    expect(badgeBox.x).toBeGreaterThanOrEqual(rowBox.x);
                    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
                    if (!grid) {
                        const actionsBox = await row.locator('.avatar_container_states').boundingBox();
                        expect(badgeBox.y).toBeGreaterThanOrEqual(actionsBox.y + actionsBox.height - 1);
                    }
                    expect(await badge.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
                }
                for (const selector of ['.persona_quick_rename', '.persona_quick_delete']) {
                    if (grid) {
                        await expect(row.locator(selector)).toBeHidden();
                        continue;
                    }
                    await expect(row.locator(selector)).toBeVisible();
                    expect((await row.locator(selector).boundingBox()).height).toBeGreaterThanOrEqual(phone ? 44 : 32);
                }
            }
            await row.evaluate(element => element.classList.remove('default_persona', 'locked_to_chat', 'locked_to_character'));
            await expect(row.locator('.persona-row-status')).toBeHidden();
        });
    });
}

for (const phone of [true, false]) {
    test.describe(`Scenario Note editor on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use({ viewport: { width: phone ? 393 : 1280, height: phone ? 852 : 900 }, hasTouch: phone, isMobile: phone });

        test('aligns the label and fullscreen button with the note field', async ({ page }, testInfo) => {
            test.slow();
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.personas[user_avatar] = 'Scenario Test';
                power_user.persona_descriptions[user_avatar] = { description: 'Base persona', appendices: [], activeAppendices: {} };
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            });
            await openPersonaEditor(page);
            await page.locator('#persona_appendices_heading').click();
            await page.locator('#persona_appendix_add').click();
            await page.locator('#persona_appendix_name_input').fill('Genshin');

            const field = page.locator('#persona_appendix_description_input');
            const header = page.locator('.persona-appendix-editor-label');
            const expand = header.getByRole('button', { name: 'Expand the editor' });
            await expect(field).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath(`scenario-note-${phone ? 'phone' : 'desktop'}.png`) });
            const fieldBox = await field.boundingBox();
            const headerBox = await header.boundingBox();
            const buttonBox = await expand.boundingBox();
            const textLeft = await header.evaluate(element => {
                const range = element.ownerDocument.createRange();
                range.selectNodeContents(element.firstChild);
                return range.getBoundingClientRect().left;
            });
            expect(Math.abs(textLeft - fieldBox.x)).toBeLessThan(2);
            expect(Math.abs(buttonBox.x + buttonBox.width - fieldBox.x - fieldBox.width)).toBeLessThan(2);
            expect(Math.abs(headerBox.y + headerBox.height / 2 - buttonBox.y - buttonBox.height / 2)).toBeLessThan(2);

            await field.fill('Additional persona details for this scenario.');
            await expand.click();
            const expanded = page.locator('textarea.maximized_textarea');
            await expect(expanded).toHaveValue('Additional persona details for this scenario.');
            await expanded.fill('Updated in fullscreen.');
            await page.locator('dialog[open]').last().locator('.popup-button-ok').click();
            await expect(expanded).toBeHidden();
            await expect(field).toHaveValue('Updated in fullscreen.');
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('.persona-appendix-card')).toContainText('Genshin');
        });
    });
}

for (const phone of [true, false]) {
    test.describe(`Scenario Note scroll on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test('keeps description typing data immediate without redrawing notes on each keystroke', async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.personas[user_avatar] = 'Typing Test';
                power_user.persona_descriptions[user_avatar] = {
                    description: 'Base persona. '.repeat(300),
                    appendices: Array.from({ length: 24 }, (_, index) => ({
                        id: `typing-note-${index}`, name: `Scenario ${index + 1}`, description: 'Keep this scenario context.',
                    })),
                    activeAppendices: {},
                };
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            });
            await openPersonaEditor(page);
            if (phone) await applyIOSOnlyCss(page);
            const input = page.locator('#persona_description');
            await input.focus();
            const result = await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar } = await import('/scripts/personas.js');
                const { eventSource, event_types } = await import('/script.js');
                const input = document.getElementById('persona_description');
                const observer = new MutationObserver(() => {});
                observer.observe(document.getElementById('persona_appendices_list'), { subtree: true, childList: true, attributes: true });
                window.personaTypingEvents = [];
                eventSource.on(event_types.PERSONA_UPDATED, avatar => window.personaTypingEvents.push(avatar));
                for (const character of ' typing test') {
                    input.value += character;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const mutations = observer.takeRecords().length;
                observer.disconnect();
                return {
                    value: input.value, stored: power_user.persona_descriptions[user_avatar].description,
                    prompt: power_user.persona_description, mutations, events: window.personaTypingEvents.length, avatar: user_avatar,
                };
            });
            expect(result.stored).toBe(result.value);
            expect(result.prompt).toBe(result.value);
            expect(result.mutations).toBe(0);
            expect(result.events).toBe(0);
            await expect(page.locator('#persona_effective_description_preview')).toHaveText(result.value);
            await expect.poll(() => page.evaluate(() => window.personaTypingEvents)).toEqual([result.avatar]);
            await expect(input).toBeFocused();

            const saved = page.waitForRequest(request => request.url().endsWith('/api/settings/save')
                && request.postDataJSON()?.power_user?.persona_descriptions?.[result.avatar]?.description === `${result.value} more text`);
            await input.press('Control+End');
            await input.pressSequentially(' more text', { delay: 40 });
            await expect(page.locator('#persona_effective_description_preview')).toHaveText(`${result.value} more text`);
            await expect.poll(() => page.evaluate(() => window.personaTypingEvents.length)).toBe(2);
            await expect(input).toHaveValue(`${result.value} more text`);
            await saved;
        });

        test('keeps the toggled note in place and preserves keyboard focus', async ({ page, context }) => {
            if (phone) {
                await installIPhoneSafari(context);
            }
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.personas[user_avatar] = 'Scroll Test';
                power_user.persona_descriptions[user_avatar] = {
                    description: 'Base persona',
                    appendices: Array.from({ length: 24 }, (_, index) => ({
                        id: `scroll-note-${index}`,
                        name: `Scenario ${index + 1}`,
                        description: `Details for scenario ${index + 1}.`,
                    })),
                    activeAppendices: {},
                };
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            });
            await expect(page.locator('#PersonaManagement')).toBeVisible();
            await openPersonaEditor(page);
            await page.locator('#persona_appendices_heading').click();
            if (phone) {
                await applyIOSOnlyCss(page);
            }

            const toggle = page.getByRole('checkbox', { name: 'Scenario 19', exact: true });
            const preview = page.locator('#persona_effective_description_preview');
            await toggle.scrollIntoViewIfNeeded();
            await toggle.focus();
            // Check the viewport directly: Playwright's next click would otherwise scroll
            // the replaced checkbox back into view and hide this regression.
            const before = await toggle.boundingBox();
            for (const keyboard of [false, true]) {
                for (const checked of [true, false]) {
                    if (keyboard) {
                        await page.keyboard.press('Space');
                    } else if (phone) {
                        await toggle.tap();
                    } else {
                        await toggle.click();
                    }
                    await expect(toggle).toBeChecked({ checked });
                    await expect(preview).toHaveText(checked ? 'Base persona\n\n(Scenario 19)\nDetails for scenario 19.' : 'Base persona');
                    await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
                    await expect(toggle).toBeFocused();
                    expect(Math.abs((await toggle.boundingBox()).y - before.y)).toBeLessThan(2);
                }
            }
        });
    });
}

for (const width of [320, 390, 1280]) {
    test.describe(`Scenario Note dropdowns at ${width}px`, () => {
        test.use({
            viewport: { width, height: 844 },
            isMobile: width < 768,
            hasTouch: width < 768,
            userAgent: width < 768 ? devices['iPhone 13'].userAgent : undefined,
        });

        test('collapses each note independently without changing active notes', async ({ page }, testInfo) => {
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.personas[user_avatar] = 'Dropdown Test';
                power_user.persona_descriptions[user_avatar] = {
                    description: 'Base persona',
                    appendices: [
                        { id: 'note-one', name: 'First note', description: 'Long scenario note.\n'.repeat(30) },
                        { id: 'note-two', name: 'Second note', description: 'Second scenario note.' },
                    ],
                    activeAppendices: {},
                };
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            });
            await expect(page.locator('#PersonaManagement')).toBeVisible();
            await openPersonaEditor(page);
            await page.locator('#persona_appendices_heading').click();

            const first = page.locator('.persona-appendix-card[data-appendix-id="note-one"]');
            const second = page.locator('.persona-appendix-card[data-appendix-id="note-two"]');
            const firstDetails = first.locator('details');
            const secondDetails = second.locator('details');
            const preview = page.locator('#persona_effective_description_preview');

            await expect(firstDetails).toHaveJSProperty('open', false);
            await expect(secondDetails).toHaveJSProperty('open', false);
            await expect(first.locator('.persona-appendix-description')).toBeHidden();
            await first.locator('summary').click();
            await expect(first.locator('.persona-appendix-description')).toBeVisible();
            await expect(secondDetails).toHaveJSProperty('open', false);
            await expect(preview).toHaveText('Base persona');

            await second.getByRole('checkbox', { name: 'Second note', exact: true }).check();
            await expect(preview).toContainText('Second scenario note.');
            await expect(firstDetails).toHaveJSProperty('open', true);
            await expect(secondDetails).toHaveJSProperty('open', false);
            await first.locator('summary').press('Space');
            await expect(firstDetails).toHaveJSProperty('open', false);
            await expect(preview).toContainText('Second scenario note.');
            await first.locator('summary').press('Enter');
            await second.locator('summary').click();
            await expect(firstDetails).toHaveJSProperty('open', true);
            await expect(secondDetails).toHaveJSProperty('open', true);

            await second.locator('.persona_appendix_edit').click();
            await page.locator('#persona_appendix_description_input').fill('Updated scenario note.');
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(preview).toContainText('Updated scenario note.');
            await expect(firstDetails).toHaveJSProperty('open', true);
            await expect(secondDetails).toHaveJSProperty('open', true);
            await first.locator('summary').click();
            await second.locator('summary').click();
            await second.locator('.persona_appendix_delete').click();
            await page.locator('dialog[open] .popup-button-cancel').click();
            await expect(secondDetails).toHaveJSProperty('open', false);
            await expect(second.getByRole('checkbox')).toBeChecked();
            await expect(preview).toContainText('Updated scenario note.');
            await first.scrollIntoViewIfNeeded();
            await page.screenshot({ path: testInfo.outputPath('scenario-note-dropdowns.png') });

            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.persona_descriptions[user_avatar].appendices[0].name = 'LongLabel'.repeat(20);
                setPersonaDescription();
            });
            await expect(first.locator('summary')).toHaveText('LongLabel'.repeat(20));
            for (const card of [first, second]) {
                expect(await card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
                expect((await card.locator('summary').boundingBox()).height).toBeGreaterThanOrEqual(44);
            }
            await first.scrollIntoViewIfNeeded();
            await page.screenshot({ path: testInfo.outputPath('long-note-label.png') });

            await second.locator('summary').click();
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, initUserAvatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.persona_descriptions['dropdown-other.png'] = structuredClone(power_user.persona_descriptions[user_avatar]);
                initUserAvatar('dropdown-other.png');
                setPersonaDescription();
            });
            await expect(firstDetails).toHaveJSProperty('open', false);
            await expect(secondDetails).toHaveJSProperty('open', false);
        });
    });
}

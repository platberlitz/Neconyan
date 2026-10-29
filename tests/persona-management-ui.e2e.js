/* global window */
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
    test.describe(`Scenario Note scroll on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

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

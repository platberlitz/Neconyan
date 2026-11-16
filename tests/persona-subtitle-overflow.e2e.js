/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openPersonaEditor, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const longNote = 'Genshin Impact: Sumeru Dropout & Garret Fugitive with a Very Long Scenario Name and an Even Longer Backstory in the Desert';
const unbroken = 'UnbrokenScenarioName'.repeat(8);

for (const phone of [true, false]) {
    test.describe(`Long persona labels on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test('wraps long titles and active Scenario Notes within their containers', async ({ page, context }, testInfo) => {
            test.setTimeout(90000);
            if (phone) await installIPhoneSafari(context);
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                settings.accountStorage['neconyanToolTourInvite.persona'] = 'seen';
            });
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.evaluate(async ({ longNote, unbroken }) => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.personas[user_avatar] = 'Coco';
                power_user.persona_descriptions[user_avatar] = {
                    title: 'The user is a 24 year old woman.',
                    description: 'Persona description.',
                    appendices: [
                        { id: 'long-note', name: longNote, description: 'Scenario details.' },
                        { id: 'unbroken-note', name: unbroken, description: 'More scenario details.' },
                    ],
                    activeAppendices: {},
                };
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            }, { longNote, unbroken });
            await openPersonaEditor(page);
            await page.locator('#persona_appendices_heading').click();
            if (phone) await applyIOSOnlyCss(page);
            await page.getByRole('checkbox', { name: longNote, exact: true }).check();

            const masthead = page.locator('#persona_selected_masthead');
            await masthead.scrollIntoViewIfNeeded();
            await page.evaluate(() => {
                document.querySelectorAll('#nn-update-toast, #toast-container').forEach(element => element.remove());
            });
            await page.screenshot({ path: testInfo.outputPath(`persona-overflow-${phone ? 'phone' : 'desktop'}.png`) });

            async function expectContained(selector, parentSelector, text) {
                const label = page.locator(selector);
                await expect(label).toHaveText(text);
                const geometry = await label.evaluate((element, parentSelector) => {
                    const parent = element.closest(parentSelector).getBoundingClientRect();
                    const box = element.getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return {
                        parentLeft: parent.left, parentRight: parent.right,
                        left: box.left, right: box.right,
                        textRects: Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right })),
                        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
                    };
                }, parentSelector);
                expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft - 1);
                expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1);
                expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
                for (const rect of geometry.textRects) {
                    expect(rect.left).toBeGreaterThanOrEqual(geometry.left - 1);
                    expect(rect.right).toBeLessThanOrEqual(geometry.right + 1);
                }
            }

            for (const [selector, parent, prefix] of [
                ['#persona_selected_chips .is-appendix', '.persona-selected-chips', '+ '],
                ['#persona_appendices_active_chips .is-appendix', '.persona-appendices-active-chips', ''],
            ]) {
                await expectContained(selector, parent, `${prefix}${longNote}`);
            }

            await page.getByRole('checkbox', { name: longNote, exact: true }).uncheck();
            await page.getByRole('checkbox', { name: unbroken, exact: true }).check();
            await page.evaluate(async (title) => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.persona_descriptions[user_avatar].title = title;
                setPersonaDescription();
            }, unbroken);
            await expectContained('#persona_selected_title', '.persona-selected-copy', unbroken);
            await expectContained('#persona_selected_chips .is-appendix', '.persona-selected-chips', `+ ${unbroken}`);
            await expectContained('#persona_appendices_active_chips .is-appendix', '.persona-appendices-active-chips', unbroken);
        });
    });
}

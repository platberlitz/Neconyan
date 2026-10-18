/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { openPersonaEditor } from './chat-scroll-regression-helpers.js';
import { openMacros } from './macro-enhanced-native-helpers.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

test('The compact introduction remembers its state and keeps the manual tour available', async ({ app }) => {
    const { page } = await openMacros(app, true);
    const intro = page.locator('.neconyan-included-tool-page[data-tool-page="macro-enhanced"] .neconyan-tool-page-intro');
    const toggle = intro.getByRole('button', { name: 'Prompt macros', exact: true });
    const tour = intro.getByRole('button', { name: 'Start Nori\'s Macro Enhanced tour', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(intro.locator('.neconyan-tool-page-description')).toBeHidden();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
        && response.ok()
        && response.request().postDataJSON()?.accountStorage?.['neconyanPageIntroExpanded.macro-enhanced'] === 'true');
    await toggle.click();
    await expect(intro.locator('.neconyan-tool-page-description')).toBeVisible();
    await saved;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.NeconyanShell?.openIncludedTool && document.getElementById('me-settings-drawer'));
    await page.evaluate(() => window.NeconyanShell.openIncludedTool('MacroEnhanced'));
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await tour.click();
    const card = page.locator('#neconyan-tool-tour');
    await expect(card).toBeVisible();
    for (const title of ['Where these macros work', 'Playground', 'Reference', 'My macros', 'This chat', 'Setup', 'Ready to try one']) {
        await card.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(card.locator('.neconyan-tool-tour-title')).toHaveText(title);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#neconyan-tool-tour')).toHaveCount(0);
    await expect(tour).toBeFocused();
});

test('Setup pronouns and the Persona editor stay in sync without losing custom input', async ({ app }) => {
    const { page, workbench } = await openMacros(app, false, { configureSettings: settings => {
        settings.power_user.personas[settings.user_avatar] = 'Macro Tester';
    } });
    const current = () => page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        return {
            saved: ctx.extensionSettings.MacroEnhanced?.pronouns?.personas?.[ctx.userAvatar] ?? '',
            expanded: ctx.substituteParams('{{Sub}} {{pverb::is::are}} sure {{sub}} saw {{poss}} cat.'),
        };
    });
    await workbench.getByRole('tab', { name: 'Setup', exact: true }).click();
    const pronouns = workbench.locator('.me-pronoun-input').first();
    await pronouns.fill('he/him');
    await pronouns.locator('..').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(current).toEqual({ saved: 'he/him', expanded: 'He is sure he saw his cat.' });
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'persona'));
    await openPersonaEditor(page);
    const field = page.locator('#me-persona-pronouns');
    const input = page.locator('#me_persona_pronouns_input');
    await expect(input).toHaveValue('he/him');
    await field.getByRole('button', { name: 'she/her', exact: true }).click();
    await expect.poll(current).toEqual({ saved: 'she/her', expanded: 'She is sure she saw her cat.' });
    await expect(pronouns).toHaveValue('she/her');
    await input.fill('xe/xem/xyr/xyrs/xemself');
    await expect.poll(current).toEqual({ saved: 'xe/xem/xyr/xyrs/xemself', expanded: 'Xe is sure xe saw xyr cat.' });
    await expect(input).toBeFocused();
    await expect(pronouns).toHaveValue('xe/xem/xyr/xyrs/xemself');
    await input.fill('banana');
    await input.blur();
    await expect(field.locator('.me-pronoun-problem')).toBeVisible();
    expect((await current()).saved).toBe('xe/xem/xyr/xyrs/xemself');
    await input.fill('');
    await input.blur();
    await expect.poll(current).toEqual({ saved: '', expanded: 'They are sure they saw their cat.' });
    await expect(pronouns).toHaveValue('');
});

test('Slash-command changes refresh My macros and Reference without reopening the page', async ({ app }) => {
    const { page, workbench } = await openMacros(app);
    await workbench.getByRole('tab', { name: 'Reference', exact: true }).click();
    const search = workbench.getByRole('searchbox');
    await search.fill('necolive');
    await expect(workbench.locator('.me-ref-results')).toContainText('No');
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/me-define name=necolive A live command result');
    });
    await expect(search).toHaveValue('necolive');
    await expect(workbench.locator('.me-ref-item-label').filter({ hasText: '{{necolive}}' })).toBeVisible();
    await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
    await expect(workbench.locator('#me-panel-macros').getByText('{{necolive}}', { exact: true }).first()).toBeVisible();
    await expect(workbench.getByRole('button', { name: /Export.*1/ }).first()).toBeVisible();
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/me-undefine necolive');
    });
    await expect(workbench.locator('#me-panel-macros').getByText('{{necolive}}', { exact: true })).toHaveCount(0);
    await workbench.getByRole('tab', { name: 'Reference', exact: true }).click();
    await expect(search).toHaveValue('necolive');
    await expect(workbench.locator('.me-ref-item-label').filter({ hasText: '{{necolive}}' })).toHaveCount(0);
    await expect(workbench.locator('.me-ref-results')).toContainText('No');
    expect(app.provider.calls).toHaveLength(0);
});

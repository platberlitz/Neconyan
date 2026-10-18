/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { captureMacros, openMacros, savedMacroState, selectMacroCharacter } from './macro-enhanced-native-helpers.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

test('Playground isolates writes, times expansions and keeps the send shortcut local', async ({ app }, info) => {
    const { page, account, workbench } = await openMacros(app);
    await selectMacroCharacter(page, account.avatar);
    const before = await savedMacroState(page);
    const input = workbench.getByLabel('Macro text', { exact: true });
    await input.fill('{{setvar::sandboxOnly::7}}{{getvar::sandboxOnly}} / {{setchatvar::trialOnly::9}}{{getchatvar::trialOnly}}');
    await expect(workbench.locator('.me-result-output')).toHaveText('7 / 9');
    await expect(workbench.locator('.me-ledger')).toContainText('sandboxOnly');
    await expect(workbench.locator('.me-ledger')).toContainText('trialOnly');
    await expect.poll(() => savedMacroState(page)).toBe(before);
    await input.press('Control+Enter');
    await expect(workbench.locator('.me-result-output')).toHaveText('7 / 9');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('#send_textarea')).toHaveValue('');
    await workbench.getByRole('button', { name: 'Time each macro', exact: true }).click();
    await expect(workbench.locator('.me-trace-results')).toContainText('setchatvar');
    await expect.poll(() => savedMacroState(page)).toBe(before);
    await captureMacros(page, info, 'desktop-playground-after');
    expect(app.provider.calls).toHaveLength(0);
});

test('Reference search and Try it open an executable example in the Playground', async ({ app }, info) => {
    const { page, workbench } = await openMacros(app, true);
    await workbench.getByRole('tab', { name: 'Reference', exact: true }).click();
    const search = workbench.getByRole('searchbox');
    await search.fill('nothingmatchesnecoexample');
    await expect(workbench.locator('.me-ref-results')).toContainText('No');
    await search.fill('upper');
    const item = workbench.locator('.me-ref-item').filter({ has: page.locator('.me-ref-item-label', { hasText: '{{upper' }) }).first();
    await item.locator('.me-ref-item-head').click();
    await captureMacros(page, info, 'phone-reference-after');
    const example = await item.locator('.me-ref-example-text').first().innerText();
    await item.getByRole('button', { name: 'Try it', exact: true }).first().click();
    await expect(workbench.getByRole('tab', { name: 'Playground', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(workbench.getByLabel('Macro text', { exact: true })).toHaveValue(example);
    await expect(workbench.getByLabel('Macro text', { exact: true })).toBeFocused();
    await expect(workbench.locator('.me-result-output')).not.toBeEmpty();
    expect(app.provider.calls).toHaveLength(0);
});

test('Custom macro validation preserves the draft, saves executable text and refreshes exports', async ({ app }, info) => {
    const { page, workbench } = await openMacros(app, true);
    await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
    await workbench.getByRole('button', { name: 'New macro', exact: true }).first().click();
    const editor = workbench.locator('.me-macro-editor');
    await expect(editor.getByRole('textbox', { name: /^Name/ })).toBeFocused();
    await editor.getByRole('textbox', { name: /^Name/ }).fill('123invalid');
    await editor.getByRole('textbox', { name: 'What it expands to', exact: true }).fill('A dependable macro.');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('textbox', { name: /^Name/ })).toHaveValue('123invalid');
    await expect(editor.locator('.me-form-problem:visible')).not.toBeEmpty();
    await expect(editor.getByRole('radio', { name: /^This character/ })).toBeDisabled();
    await expect(editor.getByRole('radio', { name: /^This chat/ })).toBeDisabled();
    await editor.getByRole('textbox', { name: /^Name/ }).fill('necoexample');
    await page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        await ctx.eventSource.emit(ctx.eventTypes.PERSONA_CHANGED);
    });
    await expect(editor.getByRole('textbox', { name: /^Name/ })).toHaveValue('necoexample');
    await expect(editor.getByRole('textbox', { name: 'What it expands to', exact: true })).toHaveValue('A dependable macro.');
    await captureMacros(page, info, 'phone-editor-after');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok()
        && response.request().postDataJSON()?.extension_settings?.MacroEnhanced?.customMacros?.some(macro => macro.name === 'necoexample'));
    await editor.getByRole('button', { name: 'Save and try it', exact: true }).click();
    await expect(workbench.getByRole('tab', { name: 'Playground', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(workbench.locator('.me-result-output')).toHaveText('A dependable macro.');
    await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
    await expect(workbench.getByRole('button', { name: /Export.*1/ }).first()).toBeVisible();
    expect(await page.evaluate(() => window.SillyTavern.getContext().substituteParams('{{necoexample}}'))).toBe('A dependable macro.');
    await captureMacros(page, info, 'phone-macros-after');
    await saved;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.NeconyanShell?.openIncludedTool && document.getElementById('me-settings-drawer'));
    await page.evaluate(() => window.NeconyanShell.openIncludedTool('MacroEnhanced'));
    await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
    await expect(workbench.getByRole('button', { name: /Export.*1/ }).first()).toBeVisible();
    expect(await page.evaluate(() => window.SillyTavern.getContext().substituteParams('{{necoexample}}'))).toBe('A dependable macro.');
    expect(app.provider.calls).toHaveLength(0);
});

/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { captureMacros as capture, openMacros } from './macro-enhanced-native-helpers.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} native macro tabs retain keyboard roles and fit the page`, async ({ app }, info) => {
        const { page, workbench } = await openMacros(app, phone);
        await expect(workbench).toBeVisible();
        const intro = page.locator('.neconyan-included-tool-page[data-tool-page="macro-enhanced"] .neconyan-tool-page-intro');
        await expect(intro.getByRole('button', { name: 'Prompt macros', exact: true })).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.neconyan-tool-tour-invite[data-tool-page="macro-enhanced"]')).toHaveCount(0);
        const tabs = workbench.getByRole('tab');
        await expect(tabs).toHaveText(['Playground', 'Reference', 'My macros', 'This chat', 'Setup']);
        await expect(workbench.getByRole('tab', { name: 'Playground', exact: true })).toHaveAttribute('aria-selected', 'true');
        await capture(page, info, `${phone ? 'phone' : 'desktop'}-settings-after`);

        const first = tabs.first();
        await first.focus();
        await first.press('End');
        await expect(tabs.last()).toBeFocused();
        await tabs.last().press('Home');
        await expect(first).toBeFocused();
        await first.press('ArrowRight');
        await expect(workbench.getByRole('tab', { name: 'Reference', exact: true })).toBeFocused();

        for (const label of ['Reference', 'My macros', 'This chat', 'Setup', 'Playground']) {
            const tab = workbench.getByRole('tab', { name: label, exact: true });
            await tab.click();
            await expect(tab).toHaveAttribute('aria-selected', 'true');
            await expect(tab).toHaveAttribute('role', 'tab');
            await expect(workbench.getByRole('tabpanel')).toBeVisible();
            const bounds = await workbench.boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            const size = await tab.boundingBox();
            expect(size.height).toBeGreaterThanOrEqual(44);
            expect(size.width).toBeGreaterThanOrEqual(44);
        }
        expect(app.provider.calls).toHaveLength(0);
    });
}

test('read-only browser prompt previews cannot change saved Macro Enhanced state', async ({ app }) => {
    const { page, account } = await openMacros(app);
    const builtStyles = await page.locator('link[rel="stylesheet"][href^="/frontend-assets/"]').count();
    expect(builtStyles > 0).toBe(process.env.NECONYAN_TEST_FRONTEND_BUILD === '1');
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await (await import('/script.js')).selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    const result = await page.evaluate(async () => {
        const { withReadOnlyVariables } = await import('/scripts/variable-read-only.js');
        const ctx = window.SillyTavern.getContext();
        const live = ctx.substituteParams('{{setchatvar::readonlyProof::live}}{{getchatvar::readonlyProof}}');
        const before = JSON.stringify(ctx.chatMetadata.MacroEnhanced);
        const input = '{{setchatvar::readonlyProof::preview}}{{freeze::readonlyFreeze::trial}}{{setpronouns::he/him}}';
        const output = withReadOnlyVariables(() => ctx.substituteParams(input));
        return {
            live, before, after: JSON.stringify(ctx.chatMetadata.MacroEnhanced), output,
            saved: ctx.substituteParams('{{getchatvar::readonlyProof}}'),
        };
    });
    expect(result.live).toBe('live');
    expect(result.output).not.toContain('{{');
    expect(result.after).toBe(result.before);
    expect(result.saved).toBe('live');
    expect(app.provider.calls).toHaveLength(0);
});

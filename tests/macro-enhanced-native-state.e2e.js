/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { openMacros, savedMacroState, selectMacroCharacter } from './macro-enhanced-native-helpers.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

test('A dirty pronoun draft cannot overwrite the newly selected persona', async ({ app }) => {
    const { page, workbench } = await openMacros(app, false, { configureSettings: settings => {
        settings.power_user.personas[settings.user_avatar] = 'First persona';
        settings.power_user.personas['macro-second.png'] = 'Second persona';
        settings.extension_settings.MacroEnhanced = {
            ...settings.extension_settings.MacroEnhanced,
            pronouns: { personas: { [settings.user_avatar]: 'she/her', 'macro-second.png': 'they/them' } },
        };
    } });
    const first = await page.evaluate(() => window.SillyTavern.getContext().userAvatar);
    await workbench.getByRole('tab', { name: 'Setup', exact: true }).click();
    const input = workbench.locator('.me-pronoun-input').first();
    await expect(input).toHaveValue('she/her');
    await input.fill('he/him');
    await page.evaluate(async () => {
        const { setUserAvatar } = await import('/scripts/personas.js');
        await setUserAvatar('macro-second.png', { toastPersonaNameChange: false, readOnlyRoute: true });
    });
    await expect(input).toHaveValue('he/him');
    await expect(input.locator('..').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const notice = workbench.locator('.me-pronoun-draft:visible');
    await expect(notice).toContainText('First persona');
    await notice.getByRole('button', { name: 'Save pronouns for First persona', exact: true }).click();
    await expect(input).toHaveValue('they/them');
    expect(await page.evaluate(first => {
        const saved = window.SillyTavern.getContext().extensionSettings.MacroEnhanced.pronouns.personas;
        return [saved[first], saved['macro-second.png']];
    }, first)).toEqual(['he/him', 'they/them']);
    expect(app.provider.calls).toHaveLength(0);
});

test('Shorthand and frozen previews produce real results without leaving saved state', async ({ app }) => {
    const { page, account, workbench } = await openMacros(app);
    // Character selection starts a prompt preview whose validation cache is saved.
    // Wait for that unrelated startup write before measuring sandbox requests.
    const initialValidationSave = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
        && response.ok()
        && response.request().postDataJSON()?.accountStorage?.StoryStringValidationCache);
    await selectMacroCharacter(page, account.avatar);
    await initialValidationSave;
    await page.clock.install();
    await page.clock.fastForward(2000);
    const saves = [];
    page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/(?:(?:chats|groups)\/.*save|settings\/save)$/.test(new URL(request.url()).pathname)) {
            saves.push(request.url());
        }
    });
    const before = await savedMacroState(page);
    const input = workbench.getByLabel('Macro text', { exact: true });
    await input.fill('{{.hp = 5}}{{.hp}} / {{$score = 7}}{{$score}} / {{freeze::trial::hello}}');
    await expect(workbench.locator('.me-result-output')).toHaveText('5 / 7 / hello');
    await expect(workbench.locator('.me-ledger')).toContainText('hp');
    await expect(workbench.locator('.me-ledger')).toContainText('score');
    await expect(workbench.locator('.me-ledger')).toContainText('trial');
    await expect.poll(() => savedMacroState(page)).toBe(before);
    await input.press('Control+Enter');
    await expect(workbench.locator('.me-result-output')).toHaveText('5 / 7 / hello');
    await expect.poll(() => savedMacroState(page)).toBe(before);
    await page.clock.fastForward(1500);
    expect(saves).toEqual([]);
    await input.fill('{{setvar::hp::5}}{{.hp}} / {{.hp = 9}}{{getvar::hp}} / {{setglobalvar::score::3}}{{$score}} / {{$score += 2}}{{getglobalvar::score}}');
    await expect(workbench.locator('.me-result-output')).toHaveText('5 / 9 / 3 / 5');
    await page.clock.fastForward(1500);
    expect(saves).toEqual([]);
    expect(await savedMacroState(page)).toBe(before);
    expect(app.provider.calls).toHaveLength(0);
});

test('Chat values and counters refresh after commands and generation events', async ({ app }) => {
    const { page, account, workbench } = await openMacros(app);
    await selectMacroCharacter(page, account.avatar);
    await workbench.getByRole('tab', { name: 'This chat', exact: true }).click();
    const panel = workbench.locator('#me-panel-chat');
    await page.evaluate(() => window.SillyTavern.getContext().substituteParams('{{freeze::liveRefresh::a saved value}}'));
    await expect(panel.getByText('liveRefresh', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/me-unfreeze liveRefresh');
    });
    await expect(panel.getByText('liveRefresh', { exact: true })).toHaveCount(0);
    const count = await page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        const before = ctx.chatMetadata.MacroEnhanced.counters.generations;
        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
        return before + 1;
    });
    await expect(panel).toContainText(`${count} generations.`);
    await workbench.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/me-workbench');
    });
    await expect(workbench.getByRole('tab', { name: 'Playground', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(app.provider.calls).toHaveLength(0);
});

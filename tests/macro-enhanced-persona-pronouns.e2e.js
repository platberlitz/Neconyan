/* global document, window */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave, openPersonaEditor, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test.setTimeout(60000);
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const SAMPLE = '{{Sub}} {{pverb::is::are}} sure {{sub}} saw {{poss}} cat.';

function readState(page) {
    return page.evaluate(sample => {
        const ctx = SillyTavern.getContext();
        return {
            stored: ctx.extensionSettings.MacroEnhanced?.pronouns?.personas?.[ctx.userAvatar] ?? '',
            drawer: document.querySelector('#me-settings-drawer .me-pronoun-input')?.value ?? null,
            macros: ctx.substituteParams(sample),
        };
    }, SAMPLE);
}

function saveFromDrawer(page, value) {
    return page.evaluate(spec => {
        const input = document.querySelector('#me-settings-drawer .me-pronoun-input');
        input.value = spec;
        input.dispatchEvent(new Event('input'));
        [...input.parentElement.querySelectorAll('[role=button]')].find(button => button.textContent === 'Save').click();
    }, value);
}

test('persona pronoun field and Macro Enhanced pronouns edit the same value', async ({ page }) => {
    let settingsVersion = Date.now();
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route, ++settingsVersion));
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.waitForFunction(() => document.getElementById('me-persona-pronouns') && document.getElementById('me-settings-drawer'));
    await page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        delete ctx.extensionSettings.MacroEnhanced.pronouns.personas[ctx.userAvatar];
        window.NeconyanShell.openTab('characters', 'persona');
    });
    await saveFromDrawer(page, '');
    await openPersonaEditor(page);

    const field = page.locator('#me-persona-pronouns');
    const input = page.locator('#me_persona_pronouns_input');
    await expect(field).toBeVisible();
    await expect(page.locator('#persona_description + #me-persona-pronouns')).toHaveCount(1);
    await expect(input).toHaveValue('');

    await field.getByRole('button', { name: 'she/her', exact: true }).click();
    await expect(input).toHaveValue('she/her');
    expect(await readState(page)).toEqual({ stored: 'she/her', drawer: 'she/her', macros: 'She is sure she saw her cat.' });

    await saveFromDrawer(page, 'he/him');
    await expect(input).toHaveValue('he/him');
    expect((await readState(page)).macros).toBe('He is sure he saw his cat.');

    await input.fill('');
    await input.pressSequentially('xe/xem/xyr/xyrs/xemself');
    await expect.poll(async () => (await readState(page)).stored).toBe('xe/xem/xyr/xyrs/xemself');
    expect(await readState(page)).toEqual({
        stored: 'xe/xem/xyr/xyrs/xemself',
        drawer: 'xe/xem/xyr/xyrs/xemself',
        macros: 'Xe is sure xe saw xyr cat.',
    });
    await expect(input).toBeFocused();

    await input.fill('banana');
    await input.blur();
    await expect(field.locator('.me-pronoun-problem')).toBeVisible();
    expect((await readState(page)).stored).toBe('xe/xem/xyr/xyrs/xemself');

    await input.fill('');
    await input.blur();
    await expect.poll(async () => (await readState(page)).stored).toBe('');
    expect(await readState(page)).toEqual({ stored: '', drawer: '', macros: 'They are sure they saw their cat.' });
});

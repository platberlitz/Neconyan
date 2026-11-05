/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';

for (const phone of [true, false]) {
    test(`dialogue colours only list the equipped persona on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await page.evaluate(async ({ avatar, extension }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const { power_user } = await import('/scripts/power-user.js');
            Object.assign(power_user.personas, { 'aster.png': 'Aster', 'marisol.png': 'Marisol', 'robin.png': 'Robin' });
            const state = await import(`${extension}/state.js`);
            Object.assign(state.settings, {
                enabled: true, keepCardCharacter: false, autoPersonaCharacter: false,
                keepPersonaCharacter: false, persistPersonaColor: false, llmAttributionCheck: false,
                disableToasts: true, showLegend: true,
            });
            await core.setUserAvatar('aster.png', { toastPersonaNameChange: false });
            const ui = await import(`${extension}/ui.js`);
            const { buildCharacterEntry } = await import(`${extension}/palettes.js`);
            state.setCharacterColors(Object.fromEntries([
                ['aster', 'Aster', '#88bbff', []],
                ['mari', 'Mari', '#ff88aa', ['Marisol']],
                ['robin', 'Robin', '#88ffaa', []],
                ['juniper', 'Juniper', '#ddbbff', []],
                ['nova', 'Nova', '#ffbb88', []],
            ].map(([key, name, color, aliases]) => [key, buildCharacterEntry(name, { color, aliases, origin: 'import' }).entry])));
            const storage = await import(`${extension}/storage.js`);
            Object.assign(storage.getPinnedPersonaColors(), {
                'avatar:marisol.png': { ...state.characterColors.mari, persona: 'Marisol' },
                'avatar:juniper.png': { ...state.characterColors.juniper, persona: 'Juniper' },
            });
            storage.saveData();
            ui.updateCharList();
            window.NeconyanExtensions.focusUnit('Dialogue Colors');
        }, { avatar: account.avatar, extension });

        const rows = page.locator('#dc-char-list .dc-char');
        await expect(page.locator('#dc-char-list')).toBeVisible();
        await rows.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/dialogue-personas-${phone ? 'phone' : 'desktop'}-after.png` });
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toHaveAttribute('data-key', 'aster');
        await expect(page.locator('#dc-count')).toHaveText('2');
        await expect(page.locator('#dc-legend-float .dc-legend-character:not(.dc-legend-narration) .dc-legend-name')).toHaveText(['Aster', 'Nova']);
        await page.locator('#dc-search').fill('Marisol');
        await expect(rows).toHaveCount(0);
        await page.locator('#dc-search').fill('');
        await expect(rows).toHaveCount(2);
        await page.locator('#dc-select-visible').click();
        await expect(page.locator('#dc-selection-count')).toHaveText('2 selected');

        // A real host persona switch must refresh the list even with every automatic
        // persona option off. The old selected persona must not remain a bulk target.
        await page.evaluate(async () => {
            await (await import('/script.js')).setUserAvatar('marisol.png', { toastPersonaNameChange: false });
        });
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toHaveAttribute('data-key', 'mari');
        await expect(page.locator('#dc-selection-count')).toHaveText('1 selected');
        await expect(rows.first().locator('.dc-status-chip-persona')).toHaveText('You');

        // Pins being enabled or colouring being disabled must not reveal unused personas.
        for (const enabled of [true, false]) {
            await page.evaluate(async ({ extension, enabled }) => {
                const state = await import(`${extension}/state.js`);
                state.settings.persistPersonaColor = true;
                state.settings.enabled = enabled;
                await (await import('/script.js')).setUserAvatar(enabled ? 'aster.png' : 'marisol.png', { toastPersonaNameChange: false });
            }, { extension, enabled });
            await expect(rows).toHaveCount(2);
            await expect(rows.first()).toHaveAttribute('data-key', enabled ? 'aster' : 'mari');
        }
        const preserved = await page.evaluate(async extension => {
            const state = await import(`${extension}/state.js`);
            return { keys: Object.keys(state.characterColors), color: state.characterColors.mari.baseColor };
        }, extension);
        expect(preserved.keys.sort()).toEqual(['aster', 'juniper', 'mari', 'nova', 'robin']);
        expect(preserved.color).toBe('#ff88aa');
        const bounds = await page.locator('#dc-char-list').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
    });
}

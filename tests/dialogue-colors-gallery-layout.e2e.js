/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [true, false]) {
    test(`dialogue colours keep the gradient target compact on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false, timeout: 60000 });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const { addCharacter } = await import('/scripts/extensions/third-party/sillytavern-character-colors/src/ui.js');
            addCharacter('Durable Nova', '#88bbff');
            window.NeconyanExtensions.focusUnit('Dialogue Colors');
        }, account.avatar);
        await page.locator('#dc-page-library > summary').click();
        await page.locator('[data-dc-disclosure="library-gradient-presets"]').scrollIntoViewIfNeeded();
        const target = page.locator('#dc-gradient-gallery-target');
        await expect(target).toBeVisible();
        if (phone) await applyIOSOnlyCss(page);
        await target.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/dialogue-gallery-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png` });

        const bounds = await target.boundingBox();
        expect(bounds.height).toBeLessThanOrEqual(50);
        if (phone) expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);

        // The compact control still opens and retains its target when presets change.
        const value = await target.locator('option').last().getAttribute('value');
        await target.selectOption(value);
        await page.locator('[data-gradient-gallery-preset]').nth(1).click();
        await expect(target).toHaveValue(value);
        await expect(page.locator('#dc-gradient-gallery-apply')).toBeEnabled();
    });
}

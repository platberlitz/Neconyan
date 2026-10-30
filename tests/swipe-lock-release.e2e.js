/* global document, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

const reply = 'A reply that can be switched.';
const refusal = 'Cannot switch replies while a reply is being written. Stop the reply and try again.';

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await expect(page.locator('#send_textarea')).toBeVisible();
    return page;
}

async function swipeState(page) {
    return page.evaluate(async () => {
        const core = await import('/script.js');
        return { state: core.swipeState, allowed: core.isSwipingAllowed() };
    });
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport}: a swipe on a reply missing from the page leaves swiping available`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await openChat(account);
        await page.evaluate(async () => {
            const core = await import('/script.js');
            const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
            document.querySelector(`#chat .mes[mesid="${core.chat.length - 1}"]`).remove();
            await core.swipe(null, SWIPE_DIRECTION.LEFT);
        });
        expect(await swipeState(page)).toEqual({ state: 'none', allowed: true });
    });

    test(`${viewport}: switching replies while a new reply is being written says why it was refused`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.reply = { choices: [{ message: { content: reply } }] };
        const account = await app.account({ phone, activeConnection: true });
        const page = await openChat(account);
        await page.locator('#send_textarea').fill('Write something I can swipe.');
        await page.evaluate(async () => { await (await import('/script.js')).Generate('normal'); });
        await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(reply);

        app.provider.mode.hold = MODEL;
        await page.evaluate(async () => {
            const core = await import('/script.js');
            const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
            window.fixtureSwipe = core.swipe(null, SWIPE_DIRECTION.RIGHT);
        });
        await expect.poll(() => app.provider.calls.filter(call => call.model === MODEL).length).toBe(2);
        await page.evaluate(async () => {
            const core = await import('/script.js');
            const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
            await core.swipe(null, SWIPE_DIRECTION.LEFT);
        });
        const shown = await page.locator('#toast-container').getByText(refusal).waitFor({ timeout: 5000 }).then(() => true, () => false);
        await page.screenshot({ path: `../screenshots/swipe-refusal-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        expect(shown).toBe(true);

        await app.release();
        await page.evaluate(() => window.fixtureSwipe);
        expect(await swipeState(page)).toEqual({ state: 'none', allowed: true });

        // Once the reply has ended, an ordinary switch goes ahead and is not refused.
        const after = await page.evaluate(async () => {
            const core = await import('/script.js');
            const { SWIPE_DIRECTION } = await import('/scripts/constants.js');
            const warnings = [];
            const warning = window.toastr.warning;
            window.toastr.warning = (...parts) => {
                warnings.push(String(parts[0]));
                return warning.apply(window.toastr, parts);
            };
            try {
                await core.swipe(null, SWIPE_DIRECTION.LEFT);
            } finally {
                window.toastr.warning = warning;
            }
            return { warnings, swipeId: core.chat.at(-1).swipe_id };
        });
        expect(after.warnings).not.toContain(refusal);
        expect(after.swipeId).toBe(0);
        expect(await swipeState(page)).toEqual({ state: 'none', allowed: true });
    });
}

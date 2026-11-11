/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} typed tools swap command lines for results before the message is sent`, async ({ app }) => {
        test.setTimeout(150000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        const composer = page.locator('.scratchpad-composer');
        await expect(composer).toBeEnabled();
        if (phone) await applyIOSOnlyCss(page);
        const send = page.locator('.scratchpad-send');
        const toasts = page.locator('#toast-container');
        const sentCount = () => app.provider.calls.length;
        const before = sentCount();

        // Asking for the list sends nothing and keeps the text.
        await composer.fill('/tools');
        await send.click();
        await expect(toasts).toContainText('Typed tools');
        await expect(toasts).toContainText('/roll 2d6+1');
        await expect(composer).toHaveValue('/tools');
        await page.screenshot({ path: `../screenshots/scratchpad-typed-tools/${size}-list.png` });

        // A line that cannot be worked out stops the message and says why.
        await composer.fill('Check this.\n/calc 2+');
        await send.click();
        await expect(toasts).toContainText('Nothing was sent');
        await expect(toasts).toContainText('\'/calc 2+\' is not a sum Scratchpad can work out.');
        await expect(composer).toHaveValue('Check this.\n/calc 2+');
        await expect(composer).toBeFocused();
        await expect(page.locator('.scratchpad-message')).toHaveCount(0);
        expect(sentCount()).toBe(before);
        await page.screenshot({ path: `../screenshots/scratchpad-typed-tools/${size}-refused.png` });

        app.provider.mode.streamReply = () => ({ first: 'A fine', rest: ' result.' });
        await composer.fill('Does the lock give?\n/roll 2d6+1 for the lock\n/calc 12*(3+4)\n/pick left | right');
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await send.click();
        const response = await sent;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('A fine');
        const call = app.provider.calls.at(-1);
        const lines = call.messages.at(-1).content.split('\n');
        expect(lines[0]).toBe('Does the lock give?');
        const roll = /^\u{1F3B2} 2d6\+1 \(for the lock\): \[(\d), (\d)\] \+ 1 = (\d+)$/u.exec(lines[1]);
        expect(roll, lines[1]).not.toBeNull();
        expect(Number(roll[1]) + Number(roll[2]) + 1).toBe(Number(roll[3]));
        for (const die of [roll[1], roll[2]]) expect(Number(die)).toBeGreaterThanOrEqual(1);
        for (const die of [roll[1], roll[2]]) expect(Number(die)).toBeLessThanOrEqual(6);
        expect(lines[2]).toBe('\u{1F9EE} 12*(3+4) = 84');
        expect(lines[3]).toMatch(/^\u{1F3AF} Picked: (left|right) \(from: left, right\)$/u);
        call.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);

        // The saved message shows the results, and the box is empty again.
        const message = page.locator('.scratchpad-message.is-user');
        await expect(message).toHaveCount(1);
        await expect(message).toContainText('12*(3+4) = 84');
        await expect(message).toContainText('2d6+1 (for the lock)');
        await expect(composer).toHaveValue('');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: `../screenshots/scratchpad-typed-tools/${size}-sent.png` });
    });
}

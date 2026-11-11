/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Try again redoes an earlier reply and leaves later messages alone`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        if (phone) await applyIOSOnlyCss(page);

        let turn = 0;
        app.provider.mode.streamReply = () => ({ first: `Answer ${++turn}`, rest: ' is done.' });
        const ask = async (click, question) => {
            const sent = page.waitForResponse('**/api/scratchpad/send');
            await click();
            const response = await sent;
            expect(response.ok(), await response.text()).toBe(true);
            await expect(page.locator('.scratchpad-stream')).toContainText(`Answer ${turn}`);
            const call = app.provider.calls.at(-1);
            expect(call.messages.at(-1).content).toBe(question);
            call.finishStream();
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Send');
            await expect(page.locator('.scratchpad-send')).toBeEnabled();
            return call;
        };
        for (const question of ['First question?', 'Second question?']) {
            await page.locator('.scratchpad-composer').fill(question);
            await ask(() => page.locator('.scratchpad-send').click(), question);
        }
        const replies = page.locator('.scratchpad-message.is-assistant');
        await expect(replies).toHaveCount(2);
        await expect(replies.nth(0)).toContainText('Answer 1 is done.');
        await expect(replies.nth(1)).toContainText('Answer 2 is done.');

        const earlier = replies.nth(0);
        await earlier.locator('summary[aria-label="Message actions"]').click();
        const retry = earlier.getByRole('button', { name: 'Try again', exact: true });
        await expect(retry).toBeVisible();
        const box = await retry.boundingBox();
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(phone ? 44 : 32);
        await page.screenshot({ path: `../screenshots/scratchpad-retry-any/${phone ? 'phone' : 'desktop'}-button.png` });

        const call = await ask(() => retry.click(), 'First question?');
        // The redone reply answers the first question without seeing anything written after it.
        expect(call.messages.map(message => message.content).join('\n')).not.toContain('Second question?');
        await expect(replies).toHaveCount(2);
        await expect(replies.nth(0)).toContainText('Answer 3 is done.');
        await expect(replies.nth(0).locator('.scratchpad-swipe-count')).toHaveText('2 of 2');
        await expect(replies.nth(1)).toContainText('Answer 2 is done.');
        await expect(page.locator('.scratchpad-message.is-user')).toHaveCount(2);
        await page.screenshot({ path: `../screenshots/scratchpad-retry-any/${phone ? 'phone' : 'desktop'}-redone.png` });

        // The earlier version is still there.
        await replies.nth(0).getByRole('button', { name: 'Previous reply', exact: true }).click();
        await expect(replies.nth(0)).toContainText('Answer 1 is done.');
    });
}

/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} a message branches into a new session and the original stays`, async ({ app }) => {
        test.setTimeout(150000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        if (phone) await applyIOSOnlyCss(page);

        let turn = 0;
        app.provider.mode.streamReply = () => ({ first: `Answer ${++turn}`, rest: ' is done.' });
        for (const question of ['First question?', 'Second question?']) {
            await page.locator('.scratchpad-composer').fill(question);
            const sent = page.waitForResponse('**/api/scratchpad/send');
            await page.locator('.scratchpad-send').click();
            const response = await sent;
            expect(response.ok(), await response.text()).toBe(true);
            await expect(page.locator('.scratchpad-stream')).toContainText(`Answer ${turn}`);
            app.provider.calls.at(-1).finishStream();
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            await expect(page.locator('.scratchpad-send')).toBeEnabled();
        }
        const replies = page.locator('.scratchpad-message.is-assistant');
        const mine = page.locator('.scratchpad-message.is-user');
        await expect(replies).toHaveCount(2);
        const viewport = page.viewportSize();

        // A reply: the copy ends with it.
        await replies.nth(0).locator('summary[aria-label="Message actions"]').click();
        const branch = replies.nth(0).getByRole('button', { name: 'Branch into a new session from here', exact: true });
        await expect(branch).toBeVisible();
        const box = await branch.boundingBox();
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(phone ? 44 : 32);
        const menu = await replies.nth(0).locator('.scratchpad-message-actions').boundingBox();
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({ path: `../screenshots/scratchpad-branch/${size}-button.png` });

        let branched = page.waitForResponse('**/api/scratchpad/session/branch');
        await branch.click();
        expect((await branched).ok()).toBe(true);
        await expect(replies).toHaveCount(1);
        await expect(mine).toHaveCount(1);
        await expect(replies.nth(0)).toContainText('Answer 1 is done.');
        await expect(page.locator('.scratchpad-composer')).toHaveValue('');
        await expect(page.locator('#toast-container')).toContainText('The original session is unchanged.');

        await page.locator('#neconyan-scratchpad').getByRole('tab', { name: 'Sessions' }).click();
        const rows = page.locator('.scratchpad-sessions:not(.scratchpad-found) > .scratchpad-session');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText('First question? (branch)');
        await expect(rows.nth(1)).toContainText('First question?');
        await page.screenshot({ path: `../screenshots/scratchpad-branch/${size}-sessions.png` });

        // Back in the original, which still has both turns: one of the user's own messages.
        await rows.nth(1).getByRole('button', { name: 'Open', exact: true }).click();
        await expect(replies).toHaveCount(2);
        await mine.nth(1).locator('summary[aria-label="Message actions"]').click();
        const reword = mine.nth(1).getByRole('button', { name: 'Reword in a new session', exact: true });
        await expect(reword).toBeVisible();
        branched = page.waitForResponse('**/api/scratchpad/session/branch');
        await reword.click();
        expect((await branched).ok()).toBe(true);
        await expect(replies).toHaveCount(1);
        await expect(mine).toHaveCount(1);
        await expect(page.locator('.scratchpad-composer')).toHaveValue('Second question?');
        await expect(page.locator('.scratchpad-composer')).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({ path: `../screenshots/scratchpad-branch/${size}-reworded.png` });

        // The reworded message goes to the new session, and the model sees only the first turn before it.
        await page.locator('.scratchpad-composer').fill('A different second question?');
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await sent;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('Answer 3');
        const call = app.provider.calls.at(-1);
        const prompt = call.messages.map(message => message.content).join('\n');
        expect(prompt).toContain('Answer 1 is done.');
        expect(prompt).not.toContain('Second question?\n');
        expect(prompt).not.toContain('Answer 2 is done.');
        call.finishStream();
        await account.settled((await response.json()).job.id);

        await page.locator('#neconyan-scratchpad').getByRole('tab', { name: 'Sessions' }).click();
        await expect(rows).toHaveCount(3);
    });
}

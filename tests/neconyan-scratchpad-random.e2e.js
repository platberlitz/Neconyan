/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Random sends one selected assistant per turn and preserves the speaker on retry`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            const profiles = saved.extension_settings.connectionManager.profiles;
            for (const id of ['miso', 'taro', 'nori']) profiles.push({ ...profiles[0], id: `random-${id}`, name: id, model: `random-${id}` });
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            await expect(page.locator('.scratchpad-composer')).toBeEnabled();
            if (phone) await applyIOSOnlyCss(page);
        };
        await open();
        await expect(page.locator('.scratchpad-random')).toBeHidden();
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        for (const id of ['miso', 'taro', 'nori']) await page.locator(`#scratchpad-connection-${id}`).selectOption(`random-${id}`);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-random')).toHaveAttribute('aria-pressed', 'false');
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Nori', exact: true }).click();
        await expect(page.locator('.scratchpad-send')).toHaveText('Ask 2');
        await page.locator('.scratchpad-random').click();
        await expect(page.locator('.scratchpad-random')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.scratchpad-send')).toHaveText('Ask 1');
        const rect = await page.locator('.scratchpad-random').boundingBox();
        expect(Math.min(rect.width, rect.height)).toBeGreaterThanOrEqual(phone ? 44 : 32);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Assistant prompt', exact: true })).toHaveValue(/You are the only assistant replying to this message/);
        await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();

        app.provider.mode.streamReply = body => ({ first: `${body.model} answers`, rest: ' in one reply.' });
        await page.locator('.scratchpad-composer').fill('Choose a starting point.');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok()).toBe(true);
        const result = await response.json();
        await expect(page.locator('.scratchpad-stream')).toHaveCount(1);
        await expect(page.locator('.scratchpad-stream')).toContainText('answers');
        await expect(page.locator('.scratchpad-send')).toHaveText('Stop');
        await expect(page.locator('.scratchpad-random')).toBeDisabled();
        const firstCalls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'Choose a starting point.');
        expect(firstCalls).toHaveLength(1);
        expect(['random-miso', 'random-taro']).toContain(firstCalls[0].model);
        expect(firstCalls[0].messages[0].content).toContain('You are the only assistant replying to this message');
        await page.close();
        firstCalls[0].finishStream();
        await account.settled(result.job.id);

        page = await account.open();
        await open();
        await expect(page.locator('.scratchpad-random')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.scratchpad-message.is-assistant.is-done')).toHaveCount(1);
        await expect(page.locator('.scratchpad-message.is-user')).toHaveCount(1);
        // A new user turn picks only from the current selection.
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Miso', exact: true }).click();
        await expect(page.locator('.scratchpad-assistants').getByRole('button', { name: 'Taro', exact: true })).toBeDisabled();
        await page.locator('.scratchpad-composer').fill('Now explain the next step.');
        const next = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const second = await next;
        expect(second.ok()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('random-taro answers');
        const secondCalls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'Now explain the next step.');
        expect(secondCalls.map(call => call.model)).toEqual(['random-taro']);
        secondCalls[0].finishStream();
        await account.settled((await second.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-assistant.is-done')).toHaveCount(2);

        // Changing the pool must not turn a retry into a different assistant.
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Miso', exact: true }).click();
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Taro', exact: true }).click();
        const reply = page.locator('.scratchpad-message.is-assistant').last();
        await reply.locator('summary[aria-label="Message actions"]').click();
        const retried = page.waitForResponse('**/api/scratchpad/send');
        await reply.getByRole('button', { name: 'Try again', exact: true }).click();
        const retry = await retried;
        expect(retry.ok()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('random-taro answers');
        expect(app.provider.calls.at(-1).model).toBe('random-taro');
        app.provider.calls.at(-1).finishStream();
        await account.settled((await retry.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-assistant.is-done')).toHaveCount(2);
        await expect(page.locator('.scratchpad-message.is-user')).toHaveCount(2);
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Taro', exact: true }).click();
        await page.locator('.scratchpad-random').click();
        await expect(page.locator('.scratchpad-send')).toHaveText('Ask 2');
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-random')).toBeHidden();
        await expect(page.locator('.scratchpad-send')).toHaveText('Send');
    });
}

/* eslint-disable playwright/no-conditional-in-test -- The shared phone and desktop checks use the matching iOS setup. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad keeps valid limits when fields are cleared and shows saved limits`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        if (phone) await applyIOSOnlyCss(page);
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        const replyLimit = page.locator('#scratchpad-max-tokens');
        const depth = page.locator('#scratchpad-depth');
        await expect(replyLimit).toHaveValue('32000');
        const initialDepth = await depth.inputValue();
        await replyLimit.fill('');
        await replyLimit.press('Tab');
        await expect(replyLimit).toHaveValue('32000');
        await depth.fill('');
        await depth.press('Tab');
        await expect(depth).toHaveValue(initialDepth);

        await depth.fill('999');
        await depth.press('Tab');
        await expect(depth).toHaveValue('200');
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.depth).toBe(200);
        await replyLimit.fill('2048');
        await replyLimit.press('Tab');
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.maxTokens).toBe(2048);

        await page.route('**/api/scratchpad/session/update', route => route.fulfill({ status: 503, json: { error: 'The settings could not be saved.' } }), { times: 1 });
        await replyLimit.fill('4096');
        await replyLimit.press('Tab');
        await expect(replyLimit).toHaveValue('2048');
        expect((await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].settings.maxTokens).toBe(2048);
        await page.close();
        const reopened = await account.open();
        await reopened.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await expect(reopened.locator('#scratchpad-max-tokens')).toHaveValue('2048');
        await expect(reopened.locator('#scratchpad-depth')).toHaveValue('200');
    });
}

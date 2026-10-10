/* global document */
/* eslint-disable playwright/no-standalone-expect -- Shared helpers verify the visible Scratchpad state. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function checkEmptyAssistant(page, name, title) {
    await expect(page.locator('.scratchpad-summary')).toContainText(title);
    await expect(page.locator('.scratchpad-empty')).toContainText(`Ask ${name} anything.`);
    const expected = await page.evaluate(async id => (await import('/scripts/neconyan-assistant-art.js')).getAssistantIconSrc(id), name.toLowerCase());
    await expect(page.locator('.scratchpad-empty img')).toHaveAttribute('src', expected);
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size} switches the whole empty Scratchpad identity and keeps a custom name`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        const picker = page.locator('.scratchpad-assistants');
        await page.locator('.scratchpad-composer').fill('Keep my unsent idea.');
        for (const name of ['Taro', 'Nori', 'Miso', 'Taro']) {
            await picker.getByRole('button', { name, exact: true }).click();
            await checkEmptyAssistant(page, name, `New session with ${name}`);
            await expect(page.locator('.scratchpad-composer')).toHaveValue('Keep my unsent idea.');
        }
        expect((await account.post('/api/scratchpad/bucket', { source })).bucket.sessions).toHaveLength(0);
        await page.screenshot({ path: `../screenshots/scratchpad-identity-${size}-after.png` });
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        await checkEmptyAssistant(page, 'Taro', "Taro's notes");
        await picker.getByRole('button', { name: 'Nori', exact: true }).click();
        await checkEmptyAssistant(page, 'Nori', "Nori's notes");
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket;
        await account.post('/api/scratchpad/session/update', { source, sessionId: saved.activeSessionId, changes: { name: 'My planning' } });
        await openScratchpad(page);
        await picker.getByRole('button', { name: 'Miso', exact: true }).click();
        await checkEmptyAssistant(page, 'Miso', 'My planning');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
    });
}

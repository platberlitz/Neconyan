/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} empty Scratchpad shows every selected portrait and updates gender choices`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        const portraits = page.locator('.scratchpad-empty-portraits img');
        await expect(portraits).toHaveCount(1);
        await page.locator('.scratchpad-round-table').click();
        await expect(portraits).toHaveCount(3);
        if (phone) await applyIOSOnlyCss(page);
        await expect.poll(() => portraits.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
        const positions = await portraits.evaluateAll(images => images.map(image => {
            const rect = image.getBoundingClientRect();
            return { name: image.alt, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
        expect(positions.map(image => image.name)).toEqual(['Miso', 'Taro', 'Nori']);
        expect(new Set(positions.map(image => image.y)).size).toBe(1);
        for (const image of positions) {
            expect(image.width).toBe(72);
            expect(image.height).toBe(72);
            expect(image.x).toBeGreaterThanOrEqual(0);
            expect(image.x + image.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.screenshot({ path: test.info().outputPath('selected-portraits.png') });
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Taro', exact: true }).click();
        await expect(portraits).toHaveCount(2);
        await expect(page.locator('.scratchpad-empty-portraits img[alt="Taro"]')).toHaveCount(0);
        await page.evaluate(async () => {
            const { setAssistantGender } = await import('/scripts/neconyan-assistant-art.js');
            setAssistantGender('miso', 'female');
            setAssistantGender('nori', 'male');
        });
        await expect(page.locator('.scratchpad-empty-portraits img[alt="Miso"]')).toHaveAttribute('src', /miso-female\.png/);
        await expect(page.locator('.scratchpad-empty-portraits img[alt="Nori"]')).toHaveAttribute('src', /nori-male\.png/);
        await page.locator('.scratchpad-round-table').click();
        await expect(portraits).toHaveCount(1);
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Taro', exact: true }).click();
        await expect(portraits).toHaveAttribute('alt', 'Taro');
        await expect(page.locator('.scratchpad-message')).toHaveCount(0);
        expect(app.provider.calls).toHaveLength(0);
    });
}

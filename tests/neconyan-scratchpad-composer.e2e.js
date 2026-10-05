/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad input stays one line high while writing and sending`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        if (phone) await applyIOSOnlyCss(page);
        const composer = page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true });
        await expect(composer).toBeEnabled();
        await expect(composer).toHaveAttribute('rows', '1');
        const measure = () => composer.evaluate(input => {
            const style = getComputedStyle(input);
            const lineHeight = parseFloat(style.lineHeight);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = style.font;
            const ink = canvas.measureText('First line.');
            const baseline = (lineHeight - ink.fontBoundingBoxAscent - ink.fontBoundingBoxDescent) / 2 + ink.fontBoundingBoxAscent;
            return {
                height: input.getBoundingClientRect().height,
                lines: (input.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / lineHeight,
                scrollHeight: input.scrollHeight,
                clientHeight: input.clientHeight,
                firstLineBottom: parseFloat(style.paddingTop) + baseline + ink.actualBoundingBoxDescent - input.scrollTop,
                resize: style.resize,
            };
        });
        const initial = await measure();
        expect(initial.height).toBeGreaterThanOrEqual(44);
        expect(initial.height).toBeLessThanOrEqual(48);
        expect(initial.lines).toBeGreaterThanOrEqual(0.99);
        expect(initial.lines).toBeLessThan(1.2);
        expect(initial.resize).toBe('none');
        const outputHeight = (await page.locator('.scratchpad-messages').boundingBox()).height;
        const longText = 'A longer question that wraps inside the compact input. '.repeat(20);
        await composer.fill(longText);
        const long = await measure();
        expect(long.height).toBe(initial.height);
        expect(long.scrollHeight).toBeGreaterThan(long.clientHeight);
        expect((await page.locator('.scratchpad-messages').boundingBox()).height).toBe(outputHeight);
        await page.locator('.scratchpad-quick').getByRole('button', { name: 'Plot ideas', exact: true }).click();
        await expect(composer).not.toHaveValue(longText);
        expect((await measure()).height).toBe(initial.height);
        await composer.fill('First line.');
        await composer.press('Shift+Enter');
        await page.keyboard.insertText('Second line.');
        await expect(composer).toHaveValue('First line.\nSecond line.');
        const multiline = await measure();
        expect(multiline.height).toBe(initial.height);
        expect(multiline.firstLineBottom, 'The preceding line of text must be outside the visible input').toBeLessThanOrEqual(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.screenshot({ path: test.info().outputPath('compact-composer.png') });
        app.provider.mode.streamReply = { first: 'Both lines arrived.', rest: ' The input stayed compact.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        expect(response.request().postDataJSON().text).toBe('First line.\nSecond line.');
        await expect(page.locator('.scratchpad-stream')).toContainText('Both lines arrived.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(composer).toHaveValue('');
        expect((await measure()).height).toBe(initial.height);
    });
}

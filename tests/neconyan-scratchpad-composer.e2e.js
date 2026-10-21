/* global document, getComputedStyle */
/* eslint-disable playwright/no-standalone-expect -- Shared checks cover every composer action state. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function expectIconButton(button, label, icon) {
    await expect(button).toHaveAccessibleName(label);
    await expect(button).toHaveAttribute('title', label);
    await expect(button).toHaveText('');
    await expect(button.locator(`i.${icon}`)).toHaveAttribute('aria-hidden', 'true');
    const box = await button.boundingBox();
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);
    const fits = await button.evaluate(element => {
        const box = element.getBoundingClientRect();
        const icon = element.querySelector('i').getBoundingClientRect();
        return icon.left >= box.left && icon.right <= box.right && icon.top >= box.top && icon.bottom <= box.bottom;
    });
    expect(fits, 'The icon fits inside its button').toBe(true);
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad input starts one line high and grows with the message`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        if (phone) await applyIOSOnlyCss(page);
        const composer = page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true });
        const send = page.locator('.scratchpad-send');
        await expect(composer).toBeEnabled();
        await expectIconButton(send, 'Send', 'fa-paper-plane');
        await expect(composer).toHaveAttribute('rows', '1');
        const measure = () => composer.evaluate(input => {
            const style = getComputedStyle(input);
            const lineHeight = parseFloat(style.lineHeight);
            return {
                height: input.getBoundingClientRect().height,
                lineHeight,
                lines: (input.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / lineHeight,
                scrollHeight: input.scrollHeight,
                clientHeight: input.clientHeight,
                maxHeight: parseFloat(style.maxHeight),
                resize: style.resize,
            };
        });
        const initial = await measure();
        expect(initial.height).toBeGreaterThanOrEqual(44);
        expect(initial.height).toBeLessThanOrEqual(48);
        expect(initial.lines).toBeGreaterThanOrEqual(0.99);
        expect(initial.lines).toBeLessThan(1.2);
        expect(initial.resize).toBe('none');

        await composer.fill('First line.');
        await composer.press('Shift+Enter');
        await page.keyboard.insertText('Second line.');
        await expect(composer).toHaveValue('First line.\nSecond line.');
        const multiline = await measure();
        expect(multiline.height, 'A second line makes the input taller').toBeCloseTo(initial.height + initial.lineHeight, 0);
        expect(multiline.scrollHeight, 'Both lines are visible without scrolling').toBeLessThanOrEqual(multiline.clientHeight);

        const longText = 'A longer question that wraps inside the input. '.repeat(20);
        await composer.fill(longText);
        const long = await measure();
        expect(long.height).toBeGreaterThan(multiline.height);
        expect(long.height).toBeLessThanOrEqual(long.maxHeight + 0.5);
        expect(long.scrollHeight).toBeGreaterThan(long.clientHeight);
        expect((await page.locator('.scratchpad-messages').boundingBox()).height, 'The reply area keeps room').toBeGreaterThan(80);

        await composer.fill('');
        expect((await measure()).height).toBe(initial.height);
        await page.locator('.scratchpad-quick').getByRole('button', { name: 'Plot ideas', exact: true }).click();
        await expect(composer).not.toHaveValue('');
        const prompt = await measure();
        expect(prompt.scrollHeight, 'A quick prompt fits the input it fills').toBeLessThanOrEqual(prompt.clientHeight);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);

        await composer.fill('First line.\nSecond line.');
        await page.screenshot({ path: test.info().outputPath('growing-composer.png') });
        app.provider.mode.streamReply = { first: 'Both lines arrived.', rest: ' The input shrank back.' };
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.route('**/api/scratchpad/send', async route => { await held; await route.continue(); });
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await send.click();
        try {
            await expectIconButton(send, 'Sending...', 'fa-paper-plane');
            await expect(send).toBeDisabled();
        } finally { release(); }
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        expect(response.request().postDataJSON().text).toBe('First line.\nSecond line.');
        await expect(page.locator('.scratchpad-stream')).toContainText('Both lines arrived.');
        await expectIconButton(send, 'Stop', 'fa-stop');
        await expect(send).toBeEnabled();
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(composer).toHaveValue('');
        await expectIconButton(send, 'Send', 'fa-paper-plane');
        expect((await measure()).height).toBe(initial.height);
    });
}

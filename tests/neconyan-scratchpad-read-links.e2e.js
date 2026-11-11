/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const REFUSED = 'This address is private, local or not allowed, so it was not read.';

async function openScratchpad(page, phone) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    if (phone) await applyIOSOnlyCss(page);
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} reads links only when asked and shows which pages were read`, async ({ app }) => {
        test.setTimeout(240000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        await openScratchpad(page, phone);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();

        const toggle = page.locator('.scratchpad-read-links');
        await page.locator('.scratchpad-plus').click();
        await expect(toggle).toHaveText('Read links');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(toggle).toHaveAttribute('title', 'Read the web pages linked in this message');
        const saving = page.waitForResponse('**/api/scratchpad/session/update');
        await toggle.click();
        expect((await saving).ok()).toBe(true);
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.scratchpad-plus')).toHaveClass(/menu_button_primary/);
        await expect(page.locator('.toast-info')).toContainText('up to 3 web pages');
        await page.evaluate(() => window.toastr?.remove());
        await page.locator('.scratchpad-plus').click();
        await expect(toggle).toBeVisible();
        const box = await toggle.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: `../screenshots/scratchpad-read-links/${size}-toggle.png`, scale: 'css' });

        const measurements = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            if (phone) await applyIOSOnlyCss(page);
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await settleCssTransitions(page);
                const contrast = await toggle.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const canvas = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        canvas.clearRect(0, 0, 1, 1);
                        canvas.fillStyle = colour;
                        canvas.fillRect(0, 0, 1, 1);
                        return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(element).backgroundColor));
                });
                measurements.push({ theme, accent, contrast });
                expect(contrast, JSON.stringify(measurements)).toBeGreaterThanOrEqual(4.5);
            }
        }
        await page.evaluate(() => window.toastr?.remove());
        if (await toggle.isVisible()) await page.locator('.scratchpad-plus').click();
        await expect(toggle).toBeHidden();

        const question = 'Summarise http://127.0.0.1:9/guide for me.';
        app.provider.mode.reply = { choices: [{ message: { content: 'I could not read that page, so I cannot summarise it.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
        expect(calls).toHaveLength(1);
        const block = calls[0].messages.find(message => String(message.content).startsWith('<web_pages>'));
        expect(block.content).toContain('URL: http://127.0.0.1:9/guide');
        expect(block.content).toContain(`Not read: ${REFUSED}`);

        const pages = page.locator('.scratchpad-web-pages');
        await expect(pages.locator('summary')).toHaveText('Linked pages');
        await expect(pages).toHaveAttribute('open', '');
        await expect(pages.locator('.scratchpad-web-error')).toHaveText(`Not read: ${REFUSED}`);
        await pages.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-read-links/${size}-not-read.png`, scale: 'css' });

        // The test server cannot reach a public page, so a read page is written into the saved session to check how it is shown.
        const folder = path.join(app.dataRoot, 'default-user', 'scratchpad');
        let changed = 0;
        for (const name of await fs.readdir(folder)) {
            const file = path.join(folder, name);
            const text = await fs.readFile(file, 'utf8');
            if (!text.includes('I could not read that page')) continue;
            const bucket = JSON.parse(text);
            for (const session of bucket.sessions) {
                for (const message of session.messages) {
                    if (!message.webPages) continue;
                    message.webPages = [{ url: 'https://example.org/guide', title: 'The harbour guide' }, ...message.webPages];
                    changed += 1;
                }
            }
            await fs.writeFile(file, JSON.stringify(bucket));
        }
        expect(changed).toBe(1);
        await page.close();
        page = await account.open();
        await openScratchpad(page, phone);
        await page.locator('.scratchpad-plus').click();
        await expect(page.locator('.scratchpad-read-links')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('.scratchpad-plus').click();
        const shown = page.locator('.scratchpad-web-pages');
        await expect(shown.locator('summary')).toHaveText('Pages read (1)');
        const link = shown.locator('.scratchpad-web-source-list a').first();
        await expect(link).toHaveText('The harbour guide');
        await expect(link).toHaveAttribute('href', 'https://example.org/guide');
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(shown.locator('.scratchpad-web-error')).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await shown.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.toastr?.remove());
        await page.screenshot({ path: `../screenshots/scratchpad-read-links/${size}-pages-read.png`, scale: 'css' });
    });
}

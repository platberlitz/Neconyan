/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- The phone and desktop checks share one script. */
import path from 'node:path';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';


async function scrollPreviewTo(preview, marker) {
    await preview.evaluate((element, marker) => {
        const node = element.firstChild;
        const index = node?.textContent?.indexOf(marker) ?? -1;
        if (!node || index < 0) return;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + marker.length);
        element.scrollTop += range.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
    }, marker);
}

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} shows fixed problem findings and enables the check switch from a quick prompt`, async ({ app }) => {
        test.setTimeout(150000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        const created = await account.context.request.post('/api/characters/create', {
            headers: account.headers,
            data: { ch_name: `Problem Card ${size}`, description: 'A card with a missing greeting.', first_mes: '' },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const avatar = await created.text();
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, avatar);
        await openScratchpad(page);
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        expect(source.kind).toBe('roleplay');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        if (phone) await applyIOSOnlyCss(page);
        const checks = page.getByRole('checkbox', { name: /^Problem checks/ });
        await expect(checks).not.toBeChecked();
        const previewButton = page.getByRole('button', { name: 'Show preview', exact: true });
        const preview = page.locator('pre.scratchpad-preview-text');
        await previewButton.click();
        await expect(preview).not.toContainText('## Checks');
        await expect(preview).not.toContainText('## Preset values');

        await checks.check();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.include.problems).toBe(true);
        await previewButton.click();
        await expect(preview).toContainText('## Checks');
        await expect(preview).toContainText(`- error | Character: Problem Card ${size} | first_mes | There is no first message`);
        await expect(preview).not.toContainText('## Preset values (read only)');

        const row = checks.locator('..');
        await row.scrollIntoViewIfNeeded();
        const box = await row.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
            fs.mkdirSync(path.join('..', 'screenshots', 'scratchpad-problem-checks'), { recursive: true });
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: path.join('..', 'screenshots', 'scratchpad-problem-checks', `${size}-context.png`) });
            await preview.scrollIntoViewIfNeeded();
            await scrollPreviewTo(preview, '## Checks');
            await page.screenshot({ path: path.join('..', 'screenshots', 'scratchpad-problem-checks', `${size}-preview.png`) });
        }

        // One tap on a check prompt turns both switches on and fills the request.
        await checks.uncheck();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.include.problems).toBe(false);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const prompt = page.getByRole('button', { name: 'Check my card', exact: true });
        await expect(prompt).toBeVisible();
        await prompt.click();
        await expect(page.locator('.scratchpad-composer')).toHaveValue(/^Check the shared character card for problems/);
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.include.problems).toBe(true);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(checks).toBeChecked();
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            await page.locator('.scratchpad-quick').evaluate(element => { element.scrollLeft = element.scrollWidth; });
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.activeElement?.blur());
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: path.join('..', 'screenshots', 'scratchpad-problem-checks', `${size}-quick-prompts.png`) });
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
    });
}

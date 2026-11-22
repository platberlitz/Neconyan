/* global document, getComputedStyle, window */
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
        test.setTimeout(180000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.post('/api/worldinfo/edit', { name: 'Prompt Harbour', data: { entries: {
            0: { uid: 0, comment: 'Quay', key: ['quay'], constant: true, content: 'The quay is open.' },
        } } });
        const page = await account.open({ workspace: false });

        // General Scratchpad offers only the checks that apply there.
        await openScratchpad(page);
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        const prompt = name => page.getByRole('button', { name, exact: true });
        await expect(prompt('Check my preset')).toHaveCount(0);
        await expect(prompt('Check my lorebook')).toHaveCount(0);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        if (phone) await applyIOSOnlyCss(page);
        const generalSource = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        await page.getByRole('checkbox', { name: /^Current preset:/ }).check();
        await page.locator('#scratchpad-lorebook').selectOption('Prompt Harbour');
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source: generalSource })).bucket.sessions[0]?.settings.lorebook).toBe('Prompt Harbour');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(prompt('Check my preset')).toBeVisible();
        await expect(prompt('Check my lorebook')).toBeVisible();
        await prompt('Check my lorebook').click();
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on Problem checks for this session.' }).first()).toBeVisible();
        await expect(page.locator('.scratchpad-composer')).toHaveValue('Check the shared lorebook for problems and explain how to fix them.');
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
            fs.mkdirSync(path.join('..', 'screenshots', 'scratchpad-problem-checks'), { recursive: true });
            await page.locator('.scratchpad-quick').evaluate(element => { element.scrollLeft = element.scrollWidth; });
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.activeElement?.blur());
            await page.screenshot({ path: path.join('..', 'screenshots', 'scratchpad-problem-checks', `${size}-general-quick-prompts.png`) });
        }
        await page.evaluate(() => window.toastr.clear());
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());

        // A card that defines an id in its own HTML can use that id in its CSS.
        const created = await account.context.request.post('/api/characters/create', {
            headers: account.headers,
            data: {
                ch_name: `Problem Card ${size}`,
                description: 'A card for checking.',
                first_mes: '<div id="color-probe">Colour probe.</div><style>#color-probe { color: rgb(12, 34, 56); }</style>',
                mes_example: 'Ada: hello',
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const avatar = await created.text();
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, avatar);
        const probe = page.locator('.mes_text #color-probe');
        await expect(probe).toBeVisible();
        const colour = await probe.evaluate(element => getComputedStyle(element).color);
        expect(colour).toBe('rgb(12, 34, 56)');
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
        await expect(preview).toContainText(`- warning | Character: Problem Card ${size} | mes_example | Example messages should begin with a <START> block.`);
        await expect(preview).not.toContainText('CSS selector #color-probe');
        await expect(preview).not.toContainText('## Preset values (read only)');

        const row = checks.locator('..');
        await row.scrollIntoViewIfNeeded();
        const box = await row.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
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
        const cardPrompt = prompt('Check my card');
        await expect(cardPrompt).toBeVisible();
        await cardPrompt.click();
        await expect(page.locator('.scratchpad-composer')).toHaveValue('Check the shared card for problems and explain how to fix them.');
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on Problem checks for this session.' }).first()).toBeVisible();
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

/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Before captures and both viewport sizes share the same setup. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad previews and sends server-read Mewmory only when shared`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes)).toBe('Hello.');
        const locator = await page.evaluate(async () => (await import('/scripts/mewmory/index.js')).getMewmoryLocator());
        let archive = await account.post('/api/mewmory/inspect', { locator });
        const ref = archive.sources.find(source => source.type === 'chat' && source.eligible);
        expect(ref).toBeTruthy();
        for (const [id, text, excluded] of [['ferry', 'The ferry leaves at dusk. MEMORY-FERRY', false], ['secret', 'EXCLUDED-MEMORY', true]]) {
            archive = await account.post('/api/mewmory/record/save', { locator, revision: archive.revision,
                record: { id, kind: 'event', text, refs: [{ id: ref.id, revision: ref.revision }], excluded },
            });
        }
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        if (phone) await applyIOSOnlyCss(page);
        const section = page.locator('.scratchpad-section').filter({ has: page.getByRole('heading', { name: 'Also share', exact: true }) });
        const checkbox = section.locator('label.scratchpad-check').filter({ hasText: 'Reads saved memories from this Roleplay chat' }).locator('input');
        // Context refreshes once its saved connection and note choices arrive.
        await expect(async () => { await section.scrollIntoViewIfNeeded(); }).toPass({ timeout: 10000 });
        await page.evaluate(() => window.toastr.remove());
        const prefix = `../screenshots/scratchpad-mewmory/${phone ? 'phone' : 'desktop'}`;
        if (before) {
            await expect(checkbox).toHaveCount(0);
            await page.screenshot({ path: `${prefix}-before.png` });
            return;
        }
        await expect(checkbox).not.toBeChecked();
        const updated = page.waitForResponse('**/api/scratchpad/session/update');
        await checkbox.check();
        expect((await updated).ok()).toBe(true);
        const row = checkbox.locator('..');
        await expect(async () => { await row.scrollIntoViewIfNeeded(); }).toPass({ timeout: 10000 });
        const bounds = await row.boundingBox();
        expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: `${prefix}-after.png` });
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('.scratchpad-preview-text');
        await expect(preview).toContainText('MEMORY-FERRY');
        await expect(preview).not.toContainText('EXCLUDED-MEMORY');
        await expect(page.locator('.scratchpad-preview')).toContainText('Mewmory records shared: 1. Left out to fit: 0.');
        const previewText = await preview.textContent();
        const memoryText = previewText.slice(previewText.indexOf('<mewmory_context>'));
        await preview.scrollIntoViewIfNeeded();
        await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.screenshot({ path: `${prefix}-preview.png` });
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const question = 'When does the ferry leave?';
        app.provider.mode.reply = { choices: [{ message: { content: 'At dusk, according to the saved memory.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await sent;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const call = app.provider.calls.find(call => call.messages?.at(-1)?.content === question);
        expect(call.messages.find(message => String(message.content).startsWith('<mewmory_context>')).content).toBe(memoryText);
        expect(JSON.stringify(call.messages)).not.toContain('EXCLUDED-MEMORY');
        await expect(page.locator('.scratchpad-message.is-assistant')).toContainText('At dusk');
        await page.screenshot({ path: `${prefix}-reply.png` });
        const after = await account.post('/api/mewmory/inspect', { locator });
        expect(after.revision).toBe(archive.revision);
        expect(after.records).toEqual(archive.records);

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const off = page.waitForResponse('**/api/scratchpad/session/update');
        await checkbox.uncheck();
        expect((await off).ok()).toBe(true);
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        await expect(preview).not.toContainText('MEMORY-FERRY');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
}

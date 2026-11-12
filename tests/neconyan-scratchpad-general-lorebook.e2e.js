/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const REFUSAL = 'Share that lorebook under Context before saving a change to it.';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} General Scratchpad shares one hand-picked lorebook for that session only`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.post('/api/worldinfo/edit', { name: 'Harbour', data: { entries: {
            0: { uid: 0, comment: 'Ferry', key: ['ferry'], constant: true, content: 'The ferry leaves at dawn.' },
            1: { uid: 1, comment: 'Vault', key: ['vault'], constant: true, agentBlacklisted: true, content: 'The hidden vault is under the pier.' },
        } } });
        await account.post('/api/worldinfo/edit', { name: 'Garden', data: { entries: {
            0: { uid: 0, comment: 'Roses', key: ['roses'], constant: true, content: 'The roses are white.' },
        } } });

        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        expect(source.kind).toBe('general');
        const changes = [
            { type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'The roses are red.' },
            { type: 'lorebook', action: 'edit', book: 'Harbour', uid: 0, content: 'The ferry leaves at dusk.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Lore edits', messages: [{ role: 'assistant',
            text: 'Intro.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);

        const shots = name => path.resolve('../screenshots/scratchpad-general-lorebook', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });
        const clearToasts = async () => {
            await page.evaluate(() => window.toastr.clear());
            await expect(toasts.locator('.toast')).toHaveCount(0);
        };
        const tab = name => page.getByRole('tab', { name, exact: true });
        await expect(cards).toHaveCount(2);

        await review(1).click();
        await expect(toasts).toContainText(REFUSAL);
        await expect(dialog).toHaveCount(0);
        await clearToasts();

        await tab('Context').click();
        const picker = page.locator('#scratchpad-lorebook');
        await expect(picker).toHaveValue('');
        await expect(page.getByText('Shared in this session only. Entries hidden from assistants stay hidden.')).toBeVisible();
        await expect(page.getByRole('checkbox', { name: 'Lorebook entries', exact: true })).toHaveCount(0);
        await picker.scrollIntoViewIfNeeded();
        const box = await picker.boundingBox();
        if (phone) expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        const updated = page.waitForResponse('**/api/scratchpad/session/update');
        await picker.selectOption('Harbour');
        expect((await updated).ok()).toBe(true);
        await expect(page.locator('#scratchpad-lorebook')).toHaveValue('Harbour');
        await page.locator('#scratchpad-lorebook').scrollIntoViewIfNeeded();
        await page.screenshot({ path: shots('context') });

        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('pre.scratchpad-preview-text');
        await expect(preview).toContainText('Lorebook shared by hand for this session: Harbour');
        await expect(preview).toContainText('The ferry leaves at dawn.');
        await expect(preview).not.toContainText('hidden vault');
        await expect(preview).not.toContainText('roses');
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();

        await tab('Chat').click();
        await review(0).click();
        await expect(toasts).toContainText(REFUSAL);
        await expect(dialog).toHaveCount(0);
        await clearToasts();

        await review(1).click();
        await expect(dialog).toContainText('Harbour');
        const dialogBox = await dialog.boundingBox();
        expect(dialogBox.x).toBeGreaterThanOrEqual(0);
        expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: shots('review') });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(1)).toContainText('Saved');
        await expect(cards.nth(0)).not.toContainText('Saved');
        const harbour = (await account.post('/api/worldinfo/get', { name: 'Harbour' })).entries;
        expect(harbour[0].content).toBe('The ferry leaves at dusk.');
        expect(harbour[1].content).toBe('The hidden vault is under the pier.');
        expect((await account.post('/api/worldinfo/get', { name: 'Garden' })).entries[0].content).toBe('The roses are white.');
        await clearToasts();
        await page.screenshot({ path: shots('saved') });

        const question = 'When does the ferry leave?';
        app.provider.mode.reply = { choices: [{ message: { content: 'At dusk.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
        expect(calls).toHaveLength(1);
        const sent = calls[0].messages.map(message => String(message.content)).join('\n');
        expect(sent).toContain('Lorebook entries (only');
        expect(sent).toContain('shared one lorebook by hand');
        expect(sent).toContain('The ferry leaves at dusk.');
        expect(sent).not.toContain('hidden vault');
        expect(sent).not.toContain('roses');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        const created = page.waitForResponse('**/api/scratchpad/session/create');
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        expect((await created).ok()).toBe(true);
        await tab('Context').click();
        await expect(page.locator('#scratchpad-lorebook')).toHaveValue('');
    });
}

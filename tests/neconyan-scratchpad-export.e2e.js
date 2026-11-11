import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const session = {
    name: 'Tea notes',
    assistant: 'miso',
    gender: 'male',
    settings: {},
    messages: [
        { role: 'user', text: 'Where does tea come from?', created: 1, attachments: [{ name: 'notes.txt', size: 14, kind: 'text', mimeType: 'text/plain', text: 'Leaf notes ATTACHED-TEXT.' }] },
        {
            role: 'assistant', text: 'Tea comes from a shrub [1].', created: 2, assistant: 'miso', assistantName: 'Miso', gender: 'male', reasoning: 'THINKING-TEXT about shrubs.',
            webSearch: { provider: 'brave', query: 'tea origin', sources: [{ title: 'Tea history', url: 'https://example.com/tea' }] },
        },
    ],
};

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad export offers a file type and optional extras`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async tab => {
            await page.evaluate(async name => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: name }), tab);
            if (phone) await applyIOSOnlyCss(page);
        };
        const prefix = `../screenshots/scratchpad-export/${phone ? 'phone' : 'desktop'}`;
        const dialog = page.locator('dialog[open]').filter({ hasText: 'Export this session' });
        const exportWith = async (prepare = async () => {}) => {
            await page.getByRole('button', { name: 'Export current', exact: true }).click();
            await expect(dialog).toBeVisible();
            await prepare();
            const download = page.waitForEvent('download');
            await dialog.getByRole('button', { name: 'Export', exact: true }).click();
            const file = await download;
            await expect(dialog).toHaveCount(0);
            return { name: file.suggestedFilename(), text: await fs.readFile(await file.path(), 'utf8') };
        };

        await open('sessions');
        const created = page.waitForResponse('**/api/scratchpad/session/create');
        await page.getByRole('button', { name: 'New session', exact: true }).click();
        const { source } = (await created).request().postDataJSON();
        await account.post('/api/scratchpad/session/import', { source, session });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await open('sessions');
        await expect(page.locator('.scratchpad-session').filter({ hasText: 'Tea notes' })).toHaveCount(1);

        // Cancelling downloads nothing; the dialog fits the screen and its choices are easy to press.
        await page.getByRole('button', { name: 'Export current', exact: true }).click();
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('input[type="radio"]').first()).toBeChecked();
        await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(0);
        for (const box of await dialog.locator('.scratchpad-check').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))) {
            expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 24);
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        }
        await page.screenshot({ path: `${prefix}-dialog.png` });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog).toHaveCount(0);

        // With nothing ticked the file is the same text-only export as before.
        const plain = await exportWith();
        expect(plain.name).toBe('Tea_notes.json');
        const plainMessages = JSON.parse(plain.text).session.messages;
        expect(plainMessages.map(item => item.text)).toEqual(session.messages.map(item => item.text));
        expect(plain.text).not.toMatch(/ATTACHED-TEXT|THINKING-TEXT|example\.com/);

        const full = await exportWith(async () => {
            for (const name of ['reasoning', 'sources', 'attachments']) await dialog.locator(`input[name="scratchpad-export-${name}"]`).check();
            await page.screenshot({ path: `${prefix}-extras.png` });
        });
        const [user, reply] = JSON.parse(full.text).session.messages;
        expect(user.attachments[0]).toMatchObject({ name: 'notes.txt', text: 'Leaf notes ATTACHED-TEXT.' });
        expect(reply.reasoning).toBe('THINKING-TEXT about shrubs.');
        expect(reply.webSearch).toEqual({ provider: 'brave', query: 'tea origin', sources: [{ title: 'Tea history', url: 'https://example.com/tea' }] });

        const markdown = await exportWith(async () => {
            await dialog.locator('input[type="radio"]').nth(1).check();
            await dialog.locator('input[name="scratchpad-export-sources"]').check();
        });
        expect(markdown.name).toBe('Tea_notes.md');
        expect(markdown.text).toContain('# Tea notes\n\n## You\n\nWhere does tea come from?\n\n*Attached: notes.txt*\n\n## Miso\n\nTea comes from a shrub [1].');
        expect(markdown.text).toContain('**Sources** (Search query: tea origin)\n\n1. [Tea history](<https://example.com/tea>)');
        expect(markdown.text).not.toMatch(/ATTACHED-TEXT|THINKING-TEXT/);

        // The full file imports again through the app, and its sources say they were not searched here.
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Import', exact: true }).click();
        const imported = page.waitForResponse('**/api/scratchpad/session/import');
        await (await chooser).setFiles({ name: 'Tea_notes.json', mimeType: 'application/json', buffer: Buffer.from(full.text) });
        const result = await imported;
        expect(result.ok(), await result.text()).toBe(true);
        const note = page.locator('.scratchpad-web-imported');
        await expect(note).toHaveText('These sources came with an imported file. Scratchpad did not run this search here.');
        await expect(page.locator('.scratchpad-message.is-assistant').last()).toContainText('Tea history');
        await page.locator('.scratchpad-web-sources > summary').last().click();
        await expect(note).toBeVisible();
        await note.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-imported.png` });
    });
}

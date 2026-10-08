/* eslint-env browser */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
test.skip(process.env.NECONYAN_TERMUX_IMPORT_RECOVERY_TEST !== '1', 'Opt in to the disposable Termux recovery preload test.');

for (const phone of [false, true]) {
    test(`Termux ZIP import survives write, rename and restart on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, readyTimeout: 60000, timeout: 60000 });
        await page.waitForFunction(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            return eventSource.autoFireLastArgs.has(event_types.APP_READY);
        });
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        const categories = page.locator('.sb-settings-category-select');
        if (await categories.isVisible()) await categories.selectOption('system-device');
        else await page.locator('.sb-settings-tab-btn[data-tab="system-device"]').click();
        if (!await page.locator('#sb-import-path-input').isVisible()) {
            await page.locator('#SillyTavernImportSection .inline-drawer-toggle').first().click();
        }
        const card = page.locator('#sb-import-card');
        const archive = archiver('zip'); const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.append('Imported under stable Termux file identity.', { name: 'default-user/user/files/termux.txt' });
        // A report keeps the completed import visible until the user reloads.
        archive.append('{}', { name: 'default-user/settings.json' });
        await archive.finalize();
        const uploads = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/operations/import-input')) uploads.push(request);
        });
        page.on('dialog', dialog => dialog.accept());
        await card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({
            name: 'default-user.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks),
        });
        const note = card.locator('.sb-import-note');
        await expect(note).toContainText('Backup ZIP imported.', { timeout: 60000 });
        await expect(note).not.toContainText('could not be imported');
        expect(uploads).toHaveLength(1);
        const response = await uploads[0].response();
        expect(response.ok()).toBe(true);
        const uploadKey = uploads[0].postDataBuffer().toString().match(/name="key"\r\n\r\n([^\r]+)/)[1];
        const receipt = await response.json();
        const contents = path.join(app.directory, 'data/default-user/user/files/termux.txt');
        expect(await fs.readFile(contents, 'utf8')).toBe('Imported under stable Termux file identity.');
        await note.scrollIntoViewIfNeeded();
        const screenshot = path.resolve('..', 'screenshots', `termux-import-${phone ? 'phone' : 'desktop'}.png`);
        await fs.mkdir(path.dirname(screenshot), { recursive: true });
        await page.screenshot({ path: screenshot });
        await test.info().attach('Termux import result', { path: screenshot, contentType: 'image/png' });
        await page.close();
        await app.restart();
        const retained = await account.context.request.get(`/api/operations/import-input/${uploadKey}`, { headers: account.headers });
        expect(retained.ok()).toBe(true);
        expect(await retained.json()).toEqual(receipt);
        expect(await fs.readFile(contents, 'utf8')).toBe('Imported under stable Termux file identity.');
        if (process.env.TERMUX_VERSION === 'timestamp-fixture') {
            expect(app.serverOutput).toContain('Termux file creation times are unavailable');
        }
    });
}

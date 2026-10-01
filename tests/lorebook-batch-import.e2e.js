/* eslint-env browser */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} batch imports JSON lorebooks through the real file picker and preserves refused replacements`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false, readyTimeout: 60000, timeout: 60000 });
        await page.waitForFunction(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            return eventSource.autoFireLastArgs.has(event_types.APP_READY);
        });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
        const button = page.locator('#world_batch_import_embedded');
        await expect(button).toBeVisible();
        const actions = await page.evaluate(() => ['world_create_button', 'world_import_button', 'world_batch_import_embedded'].map(id => {
            const action = document.getElementById(id);
            const rect = action.getBoundingClientRect();
            return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), cat: action.classList.contains('neconyan-cat-control') };
        }));
        expect(actions.every(action => action.cat)).toBe(true);
        expect(new Set(actions.map(action => `${action.width}x${action.height}`)).size).toBe(1);
        expect(new Set(actions.map(action => phone ? action.x : action.y)).size).toBe(1);
        expect(await page.locator('#world_import_file').getAttribute('multiple')).not.toBeNull();
        const native = { entries: { 0: { uid: 0, key: ['Harbour'], content: 'The harbour is safe.', extensions: { foreign: true } } }, extensions: { foreign: 'retained' } };
        const card = { spec: 'lorebook_v3', data: { name: 'Card JSON', entries: [{ id: 4, keys: ['Mountain'], content: 'The mountain is quiet.', extensions: { foreign: true } }] } };
        const file = (name, data) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
        await button.click();
        const choice = page.locator('dialog.popup[open]').last();
        await expect(choice).toContainText('Choose lorebook files');
        await expect(choice.getByText('Character cards', { exact: true })).toBeVisible();
        const choosing = page.waitForEvent('filechooser');
        await choice.getByText('Lorebook files', { exact: true }).click();
        const chooser = await choosing;
        expect(chooser.isMultiple()).toBe(true);
        await chooser.setFiles([file('Harbour.json', native), { name: '<Broken>.json', mimeType: 'application/json', buffer: Buffer.from('not JSON') }, file('Mountain.json', card)]);
        const summary = page.locator('dialog.popup[open]').last();
        await expect(summary).toContainText('2 imported, 0 skipped, 1 failed.');
        await expect(summary).toContainText('<Broken>.json: Error parsing file');
        await expect(summary.locator('broken')).toHaveCount(0);
        const geometry = await summary.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
            right: element.getBoundingClientRect().right, viewport: window.innerWidth, display: getComputedStyle(element).display }));
        expect(geometry.display).not.toBe('none');
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        await test.info().attach(`${phone ? 'phone' : 'desktop'}-lorebook-batch-summary`, { body: await page.screenshot(), contentType: 'image/png' });
        await summary.locator('.popup-button-ok').click();
        expect(await account.post('/api/worldinfo/get', { name: 'Harbour' })).toEqual(native);
        const installed = await account.post('/api/worldinfo/get', { name: 'Mountain' });
        expect(Object.values(installed.entries)[0].content).toBe('The mountain is quiet.');
        expect(installed.originalData.entries[0].extensions).toEqual({ foreign: true });
        await expect(page.locator('#world_import_file')).toBeEnabled();
        await expect(page.locator('#world_import_file')).toHaveValue('');

        // Importing opens the last imported book, so return to the library like a person would.
        await expect(page.locator('#neconyan-lorebook-library')).toHaveAttribute('data-view', 'book');
        await page.locator('.neconyan-lorebook-back').click();
        await expect(page.locator('#world_import_button')).toBeVisible();

        // The ordinary Import button accepts multiple files too, and a declined overwrite does not stop the batch.
        const again = page.waitForEvent('filechooser');
        await page.locator('#world_import_button').click();
        await (await again).setFiles([file('Harbour.json', { entries: {} }), file('After refusal.json', native)]);
        const overwrite = page.locator('dialog.popup[open]').last();
        await expect(overwrite).toContainText('Do you want to overwrite it?');
        await overwrite.locator('.popup-button-cancel').click();
        await expect(summary).toContainText('1 imported, 1 skipped, 0 failed.');
        await expect(summary).toContainText('The existing lorebook was kept.');
        await summary.locator('.popup-button-ok').click();
        expect(await account.post('/api/worldinfo/get', { name: 'Harbour' })).toEqual(native);
        expect(await account.post('/api/worldinfo/get', { name: 'After refusal' })).toEqual(native);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
        await expect(page.getByRole('button', { name: 'Open Harbour', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open Mountain', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open After refusal', exact: true })).toBeVisible();
    });
}

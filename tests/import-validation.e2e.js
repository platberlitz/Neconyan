import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test('invalid preset files report errors, clear the picker and allow a corrected retry', async ({ page }) => {
    test.setTimeout(120000);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    const input = page.locator('[data-preset-manager-file="context"]');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let writes = 0;
    await page.route('**/api/presets/save', async route => {
        writes++;
        const { name } = route.request().postDataJSON();
        await route.fulfill({ json: { name } });
    });
    for (const bytes of ['{"broken":', 'null', '[]', '{"name":42}']) {
        await input.setInputFiles({ name: 'Retry.json', mimeType: 'application/json', buffer: Buffer.from(bytes) });
        await expect(page.getByText('Could not import this preset. Check the JSON file and the server connection, then try again.', { exact: true }).first()).toBeVisible();
        await expect(input).toHaveValue('');
    }
    expect(writes).toBe(0);
    const saved = page.waitForResponse('**/api/presets/save');
    await input.setInputFiles({ name: 'Retry.json', mimeType: 'application/json', buffer: Buffer.from('\uFEFF{"name":"Retry","story_string":"{{description}}"}') });
    expect((await saved).ok()).toBe(true);
    await expect(page.getByText('Template imported', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
    expect(writes).toBe(1);
    expect(errors).toEqual([]);

    const master = page.locator('#af_master_import_file');
    await master.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
    await expect(page.getByText('Could not import these templates. Check the JSON file and the server connection, then try again.', { exact: true })).toBeVisible();
    await expect(master).toHaveValue('');
});

import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Creator retries its first load and groups typing undo on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        let failed = false;
        await page.route('**/api/creator/list', async route => {
            if (!failed) {
                failed = true;
                await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary test failure' }) });
            } else await route.continue();
        });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        await expect.poll(() => failed).toBe(true);
        await page.locator('#toast-container .toast-error').filter({ hasText: 'Creator could not open' }).click();
        await page.locator('#sb_character_tab_persona').click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        const description = creator.getByLabel('Description', { exact: true });
        await description.pressSequentially('A shipwright with silver hair.', { delay: 10 });
        await creator.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(description).toHaveValue('');
        await creator.getByRole('button', { name: 'Interview', exact: true }).click();
        await expect(creator.getByRole('button', { name: 'Ask Miso', exact: true })).toBeVisible();
        await expect(creator.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
        await creator.getByRole('button', { name: 'Redo', exact: true }).click();
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await expect(description).toHaveValue('A shipwright with silver hair.');
        await page.screenshot({ path: `../screenshots/creator-audit-${phone ? 'phone' : 'desktop'}.png` });
    });
}

/* global globalThis */
import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Catelier writes an editable image prompt on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByLabel('Display name', { exact: true }).fill('Mira');
        await creator.getByLabel('Description', { exact: true }).fill('Silver hair, green eyes, blue coat.');
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        await creator.getByLabel('Image prompt guidelines (optional)', { exact: true }).fill('Watercolour, soft morning light.');
        const result = 'Watercolour portrait of Mira, silver hair, green eyes, blue coat, soft morning light.';
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: result } }] };
        await creator.getByRole('button', { name: 'Generate image prompt', exact: true }).click();
        await expect(creator.getByLabel('Portrait prompt', { exact: true })).toHaveValue(result);
        expect(app.provider.calls.some(call => call.messages?.some(message => message.content?.includes('Watercolour, soft morning light.') && message.content?.includes('Silver hair')))).toBe(true);
        await creator.getByLabel('Portrait prompt', { exact: true }).fill(`${result} Close-up.`);
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        await expect(creator.getByLabel('Portrait prompt', { exact: true })).toHaveValue(`${result} Close-up.`);
        await expect(creator.getByLabel('Image prompt guidelines (optional)', { exact: true })).toHaveValue('Watercolour, soft morning light.');
        await expect(creator.locator('.creator-portrait img')).toHaveCount(0);
        const negativeToggle = creator.getByRole('checkbox', { name: 'Image provider supports negative prompts' });
        await expect(negativeToggle).not.toBeChecked();
        await negativeToggle.check();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ prompt: result, negativePrompt: 'Lettering, blurred face.' }) } }] };
        await creator.getByRole('button', { name: 'Generate image prompt', exact: true }).click();
        await expect(creator.getByLabel('Negative portrait prompt', { exact: true })).toHaveValue('Lettering, blurred face.');
        expect(app.provider.calls.some(call => call.messages?.some(message => message.content?.includes('The image provider supports negative prompts.')))).toBe(true);
        await creator.getByLabel('Negative portrait prompt', { exact: true }).fill('Lettering, blurred face, extra fingers.');
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        await expect(negativeToggle).toBeChecked();
        await expect(creator.getByLabel('Negative portrait prompt', { exact: true })).toHaveValue('Lettering, blurred face, extra fingers.');
        await page.evaluate(async () => {
            const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
            globalThis.catelierImageRequests = [];
            registerExtensionCapability('quick-image-gen', { generateImage: async (prompt, negative) => {
                globalThis.catelierImageRequests.push({ prompt, negative });
                return null;
            } });
        });
        await creator.getByRole('button', { name: 'Generate portrait candidate', exact: true }).click();
        await expect.poll(() => page.evaluate(() => globalThis.catelierImageRequests.length)).toBe(1);
        expect(await page.evaluate(() => globalThis.catelierImageRequests[0].negative)).toBe('Lettering, blurred face, extra fingers.');
        await negativeToggle.uncheck();
        await expect(creator.getByLabel('Negative portrait prompt', { exact: true })).toHaveCount(0);
        await creator.getByRole('button', { name: 'Generate portrait candidate', exact: true }).click();
        await expect.poll(() => page.evaluate(() => globalThis.catelierImageRequests.length)).toBe(2);
        expect(await page.evaluate(() => globalThis.catelierImageRequests[1].negative)).toBe('');
        await negativeToggle.check();
        await expect(creator.getByLabel('Negative portrait prompt', { exact: true })).toHaveValue('Lettering, blurred face, extra fingers.');
        await creator.locator('.creator-status').getByRole('button', { name: 'Dismiss', exact: true }).click();
        await creator.getByLabel('Portrait prompt', { exact: true }).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-image-prompt-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
    });
}

/* global globalThis, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createCreatorDraft } from '../public/scripts/creator/model.js';

for (const phone of [false, true]) {
    test(`Creator portrait is ready from the card on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const draft = createCreatorDraft({ id: 'portrait-ready', card: { data: { name: 'Mira', description: 'Silver hair, green eyes and a blue coat.', personality: 'A confident shipwright.', scenario: 'A sunny harbour.' } } });
        draft.privateNotes = 'PRIVATE_SENTINEL';
        draft.dossier = 'DOSSIER_SENTINEL';
        await account.post('/api/creator/save', { draft, expectedRevision: null });
        const page = await account.open({ workspace: false });
        await page.waitForFunction(() => typeof globalThis.NeconyanShell?.openCreator === 'function');
        await page.evaluate(async id => {
            const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
            globalThis.creatorPortraitCalls = [];
            registerExtensionCapability('quick-image-gen', { async generateImage(prompt, negative, options) {
                globalThis.creatorPortraitCalls.push({ prompt, name: options.characterName });
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 32;
                canvas.getContext('2d').fillRect(0, 0, 32, 32);
                return { url: canvas.toDataURL('image/png') };
            } });
            globalThis.NeconyanShell.openCreator({ draftId: id });
        }, draft.id);
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        const prompt = creator.getByLabel('Portrait prompt', { exact: true });
        await expect(prompt).toHaveValue(/Silver hair, green eyes and a blue coat/);
        await page.screenshot({ path: `../screenshots/creator-portrait-ready-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Generate portrait candidate', exact: true }).click();
        await expect(creator.locator('.creator-portraits img')).toHaveCount(1);
        const calls = await page.evaluate(() => globalThis.creatorPortraitCalls);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('Mira');
        expect(calls[0].prompt).toContain('Silver hair');
        expect(calls[0].prompt).not.toContain('SENTINEL');
        await prompt.fill('My custom portrait.');
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByLabel('Description', { exact: true }).fill('Red hair and a blue coat.');
        await creator.getByRole('button', { name: 'Portrait', exact: true }).click();
        await expect(prompt).toHaveValue('My custom portrait.');
        await creator.getByRole('button', { name: 'Refresh prompt from card', exact: true }).click();
        await expect(prompt).toHaveValue(/Red hair and a blue coat/);
    });
}

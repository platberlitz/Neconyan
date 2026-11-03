/* global globalThis */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createCreatorDraft } from '../public/scripts/creator/model.js';

for (const phone of [false, true]) {
    test(`Creator stays usable without Connection Manager on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.lockedExtensionsUnlockApplied = true;
            saved.extension_settings.formerOptInEnabledExtensions = [...(saved.extension_settings.formerOptInEnabledExtensions ?? []), 'connection-manager'];
            saved.extension_settings.disabledExtensions.push('connection-manager');
        } });
        const draft = createCreatorDraft({ id: 'review-fixes', card: { data: { name: 'Mira', alternate_greetings: ['At home.', 'At sea.'] } } });
        draft.dossier = 'Mira repairs ships.';
        draft.writing = { dossierFields: ['first_mes'] };
        await account.post('/api/creator/save', { draft, expectedRevision: null });
        const page = await account.open({ workspace: false });
        await page.waitForFunction(() => typeof globalThis.NeconyanShell?.openCreator === 'function');
        await page.evaluate(id => globalThis.NeconyanShell.openCreator({ draftId: id }), draft.id);
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await expect(creator.getByLabel('Director prompt', { exact: true })).toBeVisible();
        await expect(creator).toContainText('Connection Manager is unavailable');
        await expect(creator.getByLabel('Connection profile', { exact: true })).toHaveValue('');
        await expect(creator).toContainText('without automatic adjustment');
        const count = creator.getByLabel('Number of greetings', { exact: true });
        await count.fill('102');
        await count.press('Tab');
        await expect(count).toHaveValue('101');
        await count.fill('1e3');
        await count.press('Tab');
        await expect(count).toHaveValue('1');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: { first_mes: 'At the dock.' }, questions: [], coverage: [] }) } }] };
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        await expect(creator.locator('.creator-proposal')).toBeVisible({ timeout: 30000 });
        await creator.getByRole('button', { name: 'Accept all fields', exact: true }).click();
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const saved = (await account.post('/api/creator/get', { id: draft.id })).draft;
        expect(saved.card.data.alternate_greetings).toEqual(['At home.', 'At sea.']);
        await page.evaluate(id => globalThis.NeconyanShell.openCreator({ draftId: id }), draft.id);
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await count.fill('2');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: { alternate_greetings: [] }, questions: [], coverage: [] }) } }] };
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        await expect(creator.locator('.creator-proposal')).toContainText('Removes all 2 alternate greetings.', { timeout: 30000 });
        await page.screenshot({ path: `../screenshots/creator-review-fixes-${phone ? 'phone' : 'desktop'}.png` });
    });
}

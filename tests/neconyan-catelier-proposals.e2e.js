/* global globalThis */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createCreatorDraft } from '../public/scripts/creator/model.js';
import { startCreatorConversion, mergeCreatorStep } from '../public/scripts/creator/conversion.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

for (const phone of [false, true]) {
    test(`Catelier applies revisions and accepts all during writing on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const draft = createCreatorDraft({ id: 'immediate-revisions', card: { data: { name: 'Mira' } } });
        draft.dossier = 'Mira repairs boats.';
        draft.writing = { connection: { profile: 'durable' } };
        draft.proposals = [mergeCreatorStep(draft, startCreatorConversion(draft, ['description', 'scenario']), JSON.stringify({ fields: { description: 'A patient shipwright.' } }))];
        await account.post('/api/creator/save', { draft, expectedRevision: null });
        const page = await account.open({ workspace: false });
        const calls = [];
        await page.route('**/api/backends/chat-completions/generate', async route => {
            const request = JSON.parse(route.request().postDataJSON().messages.findLast(message => message.role === 'user').content);
            calls.push(request);
            if (request.requestedFields.includes('scenario')) return;
            await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: { description: 'A stern shipwright.' } }) } }] } });
        });
        await page.waitForFunction(() => typeof globalThis.NeconyanShell?.openCreator === 'function');
        await page.evaluate(id => globalThis.NeconyanShell.openCreator({ draftId: id }), draft.id);
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByRole('button', { name: 'Review Dossier conversion', exact: true }).click();
        const review = creator.locator('.creator-proposal');
        await review.getByRole('button', { name: 'Continue writing', exact: true }).click();
        await expect.poll(() => calls.length).toBe(1);
        await review.getByLabel('Anything else to change?', { exact: true }).fill('Make her stern.');
        await review.getByLabel('Proposed text', { exact: true }).fill('A reserved shipwright.');
        await review.getByRole('button', { name: 'Apply revisions now', exact: true }).click();
        await expect.poll(() => calls.length).toBe(3);
        expect(calls[1].revisionNote).toBe('Make her stern.');
        expect(calls[1].writtenFields.description).toBe('A reserved shipwright.');
        expect(calls[1].requestedFields).toEqual(['description']);
        await expect(review.getByLabel('Proposed text', { exact: true })).toHaveValue('A stern shipwright.');
        await review.getByRole('button', { name: 'Accept all fields', exact: true }).click();
        await expect(review.locator('.creator-proposal-field')).toHaveCount(0);
        await creator.getByRole('button', { name: 'Cancel active request', exact: true }).click();
        await expect(review.getByRole('button', { name: 'Continue writing', exact: true })).toBeVisible();
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const saved = (await account.post('/api/creator/get', { id: draft.id })).draft;
        expect(saved.card.data.description).toBe('A stern shipwright.');
        expect(saved.proposals[0].changes).toEqual([]);
        expect(saved.proposals[0].plan.next).toBe(1);
        expect(saved.proposals[0].plan.steps[1].fields).toEqual(['scenario']);
    });

    test(`Catelier selects all draft conflicts on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const draft = createCreatorDraft({ id: 'compare-controls', avatar: 'Mira.png', card: { data: { name: 'Mira', description: 'Original description', personality: 'Original personality' } } });
        draft.card.data.description = 'Draft description';
        draft.card.data.personality = 'Draft personality';
        await account.post('/api/creator/save', { draft, expectedRevision: null });
        const page = await account.open({ workspace: false });
        await page.route('**/api/creator/character', route => route.fulfill({ json: {
            owner: 'default-user', card: { data: { name: 'Mira', description: 'Library description', personality: 'Library personality' } }, revision: 'library-current', extraBooks: [],
        } }));
        await page.waitForFunction(() => typeof globalThis.NeconyanShell?.openCreator === 'function');
        await page.evaluate(id => globalThis.NeconyanShell.openCreator({ draftId: id }), draft.id);
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Review & save', exact: true }).click();
        await creator.getByRole('button', { name: 'Compare with library', exact: true }).click();
        await expect(creator.getByRole('radio', { name: 'Keep draft', exact: true })).toHaveCount(2);
        await creator.getByRole('radio', { name: 'Keep library', exact: true }).first().check();
        await creator.getByRole('button', { name: 'Keep all draft changes', exact: true }).click();
        for (const radio of await creator.getByRole('radio', { name: 'Keep draft', exact: true }).all()) await expect(radio).toBeChecked();
        await page.screenshot({ path: `../screenshots/catelier-compare-after-${phone ? 'phone' : 'desktop'}.png` });
        await checkImageControlContrast(page, ['.creator-content > button'], phone);
        // Bulk selection still permits an individual exception before applying.
        await creator.getByRole('radio', { name: 'Keep library', exact: true }).nth(1).check();
        await creator.getByRole('button', { name: 'Apply comparison to draft', exact: true }).click();
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const saved = (await account.post('/api/creator/get', { id: draft.id })).draft;
        expect(saved.card.data.description).toBe('Draft description');
        expect(saved.card.data.personality).toBe('Library personality');
    });
}

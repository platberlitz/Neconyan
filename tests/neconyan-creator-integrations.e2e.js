/* global globalThis */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Creator notebook, prompt and Scratchpad integration on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const { notebook } = await account.post('/api/notebooks/create', { operationId: 'creator:book', name: 'Character research' });
        const note = await account.post('/api/notebooks/notes/create', { notebookId: notebook.id, operationId: 'creator:note', title: 'Mira facts', text: 'Mira repairs ships with {{poss}} tools.' });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Notebook sources', exact: true }).click();
        await creator.getByRole('button', { name: 'Character research', exact: true }).click();
        await creator.getByRole('button', { name: 'Mira facts', exact: true }).click();
        await creator.getByRole('button', { name: 'Copy note into Dossier', exact: true }).click();
        await expect(creator.getByRole('status')).toContainText('Note copied');
        await creator.getByRole('button', { name: 'Copy note into Dossier', exact: true }).click();
        await expect(creator.getByRole('status')).toContainText('already in the Dossier');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await expect(creator.getByLabel('Character dossier', { exact: true })).toHaveValue('## Mira facts\n\nMira repairs ships with {{poss}} tools.');
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByRole('button', { name: 'Expand Director prompt', exact: true }).click();
        const fullscreen = page.locator('.creator-fullscreen textarea');
        await fullscreen.fill('Use terse dialogue and {{char}} literally.');
        await fullscreen.press('Escape');
        await expect(creator.getByLabel('Director prompt', { exact: true })).toHaveValue('Use terse dialogue and {{char}} literally.');
        await page.screenshot({ path: `../screenshots/creator-instructions-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const drafts = await account.post('/api/creator/list');
        const stored = await account.post('/api/creator/get', { id: drafts.drafts[0].id });
        expect(stored.draft.writing.prompts.director).toBe('Use terse dialogue and {{char}} literally.');
        expect((await account.post('/api/notebooks/notes/read', { notebookId: notebook.id, noteId: note.noteId })).note.text).toBe('Mira repairs ships with {{poss}} tools.');

        await page.evaluate(async () => {
            globalThis.NeconyanShell.closeCharacters();
            await (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' });
        });
        const proposal = { type: 'creator', action: 'create', name: 'Scratchpad Mira', dossier: 'Agreed in discussion: she seeks her sister.', fields: { description: 'Mira keeps {{charposs}} tools.' } };
        app.provider.mode.streamReply = { first: 'Here is your draft.', rest: `\n\`\`\`scratchpad-change\n${JSON.stringify(proposal)}\n\`\`\`` };
        await page.locator('.scratchpad-composer').fill('Put our character discussion in Creator.');
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await sent;
        expect(response.ok()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('Here is your draft.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        await page.locator('.scratchpad-change').getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('.scratchpad-review')).toContainText('Private Creator draft');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(creator).toBeVisible();
        await expect(creator.getByLabel('Character dossier', { exact: true })).toHaveValue(proposal.dossier, { timeout: 30000 });
        const after = await account.post('/api/creator/list');
        expect(after.drafts.filter(draft => draft.name === 'Scratchpad Mira')).toHaveLength(1);
        expect(app.provider.calls.some(call => call.messages?.some(message => message.content?.includes('Creator workspace integration:')))).toBe(true);
        await page.screenshot({ path: `../screenshots/creator-scratchpad-${phone ? 'phone' : 'desktop'}.png` });
    });
}

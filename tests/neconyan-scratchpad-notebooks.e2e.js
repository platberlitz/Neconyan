/* global document */
/* eslint-disable playwright/no-standalone-expect -- Helpers assert their own fixture setup. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { fillSource, sourceText } from './notebooks-browser-fixture.js';

async function openScratchpad(page, options = { tab: 'context' }) {
    await page.evaluate(async options => (await import('/scripts/scratchpad/index.js')).openScratchpad(options), options);
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function notes(account) {
    const notebookId = (await account.post('/api/notebooks/list')).notebooks[0].id;
    const create = (title, text) => account.post('/api/notebooks/notes/create', { notebookId, title, text, operationId: `fixture:${title.replaceAll(' ', '-')}` });
    const chosen = await create('Scene plan', '# Rules\n\nThe ferry leaves at dawn.\n\n# Other section\n\nKeep this section out.');
    const hidden = await create('Private journal', 'Private words stay private.');
    await account.post('/api/notebooks/policies/update', { notebookId, patch: { assistant: 'edit', notes: { [hidden.noteId]: { assistant: 'none' } } } });
    return { notebookId, chosen, hidden };
}

async function finishReply(page, account, app, text, reply) {
    app.provider.mode.streamReply = { first: 'A useful thought.', rest: reply };
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-composer').fill(text);
    const accepted = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const response = await accepted;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('.scratchpad-stream')).toContainText('A useful thought.');
    app.provider.mode.finishStream();
    await account.settled((await response.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} shares a chosen section, reviews note edits and saves replies and sessions back to Notes`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const { notebookId, chosen } = await notes(account);
        const page = await account.open();
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('button', { name: 'Add saved note', exact: true }).click();
        const picker = page.locator('.scratchpad-review');
        await expect(picker.locator('.scratchpad-note-result')).toHaveCount(1);
        await expect(picker).not.toContainText('Private journal');
        await picker.locator('.scratchpad-note-result').click();
        await page.getByRole('button', { name: 'Choose note', exact: true }).click();
        await page.getByRole('combobox', { name: 'Note or section to share', exact: true }).selectOption({ label: 'Rules' });
        await expect(page.locator('.scratchpad-review .scratchpad-preview-text')).toHaveText('The ferry leaves at dawn.');
        await page.getByRole('button', { name: 'Share with Scratchpad', exact: true }).click();
        await expect(page.locator('.scratchpad-note')).toContainText('Scene plan');
        await expect(page.locator('.scratchpad-note')).toContainText('Edits need review');
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        await expect(page.locator('.scratchpad-preview-text')).toContainText('The ferry leaves at dawn.');
        await expect(page.locator('.scratchpad-preview-text')).not.toContainText('Keep this section out.');
        await expect(page.locator('.scratchpad-preview-text')).not.toContainText('Private words');
        const controls = await page.locator('.scratchpad-note-actions button').evaluateAll(elements => elements.map(element => {
            const { width, height } = element.getBoundingClientRect();
            return Math.min(width, height);
        }));
        expect(Math.min(...controls)).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        if (phone) {
            await page.locator('.scratchpad-panel-context').evaluate(element => { element.scrollTop = 0; });
            await page.screenshot({ path: '/tmp/opencode/scratchpad-notebooks-after.png' });
        }

        const change = { type: 'notebook', action: 'append-note', args: { notebookId, noteId: chosen.noteId, expectedRevision: chosen.revision, markdown: 'Bring a lantern.' } };
        await finishReply(page, account, app, 'Check the ferry plan.', `\n\`\`\`scratchpad-change\n${JSON.stringify(change)}\n\`\`\``);
        const call = app.provider.calls.find(call => call.messages?.at(-1)?.content === 'Check the ferry plan.');
        const noteContext = call.messages.find(message => message.content.startsWith('<notebook_context>')).content;
        expect(noteContext).toContain('The ferry leaves at dawn.');
        expect(noteContext).not.toContain('Keep this section out.');
        expect(noteContext).not.toContain('Private words');
        expect((await account.post('/api/notebooks/assistant/proposals')).proposals).toHaveLength(1);
        expect((await account.post('/api/notebooks/notes/read', { notebookId, noteId: chosen.noteId })).note.text).not.toContain('Bring a lantern.');
        await page.locator('.scratchpad-change').getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('.scratchpad-review-after')).toContainText('Bring a lantern.');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(page.locator('.scratchpad-change')).toContainText('Saved');
        expect((await account.post('/api/notebooks/notes/read', { notebookId, noteId: chosen.noteId })).note.text).toContain('Bring a lantern.');

        const reply = page.locator('.scratchpad-message.is-assistant');
        await reply.locator('summary[aria-label="Message actions"]').click();
        await reply.getByRole('button', { name: 'Save selection or message to note', exact: true }).click();
        await expect(page.locator('.notes-capture-preview')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.notes-capture-preview')).toHaveText('A useful thought.');
        await page.getByRole('button', { name: 'Existing note', exact: true }).click();
        await page.locator('.notes-dialog .notes-note-link').filter({ hasText: 'Scene plan' }).click();
        await page.locator('.popup').getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(async () => (await account.post('/api/notebooks/notes/read', { notebookId, noteId: chosen.noteId })).note.text).toContain('Saved from Scratchpad');
        const saved = (await account.post('/api/notebooks/notes/read', { notebookId, noteId: chosen.noteId })).note.text;
        expect(saved).toContain('> A useful thought.');
        expect(saved).not.toContain('scratchpad-change');
        await openScratchpad(page, { tab: 'sessions' });
        await page.getByRole('button', { name: 'Save session to note', exact: true }).click();
        await expect(page.locator('.notes-capture-preview')).toContainText('Check the ferry plan.');
        await expect(page.locator('.notes-capture-preview')).not.toContainText('scratchpad-change');
        await page.locator('.popup').getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => sourceText(page)).toContain('> ## You');
        await openScratchpad(page);
        await expect(page.locator('.scratchpad-note')).toContainText('Scene plan');
        await account.post('/api/notebooks/policies/update', { notebookId, patch: { assistant: 'none', notes: { [chosen.noteId]: { assistant: null } } } });
        await openScratchpad(page);
        await expect(page.locator('.scratchpad-note')).toContainText('Not shared');
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        await expect(page.locator('.scratchpad-preview-text')).not.toContainText('The ferry leaves at dawn.');
        expect((await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].settings.notes).toHaveLength(1);
    });
}

async function checkNoteSelection({ app }, access) {
    test.setTimeout(180000);
    const account = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT });
    await installIPhoneSafari(account.context, { standalone: true });
    const notebookId = (await account.post('/api/notebooks/list')).notebooks[0].id;
    const created = await account.post('/api/notebooks/notes/create', { notebookId, title: 'Private plan', text: 'Old draft.', operationId: 'private:selection' });
    if (access !== 'none') await account.post('/api/notebooks/policies/update', { notebookId, patch: { assistant: access } });
    const page = await account.open();
    await page.evaluate(async ref => (await import('/scripts/notebooks/notes-app.js')).openNotes({ ...ref, layout: 'full' }), { notebookId, noteId: created.noteId });
    await fillSource(page, 'Private beginning. Shared passage. Private ending.');
    await page.evaluate(async () => {
        const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
        app.elements.textarea.setSelectionRange(19, 34);
    });
    await page.getByRole('button', { name: 'Ask Scratchpad', exact: true }).click();
    await expect(page.locator('.notes-dialog .notes-capture-preview')).toHaveText('Shared passage.');
    await page.getByRole('checkbox', { name: 'Allow proposed edits to the shared text', exact: true }).check();
    await page.getByRole('button', { name: 'Open Scratchpad', exact: true }).click();
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
    await applyIOSOnlyCss(page);
    await expect(page.locator('.scratchpad-note')).toContainText('Selected text only');
    await expect(page.locator('#scratchpad-depth')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Context', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('button', { name: 'Show preview', exact: true }).click();
    const preview = page.locator('.scratchpad-preview-text');
    await expect(preview).toContainText('Shared passage.');
    await expect(preview).not.toContainText('Private beginning.');
    await expect(preview).not.toContainText('Original question.');
    await expect(preview).not.toContainText('Nova belongs to account');
    await finishReply(page, account, app, 'Help with this passage.', ' Keep its meaning clear.');
    const prompt = JSON.stringify(app.provider.calls.at(-1).messages);
    expect(prompt).toContain('Shared passage.');
    expect(prompt).not.toContain('Private beginning.');
    expect(prompt).not.toContain('Original question.');
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await expect(page.locator('.scratchpad-notes')).toContainText('No saved notes are shared');
    expect((await account.post('/api/notebooks/assistant/grants/list')).grants).toHaveLength(0);
    expect((await account.post('/api/notebooks/policies/get', { notebookId })).policy.assistant).toBe(access);
    await page.getByRole('button', { name: 'Back to Notes', exact: true }).click();
    await expect.poll(() => sourceText(page)).toBe('Private beginning. Shared passage. Private ending.');
}

for (const access of ['none', 'edit']) {
    test(`a ${access === 'none' ? 'private' : 'shared'} note selection opens its own Scratchpad, saves unsaved text first and revokes temporary sharing`, ({ app }) => checkNoteSelection({ app }, access));
}

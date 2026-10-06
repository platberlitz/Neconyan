/* global window */
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { splitFrontmatter } from '../src/notebooks/markdown.js';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { fillSource, sourceText } from './notebooks-browser-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.setTimeout(180_000);

async function openFeedbackNote(app, { phone = false, text = '# Field notes\n\n## Routes\n\n### Harbour\n\nA place to keep plans.\n' } = {}) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    const page = await account.open({ workspace: false });
    await page.evaluate(async () => {
        const { openNotes } = await import('/scripts/notebooks/notes-app.js');
        await openNotes({ layout: 'full' });
    });
    const notebookId = (await account.post('/api/notebooks/list', {})).notebooks[0].id;
    const created = await account.post('/api/notebooks/notes/create', {
        notebookId, operationId: 'feedback:create-note', folder: 'Inbox', title: 'Field notes', text,
    });
    expect(created.status).toBe('success');
    await page.evaluate(async ({ notebookId, noteId }) => {
        await window.NeconyanNotes.open({ notebookId, noteId, layout: 'full' });
    }, { notebookId, noteId: created.noteId });
    await expect(page.getByRole('textbox', { name: 'Note text (Markdown)' })).toBeVisible();
    if (phone) await applyIOSOnlyCss(page);
    return { account, page, notebookId, noteId: created.noteId };
}

async function setPane(page, pane) {
    await page.evaluate(async pane => (await import('/scripts/notebooks/notes-app.js')).notesApp().setPane(pane), pane);
}

async function savePreferences(page) {
    expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
}

async function openAgain(page, notebookId, noteId) {
    await page.evaluate(async ({ notebookId, noteId }) => (await import('/scripts/notebooks/notes-app.js')).openNotes({ notebookId, noteId, layout: 'full' }), { notebookId, noteId });
}

async function findPropertyRow(root, key) {
    const rows = root.locator('.notes-property-row');
    for (let index = 0; index < await rows.count(); index++) {
        if (await rows.nth(index).locator('.notes-prop-key').inputValue() === key) return rows.nth(index);
    }
    throw new Error(`No property row named '${key}'.`);
}

async function exportedFiles(page) {
    const download = await page.waitForEvent('download');
    return unzipSync(new Uint8Array(await readFile(await download.path())));
}

for (const phone of [false, true]) {
    const layout = phone ? 'iPhone-emulated' : 'desktop';

    test(`Notebook writing keeps full screen, undo and continuing lists on ${layout}`, async ({ app }) => {
        const { page, notebookId, noteId } = await openFeedbackNote(app, { phone });
        const root = page.locator('#neconyan-notes');
        await expect(root.locator('.notes-header h2')).toHaveText('Notebooks');
        await expect(page.locator('#neconyan-workspace-rail [data-neconyan-route="notes"]')).toContainText('Notebooks');
        await page.evaluate(async () => { window.feedbackEditor = (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor; });
        await root.getByRole('button', { name: 'Full screen', exact: true }).click();
        for (const view of ['Read', 'Outline', 'Write']) {
            await root.getByRole('button', { name: view, exact: true }).click();
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'true');
            await expect(root.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
        }
        expect(await page.evaluate(async () => window.feedbackEditor === (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor)).toBe(true);
        await root.getByRole('button', { name: 'Exit full screen', exact: true }).click();

        await fillSource(page, '- First item');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        expect(await sourceText(page)).toBe('- First item\n- ');
        await page.keyboard.press('Tab');
        expect(await sourceText(page)).toBe('- First item\n    - ');
        await page.keyboard.press('Shift+Tab');
        expect(await sourceText(page)).toBe('- First item\n- ');
        await page.keyboard.insertText('Second item');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        expect(await sourceText(page)).toBe('- First item\n- Second item\n');

        await fillSource(page, 'First item\nSecond item');
        await page.keyboard.press('ControlOrMeta+a');
        await root.getByRole('button', { name: 'Numbered list', exact: true }).click();
        expect(await sourceText(page)).toBe('1. First item\n2. Second item');
        await page.keyboard.press('ControlOrMeta+z');
        expect(await sourceText(page)).toBe('First item\nSecond item');
        // The iPhone stand-in keeps Chromium's vendor, so the editor uses its
        // generic redo binding, not the Linux-only Ctrl+Shift+Z shortcut.
        await page.keyboard.press(phone ? 'ControlOrMeta+y' : 'ControlOrMeta+Shift+Z');
        expect(await sourceText(page)).toBe('1. First item\n2. Second item');
        await root.getByRole('button', { name: 'Indent', exact: true }).click();
        expect(await sourceText(page)).toBe('    1. First item\n    2. Second item');
        await root.getByRole('button', { name: 'Outdent', exact: true }).click();
        expect(await sourceText(page)).toBe('1. First item\n2. Second item');

        await fillSource(page, '- Keyboard item');
        await page.keyboard.press('End');
        await page.getByRole('textbox', { name: 'Note text (Markdown)' }).evaluate(element => element.dispatchEvent(new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' })));
        expect(await sourceText(page)).toBe('- Keyboard item\n- ');
        await fillSource(page, '```\n- Example');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        expect(await sourceText(page)).toBe('```\n- Example\n');
        await fillSource(page, '- Composing');
        await page.keyboard.press('End');
        await page.getByRole('textbox', { name: 'Note text (Markdown)' }).evaluate(element => element.dispatchEvent(new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph', isComposing: true })));
        expect(await sourceText(page)).toBe('- Composing');

        const text = '# Field notes\n\n## Routes\n\n### Harbour\n\n1. First item\n2. Second item\n';
        await fillSource(page, text);
        await expect(root.locator('.notes-fold-controls')).toBeVisible();
        await root.getByRole('button', { name: 'Show or hide section controls', exact: true }).click();
        await expect(root.locator('.notes-fold-controls')).toBeHidden();
        await savePreferences(page);
        await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).hideNotes());
        await openAgain(page, notebookId, noteId);
        await expect(root.locator('.notes-fold-controls')).toBeHidden();
        await root.getByRole('button', { name: 'Show or hide section controls', exact: true }).click();
        await expect(root.locator('.notes-fold-controls')).toBeVisible();

        await setPane(page, 'details');
        await root.getByRole('button', { name: 'Links', exact: true }).click();
        const outline = root.locator('.notes-links-outline');
        await expect(outline.getByRole('button', { name: 'Harbour', exact: true })).toBeVisible();
        const parent = await outline.getByRole('button', { name: 'Field notes', exact: true }).boundingBox();
        const child = await outline.getByRole('button', { name: 'Harbour', exact: true }).boundingBox();
        expect(child.x).toBeGreaterThan(parent.x + 20);
        await outline.getByRole('button', { name: 'Hide subsections of Field notes', exact: true }).click();
        await expect(outline.getByRole('button', { name: 'Harbour', exact: true })).toBeHidden();
        await outline.getByRole('button', { name: 'Show subsections of Field notes', exact: true }).click();
        await expect(outline.getByRole('button', { name: 'Harbour', exact: true })).toBeVisible();
        expect(await sourceText(page)).toBe(text);
        await setPane(page, 'note');
        await fillSource(page, `${text}\n### Another harbour\n`);
        await setPane(page, 'details');
        await expect(outline.getByRole('button', { name: 'Another harbour', exact: true })).toBeVisible();
        await outline.getByRole('button', { name: 'Harbour', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Note text (Markdown)' })).toBeVisible();
        await expect(root.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
        expect(await root.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (phone) await page.screenshot({ path: '/tmp/opencode/notebook-feedback-after.png' });
        if (!phone) {
            await root.getByRole('button', { name: 'Show notes beside the chat', exact: true }).click();
            await expect(root.locator('.notes-intro')).toBeHidden();
            await expect(page.getByRole('textbox', { name: 'Note text (Markdown)' })).toBeVisible();
        }
    });

    test(`Notebook templates can be edited, added, removed and cancelled on ${layout}`, async ({ app }) => {
        const { page, account } = await openFeedbackNote(app, { phone });
        const root = page.locator('#neconyan-notes');
        const popup = page.locator('.popup:visible').last();
        await setPane(page, 'nav');
        await root.locator('.notes-create-row').getByRole('button', { name: 'New note', exact: true }).click();
        await popup.getByRole('button', { name: 'Location', exact: true }).click();
        await expect(popup.getByRole('group', { name: 'Start from' }).locator('[aria-pressed="true"]')).toHaveCount(1);
        await popup.getByRole('button', { name: 'Manage templates', exact: true }).click();
        const manager = page.locator('.notes-template-manager');
        await manager.getByRole('combobox', { name: 'Saved template', exact: true }).selectOption('location');
        await manager.getByRole('textbox', { name: 'Template contents', exact: true }).fill('# Edited location\n\nMy starting text.');
        await manager.getByRole('combobox', { name: 'Saved template', exact: true }).selectOption('scene');
        await manager.getByRole('button', { name: 'Remove template', exact: true }).click();
        await expect(manager.locator('option[value="scene"]')).toHaveCount(0);
        await manager.getByRole('button', { name: 'Add template', exact: true }).click();
        await manager.getByRole('textbox', { name: 'Template name', exact: true }).fill('Field report');
        await manager.getByRole('textbox', { name: 'Suggested note name', exact: true }).fill('New report');
        const templateText = '# Field report\n\n{{user}} is literal template text.\n\n## Findings\n';
        await manager.getByRole('textbox', { name: 'Template contents', exact: true }).fill(templateText);
        await popup.getByRole('button', { name: 'Save templates', exact: true }).click();
        await expect(popup.getByRole('button', { name: 'Scene plan', exact: true })).toHaveCount(0);
        await popup.getByRole('button', { name: 'Field report', exact: true }).click();
        await expect(popup.getByRole('button', { name: 'Field report', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await popup.getByRole('button', { name: 'Create note', exact: true }).click();
        await expect(root.getByRole('textbox', { name: 'Note name', exact: true })).toHaveValue('New report');
        expect(await sourceText(page)).toBe(templateText);
        const created = await page.evaluate(async () => {
            const { state } = (await import('/scripts/notebooks/notes-app.js')).notesApp();
            return { notebookId: state.notebookId, noteId: state.note.id };
        });
        await savePreferences(page);
        const settings = JSON.parse((await account.post('/api/settings/get', {})).settings);
        const saved = JSON.parse(settings.accountStorage.neconyan_note_templates);
        expect(saved.templates.find(item => item.id === 'location').text).toBe('# Edited location\n\nMy starting text.');
        expect(saved.templates.some(item => item.id === 'scene')).toBe(false);

        await setPane(page, 'nav');
        await root.locator('.notes-create-row').getByRole('button', { name: 'New note', exact: true }).click();
        await popup.getByRole('button', { name: 'Manage templates', exact: true }).click();
        await manager.getByRole('combobox', { name: 'Saved template', exact: true }).selectOption({ label: 'Field report' });
        await manager.getByRole('textbox', { name: 'Template name', exact: true }).fill('Do not save');
        await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(popup.getByRole('button', { name: 'Field report', exact: true })).toBeVisible();
        await expect(popup.getByRole('button', { name: 'Do not save', exact: true })).toHaveCount(0);
        await popup.getByRole('button', { name: 'Manage templates', exact: true }).click();
        await manager.getByRole('button', { name: 'Restore default templates', exact: true }).click();
        await popup.getByRole('button', { name: 'Restore defaults', exact: true }).click();
        await popup.getByRole('button', { name: 'Save templates', exact: true }).click();
        await expect(popup.getByRole('button', { name: 'Scene plan', exact: true })).toBeVisible();
        await expect(popup.getByRole('button', { name: 'Blank note', exact: true })).toBeVisible();
        await expect(popup.getByRole('button', { name: 'Field report', exact: true })).toHaveCount(0);
        await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect((await account.post('/api/notebooks/notes/read', created)).note.text).toBe(templateText);
    });

    test(`Notebook property rows add several fields before one safe save on ${layout}`, async ({ app }) => {
        const text = '---\npopulation: 12\nopen: true\nmembers: [one, two]\nnested:\n    value: keep # retained nested comment\n---\n# Field notes\n\nA plan.\n';
        const { page, account, notebookId, noteId } = await openFeedbackNote(app, { phone, text });
        await account.post('/api/notebooks/notes/create', { notebookId, operationId: 'feedback:known-fields', folder: 'Inbox', title: 'Reference', text: '---\nseason: summer\n---\n# Reference\n' });
        const root = page.locator('#neconyan-notes');
        await setPane(page, 'details');
        await root.getByRole('button', { name: 'Properties', exact: true }).click();
        await expect(root.locator('#notes-known-property-fields option[value="season"]')).toHaveCount(1);
        const first = await findPropertyRow(root, '');
        await first.locator('.notes-prop-key').fill('season');
        await first.locator('.notes-prop-value').fill('autumn');
        await root.getByRole('button', { name: 'Add field', exact: true }).click();
        const second = await findPropertyRow(root, '');
        await second.locator('.notes-prop-key').fill('district');
        await second.locator('.notes-prop-value').fill('Harbour');
        const field = await second.locator('.notes-prop-key').boundingBox();
        const value = await second.locator('.notes-prop-value').boundingBox();
        expect(value.x).toBeGreaterThan(field.x);
        expect(Math.abs(value.y - field.y)).toBeLessThanOrEqual(1);
        await root.getByRole('button', { name: 'Add field', exact: true }).click();
        await (await findPropertyRow(root, '')).getByRole('button', { name: 'Remove field', exact: true }).click();
        await (await findPropertyRow(root, 'population')).locator('.notes-prop-value').fill('15');
        const before = await account.post('/api/notebooks/notes/read', { notebookId, noteId });
        expect(before.note.properties.population).toBe(12);
        expect(before.note.properties.season).toBeUndefined();
        expect(before.note.properties.district).toBeUndefined();
        let release;
        const hold = new Promise(resolve => { release = resolve; });
        await page.route('**/api/notebooks/notes/update', async route => { await hold; await route.continue(); });
        const request = page.waitForRequest('**/api/notebooks/notes/update');
        try {
            await root.getByRole('button', { name: 'Save properties', exact: true }).click();
            await request;
            await expect(root.getByRole('button', { name: 'Add field', exact: true })).toBeDisabled();
            await expect(second.locator('.notes-prop-key')).toBeDisabled();
        } finally { release(); }
        await page.unroute('**/api/notebooks/notes/update');
        await expect.poll(async () => (await account.post('/api/notebooks/notes/read', { notebookId, noteId })).note.properties.population).toBe(15);
        const after = await account.post('/api/notebooks/notes/read', { notebookId, noteId });
        expect(after.note.properties).toMatchObject({ population: 15, open: true, members: ['one', 'two'], season: 'autumn', district: 'Harbour' });
        expect(splitFrontmatter(after.note.text).data.nested).toEqual(splitFrontmatter(before.note.text).data.nested);
        expect(splitFrontmatter(after.note.text).body).toBe(splitFrontmatter(before.note.text).body);
        expect(after.note.text).toContain('# retained nested comment');
        await expect(root.getByRole('button', { name: 'Add field', exact: true })).toBeEnabled();
        expect(await root.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (phone) await page.screenshot({ path: '/tmp/opencode/notebook-feedback-properties.png' });
    });

    test(`Notebook exports can select notes or a folder on ${layout}`, async ({ app }) => {
        const { page, account, notebookId, noteId } = await openFeedbackNote(app, { phone });
        await account.post('/api/notebooks/folders/create', { notebookId, operationId: 'feedback:create-folder', folder: 'Plans/Sub' });
        await account.post('/api/notebooks/notes/create', { notebookId, operationId: 'feedback:other-note', folder: 'Plans', title: 'Other plan', text: 'Only in the selected folder.' });
        await account.post('/api/notebooks/notes/create', { notebookId, operationId: 'feedback:child-note', folder: 'Plans/Sub', title: 'Nested plan', text: 'Only in its subfolder.' });
        const root = page.locator('#neconyan-notes');
        const popup = page.locator('.popup:visible').last();
        await setPane(page, 'nav');
        await root.getByRole('button', { name: 'Export', exact: true }).click();
        await popup.getByRole('button', { name: 'Choose notes', exact: true }).click();
        await popup.getByRole('checkbox', { name: /Field notes/ }).check();
        const selected = page.waitForRequest('**/api/notebooks/export');
        const firstDownload = exportedFiles(page);
        await popup.getByRole('button', { name: 'Export Markdown', exact: true }).click();
        expect((await selected).postDataJSON().selection).toEqual({ mode: 'notes', noteIds: [noteId] });
        const firstFiles = Object.keys(await firstDownload);
        expect(firstFiles.filter(path => path.endsWith('.md'))).toHaveLength(1);
        expect(firstFiles.some(path => path.includes('Other plan') || path.includes('Nested plan'))).toBe(false);

        await root.getByRole('button', { name: 'Export', exact: true }).click();
        await popup.getByRole('button', { name: 'A folder', exact: true }).click();
        await popup.getByRole('combobox', { name: 'Folder to export', exact: true }).selectOption('Plans');
        await popup.getByRole('checkbox', { name: 'Include subfolders', exact: true }).uncheck();
        const folderRequest = page.waitForRequest('**/api/notebooks/export');
        const folderDownload = exportedFiles(page);
        await popup.getByRole('button', { name: 'Export Markdown', exact: true }).click();
        expect((await folderRequest).postDataJSON().selection).toEqual({ mode: 'folder', folder: 'Plans', includeSubfolders: false });
        const folderFiles = Object.keys(await folderDownload);
        expect(folderFiles.filter(path => path.endsWith('.md'))).toHaveLength(1);
        expect(folderFiles.some(path => path.includes('Other plan'))).toBe(true);
        expect(folderFiles.some(path => path.includes('Nested plan') || path.includes('Field notes'))).toBe(false);
    });
}

test('Notebook export can choose a note beyond the first page without selecting other notes', async ({ app }) => {
    test.setTimeout(300_000);
    const { page, account, notebookId, noteId } = await openFeedbackNote(app);
    await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).hideNotes());
    for (let index = 0; index < 200; index++) {
        const result = await account.post('/api/notebooks/notes/create', { notebookId, operationId: `feedback:paging:${index}`, folder: 'Inbox', title: `Extra ${String(index).padStart(3, '0')}`, text: `# Extra ${index}\n` });
        expect(result.status).toBe('success');
    }
    await openAgain(page, notebookId, noteId);
    const root = page.locator('#neconyan-notes');
    const popup = page.locator('.popup:visible').last();
    await root.getByRole('button', { name: 'Export', exact: true }).click();
    await popup.getByRole('button', { name: 'Choose notes', exact: true }).click();
    await expect(popup.locator('.notes-export-list .notes-export-check')).toHaveCount(200);
    await expect(popup.getByRole('checkbox', { name: /Field notes/ })).toHaveCount(0);
    await popup.getByRole('button', { name: 'Load more notes', exact: true }).click();
    await popup.getByRole('checkbox', { name: /Field notes/ }).check();
    const request = page.waitForRequest('**/api/notebooks/export');
    const download = exportedFiles(page);
    await popup.getByRole('button', { name: 'Export Markdown', exact: true }).click();
    expect((await request).postDataJSON().selection).toEqual({ mode: 'notes', noteIds: [noteId] });
    expect(Object.keys(await download).filter(path => path.endsWith('.md'))).toHaveLength(1);
});

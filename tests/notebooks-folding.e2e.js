/* global document, getComputedStyle */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { enterNotes, expectSourceText, notesApi, openNotes, openWorkspace, showNotebooks } from './notebooks-browser-fixture.js';

test.use({ hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(180000);
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

const original = '--- \t\r\ntitle: Fold fixture\r\nstatus: draft\r\n---\r\n# One\r\nFirst paragraph 🐈.\r\n## Child\r\nChild body.\r\n```md\r\n# Not a section\r\n```\r\n# Two\r\nLast paragraph.\r\n';

async function setup(page, viewport) {
    await openNotes(page, viewport);
    const createdBook = await notesApi(page, '/create', { operationId: `browser:${randomUUID()}`, name: `Fold fixture ${randomUUID()}` });
    expect(createdBook.status).toBe('success');
    const notebookId = createdBook.notebook.id;
    const created = await notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId, title: 'Fold fixture', text: original });
    expect(created.status).toBe('success');
    await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText('Fold fixture', { exact: true }).first().click();
    await expect(page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true })).toBeVisible();
    return { notebookId, noteId: created.noteId, revision: created.revision };
}

async function editorState(page) {
    return page.evaluate(async () => {
        const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
        return { text: app.elements.textarea.value, selection: app.sourceEditor.view.state.selection.toJSON(), folds: app.sourceEditor.folds(),
            dirty: app.state.dirty, composing: app.sourceEditor.composing };
    });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`source and Read folds preserve bytes, selection and undo at ${viewport.width}px`, async ({ page }, info) => {
        const updates = [];
        page.on('request', request => { if (request.url().endsWith('/api/notebooks/notes/update')) updates.push(request); });
        const fixture = await setup(page, viewport);
        const expected = original.replace(/\r\n/g, '\n');
        await expectSourceText(page, expected);
        await page.evaluate(async () => {
            const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
            const start = app.elements.textarea.value.indexOf('First paragraph');
            app.elements.textarea.setSelectionRange(start, start + 5, 'backward');
        });
        const initial = await editorState(page);
        await page.getByRole('button', { name: 'Sections', exact: true }).click();
        await page.locator('.notes-fold-sections').getByRole('button', { name: 'Fold One', exact: true }).click();
        let state = await editorState(page);
        expect(state.selection).toEqual(initial.selection);
        expect(state.text).toBe(expected);
        expect(state.dirty).toBe(false);
        expect(state.folds).toHaveLength(1);
        await expect(page.locator('.notes-fold-placeholder')).toBeVisible();
        const heightFolded = await page.locator('.cm-content').evaluate(element => element.getBoundingClientRect().height);
        await page.locator('.notes-fold-sections').getByRole('button', { name: 'Show One', exact: true }).click();
        const heightOpen = await page.locator('.cm-content').evaluate(element => element.getBoundingClientRect().height);
        expect(heightOpen).toBeGreaterThan(heightFolded);
        expect((await editorState(page)).selection).toEqual(initial.selection);
        await page.getByRole('button', { name: 'Sections', exact: true }).click();
        await page.getByRole('button', { name: 'Read', exact: true }).click();
        await page.locator('.notes-reader').getByRole('button', { name: 'Fold Child', exact: true }).click();
        const child = page.locator('.notes-reader .notes-read-section').filter({ has: page.locator(':scope > .notes-read-heading > h2') });
        await expect(child.locator(':scope > .notes-section-body')).toBeHidden();
        await page.locator('.notes-reader').getByRole('button', { name: 'Fold One', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.notes-reader > .notes-read-section').first().locator(':scope > .notes-section-body')).toBeHidden();
        expect((await editorState(page)).selection).toEqual(initial.selection);
        expect((await editorState(page)).text).toBe(expected);
        await page.locator('.notes-reader').getByRole('button', { name: 'Show One', exact: true }).click();
        await expect(child.locator(':scope > .notes-section-body')).toBeHidden();
        await page.getByRole('button', { name: 'Write', exact: true }).click();
        await page.getByRole('button', { name: 'Show all', exact: true }).click();
        await page.evaluate(async () => {
            const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
            const position = app.elements.textarea.value.indexOf('First paragraph') + 4;
            app.elements.textarea.setSelectionRange(position, position);
            app.elements.textarea.focus();
        });
        expect(updates).toHaveLength(0);
        const unchanged = await notesApi(page, '/notes/read', fixture);
        expect(unchanged.note.text).toBe(original);
        expect(unchanged.note.revision).toBe(fixture.revision);
        await page.getByRole('button', { name: 'Sections', exact: true }).click();
        await page.locator('.notes-fold-sections').getByRole('button', { name: 'Fold One', exact: true }).click();
        const editingSelection = (await editorState(page)).selection;
        await page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true }).focus();
        expect((await editorState(page)).selection).toEqual(editingSelection);
        await expect(page.locator('.notes-fold-sections').getByRole('button', { name: 'Fold One', exact: true })).toBeVisible();
        const insertion = expected.indexOf('First paragraph') + 4;
        await page.keyboard.insertText('Edited words.');
        await expectSourceText(page, expected.slice(0, insertion) + 'Edited words.' + expected.slice(insertion));
        await page.getByRole('button', { name: 'Fold all', exact: true }).click();
        await page.getByRole('button', { name: 'Read', exact: true }).click();
        await page.getByRole('button', { name: 'Write', exact: true }).click();
        await page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true }).press('ControlOrMeta+z');
        await expectSourceText(page, expected);
        await page.getByRole('button', { name: 'Fold all', exact: true }).click();
        const geometry = await page.locator('.notes-source').evaluate(element => ({
            background: getComputedStyle(element).backgroundColor, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
            buttons: [...document.querySelectorAll('.notes-fold-controls button, .notes-fold-placeholder')].map(control => control.getBoundingClientRect().height),
            sourceFont: getComputedStyle(element.querySelector('.cm-content')).fontFamily,
        }));
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
        for (const height of geometry.buttons) expect(height).toBeGreaterThanOrEqual(44);
        await info.attach('fold-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('source-folds.png') });
    });

    test(`fold choices survive reopening and reload without affecting another note at ${viewport.width}px`, async ({ page }) => {
        const fixture = await setup(page, viewport);
        const updates = [];
        page.on('request', request => { if (request.url().endsWith('/api/notebooks/notes/update')) updates.push(request); });
        await page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true }).press('ControlOrMeta+Home');
        await page.getByRole('button', { name: 'Sections', exact: true }).click();
        await page.locator('.notes-fold-sections').getByRole('button', { name: 'Fold One', exact: true }).click();
        const folded = (await editorState(page)).folds;
        expect(folded).toHaveLength(1);
        const other = await notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId: fixture.notebookId,
            title: 'Other fold fixture', text: original.replace('title: Fold fixture', 'title: Other fold fixture') });
        expect(other.status).toBe('success');
        await showNotebooks(page, viewport);
        await page.locator('.notes-pane-nav .notes-note-title').getByText('Other fold fixture', { exact: true }).first().click();
        await expectSourceText(page, original.replace('title: Fold fixture', 'title: Other fold fixture').replace(/\r\n/g, '\n'));
        expect((await editorState(page)).folds).toEqual([]);
        await showNotebooks(page, viewport);
        await page.locator('.notes-pane-nav .notes-note-title').getByText('Fold fixture', { exact: true }).first().click();
        await expectSourceText(page, original.replace(/\r\n/g, '\n'));
        expect((await editorState(page)).folds).toEqual(folded);
        const saved = await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }));
        expect(saved).toBe(true);
        await page.unroute('**/api/settings/get');
        await openWorkspace(page, { preserveNotesPrefs: true });
        await enterNotes(page, viewport);
        await page.locator('.notes-pane-nav .notes-note-title').getByText('Fold fixture', { exact: true }).first().click();
        await expectSourceText(page, original.replace(/\r\n/g, '\n'));
        expect((await editorState(page)).folds).toEqual(folded);
        await page.getByRole('button', { name: 'Read', exact: true }).click();
        await expect(page.locator('.notes-reader').getByRole('button', { name: 'Show One', exact: true })).toHaveAttribute('aria-expanded', 'false');
        expect(updates).toHaveLength(0);
        const unchanged = await notesApi(page, '/notes/read', fixture);
        expect(unchanged.note.text).toBe(original);
        expect(unchanged.note.revision).toBe(fixture.revision);
    });

    test(`composition remains editable and cannot fold or autosave partial text at ${viewport.width}px`, async ({ page, context }) => {
        const fixture = await setup(page, viewport);
        const expected = original.replace(/\r\n/g, '\n');
        await page.evaluate(async () => {
            const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
            const end = app.elements.textarea.value.length;
            app.elements.textarea.setSelectionRange(end, end);
            app.elements.textarea.focus();
        });
        const session = await context.newCDPSession(page);
        const updates = [];
        page.on('request', request => { if (request.url().endsWith('/api/notebooks/notes/update')) updates.push(request); });
        await session.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
        await expect.poll(async () => (await editorState(page)).composing).toBe(true);
        await expect(page.getByRole('button', { name: 'Fold all', exact: true })).toBeDisabled();
        const during = await editorState(page);
        const replaced = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.setDocument('Stale server reply.', 'another-note'));
        expect(replaced).toBe(false);
        const folded = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.foldAll());
        expect(folded).toBe(false);
        expect((await editorState(page)).selection).toEqual(during.selection);
        await page.clock.install();
        await page.clock.fastForward(2000);
        expect(updates).toHaveLength(0);
        await session.send('Input.insertText', { text: '日本語' });
        await page.clock.runFor(100);
        await expect.poll(async () => (await editorState(page)).composing).toBe(false);
        await expectSourceText(page, expected + '日本語');
        await page.clock.runFor(1400);
        await expect.poll(async () => (await notesApi(page, '/notes/read', fixture)).note.text).toBe(expected + '日本語');
        await session.detach();
    });
}

test('the self-hosted source editor is not requested during ordinary chat startup', async ({ page }) => {
    const requests = [];
    page.on('request', request => { if (request.url().includes('notes-editor.js')) requests.push(request); });
    await openWorkspace(page);
    expect(requests).toHaveLength(0);
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="notes"]').click();
    await expect(page.locator('#neconyan-notes')).toBeVisible({ timeout: 60000 });
    expect(requests).toHaveLength(1);
    const response = await requests[0].response();
    expect(response.ok()).toBe(true);
    const source = await response.text();
    expect(source).not.toMatch(/from\s*['"]@codemirror\//);
    expect(Buffer.byteLength(source)).toBeLessThan(512 * 1024);
});

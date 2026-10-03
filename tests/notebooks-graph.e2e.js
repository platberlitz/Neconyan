/* global getComputedStyle, globalThis, requestAnimationFrame */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectSourceText, notesApi, openNotes, showNotebooks } from './notebooks-browser-fixture.js';

test.use({ hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(180000);
const gates = new WeakMap();
test.beforeEach(async ({ page }) => gates.set(page, []));
test.afterEach(async ({ page }) => {
    for (const release of gates.get(page) ?? []) release();
    await page.unrouteAll({ behavior: 'wait' });
});

async function fixture(page, viewport) {
    await openNotes(page, viewport);
    const created = await notesApi(page, '/create', { operationId: `browser:${randomUUID()}`, name: `Graph checks ${randomUUID()}` });
    expect(created.status).toBe('success');
    const notebookId = created.notebook.id;
    const make = async (title, text, folder) => {
        const result = await notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId, title, text, folder });
        expect(result.status).toBe('success');
        return { notebookId, noteId: result.noteId, text, title };
    };
    const alpha = await make('Alpha', '---\r\ntags: [world/cities]\r\n---\r\n# Alpha\r\nSaved body. [[Beta]] ![[Beta]]\r\n', 'World/Cities');
    const beta = await make('Beta', '---\ntags: [world/cities/harbour]\n---\n# Beta\n[[Alpha]]\n', 'World/Cities');
    await make('Gamma', '# Gamma\n[[Alpha]]\n', 'Other');
    await choose(page, viewport, alpha);
    return { notebookId, alpha, beta };
}

async function choose(page, viewport, note) {
    await page.evaluate(async id => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(id), note.notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText(note.title, { exact: true }).first().click();
    await expectSourceText(page, note.text.replace(/\r\n?/g, '\n'));
}

async function openGraph(page, viewport) {
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav').getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.locator('.notes-graph')).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`graph filters, diagram and keyboard/touch list stay native and read-only at ${viewport.width}px`, async ({ page }, info) => {
        const { notebookId, alpha, beta } = await fixture(page, viewport);
        const graphImports = [];
        const writes = [];
        page.on('request', request => {
            if (request.url().includes('/scripts/notebooks/graph.js')) graphImports.push(request);
            if (request.url().endsWith('/api/notebooks/notes/update')) writes.push(request);
        });
        expect(graphImports).toHaveLength(0);
        const before = await notesApi(page, '/notes/read', alpha);
        const policy = await notesApi(page, '/policies/get', { notebookId });
        const history = await notesApi(page, '/history/list', alpha);
        await page.evaluate(async () => { globalThis.graphOriginalDocument = (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.doc; });
        await openGraph(page, viewport);
        const graph = page.locator('.notes-graph');
        await expect(graph.locator('[data-graph-note]')).toHaveCount(3, { timeout: 30000 });
        expect(graphImports).toHaveLength(1);
        await expect(graph.getByRole('button', { name: viewport.width < 769 ? 'List' : 'Diagram', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
        await expect(graph.getByRole('img', { name: 'Notebook links. Open a note using the list below.' })).toBeVisible();
        await expect(graph.locator('svg [data-graph-node]')).toHaveCount(3);
        await expect(graph.locator('svg line')).toHaveCount(2);
        const labelHeights = await graph.locator('svg text').evaluateAll(labels => labels.map(label => label.getBoundingClientRect().height));
        expect(labelHeights).toHaveLength(3);
        expect(labelHeights.every(height => height >= 12)).toBe(true);
        await graph.getByRole('textbox', { name: 'Graph folder', exact: true }).fill('World');
        await graph.getByRole('textbox', { name: 'Graph tag', exact: true }).fill('#world/cities');
        await graph.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expect(graph.locator('[data-graph-note]')).toHaveCount(2);
        await expect(graph.locator('.notes-graph-summary')).toHaveText('Showing 2 of 2 notes, with 1 connection.');
        await graph.getByRole('button', { name: 'Up to 50', exact: true }).click();
        await expect(graph.locator('[data-graph-note]')).toHaveCount(2);
        await expect(graph.getByRole('button', { name: 'Up to 50', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await graph.getByRole('button', { name: 'List', exact: true }).click();
        await expect(graph.locator('.notes-graph-map')).toBeHidden();
        await graph.getByRole('button', { name: 'Clear filters', exact: true }).click();
        await expect(graph.locator('[data-graph-note]')).toHaveCount(3);
        await graph.getByRole('textbox', { name: 'Graph folder', exact: true }).fill('No such folder');
        await graph.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expect(graph).toContainText('No notes match these filters.');
        await graph.getByRole('button', { name: 'Clear filters', exact: true }).click();
        await expect(graph.locator('[data-graph-note]')).toHaveCount(3);
        if (viewport.width > 768) await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
        await graph.locator('.notes-graph-head').scrollIntoViewIfNeeded();
        const geometry = await graph.evaluate(root => {
            const box = root.getBoundingClientRect();
            const controls = [...root.querySelectorAll('button, input')].filter(control => control.getClientRects().length);
            return { left: box.left, right: box.right, background: getComputedStyle(root.closest('.notes-app')).backgroundColor,
                heights: controls.map(control => control.getBoundingClientRect().height), font: getComputedStyle(root).fontFamily };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(-1);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.heights.every(height => height >= 44)).toBe(true);
        expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
        await info.attach('native-graph-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('notebook-graph.png') });
        await graph.getByRole('button', { name: 'Back to note', exact: true }).click();
        await expectSourceText(page, alpha.text.replace(/\r\n?/g, '\n'));
        expect(await page.evaluate(async () => globalThis.graphOriginalDocument === (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.doc)).toBe(true);
        expect((await notesApi(page, '/notes/read', alpha)).note).toEqual(before.note);
        expect((await notesApi(page, '/policies/get', { notebookId })).policy).toEqual(policy.policy);
        expect((await notesApi(page, '/history/list', alpha)).history).toEqual(history.history);
        expect(writes).toHaveLength(0);
        await openGraph(page, viewport);
        await expect(graph.locator(`[data-graph-note="${beta.noteId}"]`)).toBeVisible();
        const control = graph.locator(`[data-graph-note="${beta.noteId}"]`);
        if (viewport.width > 768) { await control.focus(); await control.press('Enter'); }
        else await control.tap();
        await expect(graph).toBeHidden();
        await expectSourceText(page, beta.text.replace(/\r\n?/g, '\n'));
    });

    test(`delayed graph results keep typed filters and cannot replace a later notebook at ${viewport.width}px`, async ({ page }) => {
        const { alpha } = await fixture(page, viewport);
        let release;
        let completed;
        const held = new Promise(resolve => { release = resolve; });
        const done = new Promise(resolve => { completed = resolve; });
        gates.get(page).push(release);
        let waiting;
        const entered = new Promise(resolve => { waiting = resolve; });
        const handler = async route => {
            const response = await route.fetch();
            waiting();
            await held;
            await route.fulfill({ response });
            completed();
        };
        await page.route('**/api/notebooks/graph', handler, { times: 1 });
        await openGraph(page, viewport);
        await entered;
        const graph = page.locator('.notes-graph');
        const folder = graph.getByRole('textbox', { name: 'Graph folder', exact: true });
        await folder.fill('World');
        release();
        await done;
        await expect(graph.locator('[data-graph-note]')).toHaveCount(3);
        await expect(folder).toHaveValue('World');
        await page.unroute('**/api/notebooks/graph', handler);
        let releaseAgain;
        let completedAgain;
        const heldAgain = new Promise(resolve => { releaseAgain = resolve; });
        const doneAgain = new Promise(resolve => { completedAgain = resolve; });
        gates.get(page).push(releaseAgain);
        let waitingAgain;
        const enteredAgain = new Promise(resolve => { waitingAgain = resolve; });
        await page.route('**/api/notebooks/graph', async route => {
            const response = await route.fetch(); waitingAgain(); await heldAgain;
            await route.fulfill({ response }); completedAgain();
        }, { times: 1 });
        await graph.getByRole('button', { name: 'Refresh graph', exact: true }).click();
        await enteredAgain;
        const otherBook = await notesApi(page, '/create', { operationId: `browser:${randomUUID()}`, name: `Later graph notebook ${randomUUID()}` });
        const other = await notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId: otherBook.notebook.id, title: 'Later choice', text: 'Later notebook body.', folder: '' });
        await choose(page, viewport, { notebookId: otherBook.notebook.id, noteId: other.noteId, title: 'Later choice', text: 'Later notebook body.' });
        releaseAgain();
        await doneAgain;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(graph).toBeHidden();
        await expectSourceText(page, 'Later notebook body.');
        const state = await page.evaluate(async () => {
            const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
            return { notebookId: app.state.notebookId, noteId: app.state.note.id };
        });
        expect(state).toEqual({ notebookId: otherBook.notebook.id, noteId: other.noteId });
        expect(state.noteId).not.toBe(alpha.noteId);
    });
}

/* global getComputedStyle, globalThis, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expectSourceText, notesApi, openNotes, showNotebooks } from './notebooks-browser-fixture.js';

test.use({ hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(180000);
const gates = new WeakMap();
test.beforeEach(async ({ page }) => gates.set(page, []));
test.afterEach(async ({ page }) => {
    for (const release of gates.get(page) ?? []) release();
    await page.unrouteAll({ behavior: 'wait' });
});

async function notebook(page, viewport) {
    await openNotes(page, viewport);
    const result = await notesApi(page, '/create', { operationId: `table:${randomUUID()}`, name: `Table checks ${randomUUID()}` });
    expect(result.status).toBe('success');
    return result.notebook.id;
}

async function createNote(page, notebookId, title, text, folder = '') {
    const result = await notesApi(page, '/notes/create', { operationId: `table:${randomUUID()}`, notebookId, title, text, folder });
    expect(result.status).toBe('success');
    return { notebookId, noteId: result.noteId, revision: result.revision, title, text };
}

async function choose(page, viewport, note) {
    await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), note.notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText(note.title, { exact: true }).first().click();
    await expectSourceText(page, note.text.replace(/\r\n?/g, '\n'));
}

async function openTable(page, viewport) {
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav').getByRole('button', { name: 'Property table', exact: true }).click();
    await expect(page.locator('.notes-table-view')).toBeVisible();
    await expect(page.locator('.notes-property-table tbody tr').first()).toBeVisible({ timeout: 30000 });
}

async function columns(page, wanted) {
    const table = page.locator('.notes-table-view');
    await table.locator('.notes-table-column-picker > summary').click();
    const names = await table.locator('.notes-table-column-picker button').evaluateAll(nodes => nodes.map(node => ({ name: node.textContent.trim(), selected: node.getAttribute('aria-pressed') === 'true' })));
    for (const { name, selected } of names) {
        if (selected === wanted.includes(name)) continue;
        const reply = page.waitForResponse(response => response.url().endsWith('/api/notebooks/properties/table'));
        await table.locator('.notes-table-column-picker').getByRole('button', { name, exact: true }).click();
        await reply;
        await expect(table.locator('.notes-table-column-picker')).toHaveAttribute('open', '');
        await expect(table.locator('.notes-table-column-picker').getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', String(!selected));
    }
    await table.locator('.notes-table-column-picker > summary').click();
}

async function saveCell(page, title, key, value, type) {
    await page.getByRole('button', { name: `Edit ${key} for ${title}`, exact: true }).click();
    const popup = page.locator('dialog.popup:visible');
    await expect(popup.getByRole('heading', { name: `Edit ${key}`, exact: true })).toBeVisible();
    await expect(popup).not.toContainText('[object Object]');
    if (type) await popup.getByRole('button', { name: type, exact: true }).click();
    if (value !== null) await popup.getByRole('textbox', { name: 'Value', exact: true }).fill(value);
    await popup.getByRole('button', { name: 'Save property', exact: true }).click();
    await expect(popup).not.toBeVisible();
    const display = type === 'Remove property' ? 'Not set' : key === 'labels' ? JSON.stringify(JSON.parse(value)) : value;
    await expect(page.getByRole('button', { name: `Edit ${key} for ${title}`, exact: true })).toHaveText(display);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`property table is lazy, filtered, numerically sorted and server-paged at ${viewport.width}px`, async ({ page }, info) => {
        const modules = [];
        page.on('request', request => { if (request.url().endsWith('/scripts/notebooks/property-table.js')) modules.push(request); });
        const notebookId = await notebook(page, viewport);
        const notes = [];
        for (let index = 0; index < 30; index++) {
            const title = `Table note ${String(index).padStart(3, '0')}`;
            notes.push(await createNote(page, notebookId, title, `---\r\ntitle: ${title}\r\nscore: ${index}\r\ntags: [world/cities]\r\n---\r\n# ${title}\r\nExact saved body.\r\n`, 'World/Cities'));
        }
        await choose(page, viewport, notes[0]);
        await page.evaluate(async () => { globalThis.tableOriginalDocument = (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.doc; });
        const before = await notesApi(page, '/policies/get', { notebookId });
        const writes = [];
        page.on('request', request => { if (request.url().endsWith('/api/notebooks/notes/update')) writes.push(request); });
        expect(modules).toHaveLength(0);
        await openTable(page, viewport);
        expect(modules).toHaveLength(1);
        const table = page.locator('.notes-table-view');
        await table.getByRole('button', { name: '25 rows per page', exact: true }).click();
        await expect(table.locator('tbody tr')).toHaveCount(25);
        await table.getByLabel('Sort property', { exact: true }).fill('score');
        await table.getByRole('button', { name: 'Sort by property', exact: true }).click();
        await table.getByRole('button', { name: 'Descending', exact: true }).click();
        await expect(table.locator('tbody tr').first()).toContainText('Table note 029');
        await table.getByRole('button', { name: 'Next page', exact: true }).click();
        await expect(table.locator('tbody tr')).toHaveCount(5);
        await expect(table).toContainText('Showing notes 26-30 of 30.');
        await expect(table.locator('tbody tr').first()).toContainText('Table note 004');
        await table.getByRole('button', { name: 'Previous page', exact: true }).click();
        await expect(table.locator('tbody tr')).toHaveCount(25);
        await table.getByLabel('Folder', { exact: true }).fill('World');
        await table.getByLabel('Tag', { exact: true }).fill('#world');
        await table.getByLabel('Filter property', { exact: true }).fill('score');
        await table.getByLabel('Filter value', { exact: true }).fill('27');
        await table.getByLabel('Filter value type', { exact: true }).selectOption('number');
        await table.getByLabel('Comparison', { exact: true }).selectOption('greater');
        await table.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expect(table.locator('tbody tr')).toHaveCount(2);
        await expect(table.locator('tbody tr').last()).toContainText('Table note 028');
        await table.getByLabel('Find notes', { exact: true }).fill('no matching note');
        await table.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expect(table).toContainText('No notes match these filters.');
        await table.getByRole('button', { name: 'Clear filters', exact: true }).click();
        await expect(table.locator('tbody tr')).toHaveCount(25);

        const geometry = await table.evaluate(root => ({ width: root.getBoundingClientRect().width,
            background: getComputedStyle(root.querySelector('.notes-property-table-scroll')).backgroundColor,
            touchAction: getComputedStyle(root.querySelector('.notes-property-table-scroll')).touchAction,
            controls: [...root.querySelectorAll('button, input, select, summary')].filter(node => node.getBoundingClientRect().height).map(node => node.getBoundingClientRect().height),
            contentWidth: root.querySelector('.notes-property-table-scroll').scrollWidth,
            viewportWidth: root.querySelector('.notes-property-table-scroll').clientWidth }));
        expect(geometry.width).toBeLessThanOrEqual(viewport.width);
        expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(geometry.controls.every(height => height >= 44)).toBe(true);
        expect(geometry.touchAction).toBe('pan-x');
        await table.locator('.notes-property-table-scroll').scrollIntoViewIfNeeded();
        if (viewport.width < 768) {
            expect(geometry.contentWidth).toBeGreaterThan(geometry.viewportWidth);
            const client = await page.context().newCDPSession(page);
            const rail = table.locator('.notes-property-table-scroll');
            await rail.locator('thead').scrollIntoViewIfNeeded();
            const box = await rail.boundingBox();
            const pane = await page.locator('.notes-pane-editor').boundingBox();
            const top = Math.max(box.y, pane.y);
            const bottom = Math.min(box.y + box.height, pane.y + pane.height, viewport.height);
            expect(bottom).toBeGreaterThan(top);
            const y = (top + bottom) / 2;
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 250, y }] });
            for (const x of [230, 190, 150, 110, 70]) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + x, y }] });
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await expect.poll(() => rail.evaluate(node => node.scrollLeft)).toBeGreaterThan(30);
            const beforeVertical = await page.locator('.notes-table-pane').evaluate(node => node.scrollTop);
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 100, y }] });
            for (const distance of [20, 40, 60, 80, 100]) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 101, y: y - distance }] });
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await expect.poll(() => page.locator('.notes-table-pane').evaluate(node => node.scrollTop)).toBeGreaterThan(beforeVertical + 30);
            await client.detach();
        }
        await info.attach('table-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('property-table.png') });
        await table.getByRole('button', { name: 'Back to note', exact: true }).click();
        await expectSourceText(page, notes[0].text.replace(/\r\n?/g, '\n'));
        expect(await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.doc === globalThis.tableOriginalDocument)).toBe(true);
        expect(writes).toHaveLength(0);
        expect((await notesApi(page, '/notes/read', notes[0])).note.text).toBe(notes[0].text);
        expect((await notesApi(page, '/policies/get', { notebookId })).policy).toEqual(before.policy);
    });

    test(`property cells retain types, comments and conflict values at ${viewport.width}px`, async ({ page }, info) => {
        const notebookId = await notebook(page, viewport);
        const text = '---\r\ntitle: Typed source\r\nscore: 2 # kept score comment\r\nenabled: false\r\nlabels:\r\n  - one # kept list comment\r\n  - two # kept second comment\r\nnested:\r\n  untouched: hidden nested value\r\nempty: null\r\nneconyan_id: n_1122334455667788\r\ntextish: "002"\r\n---\r\n# Exact body\r\nSaved verbatim after all cell edits.\r\n';
        const note = await createNote(page, notebookId, 'Typed source', text);
        await choose(page, viewport, note);
        const before = await notesApi(page, '/policies/get', { notebookId });
        await openTable(page, viewport);
        await columns(page, ['score', 'enabled', 'labels', 'nested', 'empty', 'neconyan_id', 'textish']);
        const table = page.locator('.notes-table-view');
        for (const key of ['nested', 'empty', 'neconyan_id']) await expect(table.getByRole('button', { name: `Edit ${key} for Typed source`, exact: true })).toHaveCount(0);
        await expect(table).not.toContainText('hidden nested value');
        await page.getByRole('button', { name: 'Edit score for Typed source', exact: true }).click();
        const popup = page.locator('dialog.popup:visible');
        await popup.getByRole('textbox', { name: 'Value', exact: true }).fill('not a number');
        await popup.getByRole('button', { name: 'Save property', exact: true }).click();
        await expect(popup).toContainText('Enter a finite number');
        await expect(popup.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('not a number');
        await popup.getByRole('textbox', { name: 'Value', exact: true }).fill('3.5');
        await popup.getByRole('button', { name: 'Save property', exact: true }).click();
        await expect(popup).not.toBeVisible();
        await expect(table.getByRole('button', { name: 'Edit score for Typed source', exact: true })).toHaveText('3.5');
        await saveCell(page, 'Typed source', 'enabled', 'true');
        await saveCell(page, 'Typed source', 'labels', '["changed", "two"]');
        await saveCell(page, 'Typed source', 'textish', '003', 'Text');
        const saved = (await notesApi(page, '/notes/read', note)).note;
        expect(saved.properties.score).toBe(3.5);
        expect(saved.properties.enabled).toBe(true);
        expect(saved.properties.labels).toEqual(['changed', 'two']);
        expect(saved.properties.textish).toBe('003');
        expect(saved.text).toContain('kept score comment');
        expect(saved.text).toContain('kept list comment');
        expect(saved.text).toContain('kept second comment');
        expect(saved.text).toContain('hidden nested value');
        expect(saved.text.endsWith('# Exact body\r\nSaved verbatim after all cell edits.\r\n')).toBe(true);

        await table.getByRole('button', { name: 'Edit score for Typed source', exact: true }).click();
        await popup.getByRole('textbox', { name: 'Value', exact: true }).fill('50');
        const peer = await page.context().request.post('/api/notebooks/notes/update', { headers: await page.evaluate(async () => (await import('/script.js')).getRequestHeaders()),
            data: { operationId: `table:${randomUUID()}`, notebookId, noteId: note.noteId, expectedRevision: saved.revision, changes: [{ type: 'properties', set: { score: 99 } }] } });
        expect(peer.status()).toBe(200);
        const attempted = page.waitForRequest(request => request.url().endsWith('/api/notebooks/notes/update') && request.postDataJSON().changes[0].set.score === 50);
        await popup.getByRole('button', { name: 'Save property', exact: true }).click();
        expect((await attempted).postDataJSON().expectedRevision).toBe(saved.revision);
        await expect(popup).toContainText('Nothing was overwritten');
        await expect(popup.getByRole('textbox', { name: 'Value', exact: true })).toHaveValue('50');
        expect((await notesApi(page, '/notes/read', note)).note.properties.score).toBe(99);
        await info.attach('typed-property-dialog', { body: JSON.stringify(await popup.evaluate(root => ({ width: root.getBoundingClientRect().width,
            controls: [...root.querySelectorAll('button, .popup-control, .popup-button, textarea')].filter(node => node.getBoundingClientRect().height).map(node => node.getBoundingClientRect().height) }))), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('property-conflict.png') });
        await popup.getByRole('button', { name: 'Not now', exact: true }).click();
        await table.getByRole('button', { name: 'Refresh table', exact: true }).click();
        await expect(table.getByRole('button', { name: 'Edit score for Typed source', exact: true })).toHaveText('99');
        await saveCell(page, 'Typed source', 'textish', null, 'Remove property');
        expect(Object.hasOwn((await notesApi(page, '/notes/read', note)).note.properties, 'textish')).toBe(false);
        expect((await notesApi(page, '/policies/get', { notebookId })).policy).toEqual(before.policy);
        await table.getByRole('button', { name: 'Typed source', exact: true }).click();
        const latest = (await notesApi(page, '/notes/read', note)).note.text.replace(/\r\n?/g, '\n');
        await expectSourceText(page, latest);
        if (viewport.width < 768) await page.locator('.notes-pane-tabs').getByRole('button', { name: 'Details', exact: true }).click();
        const details = page.locator('.notes-pane-details');
        await details.getByRole('button', { name: 'Links', exact: true }).click();
        await details.getByRole('button', { name: 'Exact body', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true })).toBeVisible();
        expect(await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.selection.main.head)).toBe(latest.indexOf('# Exact body'));
    });

    test(`delayed table replies preserve filter typing and cannot replace a later note at ${viewport.width}px`, async ({ page }) => {
        const notebookId = await notebook(page, viewport);
        const original = await createNote(page, notebookId, 'Original table note', '---\nscore: 2\n---\nOriginal saved body.\n');
        await choose(page, viewport, original);
        let release;
        const held = new Promise(resolve => { release = resolve; });
        gates.get(page).push(release);
        let reached;
        const started = new Promise(resolve => { reached = resolve; });
        const route = async handler => { const response = await handler.fetch(); reached(); await held; await handler.fulfill({ response }); };
        await page.route('**/api/notebooks/properties/table', route);
        await showNotebooks(page, viewport);
        await page.locator('.notes-pane-nav').getByRole('button', { name: 'Property table', exact: true }).click();
        await started;
        const table = page.locator('.notes-table-view');
        await table.getByLabel('Folder', { exact: true }).fill('World/Cities');
        release();
        await expect(table.locator('tbody tr')).toHaveCount(1);
        await expect(table.getByLabel('Folder', { exact: true })).toHaveValue('World/Cities');
        await page.unroute('**/api/notebooks/properties/table', route);

        let releaseSecond;
        const heldSecond = new Promise(resolve => { releaseSecond = resolve; });
        gates.get(page).push(releaseSecond);
        let reachedSecond;
        const startedSecond = new Promise(resolve => { reachedSecond = resolve; });
        const secondRoute = async handler => { const response = await handler.fetch(); reachedSecond(); await heldSecond; await handler.fulfill({ response }); };
        await page.route('**/api/notebooks/properties/table', secondRoute);
        await table.getByRole('button', { name: 'Refresh table', exact: true }).click();
        await startedSecond;
        const otherId = (await notesApi(page, '/create', { operationId: `table:${randomUUID()}`, name: `Other table ${randomUUID()}` })).notebook.id;
        const other = await createNote(page, otherId, 'Later chosen note', 'Only the later chosen note.\n');
        await choose(page, viewport, other);
        releaseSecond();
        await page.unroute('**/api/notebooks/properties/table', secondRoute);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(table).not.toBeVisible();
        await expectSourceText(page, other.text);
        expect(await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().state.notebookId)).toBe(otherId);
    });
}

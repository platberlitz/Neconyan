/* global getComputedStyle, globalThis, requestAnimationFrame, Storage */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { enterNotes, expectSourceText, notesApi, openNotes, showNotebooks } from './notebooks-browser-fixture.js';

test.use({ hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(180000);
const gates = new WeakMap();
test.beforeEach(async ({ page }) => gates.set(page, []));
test.afterEach(async ({ page }) => {
    for (const release of gates.get(page) ?? []) release();
    await page.unrouteAll({ behavior: 'wait' });
});

const request = (page, route, body) => notesApi(page, `/canvas/${route}`, body);
const canvasView = page => page.locator('.notes-canvas-view');
const card = (page, id) => canvasView(page).locator(`[data-canvas-card="${id}"]`);

async function setup(page, viewport) {
    await openNotes(page, viewport);
    const book = await notesApi(page, '/create', { operationId: `canvas:${randomUUID()}`, name: `Canvas checks ${randomUUID()}` });
    expect(book.status).toBe('success');
    const notebookId = book.notebook.id;
    const text = '---\r\ntitle: Canvas reference\r\n---\r\n# Canvas reference\r\n## Details\r\nSaved note passage. ![[Unshared]]\r\n';
    const note = await notesApi(page, '/notes/create', { notebookId, operationId: `canvas:${randomUUID()}`, title: 'Canvas reference', folder: 'Notes', text });
    expect(note.status).toBe('success');
    const document = { future: { version: 7, keep: ['one', 2] }, nodes: [
        { id: 'group', type: 'group', x: -20, y: -20, width: 720, height: 420, label: 'Planning group', color: '2',
            background: 'https://example.com/never-fetch-canvas-background.png', backgroundStyle: 'repeat', plugin: { keep: true } },
        { id: 'text', type: 'text', x: 0, y: 0, width: 320, height: 180, text: 'Initial planning text. <script>globalThis.canvasExecuted = true</script>',
            color: '#AABBCC', plugin: { opaque: ['keep', 7] } },
        { id: 'file', type: 'file', x: 360, y: 0, width: 320, height: 180, file: '../Notes/Canvas reference.md', subpath: '#Details' },
        { id: 'missing', type: 'file', x: 0, y: 220, width: 320, height: 180, file: 'Never existed.md' },
        { id: 'link', type: 'link', x: 360, y: 220, width: 320, height: 180, url: 'javascript:alert(1)' },
        { id: 'opaque', type: 'future-card', x: 720, y: 0, width: 320, height: 180, custom: { command: 'never execute', keep: true } },
    ], edges: [{ id: 'edge', fromNode: 'text', toNode: 'file', fromSide: 'bottom', toSide: 'top', toEnd: 'arrow', label: 'Saved relation', future: ['keep'] }] };
    const created = await request(page, 'create', { notebookId, operationId: `canvas:${randomUUID()}`, title: 'Board', folder: 'Plans', document });
    expect(created.status).toBe('success');
    await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText('Canvas reference', { exact: true }).first().click();
    await expectSourceText(page, text.replace(/\r\n/g, '\n'));
    return { notebookId, noteId: note.noteId, noteRevision: note.revision, noteText: text, canvasId: created.canvasId, document, revision: created.revision };
}

async function openCanvas(page, viewport) {
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav').getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(canvasView(page)).toBeVisible();
    await expect(card(page, 'file')).toContainText('Saved note passage.', { timeout: 30000 });
}

async function editText(page, id, text) {
    await card(page, id).getByRole('button', { name: 'Edit card', exact: true }).click();
    const popup = page.locator('dialog.popup:visible');
    await expect(popup.getByRole('heading', { name: 'Edit card', exact: true })).toBeVisible();
    await popup.getByRole('textbox', { name: 'Card text (Markdown)', exact: true }).fill(text);
    await popup.getByRole('button', { name: 'Apply to draft', exact: true }).click();
    await expect(popup).not.toBeVisible();
    await expect(card(page, id)).toContainText(text);
}

async function savedCanvas(page, f) {
    const result = await request(page, 'read', { notebookId: f.notebookId, canvasId: f.canvasId });
    expect(result.status).toBe('success');
    return result.canvas;
}

async function peerUpdate(page, context, f, text) {
    const { getRequestHeaders } = await page.evaluate(() => import('/script.js').then(module => ({ getRequestHeaders: module.getRequestHeaders() })));
    const saved = await savedCanvas(page, f);
    const document = structuredClone(saved.document);
    document.nodes.find(node => node.id === 'text').text = text;
    const response = await context.request.post('/api/notebooks/canvas/update', { headers: getRequestHeaders,
        data: { notebookId: f.notebookId, canvasId: f.canvasId, operationId: `canvas-peer:${randomUUID()}`, expectedRevision: saved.revision, document } });
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.status).toBe('success');
    return result;
}

async function draft(page, f) {
    return page.evaluate(async f => {
        const { readCanvasDraft } = await import('/scripts/notebooks/canvas-drafts.js');
        const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
        return readCanvasDraft(app.state.account, f.notebookId, f.canvasId);
    }, f);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`a downloaded window-only canvas can be confirmed without silently saving or losing later edits at ${viewport.width}px`, async ({ page }) => {
        const f = await setup(page, viewport);
        await openCanvas(page, viewport);
        await page.evaluate(() => {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
                if (String(key).startsWith('neconyan-canvas-draft:')) throw new Error('Deliberate Canvas device-storage failure.');
                return original.call(this, key, value);
            };
        });
        await editText(page, 'text', 'Window-only planning change.');
        await canvasView(page).getByRole('button', { name: 'Back to note', exact: true }).click();
        await expect(canvasView(page)).toBeVisible();
        await expect(canvasView(page).getByRole('button', { name: 'I\'ve saved the download', exact: true })).toHaveCount(0);
        const download = page.waitForEvent('download');
        await canvasView(page).getByRole('button', { name: 'Download canvas', exact: true }).click();
        const first = await download;
        const copied = JSON.parse(await fs.readFile(await first.path(), 'utf8'));
        expect(copied.nodes.find(node => node.id === 'text').text).toBe('Window-only planning change.');
        expect(copied.future).toEqual(f.document.future);
        await canvasView(page).getByRole('button', { name: 'I\'ve saved the download', exact: true }).click();
        await editText(page, 'text', 'Another window-only change.');
        await expect(canvasView(page).getByRole('button', { name: 'I\'ve saved the download', exact: true })).toHaveCount(0);
        await canvasView(page).getByRole('button', { name: 'Back to note', exact: true }).click();
        await expect(canvasView(page)).toBeVisible();
        const latest = page.waitForEvent('download');
        await canvasView(page).getByRole('button', { name: 'Download canvas', exact: true }).click();
        const second = await latest;
        expect(JSON.parse(await fs.readFile(await second.path(), 'utf8')).nodes.find(node => node.id === 'text').text).toBe('Another window-only change.');
        await canvasView(page).getByRole('button', { name: 'I\'ve saved the download', exact: true }).click();
        await canvasView(page).getByRole('button', { name: 'Back to note', exact: true }).click();
        await expect(canvasView(page)).toBeHidden();
        await expectSourceText(page, f.noteText.replace(/\r\n/g, '\n'));
        const saved = await savedCanvas(page, f);
        expect(saved.document).toEqual(f.document);
        expect(saved.revision).toBe(f.revision);
    });

    test(`portable Canvas cards, board movement and checked saves work at ${viewport.width}px`, async ({ page, context }, info) => {
        const modules = [];
        const remote = [];
        const writes = [];
        page.on('request', request => {
            if (request.url().endsWith('/scripts/notebooks/canvas.js')) modules.push(request);
            if (request.url().startsWith('https://example.com/never-fetch')) remote.push(request.url());
            if (request.url().endsWith('/api/notebooks/canvas/update')) writes.push(request);
        });
        const f = await setup(page, viewport);
        expect(modules).toHaveLength(0);
        const policy = (await notesApi(page, '/policies/get', { notebookId: f.notebookId })).policy;
        await page.evaluate(async () => { globalThis.canvasOriginalSource = (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.doc; });
        await openCanvas(page, viewport);
        expect(modules).toHaveLength(1);
        await expect(card(page, 'missing')).toContainText('Note unavailable.');
        await expect(card(page, 'missing').getByRole('button', { name: 'Open note', exact: true })).toHaveCount(0);
        await expect(card(page, 'link').getByRole('link')).toHaveCount(0);
        await expect(card(page, 'opaque')).toContainText('Unsupported card type');
        await expect(card(page, 'file')).toContainText('![[Unshared]]');
        expect(await page.evaluate(() => globalThis.canvasExecuted)).toBeUndefined();
        await expect(canvasView(page).locator('script, iframe, form, img')).toHaveCount(0);
        expect(remote).toEqual([]);
        const preference = viewport.width <= 768 ? 'Card list' : 'Board';
        await expect(canvasView(page).getByRole('button', { name: preference, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await editText(page, 'text', 'Planning text stays local until Save canvas.');
        expect(writes).toHaveLength(0);
        expect((await savedCanvas(page, f)).revision).toBe(f.revision);
        await canvasView(page).getByRole('button', { name: 'Undo canvas change', exact: true }).click();
        await expect(card(page, 'text')).toContainText('Initial planning text.');
        await canvasView(page).getByRole('button', { name: 'Redo canvas change', exact: true }).click();
        await expect(card(page, 'text')).toContainText('Planning text stays local until Save canvas.');
        await canvasView(page).getByRole('button', { name: 'Board', exact: true }).click();
        await expect(canvasView(page).locator('[data-canvas-node]')).toHaveCount(6);
        const order = await canvasView(page).locator('[data-canvas-node]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-canvas-node')));
        expect(order).toEqual(f.document.nodes.map(node => node.id));
        const captions = await canvasView(page).locator('[data-canvas-node] > text').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        expect(Math.min(...captions)).toBeGreaterThanOrEqual(12);
        const hitTargets = await canvasView(page).locator('.notes-canvas-hit').evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(); return { width: box.width, height: box.height };
        }));
        expect(hitTargets).toHaveLength(6);
        for (const target of hitTargets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44); }
        const edge = canvasView(page).locator('.notes-canvas-diagram > line');
        await expect(edge).toHaveAttribute('marker-end', /url\(#notes-canvas-arrow-/);
        await canvasView(page).getByRole('button', { name: 'Move cards', exact: true }).click();
        expect(await canvasView(page).locator('.notes-canvas-diagram').evaluate(node => getComputedStyle(node).touchAction)).toBe('none');
        const moving = canvasView(page).locator('[data-canvas-node="text"]');
        await moving.scrollIntoViewIfNeeded();
        const bounds = await moving.boundingBox();
        const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        if (viewport.width <= 768) {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
            for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + step * 5, y: start.y + step * 3, id: 1 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(start.x + 30, start.y + 18, { steps: 6 });
            await page.mouse.up();
        }
        await expect.poll(async () => (await draft(page, f)).document.nodes.find(node => node.id === 'text').x).toBeGreaterThan(0);
        await canvasView(page).getByRole('button', { name: 'Move cards', exact: true }).click();
        expect(await canvasView(page).locator('.notes-canvas-diagram').evaluate(node => getComputedStyle(node).touchAction)).toBe('auto');
        await canvasView(page).getByRole('button', { name: 'Add note card', exact: true }).click();
        const picker = page.locator('dialog.popup:visible');
        await picker.getByRole('button', { name: /Canvas reference \(Notes\/Canvas reference.md\)/ }).click();
        await picker.getByRole('button', { name: 'Add card', exact: true }).click();
        await expect(picker).not.toBeVisible();
        await expect(canvasView(page).locator('.notes-canvas-card')).toHaveCount(7);
        await canvasView(page).getByRole('button', { name: 'Add connection', exact: true }).click();
        const connection = page.locator('dialog.popup:visible');
        await connection.getByRole('combobox', { name: 'From card', exact: true }).selectOption('text');
        await connection.getByRole('combobox', { name: 'To card', exact: true }).selectOption('file');
        await connection.getByRole('combobox', { name: 'From side', exact: true }).selectOption('left');
        await connection.getByRole('combobox', { name: 'To end', exact: true }).selectOption('none');
        await connection.getByRole('textbox', { name: 'Connection label', exact: true }).fill('New declared relation');
        await connection.getByRole('button', { name: 'Apply to draft', exact: true }).click();
        await expect(connection).not.toBeVisible();
        expect(writes).toHaveLength(0);
        await canvasView(page).getByRole('button', { name: 'Save canvas', exact: true }).click();
        await expect(canvasView(page).locator('[data-canvas-status]')).toHaveText('Saved canvas');
        const saved = await savedCanvas(page, f);
        expect(saved.document.future).toEqual(f.document.future);
        expect(saved.document.nodes.find(node => node.id === 'text').plugin).toEqual(f.document.nodes[1].plugin);
        expect(saved.document.nodes.find(node => node.id === 'opaque')).toEqual(f.document.nodes[5]);
        expect(saved.document.edges[0].future).toEqual(['keep']);
        expect(saved.document.edges[1]).toMatchObject({ fromNode: 'text', toNode: 'file', fromSide: 'left', toEnd: 'none', label: 'New declared relation' });
        expect(saved.revision).not.toBe(f.revision);
        const [download] = await Promise.all([page.waitForEvent('download'), canvasView(page).getByRole('button', { name: 'Download canvas', exact: true }).click()]);
        expect(JSON.parse(await fs.readFile(await download.path(), 'utf8'))).toEqual(saved.document);
        expect((await notesApi(page, '/policies/get', { notebookId: f.notebookId })).policy).toEqual(policy);
        const source = await notesApi(page, '/notes/read', { notebookId: f.notebookId, noteId: f.noteId });
        expect(source.note.text).toBe(f.noteText);
        expect(source.note.revision).toBe(f.noteRevision);
        expect(remote).toEqual([]);
        const geometry = await canvasView(page).evaluate(root => {
            const box = root.getBoundingClientRect();
            const controls = [...root.querySelectorAll('button, summary')].filter(node => node.getBoundingClientRect().height > 0);
            return { right: box.right, width: box.width, background: getComputedStyle(root).backgroundColor,
                minimumTarget: Math.min(...controls.map(node => node.getBoundingClientRect().height)), font: getComputedStyle(root.querySelector('h2')).fontFamily };
        });
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.minimumTarget).toBeGreaterThanOrEqual(44);
        await info.attach('canvas-geometry.json', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await canvasView(page).getByRole('heading', { name: 'Planning canvases', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('planning-canvas.png') });
        await canvasView(page).getByRole('button', { name: 'Back to note', exact: true }).click();
        await expectSourceText(page, f.noteText.replace(/\r\n/g, '\n'));
        expect(await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor.view.state.doc === globalThis.canvasOriginalSource)).toBe(true);
        await openCanvas(page, viewport);
        await card(page, 'file').getByRole('button', { name: 'Open note', exact: true }).click();
        await expectSourceText(page, f.noteText.replace(/\r\n/g, '\n'));
        await expect(page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true })).toBeVisible();
    });

    test(`Canvas conflicts and device drafts keep deliberate choices at ${viewport.width}px`, async ({ page, context }, info) => {
        const f = await setup(page, viewport);
        await openCanvas(page, viewport);
        for (const choice of ['Use saved canvas', 'Save my canvas as copy', 'Keep my version']) {
            await editText(page, 'text', `My choice: ${choice}.`);
            const original = await savedCanvas(page, f);
            await peerUpdate(page, context, f, `Other saved change: ${choice}.`);
            const failed = page.waitForResponse(response => response.url().endsWith('/api/notebooks/canvas/update'));
            await canvasView(page).getByRole('button', { name: 'Save canvas', exact: true }).click();
            const response = await failed;
            expect(response.status()).toBe(409);
            expect(response.request().postDataJSON().expectedRevision).toBe(original.revision);
            const banner = canvasView(page).locator('.notes-canvas-save-conflict');
            await expect(banner).toContainText('Nothing was overwritten.');
            await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
            expect((await draft(page, f)).document.nodes.find(node => node.id === 'text').text).toBe(`My choice: ${choice}.`);
            if (choice === 'Keep my version') await page.screenshot({ path: info.outputPath('canvas-conflict.png') });
            await banner.getByRole('button', { name: choice, exact: true }).click();
            await expect(banner).not.toBeVisible();
            await expect(canvasView(page).locator('[data-canvas-status]')).toHaveText('Saved canvas');
            if (choice === 'Save my canvas as copy') {
                expect((await savedCanvas(page, f)).document.nodes.find(node => node.id === 'text').text).toBe(`Other saved change: ${choice}.`);
                await expect(canvasView(page).locator('.notes-canvas-title')).toContainText('(my copy)');
                const copyId = await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().readPrefs().canvases[notebookId], f.notebookId);
                expect((await request(page, 'read', { notebookId: f.notebookId, canvasId: copyId })).canvas.document.nodes.find(node => node.id === 'text').text).toBe(`My choice: ${choice}.`);
                await canvasView(page).locator('.notes-canvas-files > summary').click();
                await canvasView(page).getByRole('button', { name: 'Plans/Board.canvas', exact: true }).click();
                await expect(canvasView(page).locator('.notes-canvas-title')).toHaveText('Plans/Board.canvas');
            } else {
                const wanted = choice === 'Use saved canvas' ? `Other saved change: ${choice}.` : `My choice: ${choice}.`;
                expect((await savedCanvas(page, f)).document.nodes.find(node => node.id === 'text').text).toBe(wanted);
            }
            expect(await draft(page, f)).toBeNull();
        }
        await editText(page, 'text', 'Device-only Canvas draft after reload.');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await enterNotes(page, viewport);
        await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), f.notebookId);
        await openCanvas(page, viewport);
        await expect(card(page, 'text')).toContainText('Device-only Canvas draft after reload.');
        await expect(canvasView(page)).toContainText('Restored the canvas draft saved on this device.');
        await peerUpdate(page, context, f, 'Peer changes before older device recovery.');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await enterNotes(page, viewport);
        await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), f.notebookId);
        await openCanvas(page, viewport);
        const older = canvasView(page).locator('.notes-canvas-draft-conflict');
        await expect(older).toBeVisible();
        await card(page, 'text').getByRole('button', { name: 'Edit card', exact: true }).click();
        await expect(page.locator('dialog.popup:visible')).toHaveCount(0);
        expect((await draft(page, f)).document.nodes.find(node => node.id === 'text').text).toBe('Device-only Canvas draft after reload.');
        await older.getByRole('button', { name: 'Discard device draft', exact: true }).click();
        expect(await draft(page, f)).toBeNull();
        await expect(card(page, 'text')).toContainText('Peer changes before older device recovery.');
    });

    test(`delayed Canvas reads keep newer local edits and later notebook selections at ${viewport.width}px`, async ({ page }) => {
        const f = await setup(page, viewport);
        await openCanvas(page, viewport);
        const held = new Promise(resolve => {
            const ready = async route => {
                const reply = await route.fetch();
                let release;
                const gate = new Promise(done => { release = done; });
                gates.get(page).push(release);
                resolve({ release, reply: async () => route.fulfill({ response: reply }) });
                await gate;
                await route.fulfill({ response: reply });
            };
            void page.route('**/api/notebooks/canvas/preview', ready, { times: 1 });
        });
        await editText(page, 'text', 'First pending preview.');
        const old = await held;
        await editText(page, 'text', 'Newest local preview text.');
        old.release();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(card(page, 'text')).toContainText('Newest local preview text.');
        expect((await draft(page, f)).document.nodes.find(node => node.id === 'text').text).toBe('Newest local preview text.');
        await page.unroute('**/api/notebooks/canvas/preview');
        let release;
        let announce;
        const announced = new Promise(resolve => { announce = resolve; });
        await page.route('**/api/notebooks/canvas/list', async route => {
            const response = await route.fetch();
            const wait = new Promise(resolve => { release = resolve; gates.get(page).push(release); });
            announce();
            await wait;
            await route.fulfill({ response });
        }, { times: 1 });
        await canvasView(page).getByRole('button', { name: 'Refresh files', exact: true }).click();
        await announced;
        const other = await notesApi(page, '/create', { operationId: `canvas:${randomUUID()}`, name: `Later Canvas book ${randomUUID()}` });
        const note = await notesApi(page, '/notes/create', { notebookId: other.notebook.id, operationId: `canvas:${randomUUID()}`, title: 'Later chosen note', text: '# Later chosen note\nDo not replace this.', folder: '' });
        await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), other.notebook.id);
        await showNotebooks(page, viewport);
        await page.locator('.notes-pane-nav .notes-note-title').getByText('Later chosen note', { exact: true }).first().click();
        release();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expectSourceText(page, '# Later chosen note\nDo not replace this.');
        await expect(canvasView(page)).not.toBeVisible();
        expect(await draft(page, f)).not.toBeNull();
        expect(note.status).toBe('success');
    });

    test(`new Canvas files, card types and history remain portable at ${viewport.width}px`, async ({ page }) => {
        const f = await setup(page, viewport);
        const remote = [];
        page.on('request', request => { if (request.url().startsWith('https://example.com/')) remote.push(request.url()); });
        await openCanvas(page, viewport);
        const name = `Fresh plan ${randomUUID()}`;
        await canvasView(page).getByRole('button', { name: 'New canvas', exact: true }).click();
        const prompt = page.locator('dialog.popup:visible');
        await prompt.getByRole('textbox').fill(name);
        await prompt.getByRole('button', { name: 'Create canvas', exact: true }).click();
        await expect(canvasView(page).locator('.notes-canvas-title')).toHaveText(`${name}.canvas`);
        const id = await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().readPrefs().canvases[notebookId], f.notebookId);
        await canvasView(page).getByRole('button', { name: 'Add text card', exact: true }).click();
        let popup = page.locator('dialog.popup:visible');
        await popup.getByRole('textbox', { name: 'Card text (Markdown)', exact: true }).fill('Fresh planning text, saved explicitly.');
        await popup.getByRole('spinbutton', { name: 'X position', exact: true }).fill('-120');
        await popup.getByRole('spinbutton', { name: 'Y position', exact: true }).fill('-80');
        await popup.getByRole('textbox', { name: 'Colour (1 to 6, or a six-digit hex colour)', exact: true }).fill('4');
        await popup.getByRole('button', { name: 'Apply to draft', exact: true }).click();
        await expect(popup).not.toBeVisible();
        await canvasView(page).getByRole('button', { name: 'Add web link', exact: true }).click();
        popup = page.locator('dialog.popup:visible');
        await popup.getByRole('textbox', { name: 'Web address', exact: true }).fill('https://example.com/never-fetch-canvas-link');
        await popup.getByRole('button', { name: 'Apply to draft', exact: true }).click();
        await expect(popup).not.toBeVisible();
        await canvasView(page).getByRole('button', { name: 'Add group', exact: true }).click();
        popup = page.locator('dialog.popup:visible');
        await popup.getByRole('textbox', { name: 'Group label', exact: true }).fill('Planning group');
        await popup.getByRole('button', { name: 'Apply to draft', exact: true }).click();
        await expect(popup).not.toBeVisible();
        await expect(canvasView(page).locator('.notes-canvas-card')).toHaveCount(3);
        expect((await request(page, 'read', { notebookId: f.notebookId, canvasId: id })).canvas.document.nodes).toHaveLength(0);
        expect(remote).toEqual([]);
        await canvasView(page).getByRole('button', { name: 'Save canvas', exact: true }).click();
        await expect(canvasView(page).locator('[data-canvas-status]')).toHaveText('Saved canvas');
        const saved = (await request(page, 'read', { notebookId: f.notebookId, canvasId: id })).canvas;
        expect(saved.document.nodes).toHaveLength(3);
        expect(saved.document.nodes[0]).toMatchObject({ type: 'text', x: -120, y: -80, color: '4' });
        await canvasView(page).getByRole('button', { name: 'Canvas history', exact: true }).click();
        const history = page.locator('dialog.popup:visible');
        await expect(history.getByRole('heading', { name: 'Canvas history', exact: true })).toBeVisible();
        await history.getByRole('button', { name: /\(canvas-create\)/ }).click();
        await expect(history.locator('pre')).toContainText('"nodes": []');
        await history.getByRole('button', { name: 'Use version', exact: true }).click();
        await expect(history).not.toBeVisible();
        await expect(canvasView(page).locator('.notes-canvas-card')).toHaveCount(0);
        expect((await request(page, 'read', { notebookId: f.notebookId, canvasId: id })).canvas.revision).toBe(saved.revision);
        await canvasView(page).getByRole('button', { name: 'Undo canvas change', exact: true }).click();
        await expect(canvasView(page).locator('.notes-canvas-card')).toHaveCount(3);
        await canvasView(page).getByRole('button', { name: 'Redo canvas change', exact: true }).click();
        await expect(canvasView(page).locator('.notes-canvas-card')).toHaveCount(0);
        await canvasView(page).getByRole('button', { name: 'Save canvas', exact: true }).click();
        await expect(canvasView(page).locator('[data-canvas-status]')).toHaveText('Saved canvas');
        expect((await request(page, 'read', { notebookId: f.notebookId, canvasId: id })).canvas.document.nodes).toHaveLength(0);
        expect((await request(page, 'history', { notebookId: f.notebookId, canvasId: id })).history).toHaveLength(3);
        expect((await savedCanvas(page, f)).document).toEqual(f.document);
        expect(remote).toEqual([]);
    });
}

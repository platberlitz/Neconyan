/* global document, getComputedStyle, globalThis, requestAnimationFrame */
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
    const result = await notesApi(page, '/create', { operationId: `browser:${randomUUID()}`, name: `Embed checks ${randomUUID()}` });
    expect(result.status).toBe('success');
    return result.notebook.id;
}

async function note(page, notebookId, title, text, folder = '') {
    const result = await notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId, title, text, folder });
    expect(result.status).toBe('success');
    return { notebookId, noteId: result.noteId, revision: result.revision, text, title };
}

async function choose(page, viewport, fixture) {
    await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), fixture.notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText(fixture.title, { exact: true }).first().click();
    await expectSourceText(page, fixture.text.replace(/\r\n?/g, '\n'));
}

async function read(page) {
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.locator('.notes-reader')).toBeVisible();
}

function card(page, fixture) {
    return page.locator(`.notes-reader .notes-embed[data-embed-note-id="${fixture.noteId}"]`);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`saved whole, heading and block embeds remain native and read-only at ${viewport.width}px`, async ({ page }, info) => {
        const notebookId = await notebook(page, viewport);
        const child = await note(page, notebookId, 'Child', '# Child heading\r\nThe correct folder child.\r\n', 'Folder');
        await note(page, notebookId, 'Child', 'Wrong root child.', '');
        const target = await note(page, notebookId, 'Target', '# Target guide\r\nWhole-note introduction.\r\n## Detail\r\nSaved paragraph line\r\nsecond line. ^passage\r\n\r\n[[./Child|Relative wiki]]\r\n[Relative Markdown](./Child.md)\r\n[Detail anchor](#detail)\r\n![Attached image](./pixel.png)\r\n![Remote preview](https://example.invalid/never-loaded.png)\r\n\r\n![[./Child]]\r\n\r\n## After\r\nOutside the selected heading.\r\n<script>globalThis.notesEmbedExecuted = true;</script>\r\n<iframe src="https://example.invalid/frame"></iframe>\r\n<form><input value="Never active"><button>Fake note button</button></form>\r\n<span class="notes-wikilink" data-note-path="Missing.md">Authored label</span>\r\n<span data-note-open="n_0000000000000000">Not a control</span>\r\n', 'Folder');
        const upload = await page.evaluate(async notebookId => {
            const { notesUpload } = await import('/scripts/notebooks/api.js');
            const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII='), character => character.charCodeAt(0));
            return notesUpload('/attachments/upload', { operationId: `browser:${crypto.randomUUID()}`, notebookId, folder: 'Folder' }, new File([png], 'pixel.png', { type: 'image/png' }));
        }, notebookId);
        expect(upload.status).toBe('success');
        const root = await note(page, notebookId, 'Embed workspace', '---\r\ntitle: Embed workspace\r\nstatus: draft\r\n---\r\n# Root view\r\n![[Folder/Target]]\r\n\r\n![[Folder/Target#Detail]]\r\n\r\n![[Folder/Target#^passage]]\r\n\r\nBefore **![[Folder/Target#Detail]]** after.\r\n\r\n![[Missing target]]\r\n\r\n`![[Folder/Target]]`\r\n\r\n\\![[Folder/Target]]\r\n\r\n    ![[Folder/Target]]\r\n\r\n[![[Folder/Target]]](https://example.invalid/literal)\r\n\r\n![Root remote](https://example.invalid/root-image.png)\r\n<table background="https://example.invalid/background.png"><tr><td>Inactive background</td></tr></table>\r\n');
        const beforePolicy = await notesApi(page, '/policies/get', { notebookId });
        const beforeHistory = await notesApi(page, '/history/list', root);
        const writes = [];
        const external = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/notebooks/notes/update')) writes.push(request);
            if (request.url().startsWith('https://example.invalid/')) external.push(request);
        });
        await choose(page, viewport, root);
        await read(page);
        await expect(card(page, target)).toHaveCount(4, { timeout: 30000 });
        await expect(card(page, child)).toHaveCount(3);
        const whole = card(page, target).filter({ has: page.locator(':scope > .notes-embed-header > .notes-embed-title', { hasText: /^Target$/ }) });
        const heading = card(page, target).filter({ has: page.locator(':scope > .notes-embed-header > .notes-embed-title', { hasText: /^Target: Detail$/ }) });
        const block = card(page, target).filter({ has: page.locator(':scope > .notes-embed-header > .notes-embed-title', { hasText: /^Target: \^passage$/ }) });
        await expect(whole).toHaveCount(1);
        await expect(whole).toContainText('Whole-note introduction.');
        await expect(heading).toHaveCount(2);
        await expect(heading.first()).not.toContainText('Outside the selected heading.');
        await expect(block).toContainText('Saved paragraph line');
        await expect(block).not.toContainText('Relative wiki');
        await expect(block.locator(':scope > .notes-embed-body')).not.toContainText('^passage');
        const reader = page.locator('.notes-reader');
        await expect(reader).not.toContainText('Wrong root child.');
        await expect(reader.locator('p .notes-embed')).toHaveCount(0);
        await expect(reader).toContainText('Before');
        await expect(reader).toContainText('after.');
        await expect(reader.locator('code').first()).toHaveText('![[Folder/Target]]');
        await expect(reader.locator('pre code')).toHaveText('![[Folder/Target]]');
        await expect(reader.locator('a[href="https://example.invalid/literal"]')).toHaveText('![[Folder/Target]]');
        await expect(reader.locator('script, iframe, form, input, [background], [ping], [data-note-path="Missing.md"], [data-note-open="n_0000000000000000"]')).toHaveCount(0);
        expect(await page.evaluate(() => globalThis.notesEmbedExecuted)).toBeUndefined();
        expect(await reader.textContent()).not.toContain('\uE100NNembed');
        const unavailable = reader.locator('.notes-embed-placeholder').filter({ hasText: /^Embedded note unavailable\.$/ });
        await expect(unavailable).toHaveCount(1);
        await expect(unavailable.locator('button, a, [data-embed-note-id]')).toHaveCount(0);
        const image = whole.locator('img[alt="Attached image"]');
        await expect(image).toHaveAttribute('src', new RegExp(`notebookId=${notebookId}.*path=Folder%2Fpixel\\.png`));
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1);
        expect(external.map(request => request.url())).toEqual([]);
        const fold = whole.locator(':scope > .notes-embed-header').getByRole('button', { name: 'Fold embed', exact: true });
        await fold.focus();
        await page.keyboard.press('Enter');
        await expect(whole.locator(':scope > .notes-embed-body')).toBeHidden();
        await whole.getByRole('button', { name: 'Show embed', exact: true }).click();
        await expect(whole.locator(':scope > .notes-embed-body')).toBeVisible();
        await whole.scrollIntoViewIfNeeded();
        const geometry = await whole.evaluate(element => ({
            left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
            background: getComputedStyle(element).backgroundColor,
            buttons: [...document.querySelectorAll('.notes-embed-header button')].map(button => button.getBoundingClientRect().height),
        }));
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
        for (const height of geometry.buttons) expect(height).toBeGreaterThanOrEqual(44);
        await info.attach('embed-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('rendered-embeds.png') });
        expect(writes).toHaveLength(0);
        expect((await notesApi(page, '/notes/read', root)).note.text).toBe(root.text);
        expect((await notesApi(page, '/notes/read', target)).note.text).toBe(target.text);
        expect((await notesApi(page, '/policies/get', { notebookId })).policy).toEqual(beforePolicy.policy);
        expect((await notesApi(page, '/history/list', root)).history).toEqual(beforeHistory.history);
        const rootImageRequest = page.waitForRequest('https://example.invalid/root-image.png');
        await reader.getByRole('button', { name: 'Load external image: Root remote', exact: true }).click();
        await rootImageRequest;
        const childImageRequest = page.waitForRequest('https://example.invalid/never-loaded.png');
        await whole.getByRole('button', { name: 'Load external image: Remote preview', exact: true }).click();
        await childImageRequest;
        expect(external.map(request => request.url())).toEqual(['https://example.invalid/root-image.png', 'https://example.invalid/never-loaded.png']);
        await whole.getByRole('link', { name: 'Relative wiki', exact: true }).click();
        await expectSourceText(page, child.text.replace(/\r\n/g, '\n'));
        await choose(page, viewport, root);
        await read(page);
        await expect(card(page, target)).toHaveCount(4);
        await card(page, target).first().getByRole('link', { name: 'Relative Markdown', exact: true }).click();
        await expectSourceText(page, child.text.replace(/\r\n/g, '\n'));
        await choose(page, viewport, root);
        await read(page);
        await expect(card(page, target)).toHaveCount(4);
        await card(page, target).first().getByRole('link', { name: 'Detail anchor', exact: true }).click();
        await expectSourceText(page, target.text.replace(/\r\n/g, '\n'));
        await choose(page, viewport, root);
        await read(page);
        await expect(card(page, target)).toHaveCount(4);
        await card(page, target).first().locator(':scope > .notes-embed-header').getByRole('button', { name: 'Open note', exact: true }).click();
        await expectSourceText(page, target.text.replace(/\r\n/g, '\n'));
        expect(writes).toHaveLength(0);
    });

    test(`cycles and preview limits remain bounded at ${viewport.width}px`, async ({ page }) => {
        const notebookId = await notebook(page, viewport);
        await note(page, notebookId, 'Cycle A', '# Cycle heading\n![[Cycle B]]');
        await note(page, notebookId, 'Cycle B', '![[Cycle A]]');
        await note(page, notebookId, 'Large', '🙂'.repeat(17000));
        const root = await note(page, notebookId, 'Bounded previews', '# Bounded previews\n![[Cycle A]]\n![[Large]]\n![[Unknown]]');
        const writes = [];
        page.on('request', request => { if (request.url().endsWith('/api/notebooks/notes/update')) writes.push(request); });
        await choose(page, viewport, root);
        await read(page);
        await expect(page.locator('.notes-reader .notes-embed-placeholder').filter({ hasText: /^Embedded note preview limit reached\.$/ })).toHaveCount(2, { timeout: 30000 });
        await expect(page.locator('.notes-reader .notes-embed-placeholder').filter({ hasText: /^Embedded note unavailable\.$/ })).toHaveCount(1);
        expect(await page.locator('.notes-reader .notes-embed').count()).toBeLessThanOrEqual(32);
        expect((await notesApi(page, '/notes/read', root)).note.text).toBe(root.text);
        expect(writes).toHaveLength(0);
    });

    test(`a delayed embed response cannot replace a later chosen note at ${viewport.width}px`, async ({ page }) => {
        const notebookId = await notebook(page, viewport);
        await note(page, notebookId, 'Delayed target', 'Old preview must not appear.');
        const first = await note(page, notebookId, 'First embed source', '![[Delayed target]]');
        const second = await note(page, notebookId, 'Second embed source', '# Second embed source\nThe later chosen note.');
        await choose(page, viewport, first);
        let signal;
        const held = new Promise(resolve => { signal = resolve; });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        gates.get(page).push(release);
        let holding = true;
        await page.route('**/api/notebooks/embeds', async route => {
            if (!holding || route.request().postDataJSON().noteId !== first.noteId) return route.continue();
            holding = false;
            const response = await route.fetch();
            signal();
            await gate;
            return route.fulfill({ response });
        });
        await read(page);
        await held;
        await choose(page, viewport, second);
        await expect(page.locator('.notes-reader')).toContainText('The later chosen note.');
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator('.notes-reader .notes-embed')).toHaveCount(0);
        await expect(page.locator('.notes-reader')).not.toContainText('Old preview must not appear.');
        await expectSourceText(page, second.text);
    });
}

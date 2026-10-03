/* global document, getComputedStyle */
import { expect, test } from '@playwright/test';
import { notesApi, openWorkspace } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block', hasTouch: true });
test.setTimeout(120000);
test.afterEach(async ({ context }) => {
    for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
});

async function worldRequest(page, route, body) {
    return page.evaluate(async ({ route, body }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`/api/worldinfo${route}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        return { status: response.status, revision: response.headers.get('X-World-Info-Revision'), data: response.ok ? await response.json() : await response.text() };
    }, { route, body });
}

async function openEntryContent(page) {
    const content = page.locator('#WorldInfo textarea[id="world_entry_content_0"]');
    const entry = page.locator('#world_popup_entries_list .world_entry[uid="0"]');
    if (!(await content.isVisible())) await entry.locator('button.inline-drawer-toggle').click();
    await expect(content).toBeVisible();
    return content;
}

async function openBook(page, viewport, name) {
    if (viewport.width <= 768) await page.locator('#sb-hamburger').click();
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="lorebooks"]').click();
    await page.locator('.neconyan-lorebook-book-open').filter({ hasText: name }).click();
    return openEntryContent(page);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`a native World Info draft cannot overwrite a publication from another tab at ${viewport.width}px`, async ({ page, context }, testInfo) => {
        await page.setViewportSize(viewport);
        await openWorkspace(page);
        const name = `Loaded revision ${viewport.width} ${Date.now()}`;
        const original = { entries: { 0: { uid: 0, comment: 'Established rules', key: ['healing'], keysecondary: [],
            content: 'Old lore content.', constant: false, selective: false, disable: false, order: 100, position: 0, depth: 4, probability: 100, useProbability: true } } };
        expect((await worldRequest(page, '/edit', { name, data: original, revision: null })).status).toBe(200);
        await page.evaluate(async () => (await import('/scripts/world-info.js')).updateWorldInfoList());
        const loaded = await worldRequest(page, '/get', { name });
        const content = await openBook(page, viewport, name);
        await expect(content).toHaveValue('Old lore content.');

        const publisher = await context.newPage();
        await publisher.setViewportSize(viewport);
        await openWorkspace(publisher);
        const notebook = await notesApi(publisher, '/create', { operationId: `wi-browser:nb:${Date.now()}`, name: `Revision fixture ${viewport.width}` });
        const note = await notesApi(publisher, '/notes/create', { operationId: `wi-browser:note:${Date.now()}`, notebookId: notebook.notebook.id,
            title: 'Healing rules', text: '# Healing rules\n\n## Established\nHealing transfers the injury to the healer.\n\n## Draft\nUnpublished idea.\n' });
        const selector = { kind: 'heading', path: ['Healing rules', 'Established'] };
        const args = { notebookId: notebook.notebook.id, noteId: note.noteId, selector, book: name, uid: 0 };
        const { preview } = await notesApi(publisher, '/lore/preview', args);
        const published = await notesApi(publisher, '/lore/publish', { ...args, operationId: `wi-browser:publish:${Date.now()}`,
            expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash });
        expect(published.status).toBe('success');
        const current = await worldRequest(publisher, '/get', { name });
        expect(current.data.entries[0].content).toBe('Healing transfers the injury to the healer.');
        expect(current.revision).not.toBe(loaded.revision);
        await expect(content).toHaveValue('Old lore content.');

        const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/edit') && response.request().postDataJSON()?.name === name);
        await content.fill('Stale editor draft that must not be published.');
        const refused = await saveResponse;
        expect(refused.status()).toBe(409);
        expect(refused.request().postDataJSON().revision).toBe(loaded.revision);
        await expect(page.locator('.toast-message').filter({ hasText: 'Nothing was overwritten; copy your draft' })).toBeVisible();
        await expect(content).toHaveValue('Stale editor draft that must not be published.');
        expect((await worldRequest(publisher, '/get', { name })).data).toEqual(current.data);

        // Notes and bundled tools can refresh an already open native editor.
        // Keeping its typed draft must not replace that draft's original guard.
        await page.evaluate(async name => (await import('/scripts/world-info.js')).showWorldEditor(name), name);
        await openEntryContent(page);
        await expect(content).toHaveValue('Stale editor draft that must not be published.');
        const refreshedConflict = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/edit') && response.request().postDataJSON()?.name === name);
        await content.fill('Still-stale draft after the editor display refreshed.');
        const refusedAgain = await refreshedConflict;
        expect(refusedAgain.status()).toBe(409);
        expect(refusedAgain.request().postDataJSON().revision).toBe(loaded.revision);
        expect((await worldRequest(publisher, '/get', { name })).data).toEqual(current.data);
        const geometry = await content.evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(),
            background: getComputedStyle(element).backgroundColor,
            close: document.querySelector('#right-nav-panel .sb-character-shell-header .sb-shell-close')?.getBoundingClientRect().toJSON() }));
        expect(geometry.rect.right).toBeLessThanOrEqual(viewport.width + 1);
        if (viewport.width <= 768) expect(geometry.close.height).toBeGreaterThanOrEqual(44);
        await testInfo.attach('world-info-conflict-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: testInfo.outputPath('world-info-stale-save.png') });

        await openWorkspace(page);
        const refreshed = await openBook(page, viewport, name);
        await expect(refreshed).toHaveValue('Healing transfers the injury to the healer.');
        const successfulSave = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/edit') && response.request().postDataJSON()?.name === name);
        await refreshed.fill('Owner edit after explicitly reloading.');
        const accepted = await successfulSave;
        expect(accepted.status()).toBe(200);
        expect(accepted.request().postDataJSON().revision).toBe(current.revision);
        expect((await worldRequest(publisher, '/get', { name })).data.entries[0].content).toBe('Owner edit after explicitly reloading.');
        await publisher.close();
    });
}

/* global requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { notesApi, openNotes } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block', hasTouch: true });
test.setTimeout(120000);
const releases = new WeakMap();
test.beforeEach(({ page }) => { releases.set(page, []); });
test.afterEach(async ({ page }) => {
    for (const release of releases.get(page) ?? []) release();
    await page.unrouteAll({ behavior: 'wait' });
});

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const rendered = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`delayed native notebook updates cannot undo a later choice at ${viewport.width}px`, async ({ page }) => {
        await openNotes(page, viewport);
        const suffix = `${viewport.width} ${Date.now()}`;
        const old = await notesApi(page, '/create', { name: `Earlier ${suffix}`, operationId: `workspace:old:${suffix.replaceAll(' ', ':')}` });
        const next = await notesApi(page, '/create', { name: `Chosen ${suffix}`, operationId: `workspace:new:${suffix.replaceAll(' ', ':')}` });
        const oldId = old.notebook.id;
        const newId = next.notebook.id;
        const oldTitle = `Earlier note ${suffix}`;
        const newTitle = `Chosen note ${suffix}`;
        await notesApi(page, '/notes/create', { notebookId: oldId, title: oldTitle, text: '# Earlier\nOld notebook text.\n', operationId: `workspace:note:old:${suffix.replaceAll(' ', ':')}` });
        await notesApi(page, '/notes/create', { notebookId: newId, title: newTitle, text: '# Chosen\nNew notebook text.\n', operationId: `workspace:note:new:${suffix.replaceAll(' ', ':')}` });
        const root = page.locator('#neconyan-notes');
        const earlier = root.getByRole('button', { name: `Earlier ${suffix}`, exact: true });
        const chosen = root.getByRole('button', { name: `Chosen ${suffix}`, exact: true });
        const newNote = root.locator('.notes-note-title').filter({ hasText: newTitle }).first();
        await expect(chosen).toBeVisible();
        await earlier.click();
        await expect(root.locator('.notes-note-title').filter({ hasText: oldTitle }).first()).toBeVisible();

        // Hold a real notebook notification response while the user chooses another notebook.
        const listHeld = deferred();
        const releaseList = deferred();
        releases.get(page).push(releaseList.resolve);
        const listDone = deferred();
        let held = false;
        await page.route('**/api/notebooks/list', async route => {
            if (held) { await route.continue(); return; }
            held = true;
            const response = await route.fetch();
            listHeld.resolve();
            await releaseList.promise;
            await route.fulfill({ response });
            listDone.resolve();
        });
        await notesApi(page, '/create', { name: `Notification ${suffix}`, operationId: `workspace:event:${suffix.replaceAll(' ', ':')}` });
        await listHeld.promise;
        await chosen.click();
        await expect(chosen).toHaveAttribute('aria-pressed', 'true');
        await expect(newNote).toBeVisible();
        releaseList.resolve();
        await listDone.promise;
        await rendered(page);
        await expect(chosen).toHaveAttribute('aria-pressed', 'true');
        await expect(newNote).toBeVisible();
        await page.unroute('**/api/notebooks/list');

        // Hold the earlier notebook's tree and list, then deliver them after a newer selection.
        const bothHeld = deferred();
        const releaseTree = deferred();
        releases.get(page).push(releaseTree.resolve);
        const bothDone = deferred();
        let waiting = 0;
        let done = 0;
        const delayEarlier = async route => {
            if (route.request().postDataJSON()?.notebookId !== oldId) { await route.continue(); return; }
            const response = await route.fetch();
            if (++waiting === 2) bothHeld.resolve();
            await releaseTree.promise;
            await route.fulfill({ response });
            if (++done === 2) bothDone.resolve();
        };
        await page.route('**/api/notebooks/tree', delayEarlier);
        await page.route('**/api/notebooks/notes/list', delayEarlier);
        await earlier.click();
        await bothHeld.promise;
        await chosen.click();
        await expect(newNote).toBeVisible();
        releaseTree.resolve();
        await bothDone.promise;
        await rendered(page);
        await expect(chosen).toHaveAttribute('aria-pressed', 'true');
        await expect(newNote).toBeVisible();
        await expect(root.locator('.notes-note-title').filter({ hasText: oldTitle })).toHaveCount(0);
    });
}

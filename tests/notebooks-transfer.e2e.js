/* global getComputedStyle */
import fs from 'node:fs';
import { zipSync, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import { enterNotes, notesApi, openNotes } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block', hasTouch: true });
test.setTimeout(120000);
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

async function chooseArchive(page, name, files) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#neconyan-notes').getByRole('button', { name: 'Import', exact: true }).click();
    await (await chooser).setFiles({ name: `${name}.zip`, mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
    await expect(page.getByRole('heading', { name: 'Import notes', exact: true })).toBeVisible({ timeout: 30000 });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`private import previews survive reload and real export preserves bytes at ${viewport.width}px`, async ({ page }, info) => {
        await openNotes(page, viewport);
        const name = `Transfer ${viewport.width} ${Date.now()}`;
        const first = '---\r\ntitle: First\r\nstatus: draft\r\n---\r\n# First\r\nExact text.\r\n';
        const second = '# Second\n[[One]]\n';
        const files = { 'One.md': Buffer.from(first), 'Folder/Two.md': Buffer.from(second) };
        await chooseArchive(page, name, files);
        await expect(page.getByText('Imported notes start private:', { exact: false })).toBeVisible();
        const popup = page.locator('dialog[open]');
        const geometry = await popup.evaluate(element => {
            const box = element.getBoundingClientRect();
            const styles = getComputedStyle(element);
            return { width: box.width, right: box.right, background: styles.backgroundColor, buttons: [...element.querySelectorAll('button, .popup-button')].map(button => ({ label: button.textContent, height: button.getBoundingClientRect().height })) };
        });
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
        if (viewport.width <= 768) expect(geometry.buttons.every(button => button.height >= 44)).toBe(true);
        await info.attach('Native import dialog geometry', { body: JSON.stringify({ viewport, ...geometry }), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('import-preview.png') });
        await page.route('**/api/notebooks/import/commit', route => route.abort());
        await page.getByRole('button', { name: 'Import as new notebook', exact: true }).click();
        await expect(page.locator('#neconyan-notes').getByRole('button', { name: 'Unfinished imports', exact: true })).toBeVisible();
        await page.unroute('**/api/notebooks/import/commit');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await enterNotes(page, viewport);
        await page.getByRole('button', { name: 'Unfinished imports', exact: true }).click();
        const row = page.locator('dialog[open] .notes-list-item').filter({ has: page.getByText(name, { exact: true }) });
        await row.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Import as new notebook', exact: true }).click();
        await expect(page.locator('#neconyan-notes').getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
        const listed = await notesApi(page, '/list');
        const notebookId = listed.notebooks.find(item => item.name === name).id;
        const policy = await notesApi(page, '/policies/get', { notebookId });
        expect(policy.policy.admitted).toBe(false);
        expect(policy.policy.assistant).toBe('none');
        expect(policy.policy.assistantPublish).toBe(false);
        const downloaded = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export', exact: true }).click();
        const archive = unzipSync(fs.readFileSync(await (await downloaded).path()));
        expect(Buffer.from(archive[`${name}/One.md`]).toString()).toBe(first);
        expect(Buffer.from(archive[`${name}/Folder/Two.md`]).toString()).toBe(second);
        expect(Object.keys(archive).some(path => path.includes('notebook-control') || path.includes('policies.json'))).toBe(false);

        await chooseArchive(page, name, { ...files, 'One.md': Buffer.from('# First\nSelected update.\n') });
        await page.getByRole('button', { name: 'Compare with this notebook', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Update from import', exact: true })).toBeVisible();
        await page.getByLabel('One.md - differs from your copy', { exact: true }).check();
        await expect(page.getByLabel('Folder/Two.md - already the same', { exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Update ticked notes', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Update from import', exact: true })).toBeHidden();
        const notes = await notesApi(page, '/notes/list', { notebookId });
        const noteId = notes.notes.find(note => note.path === 'One.md').id;
        await expect.poll(async () => (await notesApi(page, '/notes/read', { notebookId, noteId })).note.text).toBe('# First\nSelected update.\n');
        await chooseArchive(page, `Cancel ${name}`, files);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect((await notesApi(page, '/import/list')).stages.filter(stage => stage.name.includes(name))).toHaveLength(0);
    });
}

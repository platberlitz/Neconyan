/* global window */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { openNotes, notesApi, fillSource, expectSourceText } from './notebooks-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function createCurrentNote(page) {
    const notebookId = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().state.notebookId);
    const title = `Writing controls ${randomUUID()}`;
    const result = await notesApi(page, '/notes/create', { notebookId, operationId: `browser:${randomUUID()}`, title, text: '# Notes\n\nMy ideas.' });
    expect(result.status).toBe('success');
    await page.evaluate(async ({ notebookId, noteId }) => {
        const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
        await app.openNote(notebookId, noteId);
        app.setPane('note');
    }, { notebookId, noteId: result.noteId });
    return { notebookId, noteId: result.noteId, title };
}

for (const phone of [false, true]) {
    test(`Notes full-screen writing works on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: info.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        let page;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            page = await context.newPage();
            await openNotes(page, viewport);
            await createCurrentNote(page);
            if (phone) await applyIOSOnlyCss(page);
            if (!phone) await page.getByRole('button', { name: 'Show notes beside the chat', exact: true }).click();
            await fillSource(page, '# Full screen\n\nA draft that must stay.');
            await page.evaluate(async () => { window.notesEditorBeforeFullscreen = (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor; });
            const root = page.locator('#neconyan-notes');
            const normal = await root.boundingBox();
            await root.getByRole('button', { name: 'Full screen', exact: true }).click();
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'true');
            const expanded = await root.boundingBox();
            expect(expanded).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
            await expect(root.locator('.notes-header')).toBeHidden();
            await expect(root.locator('.notes-pane-nav')).toBeHidden();
            await expect(root.locator('.notes-status')).toBeVisible();
            await fillSource(page, '# Full screen\n\nEdited in full screen.');
            await expect(root.locator('.notes-status')).toHaveText('Saved on server', { timeout: 15000 });
            expect(await page.evaluate(async () => window.notesEditorBeforeFullscreen === (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor)).toBe(true);
            await page.screenshot({ path: info.outputPath('writing-fullscreen.png') });
            await root.getByRole('button', { name: 'Exit full screen', exact: true }).click();
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'false');
            expect(await root.boundingBox()).toEqual(normal);
            await expectSourceText(page, '# Full screen\n\nEdited in full screen.');
            await root.getByRole('button', { name: 'Full screen', exact: true }).click();
            await page.keyboard.press('Escape');
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'false');
            await root.getByRole('button', { name: 'Read', exact: true }).click();
            await expect(root.getByRole('button', { name: 'Full screen', exact: true })).toBeHidden();
        } finally {
            await page?.unrouteAll({ behavior: 'wait' });
            await context.close();
        }
    });
}

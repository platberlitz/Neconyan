/* global getComputedStyle, document */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { notesApi, openNotes, revealNotebookOptions } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

/** Where each label line sits against its pill, read from the page (the label is one span, its lines come from a Range). */
function pillGeometry(button) {
    const box = button.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(button.querySelector('span'));
    const lines = [...range.getClientRects()];
    return {
        height: box.height,
        whiteSpace: getComputedStyle(button).whiteSpace,
        inside: lines.every(line => line.left >= box.left - 0.5 && line.right <= box.right + 0.5 && line.top >= box.top - 0.5 && line.bottom <= box.bottom + 0.5),
    };
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 800, height: 900 }]) {
    test(`long notebook and folder names wrap inside their pills at ${viewport.width}px`, async ({ page }) => {
        await openNotes(page, viewport);
        const id = randomUUID().replaceAll('-', '');
        const names = {
            short: `Ideas ${id.slice(0, 6)}`,
            spaced: `Your Step Dad Is Cyrano de Bergerac-ing Your Mum Into a Cabin Weekend ${id}`,
            unbroken: `Supercalifragilisticexpialidocious${id}Supercalifragilisticexpialidocious`,
        };
        const notebookIds = {};
        for (const [key, name] of Object.entries(names)) {
            const book = await notesApi(page, '/create', { name, operationId: `browser:${randomUUID()}` });
            expect(book.status).toBe('success');
            notebookIds[key] = book.notebook.id;
        }
        for (const folder of [names.spaced, names.unbroken]) {
            const note = await notesApi(page, '/notes/create', { notebookId: notebookIds.spaced, folder, title: 'Wrapping check', text: '# Wrapping check', operationId: `browser:${randomUUID()}` });
            expect(note.status).toBe('success');
        }
        await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), notebookIds.spaced);
        const root = page.locator('#neconyan-notes');
        await expect(root).toHaveAttribute('data-layout', 'full');
        const pills = [
            root.locator('.notes-notebook-row .notes-choice', { hasText: names.spaced }),
            root.locator('.notes-notebook-row .notes-choice', { hasText: names.unbroken }),
            root.locator('.notes-folder-row .notes-choice', { hasText: `${names.spaced} (1)` }),
            root.locator('.notes-folder-row .notes-choice', { hasText: `${names.unbroken} (1)` }),
        ];
        for (const pill of pills) {
            await expect(pill).toBeVisible();
            const geometry = await pill.evaluate(pillGeometry);
            expect(geometry.whiteSpace).not.toBe('nowrap');
            expect(geometry.inside).toBe(true);
        }
        const nav = await root.locator('.notes-pane-nav').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(nav.scroll).toBeLessThanOrEqual(nav.client);
        const short = await root.locator('.notes-notebook-row .notes-choice', { hasText: names.short }).evaluate(pillGeometry);
        expect(short.height).toBeLessThanOrEqual(40);
        expect(short.inside).toBe(true);
    });
}


for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`selected notebook folder heading wraps at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 393 });
        test('selected notebook folder heading wraps', async ({ page }) => {
            await openNotes(page, viewport);
            const short = 'Ideas';
            const long = 'LongFolderNameWithoutSpacesLongFolderNameWithoutSpacesLongFolderNameWithoutSpaces';
            const book = await notesApi(page, '/create', { name: 'Heading check', operationId: `browser:${randomUUID()}` });
            expect(book.status).toBe('success');
            for (const [folder, title] of [[short, 'Short note'], [long, 'Long note']]) {
                const note = await notesApi(page, '/notes/create', { notebookId: book.notebook.id, folder, title, text: `# ${title}`, operationId: `browser:${randomUUID()}` });
                expect(note.status).toBe('success');
            }
            await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), book.notebook.id);
            const root = page.locator('#neconyan-notes');
            const heading = root.locator('.notes-pane-nav [data-section="list"] > .notes-nav-heading');
            const measure = async (folder, title) => {
                await revealNotebookOptions(page);
                await root.locator('.notes-folder-row .notes-choice', { hasText: `${folder} (1)` }).click();
                await expect(heading).toHaveText(folder);
                const row = root.locator('.notes-pane-nav [data-section="list"] .notes-list').getByText(title, { exact: true });
                await expect(row).toBeVisible();
                return heading.evaluate(element => {
                    const pane = element.closest('.notes-pane-nav');
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    const lines = [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
                    const box = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
                    const paneRect = pane.getBoundingClientRect();
                    return {
                        lines,
                        heading: box(element.getBoundingClientRect()),
                        pane: { left: paneRect.left, right: paneRect.right },
                        scroll: pane.scrollWidth,
                        client: pane.clientWidth,
                        textOverflow: getComputedStyle(element).textOverflow,
                    };
                });
            };
            const shortGeometry = await measure(short, 'Short note');
            const longGeometry = await measure(long, 'Long note');
            expect(shortGeometry.lines).toHaveLength(1);
            expect(longGeometry.lines.length).toBeGreaterThan(1);
            expect(longGeometry.scroll).toBeLessThanOrEqual(longGeometry.client);
            expect(longGeometry.textOverflow).not.toBe('ellipsis');
            for (const line of longGeometry.lines) {
                expect(line.left).toBeGreaterThanOrEqual(longGeometry.pane.left - 0.5);
                expect(line.right).toBeLessThanOrEqual(longGeometry.pane.right + 0.5);
                expect(line.left).toBeGreaterThanOrEqual(longGeometry.heading.left - 0.5);
                expect(line.right).toBeLessThanOrEqual(longGeometry.heading.right + 0.5);
                expect(line.top).toBeGreaterThanOrEqual(longGeometry.heading.top - 0.5);
                expect(line.bottom).toBeLessThanOrEqual(longGeometry.heading.bottom + 0.5);
            }
        });
    });
}

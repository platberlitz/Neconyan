/* global localStorage */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { notesApi, openNotes } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(180000);

/** The reader's embed cards as shown: whether the card sits inside an element with a title the note wrote, its title, buttons and text. */
function cards(page) {
    return page.locator('.notes-reader .notes-embed').evaluateAll(list => list.map(card => ({
        inside: Boolean(card.parentElement.closest('.notes-reader [title]')),
        title: card.querySelector(':scope > .notes-embed-header > .notes-embed-title').textContent,
        buttons: [...card.querySelectorAll(':scope > .notes-embed-header > button')].map(control => control.textContent),
        body: card.querySelector(':scope > .notes-embed-body').textContent.trim(),
    })));
}

async function showReader(page, fixture) {
    await page.evaluate(async ({ notebookId, noteId }) => {
        const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
        await app.loadNotebooks(notebookId);
        await app.openNote(notebookId, noteId);
        app.setView('write');
        app.setView('read');
    }, fixture);
    await expect(page.locator('.notes-reader .notes-embed')).toHaveCount(2, { timeout: 30000 });
}

// A real note saved on the server embeds another real note twice: once inside a block the note gave a title, once on its own.
test('a saved note embedded inside an element with its own title keeps its words and shows supplied translations of its controls', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('language', 'pt-pt'));
    await openNotes(page, { width: 1280, height: 900 });
    const created = await notesApi(page, '/create', { operationId: `browser:${randomUUID()}`, name: `User text ${randomUUID()}` });
    expect(created.status).toBe('success');
    const notebookId = created.notebook.id;
    const save = async (title, text) => notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId, title, text, folder: '' });
    expect((await save('Home', 'Close the door.')).status).toBe('success');
    const plan = await save('Plan', '<div title="Home">![[Home]]</div>\n\n![[Home]]\n');
    expect(plan.status).toBe('success');
    created.plan = { notebookId, noteId: plan.noteId };

    // pt-pt as shipped: 'Home' is 'Início', and 'Open ${0}' half-translates 'Open note' outside the titled block.
    await showReader(page, created.plan);
    const shipped = await cards(page);
    expect(shipped.map(card => [card.inside, card.title, card.body])).toEqual([[true, 'Home', 'Close the door.'], [false, 'Home', 'Close the door.']]);
    expect(shipped[0].buttons).toEqual(['Open note', 'Fold embed']);
    await expect(page.locator('.notes-reader div[title]')).toHaveAttribute('title', 'Home');

    // Complete translations supplied for the embed's own wording: both cards show them, inside the titled block as well.
    await page.evaluate(async () => (await import('/scripts/i18n.js')).addLocaleData('pt-pt',
        { 'Open note': 'Abrir nota', 'Fold embed': 'Recolher incorporação', 'Show embed': 'Mostrar incorporação' }));
    await showReader(page, created.plan);
    const supplied = await cards(page);
    expect(supplied).toEqual([
        { inside: true, title: 'Home', buttons: ['Abrir nota', 'Recolher incorporação'], body: 'Close the door.' },
        { inside: false, title: 'Home', buttons: ['Abrir nota', 'Recolher incorporação'], body: 'Close the door.' },
    ]);
    await page.locator('.notes-reader div[title] .notes-embed-header > button').last().click();
    await expect(page.locator('.notes-reader div[title] .notes-embed-header > button').last()).toHaveText('Mostrar incorporação');
    await expect(page.locator('.notes-reader div[title]')).toHaveAttribute('title', 'Home');
    await page.screenshot({ path: test.info().outputPath('embed-in-titled-block.png') });
});

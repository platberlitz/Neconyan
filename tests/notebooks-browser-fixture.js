import { expect } from '@playwright/test';

export async function openWorkspace(page, { preserveNotesPrefs = false } = {}) {
    page.setDefaultTimeout(15000);
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const envelope = await response.json();
        if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
        const settings = JSON.parse(envelope.settings);
        settings.firstRun = false;
        let notePrefs = {};
        if (preserveNotesPrefs) {
            try { notePrefs = JSON.parse(settings.accountStorage?.neconyan_notes_prefs ?? '{}'); } catch { /* Use the normal first-open layout for malformed preferences. */ }
        }
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', neconyan_notes_prefs: JSON.stringify({ ...notePrefs, layout: 'full' }) };
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
}

export async function openNotes(page, viewport) {
    await page.setViewportSize(viewport);
    await openWorkspace(page);
    await enterNotes(page, viewport);
}

export async function enterNotes(page, viewport) {
    if (viewport.width <= 768) await page.locator('#sb-hamburger').click();
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="notes"]').click();
    await expect(page.locator('#neconyan-notes')).toBeVisible({ timeout: 60000 });
    await showNotebooks(page, viewport);
}

export async function showNotebooks(page, viewport) {
    if (viewport.width <= 768) await page.locator('#neconyan-notes').getByRole('button', { name: 'Notebooks', exact: true }).click();
}

export async function notesApi(page, route, body = {}) {
    return page.evaluate(async ({ route, body }) => {
        const { notesRequest } = await import('/scripts/notebooks/api.js');
        return notesRequest(route, body);
    }, { route, body });
}

/** Edit through the real contenteditable control, including CodeMirror's whole-document selection. */
export async function fillSource(page, text) {
    const editor = page.getByRole('textbox', { name: 'Note text (Markdown)', exact: true });
    await editor.click();
    await editor.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
    await expectSourceText(page, text);
}

export async function sourceText(page) {
    return page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().elements.textarea.value);
}

export async function expectSourceText(page, text) {
    await expect.poll(() => sourceText(page)).toBe(text);
}

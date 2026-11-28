/* global innerWidth, getComputedStyle */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { enterNotes, expectSourceText, fillSource, notesApi, openNotes, showNotebooks } from './notebooks-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, applyIOSOnlyCss, installIPhoneSafari } from './ios-safari-emulation.js';

const viewport = { width: 393, height: 852 };
const title = 'Night watch';
const source = '# Night watch\n\nKeep the lantern lit.';

test.use({ ...IPHONE_SAFARI_CONTEXT, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ context }) => installIPhoneSafari(context, { standalone: true }));
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

async function setup(page) {
    await openNotes(page, viewport);
    await applyIOSOnlyCss(page);
    const name = `Moonlit harbour ${randomUUID()}`;
    const book = await notesApi(page, '/create', { name, operationId: `browser:${randomUUID()}` });
    expect(book.status).toBe('success');
    const notebookId = book.notebook.id;
    for (const note of [{ title, text: source }, { title: 'Harbour map', text: '# Map' }]) {
        expect((await notesApi(page, '/notes/create', { ...note, notebookId, operationId: `browser:${randomUUID()}` })).status).toBe('success');
    }
    await page.evaluate(async id => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(id), notebookId);
    const root = page.locator('#neconyan-notes');
    const button = label => root.getByRole('button', { name: label, exact: true });
    const list = root.locator('[data-section="list"]');
    const found = list.getByText(title, { exact: true });
    await expect(root.locator('.notes-current-notebook')).toHaveText(name);
    await expect(found).toBeVisible();
    return { root, button, name, list, found };
}

test('phone opens on the notebook list and reveals options without losing search focus', async ({ page }) => {
    const { root, button, name, list, found } = await setup(page);
    const options = button('Notebook options');
    const panel = root.locator('#notes-mobile-notebook-options');
    const search = root.getByRole('searchbox', { name: 'Search notes' });
    await expect(button('New note')).toBeVisible();
    await expect(options).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    expect((await found.boundingBox()).y).toBeLessThan(viewport.height - 100);

    await options.press('Enter');
    await expect(options).toHaveAttribute('aria-expanded', 'true');
    await expect(button(name)).toHaveAttribute('aria-pressed', 'true');
    for (const label of ['Quick note', 'Graph', 'Canvas', 'Property table', 'Import', 'Export']) await expect(button(label)).toBeVisible();
    await expect(panel.locator('[data-section="folders"]')).toBeVisible();
    await search.fill('lantern');
    await expect(root.getByRole('heading', { name: 'Search results (1)', exact: true })).toBeVisible();
    await expect(search).toBeFocused();
    await expect(options).toHaveAttribute('aria-expanded', 'true');
    await options.tap();
    await expect(panel).toBeHidden();
    await expect(root.getByText(title, { exact: true }).filter({ visible: true })).toBeVisible();
    await search.fill('');
    await expect(list).toBeVisible();

    await page.setViewportSize({ width: 320, height: 740 });
    await options.tap();
    const picked = button(name);
    await expect(picked).toBeVisible();
    expect(await picked.evaluate(control => control.scrollWidth <= control.clientWidth + 1)).toBe(true);
    expect(await root.locator('.notes-pane-nav').evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(320);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(options).toBeHidden();
    await expect(button(name)).toBeVisible();
    await expect(root.locator('[data-section="views"]').getByRole('button', { name: 'Graph', exact: true })).toBeVisible();
});

test('phone prioritises note text and preserves the draft and fullscreen exit when tools collapse', async ({ page }) => {
    const { root, button, found } = await setup(page);
    await found.tap();
    const editor = root.getByRole('textbox', { name: 'Note text (Markdown)' });
    const tools = button('Note tools');
    const panel = root.locator('#notes-mobile-note-tools');
    await expect(editor).toBeVisible();
    expect((await editor.boundingBox()).y).toBeLessThan(viewport.height / 2);
    await expect(root.locator('.notes-status')).toBeVisible();
    await expect(tools).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await expect(button('Write')).toBeVisible();
    await button('Read').tap();
    await expect(root.locator('.notes-reader').getByText('Keep the lantern lit.', { exact: true })).toBeVisible();
    await button('Write').tap();
    await fillSource(page, `${source} Until dawn.`);
    await tools.tap();
    await expect(tools).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.notes-toolbar')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Sections', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Talk about this note', exact: true })).toBeVisible();
    await button('Full screen').tap();
    await tools.tap();
    await expect(panel).toBeHidden();
    await button('Exit full screen').tap();
    await expect(root).toHaveAttribute('data-writing-fullscreen', 'false');
    await expectSourceText(page, `${source} Until dawn.`);
    await editor.press('ControlOrMeta+z');
    await expectSourceText(page, source);

    await showNotebooks(page, viewport);
    await root.locator('[data-section="list"]').getByText('Harbour map', { exact: true }).tap();
    await page.setViewportSize({ width: 320, height: 740 });
    const header = root.locator('.notes-header');
    await expect(button('Back')).toBeVisible();
    await expect(button('Help')).toBeVisible();
    expect(await header.evaluate(node => [...node.querySelectorAll('button')]
        .filter(control => control.getClientRects().length && getComputedStyle(control).visibility === 'visible')
        .every(control => { const box = control.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.height >= 44; }))).toBe(true);
    await button('Help').tap();
    await expect(root.locator('#notes-mobile-help')).toBeVisible();
    await tools.tap();
    await showNotebooks(page, viewport);
    await button('Notebook options').tap();
    await button('Back to chat').tap();
    await expect(root).toBeHidden();
    await page.setViewportSize(viewport);
    await enterNotes(page, viewport);
    await expect(button('Notebook options')).toHaveAttribute('aria-expanded', 'false');
    await expect(button('Help')).toHaveAttribute('aria-expanded', 'false');
    await button('Note').tap();
    await expect(tools).toHaveAttribute('aria-expanded', 'false');
    await expectSourceText(page, '# Map');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(tools).toBeHidden();
    await expect(button('Full screen')).toBeVisible();
    await expect(panel.locator('.notes-toolbar')).toBeVisible();
});

/* global window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned helpers. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { openPersonaEditor } from './chat-scroll-regression-helpers.js';
import { test } from './neconyan-conversation-durable-fixture.js';

const TARGET = 'Target Book';
const SIMILAR = 'Target Book 2';
const LOWER = 'target book';
const RENAMED = 'Renamed Book';
const ACTIVE = 'lore-active.png';
const OTHER = 'lore-other.png';
const NEAR = 'lore-near.png';
const SHOTS = process.env.NECONYAN_LOREBOOK_SHOTS ? '../screenshots/lorebook-link-personas-notebooks' : '';

async function shot(page, name, device) {
    if (!SHOTS) return;
    await fs.mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${process.env.NECONYAN_LOREBOOK_SHOTS}-${name}-${device}.png` });
}

/** Shows the persona editor with its lorebook status in view, then takes the shot. */
async function personaShot(page, name, device) {
    if (!SHOTS) return;
    await openPersonaEditor(page);
    await page.locator('#persona_lore_status').scrollIntoViewIfNeeded();
    await shot(page, name, device);
}

const entry = (comment, content) => ({ uid: 0, key: ['target'], keysecondary: [], comment, content, constant: false, selective: false, order: 100, position: 0, disable: false });

const persona = lorebook => ({ description: 'A persona with a lorebook.', position: 0, depth: 4, role: 0, connections: [], lorebook });

/** Three personas: the active one and an inactive one on the book, and one on a book with a similar name. */
function personas(saved) {
    saved.user_avatar = ACTIVE;
    saved.power_user.persona_description_lorebook = TARGET;
    saved.power_user.personas = { ...saved.power_user.personas, [ACTIVE]: 'Lore Active', [OTHER]: 'Lore Other', [NEAR]: 'Lore Near' };
    saved.power_user.persona_descriptions = {
        ...saved.power_user.persona_descriptions,
        [ACTIVE]: persona(TARGET),
        [OTHER]: persona(`${TARGET}. `),
        [NEAR]: persona(SIMILAR),
    };
}

async function setup(app, phone) {
    const account = await app.account({ phone, seedConversation: false, configureSettings: personas });
    const avatars = path.join(app.dataRoot, 'default-user', 'User Avatars');
    for (const avatar of [ACTIVE, OTHER, NEAR]) await fs.copyFile(path.resolve('../public/img/user-default.png'), path.join(avatars, avatar));
    await account.post('/api/worldinfo/edit', { name: TARGET, data: { entries: { 0: entry('Healing', 'Old healing lore.') } } });
    await account.post('/api/worldinfo/edit', { name: SIMILAR, data: { entries: { 0: entry('Similar', 'Similar lore.') } } });
    await account.post('/api/worldinfo/edit', { name: LOWER, data: { entries: { 0: entry('Lower', 'Lower-case lore.') } } });
    const page = await account.open({ workspace: false });
    return { account, page };
}

const notes = (page, route, body) => page.evaluate(async ({ route, body }) => {
    const { notesRequest } = await import('/scripts/notebooks/api.js');
    return notesRequest(route, body);
}, { route, body });

async function ok(page, route, body) {
    const result = await notes(page, route, { operationId: `links:${randomUUID()}`, ...body });
    expect(result.status, JSON.stringify(result)).toBe('success');
    return result;
}

const SELECTOR = { kind: 'heading', path: ['Healing rules', 'Established'] };
const TEXT = '# Healing rules\n\n## Established\nHealing transfers the injury to the healer.\n\n## Draft\nUnpublished idea.\n';

/** A note published to the book, related to it and its entry, with a lorebook scope, plus links to similar books. */
async function notebook(page) {
    const notebookId = (await ok(page, '/create', { name: 'Lore links' })).notebook.id;
    const noteId = (await ok(page, '/notes/create', { notebookId, title: 'Healing rules', text: TEXT })).noteId;
    const args = { notebookId, noteId, selector: SELECTOR, book: TARGET, uid: 0 };
    const { preview } = await ok(page, '/lore/preview', args);
    await ok(page, '/lore/publish', { ...args, expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash });
    await ok(page, '/notes/associations', { notebookId, noteId, associations: [
        { kind: 'lorebook', id: TARGET, label: TARGET },
        { kind: 'lore-entry', id: TARGET, uid: 0, label: `Healing (${TARGET})` },
        { kind: 'lorebook', id: SIMILAR, label: SIMILAR },
        { kind: 'lore-entry', id: LOWER, uid: 0, label: `Lower (${LOWER})` },
    ] });
    const { policy } = await ok(page, '/policies/get', { notebookId });
    await ok(page, '/policies/update', { notebookId, expectedRevision: policy.revision, patch: { notes: { [noteId]: { context: { mode: 'reference', order: 0, scopes: [
        { kind: 'lorebook', id: TARGET, label: TARGET },
        { kind: 'lorebook', id: SIMILAR, label: SIMILAR },
    ] } } } } });
    return { notebookId, noteId };
}

async function linked(page, { notebookId, noteId }) {
    const read = await ok(page, '/notes/read', { notebookId, noteId });
    const { bindings } = await ok(page, '/lore/bindings', { notebookId, noteId });
    const { policy } = await ok(page, '/policies/get', { notebookId });
    return { text: read.note.text, revision: read.note.revision, associations: read.associations, bindings, scopes: policy.notes?.[noteId]?.context?.scopes ?? null };
}

async function openNote(page, { notebookId, noteId }, bindings = 1) {
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await page.evaluate(async ids => {
        const { openNotes } = await import('/scripts/notebooks/notes-app.js');
        const app = await openNotes({ ...ids, layout: 'full' });
        app.state.detailsTab = 'lore';
        if (app.isPhone()) app.setPane('details');
        else app.panels.renderDetails(app);
    }, { notebookId, noteId });
    const details = page.locator('#neconyan-notes');
    await expect(details.locator('li.notes-binding')).toHaveCount(bindings);
    await expect(details.locator('.notes-file-row').first()).toBeVisible();
    return details;
}

const hideNotes = page => page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).hideNotes());

async function openBook(page, name) {
    await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), 'world-info');
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'world-info');
    const back = page.locator('.neconyan-lorebook-back');
    if (await back.isVisible()) await back.click();
    await page.locator('.neconyan-lorebook-book-open').filter({ has: page.getByText(name, { exact: true }) }).click();
    await expect(page.locator('#world_editor_select')).toHaveValue(/.+/);
}

async function openTools(page) {
    const summary = page.locator('#neconyan-lorebook-library .world_popup_action_group--library > summary');
    if (await summary.isVisible()) await summary.click();
}

async function removeBook(page) {
    await openTools(page);
    await page.locator('#world_popup_delete').click();
    await page.locator('dialog.popup[open] .popup-button-ok').last().click();
}

async function renameBook(page, name) {
    await openTools(page);
    await page.locator('#world_popup_name_button').click();
    const dialog = page.locator('dialog.popup[open]').last();
    await dialog.getByRole('textbox').fill(name);
    await dialog.locator('.popup-button-ok').click();
    const renamed = page.locator('dialog.popup[open]').filter({ hasText: 'World/Lorebook renamed!' });
    await renamed.waitFor({ state: 'visible', timeout: 4000 }).catch(() => null);
    if (await renamed.isVisible()) await renamed.locator('.popup-button-ok').click();
}

async function personaStatus(page, avatar) {
    await page.evaluate(async avatar => {
        const personas = await import('/scripts/personas.js');
        await personas.setUserAvatar(avatar, { toastPersonaNameChange: false, readOnlyRoute: true });
    }, avatar);
    return page.locator('#persona_lore_status');
}

async function openPersonas(page) {
    await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), 'persona');
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'persona');
}

async function savedPersonas(account) {
    const saved = JSON.parse((await account.post('/api/settings/get')).settings);
    const lorebooks = Object.fromEntries([ACTIVE, OTHER, NEAR].map(avatar => [avatar, saved.power_user.persona_descriptions[avatar]?.lorebook]));
    return { active: saved.power_user.persona_description_lorebook, ...lorebooks };
}

for (const device of ['desktop', 'phone']) {
    const phone = device === 'phone';
    test.describe(`on ${device}`, () => {
        test.describe.configure({ mode: 'default' });

        test('deleting a lorebook clears every persona link and detaches its Notebook links', async ({ app }) => {
            test.setTimeout(180000);
            const { account, page } = await setup(app, phone);
            const ids = await notebook(page);
            const before = await linked(page, ids);
            expect(before.bindings[0].status).toBe('in_sync');

            await openBook(page, TARGET);
            await removeBook(page);
            await expect(page.locator('.toast-success').filter({ hasText: 'Removed' })).toBeVisible({ timeout: 30000 });
            await expect(page.locator('.toast-error').filter({ hasText: 'Lorebook links not fully updated' })).toHaveCount(0);

            await expect.poll(() => savedPersonas(account), { timeout: 15000 }).toEqual({ active: '', [ACTIVE]: '', [OTHER]: '', [NEAR]: SIMILAR });
            await openPersonas(page);
            await expect(page.locator('#persona_lore_status')).toHaveText('None');
            await expect(page.locator('#persona_lore_button')).not.toHaveClass(/world_set/);
            await personaShot(page, 'delete-active-persona', device);
            await expect(await personaStatus(page, OTHER)).toHaveText('None');
            await personaShot(page, 'delete-inactive-persona', device);
            await expect(await personaStatus(page, NEAR)).toHaveText(SIMILAR);

            const after = await linked(page, ids);
            expect(after.text).toBe(before.text);
            expect(after.bindings).toEqual([]);
            expect(after.associations).toEqual([
                { kind: 'lorebook', id: SIMILAR, label: SIMILAR },
                { kind: 'lore-entry', id: LOWER, uid: 0, label: `Lower (${LOWER})` },
            ]);
            expect(after.scopes).toEqual([{ kind: 'lorebook', id: SIMILAR, label: SIMILAR }]);

            const details = await openNote(page, ids, 0);
            await expect(details.getByText(`Lorebook: ${TARGET}`, { exact: true })).toHaveCount(0);
            await expect(details.getByText(`Lore entry: Healing (${TARGET})`)).toHaveCount(0);
            await expect(details.getByText(`Lorebook: ${SIMILAR}`, { exact: true })).toBeVisible();
            await shot(page, 'delete-notebook', device);
        });

        test('renaming a lorebook moves every persona link and keeps its Notebook links working', async ({ app }) => {
            test.setTimeout(180000);
            const { account, page } = await setup(app, phone);
            const ids = await notebook(page);
            const details = await openNote(page, ids);
            await expect(details.getByText(`Lore entry: Healing (${TARGET})`)).toBeVisible();
            await hideNotes(page);

            await openBook(page, TARGET);
            await renameBook(page, RENAMED);
            await expect(page.locator('.toast-success').filter({ hasText: 'Moved' })).toBeVisible({ timeout: 30000 });
            await expect(page.locator('.toast-error').filter({ hasText: 'Lorebook links not fully updated' })).toHaveCount(0);

            await expect.poll(() => savedPersonas(account), { timeout: 15000 }).toEqual({ active: RENAMED, [ACTIVE]: RENAMED, [OTHER]: RENAMED, [NEAR]: SIMILAR });
            await openPersonas(page);
            await expect(page.locator('#persona_lore_status')).toHaveText(RENAMED);
            await expect(page.locator('#persona_lore_button')).toHaveClass(/world_set/);
            await expect(await personaStatus(page, OTHER)).toHaveText(RENAMED);
            await personaShot(page, 'rename-inactive-persona', device);
            await expect(await personaStatus(page, NEAR)).toHaveText(SIMILAR);

            const after = await linked(page, ids);
            expect(after.bindings).toHaveLength(1);
            expect(after.bindings[0]).toMatchObject({ book: RENAMED, uid: 0, status: 'in_sync' });
            expect(after.associations).toEqual([
                { kind: 'lorebook', id: RENAMED, label: RENAMED },
                { kind: 'lore-entry', id: RENAMED, uid: 0, label: `Healing (${RENAMED})` },
                { kind: 'lorebook', id: SIMILAR, label: SIMILAR },
                { kind: 'lore-entry', id: LOWER, uid: 0, label: `Lower (${LOWER})` },
            ]);
            expect(after.scopes).toEqual([{ kind: 'lorebook', id: RENAMED, label: RENAMED }, { kind: 'lorebook', id: SIMILAR, label: SIMILAR }]);

            const reopened = await openNote(page, ids);
            await expect(reopened.locator('li.notes-binding[data-status="in_sync"]')).toContainText(`→ ${RENAMED}: `);
            await reopened.locator('li.notes-binding').scrollIntoViewIfNeeded();
            await shot(page, 'rename-notebook', device);
            await reopened.getByRole('button', { name: `Lore entry: Healing (${RENAMED})` }).click();
            const entryPage = page.locator('dialog.popup[open]').last();
            await expect(entryPage.locator('p.notes-live-badge')).toHaveText(`Live World Info: ${RENAMED}`);
            await expect(entryPage.getByLabel('Entry text')).toHaveValue('Healing transfers the injury to the healer.');
            await entryPage.getByRole('button', { name: 'Close' }).click();

            await ok(page, '/notes/update', { notebookId: ids.notebookId, noteId: ids.noteId, expectedRevision: after.revision,
                changes: [{ type: 'replace_selection', find: 'to the healer.', replace: 'to the healer, twice.' }] });
            const args = { ...ids, selector: SELECTOR, book: RENAMED, uid: 0 };
            const { preview } = await ok(page, '/lore/preview', args);
            await ok(page, '/lore/publish', { ...args, expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash });
            const world = await account.post('/api/worldinfo/get', { name: RENAMED });
            expect(world.entries[0].content).toBe('Healing transfers the injury to the healer, twice.');
            expect((await linked(page, ids)).bindings).toEqual([expect.objectContaining({ book: RENAMED, status: 'in_sync' })]);
        });

        test('an open Notebook shows moved and removed lore links without reopening the note', async ({ app }) => {
            test.setTimeout(180000);
            const { account, page } = await setup(app, phone);
            const ids = await notebook(page);
            const details = await openNote(page, ids);
            await expect(details.getByRole('button', { name: `Lore entry: Healing (${TARGET})` })).toBeVisible();

            const data = await account.post('/api/worldinfo/get', { name: TARGET });
            const renamed = await account.post('/api/worldinfo/rename', { oldName: TARGET, newName: RENAMED, data });
            expect(renamed.notebooks).toMatchObject({ links: 4, skipped: [] });
            await expect(details.getByRole('button', { name: `Lore entry: Healing (${RENAMED})` })).toBeVisible();
            await expect(details.getByText(`Lorebook: ${RENAMED}`, { exact: true })).toBeVisible();
            await expect(details.locator('li.notes-binding[data-status="in_sync"]')).toContainText(`→ ${RENAMED}: `);

            const deleted = await account.post('/api/worldinfo/delete', { name: RENAMED });
            expect(deleted.notebooks).toMatchObject({ links: 4, skipped: [] });
            await expect(details.getByRole('button', { name: `Lore entry: Healing (${RENAMED})` })).toHaveCount(0);
            await expect(details.locator('li.notes-binding')).toHaveCount(0);
            await expect(details.getByText(`Lorebook: ${SIMILAR}`, { exact: true })).toBeVisible();
        });

        test('a failed settings save keeps the persona links and reports them', async ({ app }) => {
            test.setTimeout(180000);
            const { account, page } = await setup(app, phone);
            await openBook(page, TARGET);
            await page.route('**/api/settings/save', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Settings disk full.' }) }));
            await renameBook(page, RENAMED);
            const failure = page.locator('.toast-error').filter({ hasText: 'Lorebook links not fully updated' });
            await expect(failure).toHaveCount(1, { timeout: 30000 });
            await expect(failure.locator('li')).toHaveText(['personas: Settings could not be saved.']);
            await page.unroute('**/api/settings/save');

            expect(await savedPersonas(account)).toEqual({ active: TARGET, [ACTIVE]: TARGET, [OTHER]: `${TARGET}. `, [NEAR]: SIMILAR });
            expect(await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                return [power_user.persona_description_lorebook, power_user.persona_descriptions['lore-other.png'].lorebook];
            })).toEqual([TARGET, `${TARGET}. `]);
            await openPersonas(page);
            await expect(page.locator('#persona_lore_status')).toHaveText(`Missing: ${TARGET}`);
            await expect(page.locator('#persona_lore_button')).toHaveClass(/world_set/);
            await personaShot(page, 'rename-failed', device);
        });
    });
}

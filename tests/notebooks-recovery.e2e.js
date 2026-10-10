/* global window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { enterNotes, expectSourceText, fillSource, notesApi, openNotes, openWorkspace, showNotebooks } from './notebooks-browser-fixture.js';

test.use({ hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(180000);
const heldRequests = new WeakMap();
test.beforeEach(async ({ page }) => {
    await page.addLocatorHandler(page.getByRole('heading', { name: 'Settings changed on another device', exact: true }), async () => {
        await page.locator('.popup:visible').getByRole('button', { name: 'Keep editing', exact: true }).click();
    });
});
test.afterEach(async ({ page }) => {
    heldRequests.get(page)?.();
    await page.unrouteAll({ behavior: 'wait' });
});

async function notebook(page, label) {
    const result = await notesApi(page, '/create', { operationId: `browser:${randomUUID()}`, name: `${label} ${randomUUID()}` });
    expect(result.status).toBe('success');
    return result.notebook.id;
}

async function createNote(page, notebookId, title, text) {
    const created = await notesApi(page, '/notes/create', { operationId: `browser:${randomUUID()}`, notebookId, title, text });
    expect(created.status).toBe('success');
    return (await notesApi(page, '/notes/read', { notebookId, noteId: created.noteId })).note;
}

async function showNote(page, viewport, notebookId, note) {
    await page.evaluate(async id => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(id), notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText(note.title, { exact: true }).first().click();
    await expect(page.locator('.notes-source')).toBeVisible();
}

async function readNote(page, notebookId, noteId) {
    return (await notesApi(page, '/notes/read', { notebookId, noteId })).note;
}

async function draftOnDevice(page, notebookId, noteId) {
    return page.evaluate(async ({ notebookId, noteId }) => {
        const { readDraft } = await import('/scripts/notebooks/drafts.js');
        const { getCurrentUserHandle } = await import('/scripts/user.js');
        return readDraft(getCurrentUserHandle(), notebookId, noteId);
    }, { notebookId, noteId });
}

async function establishConflict(page, context, notebookId, note, mine, server) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    heldRequests.set(page, release);
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    await page.route('**/api/notebooks/notes/update', async route => { started(); await gate; await route.continue(); });
    await fillSource(page, mine);
    await waiting;
    const headers = await page.evaluate(async () => (await import('/script.js')).getRequestHeaders());
    const response = await context.request.post('/api/notebooks/notes/update', { headers, data: {
        operationId: `browser:${randomUUID()}`, notebookId, noteId: note.id, expectedRevision: note.revision,
        changes: [{ type: 'replace_all', markdown: server }] } });
    expect(response.ok(), await response.text()).toBe(true);
    release();
    await expect(page.locator('[data-banner="conflict"]')).toBeVisible();
    await page.unroute('**/api/notebooks/notes/update');
}

async function measureControls(page, selector, viewport, info, name) {
    const geometry = await page.locator(selector).evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, background: getComputedStyle(element).backgroundColor,
            buttons: [...element.querySelectorAll('button')].map(button => ({ label: button.textContent.trim(), height: button.getBoundingClientRect().height })) };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
    if (viewport.width <= 768) for (const control of geometry.buttons) expect(control.height, control.label).toBeGreaterThanOrEqual(44);
    await info.attach(name, { contentType: 'application/json', body: JSON.stringify(geometry) });
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`all note-save conflict choices preserve the chosen text at ${viewport.width}px`, async ({ page, context }, info) => {
        await openNotes(page, viewport);
        const notebookId = await notebook(page, 'Conflicts');
        const peer = await context.newPage();
        await openWorkspace(peer);
        for (const choice of ['Use server version', 'Save mine as a copy', 'Keep mine']) {
            const note = await createNote(page, notebookId, `Conflict ${choice}`, 'Original words.');
            await showNote(page, viewport, notebookId, note);
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            heldRequests.set(page, release);
            let started;
            const waiting = new Promise(resolve => { started = resolve; });
            await page.route('**/api/notebooks/notes/update', async route => { started(); await gate; await route.continue(); });
            const mine = `My unsaved words for ${choice}.`;
            const server = `Newer server words for ${choice}.`;
            await fillSource(page, mine);
            await waiting;
            const changed = await notesApi(peer, '/notes/update', { operationId: `browser:${randomUUID()}`, notebookId,
                noteId: note.id, expectedRevision: note.revision, changes: [{ type: 'replace_all', markdown: server }] });
            expect(changed.status).toBe('success');
            release();
            const banner = page.locator('[data-banner="conflict"]');
            await expect(banner).toBeVisible();
            await page.unroute('**/api/notebooks/notes/update');
            await banner.getByRole('button', { name: 'Compare', exact: true }).click();
            await expect(page.locator('.notes-diff')).toContainText(server);
            await expect(page.locator('.notes-diff')).toContainText(mine);
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await expectSourceText(page, mine);
            await measureControls(page, '[data-banner="conflict"]', viewport, info, `conflict-${choice.split(' ')[0]}`);
            await banner.getByRole('button', { name: choice, exact: true }).click();
            if (choice === 'Keep mine') {
                await expect.poll(async () => (await readNote(peer, notebookId, note.id)).text).toBe(mine);
            } else {
                await expect.poll(async () => (await readNote(peer, notebookId, note.id)).text).toBe(server);
            }
            if (choice === 'Save mine as a copy') {
                await expectSourceText(page, mine);
                const list = await notesApi(peer, '/notes/list', { notebookId });
                const copy = list.notes.find(item => item.id !== note.id && item.title.includes('(my copy)'));
                expect(copy).toBeTruthy();
                expect((await readNote(peer, notebookId, copy.id)).text).toBe(mine);
            } else await expectSourceText(page, choice === 'Keep mine' ? mine : server);
            await expect(page.locator('[data-banner="conflict"]')).toHaveCount(0);
            await expect.poll(() => draftOnDevice(page, notebookId, note.id)).toBeNull();
        }
        const note = await createNote(page, notebookId, 'Unresolved conflict', 'Original.');
        await showNote(page, viewport, notebookId, note);
        await fillSource(page, 'Keep this unsaved text.');
        await notesApi(peer, '/notes/update', { operationId: `browser:${randomUUID()}`, notebookId, noteId: note.id,
            expectedRevision: note.revision, changes: [{ type: 'replace_all', markdown: 'Changed elsewhere.' }] });
        const unresolved = page.locator('[data-banner="conflict"]');
        await expect(unresolved).toBeVisible();
        await expect(unresolved.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
        await expect(page.locator('[data-banner="remote"]')).toHaveCount(0);
        await peer.close();
    });

    test(`failed conflict reads retain the draft until a successful retry at ${viewport.width}px`, async ({ page, context }) => {
        await openNotes(page, viewport);
        const notebookId = await notebook(page, 'Failed recovery read');
        const note = await createNote(page, notebookId, 'Retry without losing my draft', 'Original words.');
        await showNote(page, viewport, notebookId, note);
        const mine = 'Keep this draft when the network read fails.';
        const server = 'New server words.';
        await establishConflict(page, context, notebookId, note, mine, server);
        await page.route('**/api/notebooks/notes/read', route => route.abort('failed'));
        const failedRead = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/notebooks/notes/read') });
        await page.locator('[data-banner="conflict"]').getByRole('button', { name: 'Use server version', exact: true }).click();
        await failedRead;
        await expectSourceText(page, mine);
        await expect(page.locator('[data-banner="conflict"]')).toBeVisible();
        expect(await draftOnDevice(page, notebookId, note.id)).toMatchObject({ text: mine });
        await page.unroute('**/api/notebooks/notes/read');
        await page.locator('[data-banner="conflict"]').getByRole('button', { name: 'Use server version', exact: true }).click();
        await expectSourceText(page, server);
        await expect.poll(() => draftOnDevice(page, notebookId, note.id)).toBeNull();
        await expect(page.locator('[data-banner="conflict"]')).toHaveCount(0);
    });

    test(`typing during a delayed conflict read is retained and automatic saving stays paused at ${viewport.width}px`, async ({ page, context }, info) => {
        await openNotes(page, viewport);
        const notebookId = await notebook(page, 'Delayed recovery read');
        const note = await createNote(page, notebookId, 'Keep newer typing', 'Original words.');
        await showNote(page, viewport, notebookId, note);
        const mine = 'Earlier device draft.';
        const server = 'Newer saved server words.';
        await establishConflict(page, context, notebookId, note, mine, server);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        heldRequests.set(page, release);
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        await page.route('**/api/notebooks/notes/read', async route => {
            const response = await route.fetch();
            started();
            await gate;
            await route.fulfill({ response });
        });
        await page.locator('[data-banner="conflict"]').getByRole('button', { name: 'Use server version', exact: true }).click();
        await waiting;
        await page.clock.install();
        const updates = [];
        page.on('request', request => { if (request.url().endsWith('/api/notebooks/notes/update')) updates.push(request); });
        const later = 'Later typing while the server read was pending.';
        await fillSource(page, later);
        await page.clock.fastForward(2000);
        const finished = page.waitForEvent('requestfinished', { predicate: request => request.url().endsWith('/api/notebooks/notes/read') });
        release();
        await finished;
        await page.unroute('**/api/notebooks/notes/read');
        await page.clock.runFor(100);
        await expectSourceText(page, later);
        await expect(page.locator('[data-banner="conflict"]')).toBeVisible();
        expect(updates).toHaveLength(0);
        expect(await draftOnDevice(page, notebookId, note.id)).toMatchObject({ text: later });
        expect((await readNote(page, notebookId, note.id)).text).toBe(server);
        await measureControls(page, '[data-banner="conflict"]', viewport, info, 'later-typing-conflict');
    });

    test(`device draft recovery keeps server and draft choices separate at ${viewport.width}px`, async ({ page, context }, info) => {
        await openNotes(page, viewport);
        const notebookId = await notebook(page, 'Device drafts');
        for (const choice of ['Restore automatically', 'Use draft', 'Save draft as a copy', 'Discard draft', 'Dismiss']) {
            const note = await createNote(page, notebookId, `Draft ${choice}`, 'Original saved words.');
            await showNote(page, viewport, notebookId, note);
            await page.route('**/api/notebooks/notes/update', route => route.abort('failed'));
            const draft = `Device-only words for ${choice}.`;
            await fillSource(page, draft);
            await expect.poll(() => draftOnDevice(page, notebookId, note.id)).toMatchObject({ text: draft });
            const server = choice === 'Restore automatically' ? note.text : `New server words for ${choice}.`;
            if (choice !== 'Restore automatically') {
                const headers = await page.evaluate(async () => (await import('/script.js')).getRequestHeaders());
                const response = await context.request.post('/api/notebooks/notes/update', { headers, data: {
                    operationId: `browser:${randomUUID()}`, notebookId, noteId: note.id,
                    expectedRevision: note.revision, changes: [{ type: 'replace_all', markdown: server }] } });
                expect(response.ok(), await response.text()).toBe(true);
            }
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.unroute('**/api/notebooks/notes/update');
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
            await enterNotes(page, viewport);
            await showNote(page, viewport, notebookId, note);
            const banner = page.locator('[data-banner="draft"]');
            await expect(banner).toBeVisible();
            if (choice === 'Restore automatically') {
                await expect(banner).toContainText('Restored changes saved on this device');
                await expect.poll(async () => (await readNote(page, notebookId, note.id)).text).toBe(draft);
                continue;
            }
            await expectSourceText(page, server);
            await banner.getByRole('button', { name: 'Compare', exact: true }).click();
            await expect(page.locator('.notes-diff')).toContainText(server);
            await expect(page.locator('.notes-diff')).toContainText(draft);
            await page.getByRole('button', { name: 'Close', exact: true }).click();
            await measureControls(page, '[data-banner="draft"]', viewport, info, `draft-${choice.split(' ')[0]}`);
            await banner.getByRole('button', { name: choice, exact: true }).click();
            await expect(page.locator('[data-banner="draft"]')).toHaveCount(0);
            if (choice === 'Use draft') await expect.poll(async () => (await readNote(page, notebookId, note.id)).text).toBe(draft);
            else expect((await readNote(page, notebookId, note.id)).text).toBe(server);
            if (choice === 'Save draft as a copy') {
                const list = await notesApi(page, '/notes/list', { notebookId });
                const copy = list.notes.find(item => item.id !== note.id && item.title.includes('(draft)'));
                expect((await readNote(page, notebookId, copy.id)).text).toBe(draft);
            }
            if (choice === 'Dismiss') {
                expect(await draftOnDevice(page, notebookId, note.id)).toMatchObject({ text: draft });
                await showNote(page, viewport, notebookId, note);
                await expect(page.locator('[data-banner="draft"]')).toBeVisible();
                await page.locator('[data-banner="draft"]').getByRole('button', { name: 'Discard draft', exact: true }).click();
            }
            await expect.poll(() => draftOnDevice(page, notebookId, note.id)).toBeNull();
        }
    });

    test(`assistant review Save change, Not now and Decline at ${viewport.width}px`, async ({ page }, info) => {
        await openNotes(page, viewport);
        const notebookId = await notebook(page, 'Assistant reviews');
        const note = await createNote(page, notebookId, 'Reviewed note', 'Original owner words.');
        const policy = await notesApi(page, '/policies/get', { notebookId });
        await notesApi(page, '/policies/update', { notebookId, expectedRevision: policy.policy.revision, patch: { assistant: 'edit' } });
        const tool = await page.evaluate(async () => (await import('/scripts/notebooks/assistant-note-tools.js')).NOTE_TOOL_DEFINITIONS.AppendToNote.kind);
        for (const choice of ['Not now', 'Decline', 'Save change']) {
            await showNote(page, viewport, notebookId, note);
            const addition = `Assistant text for ${choice}.`;
            const proposed = await notesApi(page, '/assistant/tool', { tool, callId: `browser:${randomUUID()}`,
                args: { notebookId, noteId: note.id, markdown: addition } });
            expect(proposed.status, proposed.message).toBe('needs_approval');
            await showNotebooks(page, viewport);
            await page.locator('#neconyan-notes').getByRole('button', { name: 'Assistant changes', exact: true }).click();
            const row = page.locator('.popup:visible .notes-list-item').filter({ hasText: 'Add to note' }).last();
            await row.getByRole('button', { name: 'Review', exact: true }).click();
            await expect(page.locator('.neconyan-note-proposal-review')).toContainText(addition);
            await expect(page.locator('.neconyan-note-proposal-review')).toContainText('Live lore is not touched.');
            const reviewDialog = '.popup:visible:has(.neconyan-note-proposal-review)';
            await measureControls(page, reviewDialog, viewport, info, `review-${choice.split(' ')[0]}`);
            await page.locator(reviewDialog).getByRole('button', { name: choice, exact: true }).click();
            await expect(page.locator('.neconyan-note-proposal-review')).toBeHidden();
            await expect.poll(async () => (await notesApi(page, '/assistant/proposal', { proposalId: proposed.proposalId })).state)
                .toBe(choice === 'Not now' ? 'waiting' : choice === 'Decline' ? 'denied' : 'applied');
            const saved = await readNote(page, notebookId, note.id);
            expect(saved.text.includes(addition)).toBe(choice === 'Save change');
            if (choice === 'Not now') await notesApi(page, '/assistant/decide', { proposalId: proposed.proposalId, proposalHash: proposed.proposalHash, decision: 'deny' });
        }
    });

    test(`the real chat Save to note action captures and appends exact passages at ${viewport.width}px`, async ({ page, context }, info) => {
        await page.setViewportSize(viewport);
        await openWorkspace(page);
        const headers = await page.evaluate(async () => (await import('/script.js')).getRequestHeaders());
        const imported = await context.request.post('/api/characters/import', { headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-type')),
            multipart: { file_type: 'png', avatar: { name: 'Notes capture.png', mimeType: 'image/png',
                buffer: fs.readFileSync(new URL('../default/content/assistants/taro-male/card.png', import.meta.url)) } } });
        expect(imported.ok(), await imported.text()).toBe(true);
        const { file_name } = await imported.json();
        const avatar = file_name.endsWith('.png') ? file_name : `${file_name}.png`;
        const chatName = `Notes capture ${randomUUID()}`;
        const locator = { avatar_url: avatar, file_name: chatName };
        const vacant = await context.request.post('/api/chats/get', { headers, data: { ...locator, allow_create: true } });
        const evidence = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        const passage = 'Exact character words.\n\nA second paragraph with **Markdown** and [[an idea]].';
        const records = [{ user_name: 'You', character_name: 'Taro', chat_metadata: {} },
            { name: 'Taro', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: passage }];
        const saved = await context.request.post('/api/chats/save', { headers, data: { ...locator, chat: records,
            roleplay: { account: evidence.account, vacancy: evidence.vacancy, operationKey: `browser:${randomUUID()}` } } });
        expect(saved.ok(), await saved.text()).toBe(true);
        await page.evaluate(async ({ avatar, chatName }) => {
            const core = await import('/script.js');
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await core.openCharacterChat(chatName);
        }, { avatar, chatName });
        const message = page.locator('#chat .mes[mesid="0"]');
        await expect(message.locator('.mes_text')).toContainText('Exact character words.');
        await message.getByRole('button', { name: 'More message actions', exact: true }).click();
        await message.locator('.mes_save_note').click();
        await expect(page.locator('.popup:visible').getByRole('heading', { name: 'Save to note', exact: true })).toBeVisible();
        await measureControls(page, '.popup:visible', viewport, info, 'chat-capture');
        const title = `Captured ${randomUUID()}`;
        await page.locator('.popup:visible').getByLabel('Name', { exact: true }).fill(title);
        const response = page.waitForResponse('**/api/notebooks/notes/capture');
        await page.locator('.popup:visible').getByRole('button', { name: 'Save', exact: true }).click();
        const captured = await (await response).json();
        expect(captured.status).toBe('success');
        const notebookId = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().state.notebookId);
        const detail = await notesApi(page, '/notes/read', { notebookId, noteId: captured.noteId });
        expect(detail.note.text).toContain(passage.split('\n').map(line => line ? `> ${line}` : '>').join('\n'));
        expect(detail.provenance.at(-1)).toMatchObject({ chat: chatName, character: avatar, speaker: 'Taro', messageId: 0 });
        const policy = await notesApi(page, '/policies/get', { notebookId });
        expect(policy.policy.notes?.[captured.noteId]?.context?.mode ?? 'off').toBe('off');
        await page.locator('#neconyan-notes').getByRole('button', { name: 'Back to chat', exact: true }).click();
        await message.getByRole('button', { name: 'More message actions', exact: true }).click();
        await message.locator('.mes_save_note').click();
        await page.locator('.popup:visible').getByRole('button', { name: 'Existing note', exact: true }).click();
        await page.locator('.popup:visible').getByLabel('Add to', { exact: true }).fill(title);
        await page.locator('.popup:visible .notes-note-title').getByText(title, { exact: true }).click();
        const appendedResponse = page.waitForResponse('**/api/notebooks/notes/capture');
        await page.locator('.popup:visible').getByRole('button', { name: 'Save', exact: true }).click();
        expect((await (await appendedResponse).json()).noteId).toBe(captured.noteId);
        const appended = await notesApi(page, '/notes/read', { notebookId, noteId: captured.noteId });
        expect(appended.provenance).toHaveLength(2);
        expect(appended.note.text.split('> Exact character words.')).toHaveLength(3);
    });
}

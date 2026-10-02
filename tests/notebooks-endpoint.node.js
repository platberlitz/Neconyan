import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import multer from 'multer';
import { fixture } from './roleplay-transactions-fixture.js';

const { router } = await import('../src/endpoints/notebooks.js');
const { subscribeNotebookChanges } = await import('../src/notebooks/events.js');

let counter = 0;
const op = label => `endpoint:${label}:${++counter}`;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf0000000301010018dd8db40000000049454e44ae426082', 'hex');

async function server(t, owner = 'endpoint-owner') {
    const f = fixture(t, false, owner);
    const worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(worlds, { recursive: true });
    fs.writeFileSync(path.join(worlds, 'Test World.json'), JSON.stringify({ entries: { 3: { uid: 3, comment: 'Magic', content: 'Old.', key: ['magic'], disable: false, order: 9 } } }, null, 4));
    const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-uploads-'));
    t.after(() => fs.rmSync(uploads, { recursive: true, force: true }));
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use((request, _response, next) => {
        request.user = { directories: f.scope.directories, profile: { handle: f.scope.owner } };
        next();
    });
    app.use('/notebooks', router);
    const listening = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(() => {
        listening.closeAllConnections();
        listening.close();
    });
    const url = `http://127.0.0.1:${listening.address().port}/notebooks`;
    const owner_ = f.scope.owner;
    const post = async (route, body, headers = {}) => {
        const response = await fetch(`${url}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Connection: 'close', 'X-Neconyan-Account': owner_, ...headers },
            body: JSON.stringify(body),
        });
        return { http: response.status, body: await response.json() };
    };
    const upload = async (route, fields, name, bytes) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('avatar', new Blob([bytes]), name);
        const response = await fetch(`${url}${route}`, { method: 'POST', headers: { Connection: 'close', 'X-Neconyan-Account': owner_ }, body: form });
        return { http: response.status, body: await response.json() };
    };
    return { f, url, post, upload, uploads, owner: owner_ };
}

test('notes round-trip through the API with structured statuses', async t => {
    const { post } = await server(t);
    const list = await post('/list', {});
    assert.equal(list.http, 200);
    const notebookId = list.body.notebooks[0].id;

    const created = await post('/notes/create', { operationId: op('create'), notebookId, title: 'Magic system', text: '# Magic system\n\nFirst.\n' });
    assert.equal(created.body.status, 'success');
    assert.equal(created.body.committed, true);
    const { noteId, revision } = created.body;

    const read = await post('/notes/read', { notebookId, noteId });
    assert.equal(read.body.note.text, '# Magic system\n\nFirst.\n');
    assert.equal(read.body.note.revision, revision);

    const updated = await post('/notes/update', { operationId: op('update'), notebookId, noteId, expectedRevision: revision, changes: [{ type: 'append', markdown: 'Second.' }] });
    assert.equal(updated.body.status, 'success');

    const stale = await post('/notes/update', { operationId: op('stale'), notebookId, noteId, expectedRevision: revision, changes: [{ type: 'append', markdown: 'Lost?' }] });
    assert.equal(stale.http, 409);
    assert.equal(stale.body.status, 'conflict');
    assert.equal(stale.body.code, 'NOTE_CONFLICT');
    assert.equal(stale.body.currentRevision, updated.body.revision);

    const replay = await post('/notes/update', { operationId: op('again'), notebookId, noteId, expectedRevision: updated.body.revision, changes: [{ type: 'append', markdown: 'Third.' }] });
    assert.equal(replay.body.status, 'success');

    const missing = await post('/notes/read', { notebookId, noteId: 'n_0000000000000000' });
    assert.equal(missing.http, 404);
    assert.equal(missing.body.status, 'not_found');

    const search = await post('/search', { notebookId, query: 'second' });
    assert.equal(search.body.results[0].id, noteId);
    assert.equal(search.body.results[0].text, undefined, 'search results never carry whole bodies');
});

test('the account header must match the signed-in account', async t => {
    const { post } = await server(t);
    const wrong = await post('/list', {}, { 'X-Neconyan-Account': 'someone-else' });
    assert.equal(wrong.http, 409);
    assert.equal(wrong.body.code, 'ACCOUNT_CHANGED');
});

test('a reused operation id with different arguments is refused', async t => {
    const { post } = await server(t);
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    const id = op('reuse');
    const first = await post('/notes/create', { operationId: id, notebookId, title: 'One', text: 'a' });
    const again = await post('/notes/create', { operationId: id, notebookId, title: 'One', text: 'a' });
    assert.equal(again.body.noteId, first.body.noteId);
    assert.equal(again.body.replayed, true);
    const different = await post('/notes/create', { operationId: id, notebookId, title: 'Two', text: 'b' });
    assert.equal(different.http, 409);
    assert.equal(different.body.code, 'OPERATION_REUSED');
});

test('assistant proposals wait for review and apply once', async t => {
    const { post } = await server(t);
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    const note = (await post('/notes/create', { operationId: op('note'), notebookId, title: 'Ideas', text: '# Ideas\n' })).body;

    const hidden = await post('/assistant/tool', { callId: 'call-hidden-1', tool: 'read-note', args: { notebookId, noteId: note.noteId } });
    assert.equal(hidden.http, 404, 'assistants cannot see notes by default');

    const policy = await post('/policies/get', { notebookId });
    const patched = await post('/policies/update', { notebookId, expectedRevision: policy.body.policy.revision, patch: { assistant: 'edit' } });
    assert.equal(patched.body.status, 'success');

    const proposed = await post('/assistant/tool', { callId: 'call-append-1', tool: 'append-note', args: { notebookId, noteId: note.noteId, markdown: 'A new idea.' } });
    assert.equal(proposed.body.status, 'needs_approval');
    assert.equal(proposed.body.committed, false);
    assert.match(proposed.body.message, /Not saved yet/);
    const untouched = await post('/notes/read', { notebookId, noteId: note.noteId });
    assert.equal(untouched.body.note.text, '# Ideas\n');

    const retried = await post('/assistant/tool', { callId: 'call-append-1', tool: 'append-note', args: { notebookId, noteId: note.noteId, markdown: 'A new idea.' } });
    assert.equal(retried.body.proposalId, proposed.body.proposalId);

    const detail = await post('/assistant/proposal', { proposalId: proposed.body.proposalId });
    assert.equal(detail.body.state, 'waiting');

    const decided = await post('/assistant/decide', { proposalId: proposed.body.proposalId, proposalHash: proposed.body.proposalHash, decision: 'allow' });
    assert.equal(decided.body.status, 'success');
    assert.equal(decided.body.committed, true);
    const twice = await post('/assistant/decide', { proposalId: proposed.body.proposalId, proposalHash: proposed.body.proposalHash, decision: 'allow' });
    assert.equal(twice.body.revision, decided.body.revision);
    const after = await post('/notes/read', { notebookId, noteId: note.noteId });
    assert.equal(after.body.note.text.match(/A new idea\./g).length, 1);
});

test('lore previews do not emit change notifications and publication does', async t => {
    const { post, owner } = await server(t);
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    const note = (await post('/notes/create', { operationId: op('lore'), notebookId, title: 'Magic', text: '# Magic\n\n## Rules\nHealing hurts.\n' })).body;
    const seen = [];
    const unsubscribe = subscribeNotebookChanges(change => {
        if (change.owner === owner) seen.push(change.kind);
    });
    t.after(unsubscribe);
    const selector = { kind: 'heading', path: ['Magic', 'Rules'] };
    const preview = await post('/lore/preview', { notebookId, noteId: note.noteId, selector, book: 'Test World', uid: 3 });
    assert.equal(preview.body.status, 'success');
    assert.deepEqual(seen, []);
    const published = await post('/lore/publish', {
        operationId: op('publish'), notebookId, noteId: note.noteId, selector, book: 'Test World', uid: 3,
        expectedSourceHash: preview.body.preview.sourceHash, expectedTargetHash: preview.body.preview.targetHash,
    });
    assert.equal(published.body.status, 'success');
    assert.deepEqual(seen, ['lore']);
});

test('attachments upload, serve with safe headers and stay account scoped', async t => {
    const { post, upload, url, owner, uploads } = await server(t);
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    const saved = await upload('/attachments/upload', { operationId: op('upload'), notebookId }, 'harbour.png', PNG);
    assert.equal(saved.body.status, 'success');
    assert.match(saved.body.markdown, /^!\[harbour\.png\]\(attachments\/harbour\.png\)$/);
    assert.deepEqual(fs.readdirSync(uploads), [], 'temporary uploads are removed');

    const file = await fetch(`${url}/attachments/file?notebookId=${notebookId}&path=${encodeURIComponent(saved.body.path)}`, { headers: { 'X-Neconyan-Account': owner, Connection: 'close' } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('content-security-policy'), /sandbox/);
    assert.equal(file.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

    const svg = await upload('/attachments/upload', { operationId: op('svg'), notebookId }, 'icon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    assert.equal(svg.body.status, 'success');
    const svgFile = await fetch(`${url}/attachments/file?notebookId=${notebookId}&path=${encodeURIComponent(svg.body.path)}`, { headers: { Connection: 'close' } });
    assert.equal(svgFile.headers.get('content-type'), 'application/octet-stream');
    assert.match(svgFile.headers.get('content-disposition'), /^attachment;/);

    const html = await upload('/attachments/upload', { operationId: op('html'), notebookId }, 'page.html', Buffer.from('<script></script>'));
    assert.equal(html.http, 415);
});

test('export then import creates an independent notebook with inactive permissions', async t => {
    const { post, upload, url, owner } = await server(t);
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    await post('/notes/create', { operationId: op('ex'), notebookId, folder: 'Worldbuilding', title: 'Magic system', text: '---\nneconyan_id: n_1111111111111111\nmood: [a, b]\n---\n# Magic\n\n```\n[[not a link]]\n```\n' });
    const exported = await fetch(`${url}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': owner, Connection: 'close' }, body: JSON.stringify({ notebookId }) });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('content-type'), 'application/zip');
    const zip = Buffer.from(await exported.arrayBuffer());

    const staged = await upload('/import/stage', {}, 'Notebook.zip', zip);
    assert.equal(staged.body.status, 'success');
    assert.equal(staged.body.stage.notes.length, 1);
    const committed = await post('/import/commit', { operationId: op('import'), stageId: staged.body.stage.stageId, name: 'Imported' });
    assert.equal(committed.body.status, 'success');
    assert.equal(committed.body.permissions, 'inactive');
    const importedId = committed.body.notebook.id;
    assert.notEqual(importedId, notebookId);
    const policy = await post('/policies/get', { notebookId: importedId });
    assert.equal(policy.body.policy.admitted, false);
    assert.equal(policy.body.policy.assistant, 'none');
    const notes = await post('/notes/list', { notebookId: importedId });
    const imported = await post('/notes/read', { notebookId: importedId, noteId: notes.body.notes[0].id });
    assert.match(imported.body.note.text, /```\n\[\[not a link\]\]\n```/);
});

test('another account cannot read this account\'s notes', async t => {
    const first = await server(t, 'endpoint-a');
    const second = await server(t, 'endpoint-b');
    const notebookId = (await first.post('/list', {})).body.notebooks[0].id;
    const note = (await first.post('/notes/create', { operationId: op('private'), notebookId, title: 'Secret', text: 'private' })).body;
    const attempt = await second.post('/notes/read', { notebookId, noteId: note.noteId });
    assert.equal(attempt.http, 404);
    assert.doesNotMatch(JSON.stringify(attempt.body), /Secret|private/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import multer from 'multer';
import { unzipSync } from 'fflate';
import { fixture } from './roleplay-transactions-fixture.js';
import { splitFrontmatter } from '../src/notebooks/markdown.js';
import { getConfig } from '../src/util.js';
import { stopObsidian } from '../src/notebooks/obsidian.js';

const { router } = await import('../src/endpoints/notebooks.js');
const { subscribeNotebookChanges } = await import('../src/notebooks/events.js');

let counter = 0;
const op = label => `endpoint:${label}:${++counter}`;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf0000000301010018dd8db40000000049454e44ae426082', 'hex');

test('optional sync owner routes never start on a read and reconcile exact files without granting AI access or publishing lore', async t => {
    let endpoint;
    let notebookId;
    const config = getConfig();
    const previous = config.notebooks;
    t.after(async () => {
        if (endpoint && notebookId) await stopObsidian(endpoint.f.scope, notebookId).catch(() => {});
        config.notebooks = previous;
    });
    endpoint = await server(t, 'obsidian-endpoint-owner');
    const { f, post } = endpoint;
    const other = await server(t, 'obsidian-endpoint-other');
    notebookId = (await post('/list', {})).body.notebooks[0].id;
    const original = (await post('/notes/create', { notebookId, operationId: op('sync-original'), title: 'Existing', text: '# Existing\r\n\r\nOwned source.\r\n' })).body;
    const policy = (await post('/policies/get', { notebookId })).body.policy;
    await post('/policies/update', { notebookId, operationId: op('sync-permissions'), expectedRevision: policy.revision, patch: { assistant: 'edit', assistantPublish: true } });
    const folder = path.join(f.scope.directories.root, 'notebooks', notebookId);
    const executable = path.join(f.root, 'owned-headless.cjs');
    fs.writeFileSync(executable, `#!${process.execPath}\n` + fs.readFileSync(new URL('./notebooks-obsidian-cli-fixture.cjs', import.meta.url), 'utf8').replace(/^#![^\n]*\n/, ''), { mode: 0o700 });
    config.notebooks = { obsidianHeadless: { enabled: false, executable, allowedRoots: ['$ACCOUNT_ROOT/notebooks'], pollIntervalMs: 60000 } };
    const disabled = await post('/obsidian/status', { notebookId });
    assert.equal(disabled.http, 200);
    assert.equal(disabled.body.adapter.available, false);
    assert.equal(disabled.body.adapter.running, false);
    assert.equal((await post('/obsidian/start', { notebookId, operationId: op('sync-disabled'), expectedRevision: null })).http, 409);
    config.notebooks.obsidianHeadless.enabled = true;
    const ready = (await post('/obsidian/status', { notebookId })).body.adapter;
    assert.equal(ready.candidateFolder, folder);
    const source = '# Received\r\n\r\nImported frontmatter never grants access.\r\n';
    const bytes = Buffer.from([0, 1, 255, 13, 10]);
    fs.writeFileSync(path.join(folder, 'Received.md'), source);
    fs.writeFileSync(path.join(folder, 'Binary.txt'), bytes);
    const loreBefore = fs.readFileSync(path.join(f.scope.directories.root, 'worlds', 'Test World.json'));
    const input = { notebookId, operationId: op('sync-configure'), expectedRevision: ready.revision, folder, singleMechanism: true };
    const configured = await post('/obsidian/configure', input);
    assert.equal(configured.http, 200);
    assert.equal(configured.body.adapter.running, false);
    assert.equal((await post('/obsidian/configure', input)).http, 200);
    const notes = (await post('/notes/list', { notebookId })).body.notes;
    const received = notes.find(note => note.path === 'Received.md');
    assert.ok(received);
    const policies = (await post('/policies/get', { notebookId })).body.policy;
    assert.equal(policies.notes[received.id].assistant, 'none');
    assert.equal(policies.notes[received.id].context.mode, 'off');
    assert.equal(policies.assistant, 'edit');
    assert.equal((await post('/assistant/tool', { tool: 'read-note', args: { notebookId, noteId: received.id }, callId: 'sync-does-not-grant-ai' })).http, 404);
    assert.equal((await post('/notes/read', { notebookId, noteId: original.noteId })).body.note.revision, original.revision);
    const history = (await post('/obsidian/history', { notebookId })).body.history;
    const file = history.find(entry => entry.path === 'Binary.txt');
    const download = await fetch(endpoint.url + '/obsidian/history/file', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': f.scope.owner, Connection: 'close' }, body: JSON.stringify({ notebookId, historyId: file.id }) });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await other.post('/obsidian/status', { notebookId })).http, 404);
    assert.equal((await post('/obsidian/status', { notebookId }, { 'X-Neconyan-Account': 'wrong' })).http, 409);
    const started = await post('/obsidian/start', { notebookId, operationId: op('sync-start'), expectedRevision: configured.body.adapter.revision });
    assert.equal(started.http, 200);
    assert.equal(started.body.adapter.running, true);
    assert.ok(!JSON.stringify(started.body).includes('PRIVATE-CLIENT-'));
    assert.equal((await post('/obsidian/start', { notebookId, operationId: op('sync-second'), expectedRevision: configured.body.adapter.revision })).http, 409);
    const stopped = await post('/obsidian/stop', { notebookId });
    assert.equal(stopped.http, 200);
    assert.equal(stopped.body.adapter.running, false);
    assert.equal(fs.readFileSync(path.join(folder, 'Received.md'), 'utf8'), source);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'Binary.txt')), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.root, 'worlds', 'Test World.json')), loreBefore);
    const commands = fs.readFileSync(path.join(path.dirname(folder), `.obsidian-test-${path.basename(folder)}.ndjson`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(commands.map(entry => entry.args[0]), ['sync-status', 'sync']);
});

test('portable canvas owner routes check loaded revisions and retain opaque fields without sharing notes or publishing lore', async t => {
    const { f, post } = await server(t, 'canvas-endpoint-owner');
    const other = await server(t, 'canvas-other-owner');
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    const reference = (await post('/notes/create', { notebookId, operationId: op('canvas-reference'), folder: '', title: 'Reference', text: '# Rules\r\n\r\nSaved reference.\r\n' })).body;
    const policy = (await post('/policies/get', { notebookId })).body.policy;
    const liveLore = fs.readFileSync(path.join(f.scope.directories.root, 'worlds', 'Test World.json'), 'utf8');
    const document = { future: { version: 7, untouched: ['opaque', true] }, nodes: [
        { id: 'note-card', type: 'file', x: 0, y: 0, width: 320, height: 180, file: 'Reference.md', subpath: '#Rules', plugin: { retained: true } },
        { id: 'text-card', type: 'text', x: 400, y: 0, width: 320, height: 180, text: '<script>not executed</script>', color: '2' },
        { id: 'group-card', type: 'group', x: -20, y: -20, width: 760, height: 240, label: 'Plans', background: 'https://example.invalid/no-fetch.png' },
    ], edges: [{ id: 'connection', fromNode: 'note-card', toNode: 'text-card', toEnd: 'arrow', future: { retained: true } }] };
    const create = { notebookId, operationId: op('canvas-create'), title: 'Portable plan', document };
    const created = await post('/canvas/create', create);
    assert.equal(created.http, 200);
    assert.equal(created.body.status, 'success');
    const { canvasId, revision } = created.body;
    assert.equal((await post('/canvas/create', create)).body.replayed, true);
    const list = (await post('/canvas/list', { notebookId })).body;
    assert.equal(list.canvases.length, 1);
    const loaded = (await post('/canvas/read', { notebookId, canvasId })).body;
    assert.deepEqual(loaded.canvas.document, document);
    assert.equal(loaded.canvas.revision, revision);
    assert.equal(loaded.preview.nodes[0].noteId, reference.noteId);
    assert.equal(loaded.preview.nodes[0].excerpt, '# Rules\r\n\r\nSaved reference.\r\n');
    assert.ok(!JSON.stringify(loaded.preview).includes('no-fetch.png'));
    const projection = await post('/canvas/preview', { notebookId, canvasId, document: { ...document, future: { retained: true } } });
    assert.equal(projection.http, 200);
    assert.equal((await post('/canvas/read', { notebookId, canvasId })).body.canvas.revision, revision, 'previews do not write');
    const update = { notebookId, canvasId, operationId: op('canvas-update'), expectedRevision: revision,
        changes: [{ type: 'update-node', id: 'text-card', set: { text: 'Changed planning text.', x: 460 } }] };
    const changed = await post('/canvas/update', update);
    assert.equal(changed.http, 200);
    assert.equal(changed.body.status, 'success');
    assert.equal((await post('/canvas/update', update)).body.replayed, true);
    const stale = await post('/canvas/update', { ...update, operationId: op('canvas-stale') });
    assert.equal(stale.http, 409);
    assert.equal(stale.body.code, 'CANVAS_CONFLICT');
    assert.equal((await post('/canvas/update', { ...update, operationId: op('canvas-unguarded'), expectedRevision: undefined })).http, 409);
    const current = (await post('/canvas/read', { notebookId, canvasId })).body.canvas;
    assert.deepEqual(current.document.future, document.future);
    assert.deepEqual(current.document.nodes[0].plugin, document.nodes[0].plugin);
    assert.deepEqual(current.document.edges[0].future, document.edges[0].future);
    const history = (await post('/canvas/history', { notebookId, canvasId })).body.history;
    assert.equal(history.length, 2);
    const old = (await post('/canvas/history/read', { notebookId, canvasId, historyId: history.at(-1).id })).body;
    assert.deepEqual(old.document, document);
    const restored = await post('/canvas/history/restore', { notebookId, canvasId, operationId: op('canvas-restore'), expectedRevision: current.revision, historyId: history.at(-1).id });
    assert.equal(restored.http, 200);
    assert.deepEqual((await post('/canvas/read', { notebookId, canvasId })).body.canvas.document, document);
    assert.equal((await other.post('/canvas/read', { notebookId, canvasId })).http, 404);
    assert.equal((await post('/canvas/read', { notebookId, canvasId }, { 'X-Neconyan-Account': 'different-owner' })).http, 409);
    assert.equal((await post('/assistant/tool', { tool: 'read-note', args: { notebookId, noteId: reference.noteId }, callId: 'canvas-does-not-grant-read' })).http, 404);
    assert.deepEqual((await post('/policies/get', { notebookId })).body.policy, policy);
    assert.equal((await post('/notes/read', { notebookId, noteId: reference.noteId })).body.note.revision, reference.revision);
    assert.equal(fs.readFileSync(path.join(f.scope.directories.root, 'worlds', 'Test World.json'), 'utf8'), liveLore);
    const malformed = await post('/canvas/create', { notebookId, operationId: op('canvas-invalid'), title: 'Invalid', document: { nodes: [{ type: 'text' }] } });
    assert.equal(malformed.http, 400);
    assert.equal((await post('/canvas/list', { notebookId })).body.canvases.length, 1);
});

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

test('hidden cold notebooks are not indexed before assistant access is checked', async t => {
    const { f, post } = await server(t, 'cold-assistant-owner');
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    const note = (await post('/notes/create', { operationId: op('cold-private'), notebookId, title: 'Private', text: 'Not shared.' })).body;
    const folder = path.join(f.scope.directories.root, 'notebooks', notebookId);
    for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(folder, `External ${index}.md`), `# External ${index}\nPrivate data.`);
    const hidden = await post('/assistant/tool', { callId: 'cold-hidden-1', tool: 'read-note', args: { notebookId, noteId: note.noteId } });
    assert.equal(hidden.http, 404);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.scope.directories.root, 'notebook-control', notebookId, 'manifest.json'), 'utf8')).notes).length, 1);
    assert.doesNotMatch(JSON.stringify(hidden.body), /Private|External|40/);
    await post('/policies/update', { operationId: op('cold-read-access'), notebookId, patch: { assistant: 'read' } });
    for (let index = 40; index < 80; index++) fs.writeFileSync(path.join(folder, `External ${index}.md`), `# External ${index}\nShared data.`);
    const allowed = await post('/assistant/tool', { callId: 'cold-allowed-1', tool: 'read-note', args: { notebookId, noteId: note.noteId } });
    assert.equal(allowed.http, 200);
    assert.match(JSON.stringify(allowed.body), /Not shared\./);
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

test('a forced owner write prepares new external files even while the old index is fresh', async t => {
    const { f, post } = await server(t, 'fresh-index-owner');
    const notebookId = (await post('/list', {})).body.notebooks[0].id;
    assert.equal((await post('/tree', { notebookId })).body.noteCount, 0);
    const folder = path.join(f.scope.directories.root, 'notebooks', notebookId);
    for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(folder, `Fresh ${index}.md`), `# Fresh ${index}\n`);
    const created = await post('/notes/create', { operationId: op('fresh-index'), notebookId, title: 'Owner note', text: 'Saved.' });
    assert.equal(created.http, 200);
    assert.equal(created.body.status, 'success');
    const listed = await post('/notes/list', { notebookId, limit: 100 });
    assert.equal(listed.body.notes.length, 41);
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

test('rendered embeds are owner-only read previews and cannot change note bytes or AI policies', async t => {
    const first = await server(t, 'embed-owner-a');
    const other = await server(t, 'embed-owner-b');
    const notebookId = (await first.post('/list', {})).body.notebooks[0].id;
    const targetText = '---\r\ntitle: Saved target\r\n---\r\n# Target\r\n\r\nSaved content.\r\n';
    const target = (await first.post('/notes/create', { operationId: op('embed-target'), notebookId, title: 'Target', text: targetText })).body;
    const sourceText = '# Source\n![[Target]]\n';
    const source = (await first.post('/notes/create', { operationId: op('embed-source'), notebookId, title: 'Source', text: sourceText })).body;
    const policyBefore = (await first.post('/policies/get', { notebookId })).body;
    const historyBefore = (await first.post('/notes/history', { notebookId, noteId: source.noteId })).body;
    const preview = await first.post('/embeds', { notebookId, noteId: source.noteId, text: '# Unsaved owner draft\n![[Target#Target]]', actor: 'assistant' });
    assert.equal(preview.http, 200);
    assert.equal(preview.body.embeds[0].noteId, target.noteId);
    assert.equal(preview.body.embeds[0].revision, target.revision);
    assert.equal(preview.body.embeds[0].text, '# Target\r\n\r\nSaved content.\r\n');
    assert.deepEqual((await first.post('/policies/get', { notebookId })).body, policyBefore);
    assert.deepEqual((await first.post('/notes/history', { notebookId, noteId: source.noteId })).body, historyBefore);
    assert.equal((await first.post('/notes/read', { notebookId, noteId: source.noteId })).body.note.text, sourceText);
    assert.equal((await first.post('/notes/read', { notebookId, noteId: target.noteId })).body.note.text, targetText);
    assert.equal((await first.post('/assistant/tool', { callId: 'embedded-not-shared', tool: 'read-note', args: { notebookId, noteId: target.noteId } })).http, 404);
    const unavailable = await other.post('/embeds', { notebookId, noteId: source.noteId });
    assert.equal(unavailable.http, 404);
    assert.doesNotMatch(JSON.stringify(unavailable.body), /Saved target|Saved content|Source/);
    assert.equal((await first.post('/embeds', { notebookId, noteId: source.noteId }, { 'X-Neconyan-Account': other.owner })).http, 409);
    assert.equal((await first.post('/embeds', { notebookId, noteId: source.noteId, text: {} })).http, 400);
    assert.equal((await first.post('/embeds', { notebookId, noteId: source.noteId, text: 'a\0b' })).http, 400);
    assert.equal((await first.post('/embeds', { notebookId, noteId: source.noteId, text: 'a'.repeat(4 * 1024 * 1024 + 1) })).http, 413);
});

test('notebook graphs are bounded owner-only saved-note metadata, with no authoring or AI permission changes', async t => {
    const first = await server(t, 'graph-owner-a');
    const other = await server(t, 'graph-owner-b');
    const notebookId = (await first.post('/list', {})).body.notebooks[0].id;
    const a = (await first.post('/notes/create', { operationId: op('graph-a'), notebookId, folder: 'World/Cities', title: 'Alpha', text: '---\r\ntags: [world/cities]\r\n---\r\n# Alpha\r\nPrivate body. [[Beta]] ![[Beta]]\r\n' })).body;
    const b = (await first.post('/notes/create', { operationId: op('graph-b'), notebookId, folder: 'World/Cities', title: 'Beta', text: '---\ntags: [world]\n---\n[[Alpha]]\n' })).body;
    const before = (await first.post('/notes/read', { notebookId, noteId: a.noteId })).body.note;
    const policies = (await first.post('/policies/get', { notebookId })).body;
    const history = (await first.post('/notes/history', { notebookId, noteId: a.noteId })).body;
    const graph = await first.post('/graph', { notebookId, limit: 99999, actor: 'assistant' });
    assert.equal(graph.http, 200);
    assert.equal(graph.body.nodes.length, 2);
    assert.equal(graph.body.limits.nodes, 300);
    assert.deepEqual(new Set(graph.body.nodes.map(node => node.id)), new Set([a.noteId, b.noteId]));
    assert.equal(graph.body.edges[0].references, 3);
    assert.equal(graph.body.edges[0].embedded, true);
    assert.doesNotMatch(JSON.stringify(graph.body), /Private body|revision|"text"/);
    const filtered = (await first.post('/graph', { notebookId, folder: 'World', tag: '#world/cities' })).body;
    assert.equal(filtered.total, 1);
    assert.equal(filtered.nodes[0].id, a.noteId);
    assert.equal(filtered.edges.length, 0);
    assert.equal((await first.post('/graph', { notebookId, folder: '../escape' })).http, 400);
    assert.equal((await other.post('/graph', { notebookId })).http, 404);
    assert.equal((await first.post('/graph', { notebookId }, { 'X-Neconyan-Account': other.owner })).http, 409);
    assert.equal((await first.post('/assistant/tool', { callId: 'graph-does-not-share', tool: 'read-note', args: { notebookId, noteId: a.noteId } })).http, 404);
    assert.deepEqual((await first.post('/notes/read', { notebookId, noteId: a.noteId })).body.note, before);
    assert.deepEqual((await first.post('/policies/get', { notebookId })).body, policies);
    assert.deepEqual((await first.post('/notes/history', { notebookId, noteId: a.noteId })).body, history);
});

test('property table metadata is owner-only, and cell writes retain loaded revisions, types and source comments', async t => {
    const first = await server(t, 'table-owner-a');
    const other = await server(t, 'table-owner-b');
    const notebookId = (await first.post('/list', {})).body.notebooks[0].id;
    const source = '---\r\ntitle: Table source\r\nscore: 2 # retained score comment\r\nenabled: false\r\nlabels:\r\n  - one # retained list comment\r\nnested:\r\n  private: Never sent in table metadata\r\ntags: [world/cities]\r\n---\r\n# Private body\r\nExact authoring text.\r\n';
    const note = (await first.post('/notes/create', { operationId: op('table-source'), notebookId, title: 'Table source', folder: 'World/Cities', text: source })).body;
    const policies = (await first.post('/policies/get', { notebookId })).body;
    const history = (await first.post('/notes/history', { notebookId, noteId: note.noteId })).body;
    const query = await first.post('/properties/table', { notebookId, columns: ['score', 'enabled', 'labels', 'nested'], limit: 99999, actor: 'assistant' });
    assert.equal(query.http, 200);
    assert.equal(query.body.limit, 100);
    assert.equal(query.body.rows.length, 1);
    const loaded = query.body.rows[0];
    assert.equal(loaded.id, note.noteId);
    assert.equal(loaded.revision, note.revision);
    assert.deepEqual(loaded.cells.score, { kind: 'number', value: 2, display: '2', editable: true });
    assert.equal(loaded.cells.enabled.value, false);
    assert.equal(loaded.cells.nested.editable, false);
    assert.doesNotMatch(JSON.stringify(query.body), /Private body|Exact authoring text|Never sent/);
    const filtered = await first.post('/properties/table', { notebookId, folder: 'World', tag: '#world/cities', filter: { key: 'score', op: 'greater', value: 1 }, sort: { by: 'property', key: 'score', direction: 'desc' } });
    assert.equal(filtered.body.total, 1);
    assert.equal((await first.post('/properties/table', { notebookId, filter: { key: 'score', op: 'greater', value: '1' } })).http, 400);
    assert.equal((await first.post('/properties/table', { notebookId, folder: '../escape' })).http, 400);
    assert.equal((await other.post('/properties/table', { notebookId })).http, 404);
    assert.equal((await first.post('/properties/table', { notebookId }, { 'X-Neconyan-Account': other.owner })).http, 409);
    assert.equal((await first.post('/assistant/tool', { callId: 'table-is-not-sharing', tool: 'read-note', args: { notebookId, noteId: note.noteId } })).http, 404);
    assert.equal((await first.post('/notes/read', { notebookId, noteId: note.noteId })).body.note.text, source);
    assert.deepEqual((await first.post('/notes/history', { notebookId, noteId: note.noteId })).body, history);
    assert.deepEqual((await first.post('/policies/get', { notebookId })).body, policies);

    const operation = { operationId: op('table-cell'), notebookId, noteId: loaded.id, expectedRevision: loaded.revision,
        changes: [{ type: 'properties', set: { score: 3.5, enabled: true, labels: ['changed'] } }], reason: 'edit' };
    const saved = await first.post('/notes/update', operation);
    assert.equal(saved.http, 200);
    const after = (await first.post('/notes/read', { notebookId, noteId: note.noteId })).body.note;
    assert.equal(after.properties.score, 3.5);
    assert.equal(after.properties.enabled, true);
    assert.deepEqual(after.properties.labels, ['changed']);
    assert.match(after.text, /retained score comment/);
    assert.match(after.text, /retained list comment/);
    assert.match(after.text, /Never sent in table metadata/);
    assert.equal(splitFrontmatter(after.text).body, '# Private body\r\nExact authoring text.\r\n');
    const afterHistory = (await first.post('/notes/history', { notebookId, noteId: note.noteId })).body;
    const replay = await first.post('/notes/update', operation);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual((await first.post('/notes/history', { notebookId, noteId: note.noteId })).body, afterHistory);
    const stale = await first.post('/notes/update', { ...operation, operationId: op('table-stale'), changes: [{ type: 'properties', set: { score: 99 } }] });
    assert.equal(stale.http, 409);
    assert.equal(stale.body.code, 'NOTE_CONFLICT');
    assert.equal((await first.post('/notes/read', { notebookId, noteId: note.noteId })).body.note.text, after.text);
    assert.deepEqual((await first.post('/policies/get', { notebookId })).body, policies);
});

test('known property names stay owner-only without returning values or granting assistant access', async t => {
    const first = await server(t, 'property-keys-owner');
    const other = await server(t, 'property-keys-other');
    const notebookId = (await first.post('/list', {})).body.notebooks[0].id;
    const note = (await first.post('/notes/create', { notebookId, operationId: op('known-keys'), title: 'Reference',
        text: '---\nseason: PRIVATE-SEASON-VALUE\nscore: 2\n---\nPrivate note body.\n' })).body;
    const policies = (await first.post('/policies/get', { notebookId })).body;
    const history = (await first.post('/notes/history', { notebookId, noteId: note.noteId })).body;
    const result = await first.post('/properties/keys', { notebookId });
    assert.equal(result.http, 200);
    assert.deepEqual(result.body.keys, ['score', 'season']);
    assert.equal(result.body.total, 2);
    assert.equal(result.body.partial, false);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE-SEASON-VALUE|Private note body/);
    assert.equal((await other.post('/properties/keys', { notebookId })).http, 404);
    assert.equal((await first.post('/properties/keys', { notebookId }, { 'X-Neconyan-Account': other.owner })).http, 409);
    assert.equal((await first.post('/assistant/tool', { callId: 'known-keys-do-not-share', tool: 'read-note', args: { notebookId, noteId: note.noteId } })).http, 404);
    assert.deepEqual((await first.post('/policies/get', { notebookId })).body, policies);
    assert.deepEqual((await first.post('/notes/history', { notebookId, noteId: note.noteId })).body, history);
});

test('selected export routes reject foreign or empty choices and include only chosen notes and direct files', async t => {
    const first = await server(t, 'selected-export-owner');
    const other = await server(t, 'selected-export-other');
    const notebookId = (await first.post('/list', {})).body.notebooks[0].id;
    const used = await first.upload('/attachments/upload', { notebookId, operationId: op('selected-file') }, 'used.png', PNG);
    const unused = await first.upload('/attachments/upload', { notebookId, operationId: op('unselected-file') }, 'unused.png', PNG);
    assert.equal(used.http, 200);
    assert.equal(unused.http, 200);
    const source = `# Picked\n\n![Used](../${used.body.path})\n\n[[../Hidden/Unpicked]]\n`;
    const picked = (await first.post('/notes/create', { notebookId, operationId: op('selected-note'), folder: 'Inbox', title: 'Picked', text: source })).body;
    await first.post('/notes/create', { notebookId, operationId: op('unselected-note'), folder: 'Hidden', title: 'Unpicked', text: 'PRIVATE-UNSELECTED-CONTENT' });
    const policies = (await first.post('/policies/get', { notebookId })).body;
    const exportRequest = (endpoint, body, account = endpoint.owner) => fetch(`${endpoint.url}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': account, Connection: 'close' }, body: JSON.stringify(body),
    });
    const response = await exportRequest(first, { notebookId, selection: { mode: 'notes', noteIds: [picked.noteId] } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const names = Object.keys(files);
    const markdown = names.filter(name => name.endsWith('.md'));
    assert.equal(markdown.length, 1);
    assert.ok(markdown[0].endsWith('/Inbox/Picked.md'));
    assert.equal(Buffer.from(files[markdown[0]]).toString('utf8'), source);
    assert.ok(names.some(name => name.endsWith('/attachments/used.png')));
    assert.ok(!names.some(name => /Hidden\/|unused\.png|Unpicked\.md|_neconyan|policies|history/.test(name)));
    for (const selection of [null, { mode: 'notes', noteIds: [] }, { mode: 'folder', folder: '../outside' }, { mode: 'all', noteIds: [picked.noteId] }]) {
        const invalid = await exportRequest(first, { notebookId, selection });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.headers.get('content-type'), 'application/json; charset=utf-8');
    }
    const missing = await exportRequest(first, { notebookId, selection: { mode: 'notes', noteIds: ['n_0000000000000000'] } });
    assert.equal(missing.status, 404);
    const foreign = await exportRequest(other, { notebookId, selection: { mode: 'notes', noteIds: [picked.noteId] } });
    assert.equal(foreign.status, 404);
    const changedAccount = await exportRequest(first, { notebookId, selection: { mode: 'all' } }, other.owner);
    assert.equal(changedAccount.status, 409);
    assert.deepEqual((await first.post('/policies/get', { notebookId })).body, policies);
    assert.equal((await first.post('/notes/read', { notebookId, noteId: picked.noteId })).body.note.revision, picked.revision);
    assert.equal((await first.post('/assistant/tool', { callId: 'export-does-not-share', tool: 'read-note', args: { notebookId, noteId: picked.noteId } })).http, 404);
});

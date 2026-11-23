import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router } = await import('../src/endpoints/worldinfo.js');
const { initialiseRoleplayAccount, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
const { worldInfoHistoryPath } = await import('../src/world-info-history.js');
const store = await import('../src/notebooks/store.js');
const lore = await import('../src/notebooks/lore.js');
const assistant = await import('../src/notebooks/assistant.js');
const links = await import('../src/notebooks/lorebook-links.js');

let counter = 0;
const op = label => `links:${label}:${++counter}`;
const established = { kind: 'heading', path: ['Magic system', 'Established rules'] };
const MAGIC = `# Magic system

## Established rules
Healing transfers the injury to the healer.

## Unresolved ideas
Could two healers distribute the injury between them?
`;
const book = text => ({ entries: { 3: { uid: 3, comment: 'Magic', content: text, key: ['magic'] }, 4: { uid: 4, comment: 'Other', content: 'Other entry.', key: ['other'] } } });
const CONTROL_FILES = ['lore-bindings.json', 'manifest.json', 'policies.json'];

async function prepared(t) {
    const owner = 'lorebook-links';
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-lorebook-links-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const root = path.join(temp, owner);
    const directories = { ...Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)])), root };
    for (const folder of Object.values(directories)) fs.mkdirSync(folder, { recursive: true });
    const scope = initialiseRoleplayAccount({ owner, directories });
    for (const name of ['Test World', 'Test World 2', 'test world']) {
        fs.writeFileSync(path.join(directories.worlds, `${name}.json`), JSON.stringify(book(`${name} magic.`), null, 4));
    }
    const run = operation => withRoleplayAccount(scope, scope, operation);
    const first = run(lease => store.ensureDefaultNotebookLocked(lease)).id;
    const second = run(lease => store.createNotebookLocked(lease, { operationId: op('notebook'), name: 'Second' })).notebook.id;
    const note = (notebookId, title) => run(lease => store.createNoteLocked(lease, { operationId: op('note'), notebookId, title, text: MAGIC })).noteId;
    const noteA = note(first, 'Magic system');
    const noteB = note(first, 'Context only');
    const noteC = note(first, 'Lorebook only');
    const other = note(second, 'Magic system');

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((request, _response, next) => {
        request.user = { directories, profile: { handle: owner } };
        next();
    });
    app.use('/api/worldinfo', router);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (url, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* a status without a body */ }
        return { status: response.status, json };
    };
    const control = (notebookId, file) => path.join(store.notebookControlRoot(root, notebookId), file);
    return { run, root, directories, first, second, noteA, noteB, noteC, other, post, control };
}

function publish(run, notebookId, noteId, bookName, uid = 3, selector = established) {
    const preview = run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector, book: bookName, uid }));
    return run(lease => lore.publishToLoreLocked(lease, {
        operationId: op('publish'), notebookId, noteId, selector, book: bookName, uid,
        expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash,
    }));
}

function linkEverything(f) {
    const { run, first, second, noteA, noteB, noteC, other } = f;
    assert.equal(publish(run, first, noteA, 'Test World').status, 'success');
    assert.equal(publish(run, second, other, 'Test World 2').status, 'success');
    assert.equal(publish(run, first, noteB, 'test world').status, 'success');
    run(lease => store.setAssociationsLocked(lease, {
        operationId: op('associations'), notebookId: first, noteId: noteA, associations: [
            { kind: 'lorebook', id: 'Test World', label: 'Test World' },
            { kind: 'lore-entry', id: 'Test World', uid: 3, label: 'Magic (Test World)' },
            { kind: 'lorebook', id: 'Test World 2', label: 'Test World 2' },
            { kind: 'lore-entry', id: 'test world', uid: 3, label: 'Magic (test world)' },
            { kind: 'character', id: 'Nova.png', label: 'Nova' },
        ],
    }));
    run(lease => store.setAssociationsLocked(lease, {
        operationId: op('associations'), notebookId: first, noteId: noteC, associations: [{ kind: 'lorebook', id: 'Test World.json', label: 'Test World' }],
    }));
    run(lease => store.setAssociationsLocked(lease, {
        operationId: op('associations'), notebookId: second, noteId: other, associations: [{ kind: 'lorebook', id: 'Test World 2', label: 'Test World 2' }],
    }));
    run(lease => {
        const policies = store.readPoliciesLocked(lease, first);
        policies.notes[noteA] = { context: { mode: 'reference', order: 2, scopes: [
            { kind: 'lorebook', id: 'Test World' }, { kind: 'lorebook', id: 'Test World 2' }, { kind: 'character', id: 'Nova.png', label: 'Nova' },
        ] } };
        policies.notes[noteB] = { assistant: 'read', context: { mode: 'pinned', order: 0, scopes: [{ kind: 'lorebook', id: 'Test World', label: 'Test World' }] } };
        policies.notes[noteC] = { context: { mode: 'reference', order: 0, scopes: [{ kind: 'lorebook', id: 'Test World.json' }] } };
        store.writePoliciesLocked(lease, first, policies);
    });
    run(lease => assistant.storeProposalLocked(lease, {
        proposal: { tool: 'notes_publish_to_lore', notebookId: first, noteId: noteA, book: 'Test World', uid: 3 }, callId: 'call-1',
    }));
}

const read = (f, notebookId, file) => fs.readFileSync(f.control(notebookId, file));
const proposals = f => fs.readFileSync(path.join(f.root, 'notebook-control', '_proposals.json'));
const noteText = (f, notebookId, noteId) => f.run(lease => store.readNoteLocked(lease, { notebookId, noteId })).entry.text;
const byNotebook = list => [...list].sort((a, b) => a.notebookId.localeCompare(b.notebookId));

test('renaming a lorebook moves every Notebook link and the binding keeps publishing', async t => {
    const f = await prepared(t);
    linkEverything(f);
    const { run, first, second, noteA, noteB, noteC, other } = f;
    const [before] = run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA }));
    const untouched = run(lease => lore.listBindingsLocked(lease, second));
    const savedProposals = proposals(f);
    const savedSecond = CONTROL_FILES.map(file => read(f, second, file));

    const data = JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Test World.json'), 'utf8'));
    const renamed = await f.post('/api/worldinfo/rename', { oldName: 'Test World', newName: 'Renamed World', data });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.json.notebooks, { links: 7, notebooks: [first], skipped: [] });

    const [binding] = run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA }));
    assert.equal(binding.book, 'Renamed World');
    assert.equal(binding.uid, 3);
    assert.equal(binding.status, 'in_sync');
    assert.notEqual(binding.id, before.id);
    assert.equal(run(lease => lore.listBindingsLocked(lease, first, { noteId: noteB }))[0].book, 'test world');
    assert.deepEqual(run(lease => lore.listBindingsLocked(lease, second)), untouched);

    const { entry } = run(lease => store.readNoteLocked(lease, { notebookId: first, noteId: noteA }));
    assert.equal(entry.text, MAGIC);
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('edit'), notebookId: first, noteId: noteA, expectedRevision: entry.hash,
        changes: [{ type: 'replace_selection', find: 'to the healer.', replace: 'to the healer, twice.' }],
    }));
    assert.equal(run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA }))[0].status, 'draft_changed');
    assert.equal(publish(run, first, noteA, 'Renamed World').status, 'success');
    const published = JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Renamed World.json'), 'utf8'));
    assert.equal(published.entries[3].content, 'Healing transfers the injury to the healer, twice.');
    const bindings = run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA }));
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].status, 'in_sync');

    const manifest = run(lease => store.readManifestLocked(lease, first));
    assert.deepEqual(manifest.associations[noteA], [
        { kind: 'lorebook', id: 'Renamed World', label: 'Renamed World' },
        { kind: 'lore-entry', id: 'Renamed World', uid: 3, label: 'Magic (Renamed World)' },
        { kind: 'lorebook', id: 'Test World 2', label: 'Test World 2' },
        { kind: 'lore-entry', id: 'test world', uid: 3, label: 'Magic (test world)' },
        { kind: 'character', id: 'Nova.png', label: 'Nova' },
    ]);
    assert.deepEqual(manifest.associations[noteC], [{ kind: 'lorebook', id: 'Renamed World.json', label: 'Renamed World' }]);
    const page = run(lease => lore.readLoreEntryPageLocked(lease, { book: 'Renamed World', uid: 3 }));
    assert.match(JSON.stringify(page), /twice/);

    const policies = run(lease => store.readPoliciesLocked(lease, first));
    assert.deepEqual(policies.notes[noteA].context.scopes, [
        { kind: 'lorebook', id: 'Renamed World' }, { kind: 'lorebook', id: 'Test World 2' }, { kind: 'character', id: 'Nova.png', label: 'Nova' },
    ]);
    assert.equal(policies.notes[noteA].context.order, 2);
    assert.deepEqual(policies.notes[noteB], { assistant: 'read', context: { mode: 'pinned', order: 0, scopes: [{ kind: 'lorebook', id: 'Renamed World', label: 'Renamed World' }] } });
    assert.deepEqual(policies.notes[noteC].context.scopes, [{ kind: 'lorebook', id: 'Renamed World.json' }]);

    assert.deepEqual(proposals(f), savedProposals);
    assert.deepEqual(CONTROL_FILES.map(file => read(f, second, file)), savedSecond);
    assert.equal(noteText(f, second, other), MAGIC);
});

test('deleting a lorebook detaches its bindings and removes its associations and scopes', async t => {
    const f = await prepared(t);
    linkEverything(f);
    const { run, first, second, noteA, noteB, noteC, other } = f;
    const untouched = run(lease => lore.listBindingsLocked(lease, second));
    const savedProposals = proposals(f);

    const deleted = await f.post('/api/worldinfo/delete', { name: 'Test World' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { ok: true, notebooks: { links: 7, notebooks: [first], skipped: [] } });
    assert.equal(fs.existsSync(path.join(f.directories.worlds, 'Test World.json')), false);

    assert.deepEqual(run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA })), []);
    assert.equal(run(lease => lore.listBindingsLocked(lease, first, { noteId: noteB }))[0].status, 'in_sync');
    const detached = run(lease => lore.readBindingsLocked(lease, first)).detached;
    assert.equal(detached.length, 1);
    assert.equal(detached[0].book, 'Test World.json');
    assert.equal(detached[0].detachedReason, 'book-deleted');
    assert.equal(detached[0].noteId, noteA);
    assert.equal(noteText(f, first, noteA), MAGIC);
    assert.deepEqual(run(lease => lore.listBindingsLocked(lease, second)), untouched);

    const manifest = run(lease => store.readManifestLocked(lease, first));
    assert.deepEqual(manifest.associations[noteA], [
        { kind: 'lorebook', id: 'Test World 2', label: 'Test World 2' },
        { kind: 'lore-entry', id: 'test world', uid: 3, label: 'Magic (test world)' },
        { kind: 'character', id: 'Nova.png', label: 'Nova' },
    ]);
    assert.equal(noteC in manifest.associations, false);
    assert.equal(run(lease => store.readManifestLocked(lease, second)).associations[other].length, 1);

    const policies = run(lease => store.readPoliciesLocked(lease, first));
    assert.deepEqual(policies.notes[noteA].context, { mode: 'reference', order: 2, scopes: [{ kind: 'lorebook', id: 'Test World 2' }, { kind: 'character', id: 'Nova.png', label: 'Nova' }] });
    assert.deepEqual(policies.notes[noteB], { assistant: 'read' });
    assert.equal(noteC in policies.notes, false);
    assert.deepEqual(proposals(f), savedProposals);

    fs.writeFileSync(path.join(f.directories.worlds, 'Test World.json'), JSON.stringify(book('New book.'), null, 4));
    assert.equal(publish(run, first, noteA, 'Test World').status, 'success');
});

test('deleting one entry still leaves its binding waiting on the missing entry', async t => {
    const f = await prepared(t);
    linkEverything(f);
    const data = book('Test World magic.');
    delete data.entries[3];
    assert.equal((await f.post('/api/worldinfo/edit', { name: 'Test World', data })).status, 200);
    const [binding] = f.run(lease => lore.listBindingsLocked(lease, f.first, { noteId: f.noteA }));
    assert.equal(binding.status, 'target_missing');
    assert.equal(f.run(lease => store.readManifestLocked(lease, f.first)).associations[f.noteA].length, 5);
});

test('files from a newer version are reported and left as they are, one part or the whole notebook', async t => {
    const f = await prepared(t);
    linkEverything(f);
    const newer = read(f, f.first, 'lore-bindings.json').toString().replace('"schema": 1', '"schema": 99');
    assert.match(newer, /"schema": 99/);
    fs.writeFileSync(f.control(f.first, 'lore-bindings.json'), newer);
    const manifest = JSON.parse(read(f, f.second, 'manifest.json'));
    fs.writeFileSync(f.control(f.second, 'manifest.json'), JSON.stringify({ ...manifest, schema: 99 }, null, 2));
    const savedSecond = read(f, f.second, 'manifest.json');

    const deleted = await f.post('/api/worldinfo/delete', { name: 'Test World' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(byNotebook(deleted.json.notebooks.skipped), byNotebook([
        { notebookId: f.first, name: 'Notebook', part: 'bindings', code: 'NOTEBOOK_SCHEMA_UNSUPPORTED' },
        { notebookId: f.second, name: 'Second', part: 'notebook', code: 'NOTEBOOK_SCHEMA_UNSUPPORTED' },
    ]));
    assert.equal(deleted.json.notebooks.links, 6);
    assert.equal(read(f, f.first, 'lore-bindings.json').toString(), newer);
    assert.deepEqual(read(f, f.second, 'manifest.json'), savedSecond);
    assert.equal(f.run(lease => store.readManifestLocked(lease, f.first)).associations[f.noteA].length, 3);
});

test('a rename that fails later puts every Notebook file back', async t => {
    const f = await prepared(t);
    linkEverything(f);
    const saved = CONTROL_FILES.map(file => read(f, f.first, file));
    const oldPath = path.join(f.directories.worlds, 'Test World.json');
    const newPath = path.join(f.directories.worlds, 'Renamed World.json');
    fs.mkdirSync(path.dirname(worldInfoHistoryPath(oldPath)), { recursive: true });
    fs.writeFileSync(worldInfoHistoryPath(oldPath), JSON.stringify({ commits: [] }));
    fs.writeFileSync(worldInfoHistoryPath(newPath), JSON.stringify({ commits: [] }));

    const data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    const renamed = await f.post('/api/worldinfo/rename', { oldName: 'Test World', newName: 'Renamed World', data });
    assert.equal(renamed.status, 500);
    assert.equal(fs.existsSync(oldPath), true);
    assert.equal(fs.existsSync(newPath), false);
    assert.deepEqual(CONTROL_FILES.map(file => read(f, f.first, file)), saved);
    const [binding] = f.run(lease => lore.listBindingsLocked(lease, f.first, { noteId: f.noteA }));
    assert.equal(binding.book, 'Test World');
    assert.equal(binding.status, 'in_sync');
});

test('a stale binding to a missing book of the new name is detached so the renamed book can be published', async t => {
    const f = await prepared(t);
    const { run, first, second, noteA, other } = f;
    assert.equal(publish(run, first, noteA, 'Test World').status, 'success');
    const stale = path.join(f.directories.worlds, 'Renamed World.json');
    fs.writeFileSync(stale, JSON.stringify(book('Removed outside Neconyan.'), null, 4));
    assert.equal(publish(run, second, other, 'Renamed World').status, 'success');
    fs.unlinkSync(stale);
    fs.rmSync(worldInfoHistoryPath(stale), { force: true });
    assert.equal(run(lease => lore.listBindingsLocked(lease, second))[0].status, 'target_missing');

    const data = JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Test World.json'), 'utf8'));
    const renamed = await f.post('/api/worldinfo/rename', { oldName: 'Test World', newName: 'Renamed World', data });
    assert.equal(renamed.status, 200);
    assert.deepEqual(byNotebook(renamed.json.notebooks.notebooks.map(notebookId => ({ notebookId }))), byNotebook([{ notebookId: first }, { notebookId: second }]));
    assert.deepEqual(run(lease => lore.listBindingsLocked(lease, second)), []);
    assert.equal(run(lease => lore.readBindingsLocked(lease, second)).detached[0].detachedReason, 'book-replaced');
    const { entry } = run(lease => store.readNoteLocked(lease, { notebookId: first, noteId: noteA }));
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('edit'), notebookId: first, noteId: noteA, expectedRevision: entry.hash,
        changes: [{ type: 'replace_selection', find: 'to the healer.', replace: 'to the healer, again.' }],
    }));
    assert.equal(publish(run, first, noteA, 'Renamed World').status, 'success');
});

test('two bindings repaired onto one section both survive a rename and keep publishing', async t => {
    const f = await prepared(t);
    const { run, first, noteA } = f;
    const unresolved = { kind: 'heading', path: ['Magic system', 'Unresolved ideas'] };
    const list = () => run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA })).sort((a, b) => a.uid - b.uid);
    assert.equal(publish(run, first, noteA, 'Test World', 3).status, 'success');
    assert.equal(publish(run, first, noteA, 'Test World', 4, unresolved).status, 'success');
    const repaired = list().find(binding => binding.uid === 4);
    run(lease => lore.repairBindingLocked(lease, { operationId: op('repair'), notebookId: first, bindingId: repaired.id, selector: established }));
    assert.deepEqual(list().map(binding => binding.selector.path), [established.path, established.path]);

    // 'Update lore' sends the binding's own section and entry; a repaired binding keeps its id and is still found.
    assert.equal(publish(run, first, noteA, 'Test World', 4).status, 'success');
    assert.equal(list().length, 2);

    const data = JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Test World.json'), 'utf8'));
    const renamed = await f.post('/api/worldinfo/rename', { oldName: 'Test World', newName: 'Renamed World', data });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.notebooks.links, 2);
    const moved = list();
    assert.deepEqual(moved.map(binding => [binding.uid, binding.book, binding.status]), [[3, 'Renamed World', 'in_sync'], [4, 'Renamed World', 'in_sync']]);
    assert.notEqual(moved[0].id, moved[1].id);
    assert.deepEqual(moved[1].history.map(item => item.action).filter(action => action !== 'publish'), ['repair', 'book-renamed']);

    const { entry } = run(lease => store.readNoteLocked(lease, { notebookId: first, noteId: noteA }));
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('edit'), notebookId: first, noteId: noteA, expectedRevision: entry.hash,
        changes: [{ type: 'replace_selection', find: 'to the healer.', replace: 'to the healer, twice.' }],
    }));
    assert.deepEqual(list().map(binding => binding.status), ['draft_changed', 'draft_changed']);
    assert.equal(publish(run, first, noteA, 'Renamed World', 3).status, 'success');
    assert.equal(publish(run, first, noteA, 'Renamed World', 4).status, 'success');
    const published = JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Renamed World.json'), 'utf8'));
    assert.equal(published.entries[3].content, 'Healing transfers the injury to the healer, twice.');
    assert.equal(published.entries[4].content, 'Healing transfers the injury to the healer, twice.');
    assert.deepEqual(list().map(binding => [binding.id, binding.status]), moved.map(binding => [binding.id, 'in_sync']));

    const deleted = await f.post('/api/worldinfo/delete', { name: 'Renamed World' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.notebooks.links, 2);
    assert.deepEqual(list(), []);
    const detached = run(lease => lore.readBindingsLocked(lease, first)).detached;
    assert.deepEqual(detached.map(binding => [binding.uid, binding.detachedReason]).sort(), [[3, 'book-deleted'], [4, 'book-deleted']]);
});

test('damaged Notebook parts are reported and left byte for byte while the rest is updated', async t => {
    const f = await prepared(t);
    linkEverything(f);
    const { run, first, second, noteA, other } = f;
    run(lease => store.setAssociationsLocked(lease, {
        operationId: op('associations'), notebookId: second, noteId: other, associations: [
            { kind: 'lorebook', id: 'Test World 2', label: 'Test World 2' }, { kind: 'lorebook', id: 'Test World', label: 'Test World' },
        ],
    }));
    const third = run(lease => store.createNotebookLocked(lease, { operationId: op('notebook'), name: 'Third' })).notebook.id;
    const fourth = run(lease => store.createNotebookLocked(lease, { operationId: op('notebook'), name: 'Fourth' })).notebook.id;

    // A null beside a real association, policies and lore links that are JSON null, and a manifest that is JSON null.
    const manifest = JSON.parse(read(f, first, 'manifest.json'));
    manifest.associations[noteA] = [null, ...manifest.associations[noteA]];
    fs.writeFileSync(f.control(first, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(f.control(second, 'policies.json'), 'null');
    fs.writeFileSync(f.control(third, 'lore-bindings.json'), 'null');
    fs.writeFileSync(f.control(fourth, 'manifest.json'), 'null');
    const damaged = [[first, 'manifest.json'], [second, 'policies.json'], [third, 'lore-bindings.json'], [fourth, 'manifest.json']];
    const saved = damaged.map(([notebookId, file]) => read(f, notebookId, file));
    const expectedSkipped = byNotebook([
        { notebookId: first, name: 'Notebook', part: 'associations', code: 'NOTEBOOK_CONTROL_DAMAGED' },
        { notebookId: second, name: 'Second', part: 'policies', code: 'NOTEBOOK_CONTROL_DAMAGED' },
        { notebookId: third, name: 'Third', part: 'bindings', code: 'NOTEBOOK_CONTROL_DAMAGED' },
        { notebookId: fourth, name: null, part: 'notebook', code: 'NOTEBOOK_CONTROL_DAMAGED' },
    ]);

    const data = JSON.parse(fs.readFileSync(path.join(f.directories.worlds, 'Test World.json'), 'utf8'));
    const renamed = await f.post('/api/worldinfo/rename', { oldName: 'Test World', newName: 'Renamed World', data });
    assert.equal(renamed.status, 200);
    assert.deepEqual(byNotebook(renamed.json.notebooks.skipped), expectedSkipped);
    assert.equal(fs.existsSync(path.join(f.directories.worlds, 'Renamed World.json')), true);
    assert.deepEqual(damaged.map(([notebookId, file]) => read(f, notebookId, file)), saved);
    // Healthy parts of the same notebooks still moved: first's lore link and scopes, second's associations.
    const [binding] = run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA }));
    assert.deepEqual([binding.book, binding.status], ['Renamed World', 'in_sync']);
    assert.equal(run(lease => store.readPoliciesLocked(lease, first)).notes[noteA].context.scopes[0].id, 'Renamed World');
    assert.deepEqual(run(lease => store.readManifestLocked(lease, second)).associations[other].map(item => item.id), ['Test World 2', 'Renamed World']);
    assert.equal(renamed.json.notebooks.links, 5);

    const deleted = await f.post('/api/worldinfo/delete', { name: 'Renamed World' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(byNotebook(deleted.json.notebooks.skipped), expectedSkipped);
    assert.equal(fs.existsSync(path.join(f.directories.worlds, 'Renamed World.json')), false);
    assert.deepEqual(damaged.map(([notebookId, file]) => read(f, notebookId, file)), saved);
    assert.deepEqual(run(lease => lore.listBindingsLocked(lease, first, { noteId: noteA })), []);
    assert.deepEqual(run(lease => store.readManifestLocked(lease, second)).associations[other].map(item => item.id), ['Test World 2']);
});

test('book references match exactly, with or without .json', () => {
    assert.equal(links.renameBookReference('Notes', 'Notes', 'Lore'), 'Lore');
    assert.equal(links.renameBookReference('Notes.json', 'Notes', 'Lore'), 'Lore.json');
    assert.equal(links.renameBookReference('notes', 'Notes', 'Lore'), null);
    assert.equal(links.renameBookReference('Notes 2', 'Notes', 'Lore'), null);
    assert.equal(links.renameBookReference('Notes.json.json', 'Notes', 'Lore'), null);
    assert.equal(links.renameBookReference({ name: 'Notes' }, 'Notes', 'Lore'), null);
});

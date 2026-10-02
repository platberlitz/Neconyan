import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const store = await import('../src/notebooks/store.js');
const { searchEntries, backlinksTo, outgoingLinks } = await import('../src/notebooks/note-index.js');
const { extractLinks, splitFrontmatter, resolveSection, sectionBody } = await import('../src/notebooks/markdown.js');

let counter = 0;
const op = label => `test:${label}:${++counter}`;

function prepared(t) {
    const f = fixture(t, false, 'notes-owner');
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const notebook = run(lease => store.ensureDefaultNotebookLocked(lease));
    return { f, run, notebookId: notebook.id, root: f.scope.directories.root };
}

test('a note created without a chat persists with a stable identity', t => {
    const { run, notebookId, root } = prepared(t);
    const created = run(lease => store.createNoteLocked(lease, { operationId: op('create'), notebookId, title: 'First idea', text: '' }));
    assert.equal(created.status, 'success');
    assert.match(created.noteId, /^n_[a-f0-9]{16}$/);
    const file = path.join(root, 'notebooks', notebookId, created.path);
    assert.ok(fs.existsSync(file));
    const { entry } = run(lease => {
        store.invalidateNotebookCache(lease);
        return store.readNoteLocked(lease, { notebookId, noteId: created.noteId });
    });
    assert.equal(entry.id, created.noteId);
    assert.equal(entry.text, '');
});

test('unicode titles and bodies survive and colliding names never overwrite', t => {
    const { run, notebookId } = prepared(t);
    const first = run(lease => store.createNoteLocked(lease, { operationId: op('a'), notebookId, title: 'Café 猫', text: '  leading\n\nemoji 🐱\n' }));
    const second = run(lease => store.createNoteLocked(lease, { operationId: op('b'), notebookId, title: 'café 猫', text: 'other' }));
    assert.notEqual(first.path, second.path);
    const a = run(lease => store.readNoteLocked(lease, { notebookId, noteId: first.noteId }).entry);
    assert.equal(a.text, '  leading\n\nemoji 🐱\n');
    const b = run(lease => store.readNoteLocked(lease, { notebookId, noteId: second.noteId }).entry);
    assert.equal(b.text, 'other');
});

test('operation replays return the original result and reused ids with new arguments fail', t => {
    const { run, notebookId } = prepared(t);
    const id = op('replay');
    const first = run(lease => store.createNoteLocked(lease, { operationId: id, notebookId, title: 'Once', text: 'x' }));
    const again = run(lease => store.createNoteLocked(lease, { operationId: id, notebookId, title: 'Once', text: 'x' }));
    assert.equal(again.noteId, first.noteId);
    assert.equal(again.replayed, true);
    const listed = run(lease => store.loadNotebookLocked(lease, notebookId).entries.filter(entry => entry.title === 'Once'));
    assert.equal(listed.length, 1);
    assert.throws(() => run(lease => store.createNoteLocked(lease, { operationId: id, notebookId, title: 'Twice', text: 'x' })), error => error.code === 'OPERATION_REUSED');
    const append = op('append');
    const appendArgs = { operationId: append, notebookId, noteId: first.noteId, expectedRevision: first.revision, changes: [{ type: 'append', markdown: 'More' }] };
    run(lease => store.updateNoteLocked(lease, appendArgs));
    run(lease => store.updateNoteLocked(lease, appendArgs));
    const text = run(lease => store.readNoteLocked(lease, { notebookId, noteId: first.noteId }).entry.text);
    assert.equal(text.match(/More/g).length, 1);
});

test('stale revisions conflict instead of overwriting', t => {
    const { run, notebookId } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('c'), notebookId, title: 'Shared', text: 'base' }));
    run(lease => store.updateNoteLocked(lease, { operationId: op('u1'), notebookId, noteId: note.noteId, expectedRevision: note.revision, changes: [{ type: 'replace_all', markdown: 'client one' }] }));
    assert.throws(() => run(lease => store.updateNoteLocked(lease, { operationId: op('u2'), notebookId, noteId: note.noteId, expectedRevision: note.revision, changes: [{ type: 'replace_all', markdown: 'client two' }] })),
        error => error.code === 'NOTE_CONFLICT' && error.status === 409);
    assert.equal(run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }).entry.text), 'client one');
});

test('section edits preserve unknown frontmatter, code fences and unrelated sections', t => {
    const { run, notebookId } = prepared(t);
    const source = '---\ntitle: Magic system\nweird:\n  nested: [1, {a: b}]\n# comment kept\n---\n# Magic system\n\n## Established rules\nHealing transfers the injury to the healer.\n\n```js\nconst link = "[[Not a link]]";\n```\n\n## Unresolved ideas\nCould two healers share it?\n\n## Discarded idea\nHealing consumes memories.\n';
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('m'), notebookId, title: 'Magic system', text: source }));
    const heading = resolveSection(source, { kind: 'heading', path: ['Magic system', 'Unresolved ideas'] });
    assert.equal(heading.status, 'ok');
    const body = sectionBody(source, heading.heading);
    const result = run(lease => store.updateNoteLocked(lease, { operationId: op('s'), notebookId, noteId: note.noteId, expectedRevision: note.revision,
        changes: [{ type: 'replace_section', selector: { kind: 'heading', path: ['Magic system', 'Unresolved ideas'] }, expectedTextHash: store.sectionHash(body), markdown: 'Could three healers share it?' }] }));
    const text = run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }).entry.text);
    assert.ok(text.startsWith('---\ntitle: Magic system\nweird:\n  nested: [1, {a: b}]\n# comment kept\n---\n'));
    assert.ok(text.includes('const link = "[[Not a link]]";'));
    assert.ok(text.includes('Healing transfers the injury to the healer.'));
    assert.ok(text.includes('Could three healers share it?'));
    assert.ok(!text.includes('Could two healers'));
    assert.ok(text.includes('Healing consumes memories.'));
    assert.deepEqual(result.changedRegions.length > 0, true);
    assert.throws(() => run(lease => store.updateNoteLocked(lease, { operationId: op('s2'), notebookId, noteId: note.noteId, expectedRevision: result.revision,
        changes: [{ type: 'replace_section', selector: { kind: 'heading', path: ['Magic system', 'Unresolved ideas'] }, expectedTextHash: store.sectionHash(body), markdown: 'stale' }] })), error => error.status === 409);
    const links = extractLinks(text);
    assert.equal(links.some(link => link.target === 'Not a link'), false);
    assert.equal(splitFrontmatter(text).data.weird.nested[1].a, 'b');
});

test('selection edits reject stale and ambiguous matches', t => {
    const { run, notebookId } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('sel'), notebookId, title: 'Sel', text: 'cat dog cat' }));
    assert.throws(() => run(lease => store.updateNoteLocked(lease, { operationId: op('sel1'), notebookId, noteId: note.noteId, expectedRevision: note.revision, changes: [{ type: 'replace_selection', find: 'cat', replace: 'owl' }] })), error => error.code === 'NOTE_SELECTION_AMBIGUOUS');
    assert.throws(() => run(lease => store.updateNoteLocked(lease, { operationId: op('sel2'), notebookId, noteId: note.noteId, expectedRevision: note.revision, changes: [{ type: 'replace_selection', find: 'bird', replace: 'owl' }] })), error => error.code === 'NOTE_SELECTION_STALE');
    const ok = run(lease => store.updateNoteLocked(lease, { operationId: op('sel3'), notebookId, noteId: note.noteId, expectedRevision: note.revision, changes: [{ type: 'replace_selection', find: 'dog', replace: 'owl' }] }));
    assert.equal(ok.status, 'success');
    assert.equal(run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }).entry.text), 'cat owl cat');
});

test('rename updates real links but not code examples, and backlinks follow', t => {
    const { run, notebookId } = prepared(t);
    const target = run(lease => store.createNoteLocked(lease, { operationId: op('t'), notebookId, folder: 'Worldbuilding', title: 'Magic system', text: '# Magic system\n' }));
    const linker = run(lease => store.createNoteLocked(lease, { operationId: op('l'), notebookId, title: 'Linker', text: 'See [[Magic system|Healing rules]] and [[Magic system#Established rules]].\n\n`[[Magic system]]` literal\n\n```\n[[Magic system]]\n```\n' }));
    let state = run(lease => store.loadNotebookLocked(lease, notebookId));
    const back = backlinksTo(state.entries, state.byId.get(target.noteId));
    assert.equal(back.length, 1);
    assert.equal(back[0].id, linker.noteId);
    const moved = run(lease => store.moveNoteLocked(lease, { operationId: op('mv'), notebookId, noteId: target.noteId, title: 'Magic rules', expectedRevision: target.revision }));
    assert.equal(moved.status, 'success');
    const text = run(lease => store.readNoteLocked(lease, { notebookId, noteId: linker.noteId }).entry.text);
    assert.ok(text.includes('[[Magic rules|Healing rules]]'));
    assert.ok(text.includes('[[Magic rules#Established rules]]'));
    assert.ok(text.includes('`[[Magic system]]` literal'));
    assert.ok(text.includes('```\n[[Magic system]]\n```'));
    state = run(lease => store.loadNotebookLocked(lease, notebookId));
    assert.equal(state.byId.get(target.noteId).path, 'Worldbuilding/Magic rules.md');
    const out = outgoingLinks(state.entries, state.byId.get(linker.noteId));
    assert.ok(out.every(link => link.status === 'resolved'));
});

test('duplicate titles produce ambiguity, not an arbitrary target', t => {
    const { run, notebookId } = prepared(t);
    run(lease => store.createNoteLocked(lease, { operationId: op('d1'), notebookId, folder: 'A', title: 'Twin', text: '' }));
    run(lease => store.createNoteLocked(lease, { operationId: op('d2'), notebookId, folder: 'B', title: 'Twin', text: '' }));
    const linker = run(lease => store.createNoteLocked(lease, { operationId: op('d3'), notebookId, title: 'Ref', text: '[[Twin]] [[A/Twin]] [[Ghost]]' }));
    const state = run(lease => store.loadNotebookLocked(lease, notebookId));
    const out = outgoingLinks(state.entries, state.byId.get(linker.noteId));
    assert.equal(out[0].status, 'ambiguous');
    assert.equal(out[0].candidates.length, 2);
    assert.equal(out[1].status, 'resolved');
    assert.equal(out[2].status, 'missing');
});

test('search finds titles and body text with snippets', t => {
    const { run, notebookId } = prepared(t);
    run(lease => store.createNoteLocked(lease, { operationId: op('s1'), notebookId, title: 'Harbour', text: 'The lighthouse keeper sings.' }));
    run(lease => store.createNoteLocked(lease, { operationId: op('s2'), notebookId, title: 'Lighthouse', text: '---\ntags: [coast]\n---\nTall.' }));
    const state = run(lease => store.loadNotebookLocked(lease, notebookId));
    const result = searchEntries(state.entries, { query: 'lighthouse' });
    assert.equal(result.total, 2);
    assert.equal(result.results[0].title, 'Lighthouse');
    assert.ok(result.results.some(row => row.snippet && row.snippet.includes('lighthouse')));
    assert.equal(searchEntries(state.entries, { tag: 'coast' }).total, 1);
});

test('trash, restore and permanent delete are distinct', t => {
    const { run, notebookId } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('tr'), notebookId, title: 'Bin me', text: 'keep this' }));
    const trashed = run(lease => store.trashNoteLocked(lease, { operationId: op('tr1'), notebookId, noteId: note.noteId }));
    assert.throws(() => run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId })), error => error.status === 404);
    const restored = run(lease => store.restoreTrashLocked(lease, { operationId: op('tr2'), notebookId, trashId: trashed.trashId }));
    assert.equal(restored.sameIdentity, true);
    assert.equal(run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }).entry.text), 'keep this');
    const again = run(lease => store.trashNoteLocked(lease, { operationId: op('tr3'), notebookId, noteId: note.noteId }));
    run(lease => store.deleteTrashLocked(lease, { operationId: op('tr4'), notebookId, trashId: again.trashId }));
    assert.equal(run(lease => store.listTrashLocked(lease, notebookId)).length, 0);
});

test('restoring an old revision is a new change and stale restores offer a copy', t => {
    const { run, notebookId } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('h'), notebookId, title: 'Hist', text: 'one' }));
    const two = run(lease => store.updateNoteLocked(lease, { operationId: op('h2'), notebookId, noteId: note.noteId, expectedRevision: note.revision, reason: 'checkpoint', changes: [{ type: 'replace_all', markdown: 'two' }] }));
    const history = run(lease => store.listHistoryLocked(lease, { notebookId, noteId: note.noteId }));
    const original = history.find(entry => entry.revision === note.revision);
    assert.ok(original);
    assert.throws(() => run(lease => store.restoreRevisionLocked(lease, { operationId: op('h3'), notebookId, noteId: note.noteId, historyId: original.id, expectedRevision: note.revision })), error => error.status === 409);
    const copy = run(lease => store.restoreRevisionLocked(lease, { operationId: op('h4'), notebookId, noteId: note.noteId, historyId: original.id, asCopy: true }));
    assert.notEqual(copy.noteId, note.noteId);
    const restored = run(lease => store.restoreRevisionLocked(lease, { operationId: op('h5'), notebookId, noteId: note.noteId, historyId: original.id, expectedRevision: two.revision }));
    assert.equal(restored.status, 'success');
    assert.equal(run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }).entry.text), 'one');
    const after = run(lease => store.listHistoryLocked(lease, { notebookId, noteId: note.noteId }));
    assert.ok(after.some(entry => entry.revision === two.revision));
});

test('external edits, deletes and duplicate ids are reconciled without overwriting', t => {
    const { run, notebookId, root } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('x'), notebookId, title: 'Ext', text: 'mine' }));
    const content = path.join(root, 'notebooks', notebookId);
    fs.writeFileSync(path.join(content, note.path), 'theirs');
    fs.writeFileSync(path.join(content, 'Copied.md'), `---\nneconyan_id: ${note.noteId}\n---\ncopy`);
    const state = run(lease => store.loadNotebookLocked(lease, notebookId, { force: true }));
    assert.equal(state.byId.get(note.noteId).text, 'theirs');
    const copied = state.entries.find(entry => entry.path === 'Copied.md');
    assert.ok(copied);
    assert.notEqual(copied.id, note.noteId);
    const history = run(lease => store.listHistoryLocked(lease, { notebookId, noteId: note.noteId }));
    assert.ok(history.some(entry => entry.origin === 'external'));
    fs.rmSync(path.join(content, note.path));
    const after = run(lease => store.loadNotebookLocked(lease, notebookId, { force: true }));
    assert.equal(after.byId.has(note.noteId), false);
    const trash = run(lease => store.listTrashLocked(lease, notebookId));
    assert.ok(trash.some(entry => entry.noteId === note.noteId && entry.origin === 'external'));
});

test('a lost cache index is rebuilt from files and the manifest', t => {
    const { run, notebookId } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('i'), notebookId, title: 'Indexed', text: 'body words' }));
    run(lease => store.setFavouriteLocked(lease, { operationId: op('i2'), notebookId, noteId: note.noteId, favourite: true }));
    const state = run(lease => {
        store.invalidateNotebookCache(lease);
        return store.loadNotebookLocked(lease, notebookId, { force: true });
    });
    assert.equal(state.byId.get(note.noteId).favourite, true);
    assert.equal(searchEntries(state.entries, { query: 'body words' }).total, 1);
});

test('paths reject traversal and unsafe names', async () => {
    const { normaliseRelativePath } = await import('../src/notebooks/paths.js');
    for (const bad of ['../x.md', 'a/../../x.md', 'C:/x.md', '\\\\server\\x', 'a\u0000b.md', '.obsidian/app.json', 'CON.md']) {
        assert.throws(() => normaliseRelativePath(bad), bad);
    }
    assert.equal(normaliseRelativePath('Worldbuilding/Magic system.md'), 'Worldbuilding/Magic system.md');
});

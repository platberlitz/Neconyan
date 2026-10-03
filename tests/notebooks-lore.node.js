import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const store = await import('../src/notebooks/store.js');
const lore = await import('../src/notebooks/lore.js');

let counter = 0;
const op = label => `lore:${label}:${++counter}`;

const MAGIC = `# Magic system

## Established rules
Healing transfers the injury to the healer.

## Unresolved ideas
Could two healers distribute the injury between them?

## Discarded idea
Healing consumes memories instead.
`;

function prepared(t) {
    const f = fixture(t, false, 'lore-owner');
    const root = f.scope.directories.root;
    const worlds = path.join(root, 'worlds');
    fs.mkdirSync(worlds, { recursive: true });
    const book = {
        entries: {
            3: {
                uid: 3, comment: 'Magic', content: 'Old magic text.', key: ['magic', 'healing'], keysecondary: ['spell'],
                disable: false, order: 42, position: 4, depth: 2, probability: 70, group: 'arcana', extensions: { custom: { keep: true } },
            },
        },
    };
    fs.writeFileSync(path.join(worlds, 'Test World.json'), JSON.stringify(book, null, 4));
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const notebook = run(lease => store.ensureDefaultNotebookLocked(lease));
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('note'), notebookId: notebook.id, title: 'Magic system', text: MAGIC }));
    const readBook = () => JSON.parse(fs.readFileSync(path.join(worlds, 'Test World.json'), 'utf8'));
    return { f, run, notebookId: notebook.id, noteId: note.noteId, readBook, worlds, root };
}

const established = { kind: 'heading', path: ['Magic system', 'Established rules'] };

function publish(run, notebookId, noteId, extra = {}) {
    const preview = run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector: established, book: 'Test World', uid: 3, ...extra }));
    const result = run(lease => lore.publishToLoreLocked(lease, {
        operationId: op('publish'), notebookId, noteId, selector: established, book: 'Test World', uid: 3,
        expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash, ...extra,
    }));
    return { preview, result };
}

test('publishing one section excludes the others and keeps every other entry setting', t => {
    const { run, notebookId, noteId, readBook } = prepared(t);
    const before = readBook().entries[3];
    const { preview, result } = publish(run, notebookId, noteId);
    assert.equal(preview.after, 'Healing transfers the injury to the healer.');
    assert.equal(result.status, 'success');
    const after = readBook().entries[3];
    assert.equal(after.content, 'Healing transfers the injury to the healer.');
    assert.doesNotMatch(after.content, /two healers|memories/);
    for (const key of Object.keys(before)) {
        if (key !== 'content') assert.deepEqual(after[key], before[key], `${key} preserved`);
    }
    const [binding] = run(lease => lore.listBindingsLocked(lease, notebookId, { noteId }));
    assert.equal(binding.status, 'in_sync');
    assert.equal(binding.enabled, true);
});

test('draft edits stay unpublished, independent lore edits are detected, and both is a conflict', t => {
    const { run, notebookId, noteId, readBook, worlds } = prepared(t);
    publish(run, notebookId, noteId);
    const { entry } = run(lease => store.readNoteLocked(lease, { notebookId, noteId }));
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('edit'), notebookId, noteId, expectedRevision: entry.hash,
        changes: [{ type: 'replace_selection', find: 'to the healer.', replace: 'to the healer, doubled.' }],
    }));
    assert.equal(readBook().entries[3].content, 'Healing transfers the injury to the healer.');
    let [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'draft_changed');

    const book = readBook();
    book.entries[3].content = 'Edited in the lorebook.';
    fs.writeFileSync(path.join(worlds, 'Test World.json'), JSON.stringify(book, null, 4));
    [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'conflict');

    const stale = run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector: established, book: 'Test World', uid: 3 }));
    assert.throws(() => run(lease => lore.publishToLoreLocked(lease, {
        operationId: op('stale'), notebookId, noteId, selector: established, book: 'Test World', uid: 3,
        expectedSourceHash: stale.sourceHash, expectedTargetHash: 'wrong',
    })), error => error.code === 'LORE_TARGET_CHANGED');

    const pulled = run(lease => lore.pullLoreIntoNoteLocked(lease, {
        operationId: op('pull'), notebookId, bindingId: binding.id, expectedRevision: binding.noteRevision, expectedLoreHash: binding.loreHash,
    }));
    assert.equal(pulled.status, 'success');
    const { entry: reread } = run(lease => store.readNoteLocked(lease, { notebookId, noteId }));
    assert.match(reread.text, /## Established rules\nEdited in the lorebook\.\n/);
    assert.match(reread.text, /Could two healers/);
    assert.match(reread.text, /Healing consumes memories/);
    [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'in_sync');
});

test('repeat publication reuses the same entry and a replayed operation is not applied twice', t => {
    const { run, notebookId, noteId, readBook } = prepared(t);
    const preview = run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector: established, book: 'Test World', title: 'Healing' }));
    assert.equal(preview.createsEntry, true);
    const args = {
        operationId: op('new'), notebookId, noteId, selector: established, book: 'Test World', title: 'Healing',
        expectedSourceHash: preview.sourceHash, expectedTargetHash: null,
    };
    const first = run(lease => lore.publishToLoreLocked(lease, args));
    const replay = run(lease => lore.publishToLoreLocked(lease, args));
    assert.equal(replay.replayed, true);
    assert.equal(replay.uid, first.uid);
    assert.equal(Object.keys(readBook().entries).length, 2);
    const again = run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector: established, book: 'Test World' }));
    assert.equal(again.uid, first.uid);
    assert.equal(again.createsEntry, false);
    assert.throws(() => run(lease => lore.previewPublicationLocked(lease, {
        notebookId, noteId, selector: { kind: 'heading', path: ['Magic system', 'Unresolved ideas'] }, book: 'Test World', uid: first.uid,
    })), error => error.code === 'LORE_TARGET_BOUND');
});

test('a renamed or duplicated heading pauses publication instead of guessing', t => {
    const { run, notebookId, noteId } = prepared(t);
    publish(run, notebookId, noteId);
    const { entry } = run(lease => store.readNoteLocked(lease, { notebookId, noteId }));
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('rename-heading'), notebookId, noteId, expectedRevision: entry.hash,
        changes: [{ type: 'replace_selection', find: '## Established rules', replace: '## Settled rules' }],
    }));
    const [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'selector_unresolved');
    assert.throws(() => run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector: established, book: 'Test World', uid: 3 })),
        error => error.code === 'LORE_SELECTOR_MISSING');
    const repaired = run(lease => lore.repairBindingLocked(lease, {
        operationId: op('repair'), notebookId, bindingId: binding.id, selector: { kind: 'heading', path: ['Magic system', 'Settled rules'] },
    }));
    assert.equal(repaired.status, 'success');
});

test('demoting a sibling heading into the section is reported as broadened', t => {
    const { run, notebookId, noteId } = prepared(t);
    publish(run, notebookId, noteId);
    const { entry } = run(lease => store.readNoteLocked(lease, { notebookId, noteId }));
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('demote'), notebookId, noteId, expectedRevision: entry.hash,
        changes: [{ type: 'replace_selection', find: '## Unresolved ideas', replace: '### Unresolved ideas' }],
    }));
    const [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'selector_unresolved');
    assert.equal(binding.reason, 'broadened');
});

test('deleting the source keeps the lore; deleting the target is never recreated', t => {
    const { run, notebookId, noteId, readBook, worlds } = prepared(t);
    publish(run, notebookId, noteId);
    run(lease => store.trashNoteLocked(lease, { operationId: op('trash'), notebookId, noteId }));
    let [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'source_missing');
    assert.equal(readBook().entries[3].content, 'Healing transfers the injury to the healer.');
    const book = readBook();
    delete book.entries[3];
    fs.writeFileSync(path.join(worlds, 'Test World.json'), JSON.stringify(book, null, 4));
    [binding] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.equal(binding.status, 'target_missing');
    assert.equal(readBook().entries[3], undefined);
});

test('live updates only apply for allowed origins and pause on conflict', t => {
    const { run, notebookId, noteId, readBook } = prepared(t);
    const { result } = publish(run, notebookId, noteId);
    run(lease => lore.setBindingPolicyLocked(lease, { operationId: op('live'), notebookId, bindingId: result.bindingId, policy: 'live', liveOrigins: ['user'] }));
    const edit = (find, replace, origin) => run(lease => {
        const { entry } = store.readNoteLocked(lease, { notebookId, noteId });
        const operationId = op('live-edit');
        const saved = store.updateNoteLocked(lease, { operationId, notebookId, noteId, expectedRevision: entry.hash, changes: [{ type: 'replace_selection', find, replace }], origin });
        return { saved, outcomes: lore.applyLiveUpdatesLocked(lease, { notebookId, noteId, origin, operationId, actor: { kind: origin } }) };
    });
    const assistant = edit('to the healer.', 'to the healer!', 'assistant');
    assert.equal(assistant.outcomes[0].status, 'needs_review');
    assert.equal(readBook().entries[3].content, 'Healing transfers the injury to the healer.');
    const user = edit('to the healer!', 'to the healer, slowly.', 'user');
    assert.equal(user.outcomes[0].updated, true);
    assert.equal(readBook().entries[3].content, 'Healing transfers the injury to the healer, slowly.');
});

test('an interrupted publish is recovered from the pending record and never reported in sync falsely', t => {
    const { run, notebookId, noteId, root } = prepared(t);
    publish(run, notebookId, noteId);
    const file = path.join(root, 'notebook-control', notebookId, 'lore-bindings.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const binding = Object.values(value.bindings)[0];
    binding.pending = { ...binding.published, uid: 3, targetHash: 'not-written', operationId: 'lost:op:1', children: [] };
    fs.writeFileSync(file, JSON.stringify(value));
    const [described] = run(lease => lore.listBindingsLocked(lease, notebookId));
    assert.notEqual(described.status, 'in_sync');
    assert.equal(described.status, 'failed');
    assert.equal(described.lastError.code, 'LORE_PUBLISH_INTERRUPTED');
});

test('editing an entry as a page writes the same World Info record', t => {
    const { run, readBook } = prepared(t);
    const page = run(lease => lore.readLoreEntryPageLocked(lease, { book: 'Test World', uid: 3 }));
    assert.equal(page.content, 'Old magic text.');
    const saved = run(lease => lore.saveLoreEntryPageLocked(lease, { operationId: op('page'), book: 'Test World', uid: 3, expectedEntryHash: page.entryHash, content: 'Page edit.' }));
    assert.equal(saved.status, 'success');
    const entry = readBook().entries[3];
    assert.equal(entry.content, 'Page edit.');
    assert.deepEqual(entry.key, ['magic', 'healing']);
    assert.throws(() => run(lease => lore.saveLoreEntryPageLocked(lease, { operationId: op('page2'), book: 'Test World', uid: 3, expectedEntryHash: page.entryHash, content: 'x' })),
        error => error.code === 'LORE_TARGET_CHANGED');
});

test('the state machine is pure over evidence', () => {
    const h = lore.contentHash;
    const published = { sourceHash: h('a'), targetHash: h('a') };
    assert.equal(lore.deriveLoreStatus({ published: null, source: {}, target: {} }), 'unpublished');
    assert.equal(lore.deriveLoreStatus({ published, source: { status: 'ok', text: 'a' }, target: { status: 'ok', text: 'a' } }), 'in_sync');
    assert.equal(lore.deriveLoreStatus({ published, source: { status: 'ok', text: 'b' }, target: { status: 'ok', text: 'a' } }), 'draft_changed');
    assert.equal(lore.deriveLoreStatus({ published, source: { status: 'ok', text: 'a' }, target: { status: 'ok', text: 'c' } }), 'lore_changed');
    assert.equal(lore.deriveLoreStatus({ published, source: { status: 'ok', text: 'b' }, target: { status: 'ok', text: 'c' } }), 'conflict');
    assert.equal(lore.deriveLoreStatus({ published, source: { status: 'source_missing' }, target: { status: 'ok', text: 'a' } }), 'source_missing');
    assert.equal(lore.deriveLoreStatus({ published, source: { status: 'ok', text: 'a' }, target: { status: 'target_missing' } }), 'target_missing');
});

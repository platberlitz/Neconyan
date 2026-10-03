import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const store = await import('../src/notebooks/store.js');
const lore = await import('../src/notebooks/lore.js');
const context = await import('../src/notebooks/context.js');
const { applyPolicyPatch } = await import('../src/notebooks/permissions.js');

let counter = 0;
const op = label => `ctx:${label}:${++counter}`;

const MAGIC = `# Magic system

## Established rules
Healing transfers the injury to the healer.

## Unresolved ideas
Could two healers distribute the injury between them? Harbour healers argue about it.

## Discarded idea
Healing consumes memories instead.
`;

function prepared(t, owner = 'ctx-owner') {
    const f = fixture(t, false, owner);
    const root = f.scope.directories.root;
    const worlds = path.join(root, 'worlds');
    fs.mkdirSync(worlds, { recursive: true });
    fs.writeFileSync(path.join(worlds, 'Test World.json'), JSON.stringify({
        entries: { 3: { uid: 3, comment: 'Magic', content: 'Old.', key: ['magic'], disable: false } },
    }, null, 4));
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const notebook = run(lease => store.ensureDefaultNotebookLocked(lease));
    const create = (title, text) => run(lease => store.createNoteLocked(lease, { operationId: op('note'), notebookId: notebook.id, title, text })).noteId;
    const policy = patch => run(lease => {
        const current = store.readPoliciesLocked(lease, notebook.id);
        store.writePoliciesLocked(lease, notebook.id, applyPolicyPatch(current, patch, { noteExists: () => true }));
        context.invalidateContextCache(lease, notebook.id);
    });
    const collect = (scope, extra = {}) => run(lease => context.collectNoteContextLocked(lease, { scope, budgetTokens: 2000, ...extra }));
    return { f, run, notebookId: notebook.id, create, policy, collect, root };
}

const chatA = { chat: 'Nova.png:Source', character: 'Nova.png', lorebooks: ['Test World'] };
const chatB = { chat: 'Nova.png:Other', character: 'Nova.png', lorebooks: [] };

test('notes are not used in context by default', t => {
    const { create, collect } = prepared(t);
    create('Magic system', MAGIC);
    const result = collect(chatA, { query: 'healing healers harbour' });
    assert.equal(result.items.length, 0);
    assert.equal(result.content, '');
    assert.equal(result.usedTokens, 0);
});

test('pinned and reference context never expands embedded notes outside their own explicit scopes', t => {
    const { create, policy, collect } = prepared(t);
    const source = create('Reference source', '# Source\nHarbour healer ![[Private target#Secret]]');
    const target = create('Private target', '# Secret\nUnshared secret material.');
    for (const mode of ['pinned', 'reference']) {
        policy({ notes: { [source]: { context: { mode, scopes: [{ kind: 'chat', id: chatA.chat }] } } } });
        const result = collect(chatA, { query: 'harbour healer' });
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].noteId, source);
        assert.match(result.content, /!\[\[Private target#Secret\]\]/);
        assert.doesNotMatch(result.content, /Unshared secret material/);
        assert.ok(!JSON.stringify(result).includes(target));
        assert.equal(collect(chatB, { query: 'harbour healer' }).items.length, 0);
    }
});

test('reference notes are retrieved only inside their scope', t => {
    const { create, policy, collect } = prepared(t);
    const noteId = create('Magic system', MAGIC);
    policy({ notes: { [noteId]: { context: { mode: 'reference', scopes: [{ kind: 'chat', id: chatA.chat }] } } } });
    const inside = collect(chatA, { query: 'what do the harbour healers argue about' });
    assert.ok(inside.items.length > 0);
    assert.ok(inside.items.every(item => item.mode === 'reference' && item.revision && item.noteId === noteId));
    assert.match(inside.content, /Harbour healers/);
    assert.match(inside.content, /not established story events/i);
    const outside = collect(chatB, { query: 'what do the harbour healers argue about' });
    assert.equal(outside.items.length, 0);
    const noMatch = collect(chatA, { query: 'zeppelins' });
    assert.equal(noMatch.items.length, 0, 'reference eligibility is not automatic inclusion');
});

test('pinned notes are included whole and overflow is reported instead of truncating', t => {
    const { create, policy, collect } = prepared(t);
    const small = create('Small pin', 'Tiny pinned fact.');
    const big = create('Big pin', 'word '.repeat(4000));
    policy({ notes: {
        [small]: { context: { mode: 'pinned', scopes: [{ kind: 'character', id: 'Nova.png' }], order: 1 } },
        [big]: { context: { mode: 'pinned', scopes: [{ kind: 'character', id: 'Nova.png' }], order: 2 } },
    } });
    const result = collect(chatB);
    assert.deepEqual(result.items.map(item => item.noteId), [small]);
    assert.equal(result.items[0].text, 'Tiny pinned fact.');
    assert.equal(result.overflow.length, 1);
    assert.equal(result.overflow[0].noteId, big);
    assert.equal(result.overflow[0].reason, 'budget');
    assert.ok(result.usedTokens > 0 && result.usedTokens <= result.budgetTokens);
});

test('lore-bound sections are not duplicated through the notes route', t => {
    const { run, notebookId, create, policy, collect } = prepared(t);
    const noteId = create('Magic system', MAGIC);
    const selector = { kind: 'heading', path: ['Magic system', 'Established rules'] };
    const preview = run(lease => lore.previewPublicationLocked(lease, { notebookId, noteId, selector, book: 'Test World', uid: 3 }));
    run(lease => lore.publishToLoreLocked(lease, {
        operationId: op('publish'), notebookId, noteId, selector, book: 'Test World', uid: 3,
        expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash,
    }));
    policy({ notes: { [noteId]: { context: { mode: 'pinned', scopes: [{ kind: 'global' }] } } } });
    const result = collect(chatA);
    assert.equal(result.items.length, 1);
    assert.doesNotMatch(result.content, /transfers the injury/);
    assert.match(result.content, /distribute the injury/);
    assert.match(result.content, /consumes memories/);
    assert.deepEqual(result.excludedBound[0].regions, ['Established rules']);

    const note = run(lease => store.readNoteLocked(lease, { notebookId, noteId })).entry;
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('rename-heading'), notebookId, noteId, expectedRevision: note.hash,
        changes: [{ type: 'replace_all', markdown: MAGIC.replace('## Established rules', '## Settled rules') }],
    }));
    run(lease => context.invalidateContextCache(lease, notebookId));
    const unresolved = collect(chatA);
    assert.equal(unresolved.items.length, 0, 'an unresolved binding withholds the note rather than guessing');
    assert.equal(unresolved.withheld[0].reason, 'lore-bound');
});

test('imported notebooks stay out of context until admitted', t => {
    const { notebookId, create, policy, collect } = prepared(t);
    const noteId = create('Pinned', 'Pinned body.');
    policy({ notes: { [noteId]: { context: { mode: 'pinned', scopes: [{ kind: 'global' }] } } } });
    assert.equal(collect(chatA).items.length, 1);
    policy({ admitted: false });
    assert.equal(collect(chatA).items.length, 0);
    assert.ok(notebookId);
});

test('context use records revisions but no note text, and other accounts see nothing', t => {
    const { run, create, policy, collect } = prepared(t);
    const noteId = create('Pinned', 'Secret pinned body.');
    policy({ notes: { [noteId]: { context: { mode: 'pinned', scopes: [{ kind: 'global' }] } } } });
    const collected = collect(chatA);
    run(lease => context.recordContextUseLocked(lease, { chat: chatA.chat, jobId: 'job-1', collected }));
    const records = run(lease => context.readContextRecordsLocked(lease, { chat: chatA.chat }));
    assert.equal(records.length, 1);
    assert.equal(records[0].items[0].revision, collected.items[0].revision);
    assert.doesNotMatch(JSON.stringify(records), /Secret pinned body/);

    const other = prepared(t, 'ctx-other');
    assert.equal(other.collect(chatA).items.length, 0);
});

test('roleplay helpers derive scope ids and budgets', () => {
    assert.equal(context.roleplayChatScope({ group: false, avatar: 'Nova.png', chat: 'Source' }), 'Nova.png:Source');
    assert.equal(context.roleplayChatScope({ group: true, chat: 'Party' }), 'group:Party');
    assert.equal(context.roleplayContextBudget(8000, 1000), 1050);
    assert.equal(context.roleplayContextBudget(100000, 1000), 2000);
    assert.equal(context.roleplayContextBudget(500, 1000), 0);
    assert.equal(context.estimateTokens('abcdefgh'), 2);
});

test('cold large notebooks are prepared only for an admitted matching context scope', async t => {
    const { f, create, policy, notebookId, root, collect, run } = prepared(t);
    const noteId = create('Pinned', 'This pinned text must survive background preparation.');
    const contentRoot = path.join(root, 'notebooks', notebookId);
    for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(contentRoot, `External ${index}.md`), `# External ${index}\n`);
    policy({ notes: { [noteId]: { context: { mode: 'pinned', scopes: [{ kind: 'chat', id: chatA.chat }] } } } });
    await context.prepareNoteContextNotebooks(f.scope, chatB);
    assert.equal(run(lease => store.readManifestLocked(lease, notebookId)).notes[noteId].path, 'Inbox/Pinned.md');
    assert.equal(Object.keys(run(lease => store.readManifestLocked(lease, notebookId)).notes).length, 1, 'non-matching scopes do not adopt unshared content');
    await context.prepareNoteContextNotebooks(f.scope, chatA);
    assert.equal(Object.keys(run(lease => store.readManifestLocked(lease, notebookId)).notes).length, 41);
    assert.match(collect(chatA).content, /must survive background preparation/);
    assert.equal(collect(chatB).items.length, 0);
    policy({ admitted: false });
    fs.writeFileSync(path.join(contentRoot, 'Unadmitted.md'), '# Do not share\n');
    await context.prepareNoteContextNotebooks(f.scope, chatA);
    assert.equal(Object.keys(run(lease => store.readManifestLocked(lease, notebookId)).notes).length, 41);
    assert.equal(collect(chatA).items.length, 0);
});

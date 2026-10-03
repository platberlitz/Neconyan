import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { zipSync } from 'fflate';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import * as store from '../src/notebooks/store.js';
import * as transfer from '../src/notebooks/transfer.js';

const hint = 'n_1122334455667788';
const archive = count => zipSync(Object.fromEntries(Array.from({ length: count }, (_, index) => [`Note ${index}.md`, Buffer.from(`${index === 0 ? `---\nneconyan_id: ${hint}\n---\n` : ''}# Note ${index}\r\n\r\nExact bytes ${index}.\r\n`)])));
let counter = 0;
const operationId = () => `recovery:${++counter}:import`;

function prepared(t, owner = 'recovery') {
    const f = fixture(t, false, owner);
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    run(lease => store.ensureDefaultNotebookLocked(lease));
    return { ...f, base: f.scope, run };
}

for (const phase of ['planned', 'content', 'history', 'manifest', 'progress']) {
    test(`an actual process crash after ${phase} resumes with the same identities and one history entry`, async t => {
        const f = prepared(t);
        const stage = await transfer.stageImport(f.base, { filename: 'Recovery.zip', bytes: archive(25) });
        const input = { operationId: operationId(), stageId: stage.stageId, name: 'Recovered' };
        const stopped = spawnSync(process.execPath, [new URL('./notebooks-import-crash-fixture.js', import.meta.url).pathname, JSON.stringify({ directories: f.base.directories, input, phase })], { timeout: 30_000, encoding: 'utf8' });
        assert.equal(stopped.signal, 'SIGKILL', stopped.stderr || stopped.error?.message);
        const recoverable = f.run(lease => transfer.readStage(lease, stage.stageId));
        assert.equal(recoverable.recovery.operationId, input.operationId);
        const notebookId = recoverable.recovery.notebookId;
        // Opening a partly imported notebook must not randomly adopt the hinted note.
        if (phase !== 'planned') {
            const partial = f.run(lease => store.loadNotebookLocked(lease, notebookId, { force: true }));
            assert.equal(partial.entries.find(note => note.path === 'Note 0.md')?.id, hint);
            assert.equal(f.run(lease => store.readPoliciesLocked(lease, notebookId)).admitted, false);
        }
        const result = await transfer.commitImport(f.base, input);
        assert.equal(result.imported.notes, 25);
        const state = f.run(lease => store.loadNotebookLocked(lease, notebookId, { force: true }));
        assert.equal(state.entries.length, 25);
        assert.equal(state.entries.find(note => note.path === 'Note 0.md').id, hint);
        for (const note of state.entries) {
            const history = f.run(lease => store.readHistoryLocked(lease, notebookId, note.id));
            assert.equal(history.entries.length, 1, note.path);
            assert.equal(history.entries[0].revision, note.hash);
            assert.equal(history.entries[0].operationId, input.operationId);
            assert.equal(history.entries[0].origin, 'import');
            assert.ok(note.text.endsWith('\r\n'), 'exact original line endings survive');
        }
        assert.equal((await transfer.commitImport(f.base, input)).replayed, true);
        await assert.rejects(transfer.commitImport(f.base, { ...input, name: 'Different' }), { code: 'OPERATION_REUSED' });
        assert.equal(f.run(lease => transfer.listStagesLocked(lease)).length, 0);
        assert.equal(f.run(lease => store.readPoliciesLocked(lease, notebookId)).assistant, 'none');
    });
}

test('a failed batch folder flush cannot advance its durable progress', async t => {
    const f = prepared(t);
    const stage = await transfer.stageImport(f.base, { filename: 'Flush.zip', bytes: archive(12) });
    const input = { operationId: operationId(), stageId: stage.stageId };
    const original = fs.fsyncSync;
    let fail = false;
    let failedFolder;
    const retriedFolders = new Set();
    fs.fsyncSync = fd => {
        if (fail && fs.fstatSync(fd).isDirectory()) {
            failedFolder = fs.readlinkSync(`/proc/self/fd/${fd}`);
            throw new Error('Injected folder flush failure');
        }
        return original(fd);
    };
    try {
        await assert.rejects(transfer.commitImport(f.base, input, { fault: phase => { if (phase === 'content') fail = true; } }), /Injected folder flush failure/);
    } finally { fs.fsyncSync = original; }
    const journal = JSON.parse(fs.readFileSync(path.join(f.base.directories.root, 'notebook-control', '_imports', stage.stageId, 'commit-progress.json'), 'utf8'));
    assert.equal(journal.cursor, 0);
    fs.fsyncSync = fd => {
        if (fs.fstatSync(fd).isDirectory()) retriedFolders.add(fs.readlinkSync(`/proc/self/fd/${fd}`));
        return original(fd);
    };
    let result;
    try { result = await transfer.commitImport(f.base, input); } finally { fs.fsyncSync = original; }
    assert.ok(retriedFolders.has(failedFolder), 'recovery flushes the folder that failed, even when its files already exist');
    assert.equal(result.imported.notes, 12);
    const state = f.run(lease => store.loadNotebookLocked(lease, result.notebook.id, { force: true }));
    assert.equal(state.entries.length, 12);
    for (const note of state.entries) assert.equal(f.run(lease => store.readHistoryLocked(lease, result.notebook.id, note.id)).entries.length, 1);
});

test('private disk previews are account scoped, expire when unused and reject changed chunks', async t => {
    const f = prepared(t, 'preview-one');
    const other = prepared(t, 'preview-two');
    const stage = await transfer.stageImport(f.base, { filename: 'Preview.zip', bytes: archive(2) });
    assert.equal(f.run(lease => transfer.listStagesLocked(lease))[0].stageId, stage.stageId);
    assert.throws(() => other.run(lease => transfer.readStage(lease, stage.stageId)), { code: 'IMPORT_STAGE_EXPIRED' });
    const root = path.join(f.base.directories.root, 'notebook-control', '_imports', stage.stageId);
    const chunk = path.join(root, 'chunk-0.bin');
    const bytes = fs.readFileSync(chunk);
    bytes[0] ^= 1;
    fs.writeFileSync(chunk, bytes);
    await assert.rejects(transfer.commitImport(f.base, { operationId: operationId(), stageId: stage.stageId }), { code: 'IMPORT_STAGE_DAMAGED' });
    const unused = await transfer.stageImport(f.base, { filename: 'Unused.md', bytes: Buffer.from('# Unused') });
    const file = path.join(f.base.directories.root, 'notebook-control', '_imports', unused.stageId, 'stage.json');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    metadata.createdAt = 0;
    fs.writeFileSync(file, JSON.stringify(metadata));
    assert.throws(() => f.run(lease => transfer.readStage(lease, unused.stageId)), { code: 'IMPORT_STAGE_EXPIRED' });
    assert.equal(f.run(lease => transfer.cancelStage(lease, unused.stageId)), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(path.dirname(file), 'chunk-0.bin')), false);
});

test('operation retention never drops pending recovery plans', t => {
    const f = prepared(t);
    const filename = path.join(f.base.directories.root, 'notebook-control', '_operations.json');
    const entries = Object.fromEntries(Array.from({ length: 2002 }, (_, index) => [`old:${index}:done`, { state: 'done', at: new Date().toISOString() }]));
    entries['pending:keep:plan'] = { state: 'pending', kind: 'test', argsHash: 'test', at: '2000-01-01', plan: { durable: true } };
    fs.writeFileSync(filename, JSON.stringify({ schema: 1, entries }));
    f.run(lease => store.runOperationLocked(lease, { operationId: 'new:operation:keep', kind: 'test', args: {} }, () => ({ status: 'success' })));
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).entries['pending:keep:plan'].plan, { durable: true });
});

for (const phase of ['planned', 'history', 'manifest', 'progress']) {
    test(`external adoption survives a process crash after ${phase}, including later batches`, async t => {
        const f = prepared(t, 'external-recovery');
        const notebookId = f.run(lease => store.listNotebooksLocked(lease)[0].id);
        const contentRoot = path.join(f.base.directories.root, 'notebooks', notebookId);
        for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(contentRoot, `Note ${index}.md`), `${index === 0 ? `---\nneconyan_id: ${hint}\n---\n` : ''}# External ${index}\r\n\r\nExact bytes.\r\n`);
        const after = phase === 'planned' ? 0 : phase === 'history' ? 8 : phase === 'manifest' ? 4 : 1;
        const stopped = spawnSync(process.execPath, [new URL('./notebooks-import-crash-fixture.js', import.meta.url).pathname,
            JSON.stringify({ directories: f.base.directories, input: { notebookId }, phase, kind: 'reconcile', after })], { timeout: 30_000, encoding: 'utf8' });
        assert.equal(stopped.signal, 'SIGKILL', stopped.stderr || stopped.error?.message);
        const state = await store.prepareNotebook(f.base, notebookId);
        assert.equal(state.entries.length, 40);
        assert.equal(state.entries.find(note => note.path === 'Note 0.md').id, hint);
        for (const note of state.entries) {
            const history = f.run(lease => store.readHistoryLocked(lease, notebookId, note.id));
            assert.equal(history.entries.length, 1, note.path);
            assert.equal(history.entries[0].origin, 'external');
            assert.equal(history.entries[0].revision, note.hash);
            assert.ok(note.text.endsWith('\r\n'));
        }
        const operations = JSON.parse(fs.readFileSync(path.join(f.base.directories.root, 'notebook-control', '_operations.json'), 'utf8')).entries;
        assert.equal(Object.values(operations).filter(entry => entry.kind === 'reconcile-notebook').length, 1);
        assert.ok(Object.values(operations).every(entry => entry.state === 'done'), 'even a crash after the final manifest finishes its pending journal');
    });
}

test('adoption yields between bounded batches so a real protected chat remains readable', async t => {
    const f = prepared(t, 'responsive');
    const notebookId = f.run(lease => store.listNotebooksLocked(lease)[0].id);
    const contentRoot = path.join(f.base.directories.root, 'notebooks', notebookId);
    const source = f.source();
    for (let index = 0; index < 80; index++) fs.writeFileSync(path.join(contentRoot, `Note ${index}.md`), `# Note ${index}\n`);
    let reads = 0;
    const batches = [];
    const timer = setInterval(() => { assert.deepEqual(f.source(), source); reads++; }, 5);
    try {
        const state = await store.prepareNotebook(f.base, notebookId, { onBatch: batch => batches.push(batch) });
        assert.equal(state.entries.length, 80);
    } finally { clearInterval(timer); }
    assert.ok(reads >= 5, 'chat work is served during adoption, not only after it finishes');
    assert.equal(batches.length, 10);
    assert.ok(batches.every(batch => batch.count <= store.RECONCILE_BATCH_SIZE));
});

test('a resumed compared import never overwrites a later owner edit or repeats an applied update', async t => {
    const f = prepared(t, 'update-recovery');
    const notebookId = f.run(lease => store.listNotebooksLocked(lease)[0].id);
    const note = f.run(lease => store.createNoteLocked(lease, { operationId: operationId(), notebookId, folder: '', title: 'Note 0', text: 'Original.' }));
    f.run(lease => store.writePoliciesLocked(lease, notebookId, { ...store.readPoliciesLocked(lease, notebookId), assistant: 'edit', assistantPublish: true }));
    const stage = await transfer.stageImport(f.base, { filename: 'Updates.zip', bytes: archive(40) });
    f.run(lease => transfer.compareStageLocked(lease, { stageId: stage.stageId, notebookId }));
    const input = { operationId: operationId(), stageId: stage.stageId, notebookId, paths: stage.notes.map(item => item.path) };
    const stopped = spawnSync(process.execPath, [new URL('./notebooks-import-crash-fixture.js', import.meta.url).pathname,
        JSON.stringify({ directories: f.base.directories, input, phase: 'manifest', kind: 'update', after: 1 })], { timeout: 30_000, encoding: 'utf8' });
    assert.equal(stopped.signal, 'SIGKILL', stopped.stderr || stopped.error?.message);
    await store.prepareNotebook(f.base, notebookId);
    const current = f.run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId })).entry;
    f.run(lease => store.updateNoteLocked(lease, { operationId: operationId(), notebookId, noteId: note.noteId, expectedRevision: current.hash,
        changes: [{ type: 'replace_all', markdown: 'Owner edit after the stopped import.' }] }));
    const result = await transfer.commitStageUpdate(f.base, input);
    assert.equal(result.status, 'success');
    assert.equal(f.run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId })).entry.text, 'Owner edit after the stopped import.');
    const history = f.run(lease => store.readHistoryLocked(lease, notebookId, note.noteId));
    assert.equal(history.entries.filter(entry => entry.origin === 'import').length, 1);
    const state = await store.prepareNotebook(f.base, notebookId);
    assert.equal(state.entries.length, 40);
    const policies = f.run(lease => store.readPoliciesLocked(lease, notebookId));
    assert.equal(policies.assistant, 'edit');
    for (const entry of state.entries) if (entry.id !== note.noteId) assert.equal(policies.notes[entry.id]?.assistant, 'none');
});

test('a later identical external snapshot is a fresh adoption, not a completed operation replay', async t => {
    const f = prepared(t, 'repeat-adoption');
    const notebookId = f.run(lease => store.listNotebooksLocked(lease)[0].id);
    const contentRoot = path.join(f.base.directories.root, 'notebooks', notebookId);
    const files = Array.from({ length: 40 }, (_, index) => [path.join(contentRoot, `Repeat ${index}.md`), `# Repeat ${index}\n`]);
    for (const [file, text] of files) fs.writeFileSync(file, text);
    const first = await store.prepareNotebook(f.base, notebookId);
    const originalIds = new Set(first.entries.map(entry => entry.id));
    for (const [file] of files) fs.unlinkSync(file);
    assert.equal(f.run(lease => store.loadNotebookLocked(lease, notebookId, { force: true })).entries.length, 0);
    for (const [file, text] of files) fs.writeFileSync(file, text);
    const batches = [];
    const second = await store.prepareNotebook(f.base, notebookId, { force: true, onBatch: batch => batches.push(batch) });
    assert.equal(second.entries.length, 40);
    assert.equal(batches.length, 5, 'a fresh cycle is still batched');
    assert.ok(second.entries.every(entry => !originalIds.has(entry.id)), 'trashed identities are not reused');
    const journal = f.run(lease => store.readJsonLocked(lease, path.join(f.base.directories.root, 'notebook-control', '_operations.json'), null));
    const reconciliations = Object.values(journal.entries).filter(entry => entry.kind === 'reconcile-notebook');
    assert.equal(reconciliations.length, 2);
    assert.ok(reconciliations.every(entry => entry.state === 'done'));
});

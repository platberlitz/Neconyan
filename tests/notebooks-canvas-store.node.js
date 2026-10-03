import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { unzipSync, zipSync } from 'fflate';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import { ensureDefaultNotebookLocked, invalidateNotebookCache, pendingOperationsLocked, readPoliciesLocked } from '../src/notebooks/store.js';
import { buildExportZip, collectExportLocked, commitImport, stageImport } from '../src/notebooks/transfer.js';
import { canvasHistoryLocked, canvasHistoryReadLocked, canvasRecoveryReadLocked, createCanvasLocked, decideCanvasRecoveryLocked,
    listCanvasesLocked, readCanvasLocked, updateCanvasLocked } from '../src/notebooks/canvas-store.js';
import { sha256 } from '../src/notebooks/paths.js';

const document = () => ({ nodes: [{ id: 'text', type: 'text', x: 0, y: 0, width: 320, height: 180, text: '# Saved plan', plugin: { untouched: ['one', 2] } }],
    edges: [], future: { version: 7, untouched: true } });
let counter = 0;
const op = label => `canvas-test:${label}:${++counter}`;

function prepared(t) {
    const f = fixture(t, false, 'canvas-owner');
    const run = callback => withRoleplayAccount(f.scope, f.scope, callback);
    const notebookId = run(lease => ensureDefaultNotebookLocked(lease).id);
    return { ...f, root: f.scope.directories.root, run, notebookId };
}

function crash(f, kind, input, phase) {
    const result = spawnSync(process.execPath, [new URL('./notebooks-canvas-crash-fixture.js', import.meta.url).pathname,
        JSON.stringify({ directories: f.scope.directories, kind, input, phase })], { timeout: 30000, encoding: 'utf8' });
    assert.equal(result.signal, 'SIGKILL', result.stderr || result.stdout);
}

for (const kind of ['create', 'update']) {
    for (const phase of ['planned', 'staged', 'renamed', 'published', 'history', 'metadata']) {
        test(`canvas ${kind} recovers after an actual process crash at ${phase}`, t => {
            const f = prepared(t);
            const original = kind === 'update' ? f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId,
                operationId: op('initial'), title: 'Recoverable', document: document(), actor: 'owner' })) : null;
            const desired = document();
            desired.nodes[0].text = `Recovered ${kind} ${phase}.`;
            const input = { notebookId: f.notebookId, operationId: op('crash'), title: 'Recoverable', document: desired, actor: 'owner',
                ...(original ? { canvasId: original.canvasId, expectedRevision: original.revision } : {}) };
            crash(f, kind, input, phase);
            const list = f.run(lease => listCanvasesLocked(lease, f.notebookId));
            assert.equal(list.canvases.length, 1);
            assert.equal(list.warnings.length, 0);
            const saved = f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId: list.canvases[0].id })).canvas;
            assert.deepEqual(saved.document, desired);
            if (original) assert.equal(saved.id, original.canvasId);
            const history = f.run(lease => canvasHistoryLocked(lease, { notebookId: f.notebookId, canvasId: saved.id })).history;
            assert.equal(history.length, original ? 2 : 1);
            assert.equal(history.filter(entry => entry.operationId === input.operationId).length, 1);
            assert.equal(f.run(lease => pendingOperationsLocked(lease)).filter(entry => entry.plan?.type === 'canvas-write').length, 0);
            const replay = f.run(lease => kind === 'update' ? updateCanvasLocked(lease, input) : createCanvasLocked(lease, input));
            assert.equal(replay.replayed, true);
            assert.equal(replay.canvasId, saved.id);
            assert.equal(replay.revision, saved.revision);
        });
    }
}

test('canvas recovery after publication keeps a newer external writer and both exact history snapshots', t => {
    const f = prepared(t);
    const original = f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId, operationId: op('race-original'), title: 'Race', document: document(), actor: 'owner' }));
    const desired = document();
    desired.nodes[0].text = 'Interrupted Neconyan change.';
    const input = { notebookId: f.notebookId, canvasId: original.canvasId, operationId: op('race'), expectedRevision: original.revision, document: desired, actor: 'owner' };
    crash(f, 'update', input, 'published');
    const external = document();
    external.nodes[0].text = 'Newer external change must remain.';
    const exact = JSON.stringify(external, null, 4) + '\r\n';
    const filename = path.join(f.root, 'notebooks', f.notebookId, original.path);
    fs.writeFileSync(filename, exact);
    f.run(lease => invalidateNotebookCache(lease, f.notebookId));
    const saved = f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId: original.canvasId })).canvas;
    assert.equal(saved.text, exact);
    assert.deepEqual(saved.document, external);
    const history = f.run(lease => canvasHistoryLocked(lease, { notebookId: f.notebookId, canvasId: original.canvasId })).history;
    assert.equal(history.length, 3);
    const restored = history.map(item => f.run(lease => canvasHistoryReadLocked(lease, { notebookId: f.notebookId, canvasId: original.canvasId, historyId: item.id })));
    assert.ok(restored.some(item => item.document.nodes[0].text === desired.nodes[0].text));
    assert.ok(restored.some(item => item.text === exact));
    assert.equal(fs.readFileSync(filename, 'utf8'), exact);
});

test('Canvas stays a portable file across notebook ZIP import and export without activating AI access', async t => {
    const f = prepared(t);
    const exact = '\uFEFF' + JSON.stringify(document(), null, 4).replaceAll('\n', '\r\n') + '\r\n';
    const stage = await stageImport(f.scope, { filename: 'Portable.zip', bytes: zipSync({ 'Portable/Plans/Imported.canvas': Buffer.from(exact), 'Portable/Note.md': Buffer.from('# Note\n') }) });
    const committed = await commitImport(f.scope, { operationId: op('import-canvas'), stageId: stage.stageId, actor: 'owner' });
    const importedId = committed.notebook.id;
    const list = f.run(lease => listCanvasesLocked(lease, importedId));
    assert.equal(list.canvases.length, 1);
    const read = f.run(lease => readCanvasLocked(lease, { notebookId: importedId, canvasId: list.canvases[0].id })).canvas;
    assert.equal(read.text, exact);
    assert.deepEqual(read.document, document());
    const policy = f.run(lease => readPoliciesLocked(lease, importedId));
    assert.equal(policy.admitted, false);
    assert.equal(policy.assistant, 'none');
    const exported = f.run(lease => collectExportLocked(lease, { notebookId: importedId }));
    const zip = unzipSync(buildExportZip(exported));
    const canvasPath = Object.keys(zip).find(name => name.endsWith('/Plans/Imported.canvas'));
    assert.ok(canvasPath);
    assert.equal(Buffer.from(zip[canvasPath]).toString('utf8'), exact);
    assert.ok(Object.keys(zip).every(name => !name.includes('notebook-control')));
});

for (const action of ['save_copy', 'discard']) {
    test(`a blocked canvas recovery can ${action} without changing an external writer`, t => {
        const f = prepared(t);
        const original = f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId, operationId: op('blocked-original'), title: 'Blocked', document: document() }));
        const desired = document();
        desired.nodes[0].text = 'Unpublished recovery copy.';
        const input = { notebookId: f.notebookId, canvasId: original.canvasId, operationId: op('blocked'), expectedRevision: original.revision, document: desired };
        crash(f, 'update', input, 'staged');
        const external = document();
        external.nodes[0].text = 'External writer remains authoritative.';
        const exact = JSON.stringify(external) + '\r\n';
        const filename = path.join(f.root, 'notebooks', f.notebookId, original.path);
        fs.writeFileSync(filename, exact);
        const list = f.run(lease => listCanvasesLocked(lease, f.notebookId));
        assert.equal(list.warnings[0].operationId, input.operationId);
        const recovery = f.run(lease => canvasRecoveryReadLocked(lease, { notebookId: f.notebookId, recoveryOperationId: input.operationId }));
        assert.deepEqual(recovery.recovery.document, desired);
        const choice = { notebookId: f.notebookId, operationId: op('decision'), recoveryOperationId: input.operationId, action };
        const result = f.run(lease => decideCanvasRecoveryLocked(lease, choice));
        assert.equal(result.savedCopy, action === 'save_copy');
        assert.equal(fs.readFileSync(filename, 'utf8'), exact);
        assert.equal(f.run(lease => listCanvasesLocked(lease, f.notebookId)).warnings.length, 0);
        if (result.savedCopy) assert.deepEqual(f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId: result.canvasId })).canvas.document, desired);
        assert.equal(f.run(lease => decideCanvasRecoveryLocked(lease, choice)).replayed, true);
        const journal = JSON.parse(fs.readFileSync(path.join(f.root, 'notebook-control', f.notebookId, 'canvas-operations', `${sha256(input.operationId)}.json`), 'utf8'));
        assert.equal(journal.completed, true);
        assert.equal(journal.bytes, undefined);
        assert.equal(journal.args, undefined);
    });
}

test('canvas recovery refuses a changed staged target before authoring publication', t => {
    const f = prepared(t);
    const original = f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId, operationId: op('tampered-original'), title: 'Original', document: document() }));
    const desired = document();
    desired.nodes[0].text = 'Must not be redirected.';
    const input = { notebookId: f.notebookId, canvasId: original.canvasId, operationId: op('tampered'), expectedRevision: original.revision, document: desired };
    crash(f, 'update', input, 'staged');
    const journalPath = path.join(f.root, 'notebook-control', f.notebookId, 'canvas-operations', `${sha256(input.operationId)}.json`);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.staged.relative = path.join('notebooks', f.notebookId, 'Different.canvas');
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    assert.throws(() => f.run(lease => listCanvasesLocked(lease, f.notebookId)), error => error.code === 'CANVAS_RECOVERY_DAMAGED');
    assert.equal(fs.existsSync(path.join(f.root, 'notebooks', f.notebookId, 'Different.canvas')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'notebooks', f.notebookId, original.path), 'utf8')), document());
});

test('portable canvas writes use revisions, stable operation replay and private exact history', t => {
    const f = prepared(t);
    const beforePolicy = f.run(lease => readPoliciesLocked(lease, f.notebookId));
    const created = f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId, operationId: op('create'), title: 'Plan', document: document(), actor: 'owner' }));
    assert.equal(created.status, 'success');
    const read = () => f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId: created.canvasId })).canvas;
    const original = read();
    assert.deepEqual(original.document, document());
    assert.equal(f.run(lease => listCanvasesLocked(lease, f.notebookId)).canvases.length, 1);
    const request = { notebookId: f.notebookId, canvasId: created.canvasId, operationId: op('update'), expectedRevision: original.revision,
        changes: [{ type: 'update-node', id: 'text', set: { x: 180, text: '# Changed plan' } }], actor: 'owner' };
    const result = f.run(lease => updateCanvasLocked(lease, request));
    assert.equal(result.status, 'success');
    assert.notEqual(result.revision, original.revision);
    assert.equal(read().document.nodes[0].x, 180);
    assert.deepEqual(read().document.future, document().future);
    assert.deepEqual(read().document.nodes[0].plugin, document().nodes[0].plugin);
    assert.equal(f.run(lease => updateCanvasLocked(lease, request)).replayed, true);
    assert.throws(() => f.run(lease => updateCanvasLocked(lease, { ...request, changes: [{ type: 'remove-node', id: 'text' }] })), error => error.code === 'OPERATION_REUSED');
    assert.throws(() => f.run(lease => updateCanvasLocked(lease, { ...request, operationId: op('stale') })), error => error.code === 'CANVAS_CONFLICT');
    const history = f.run(lease => canvasHistoryLocked(lease, { notebookId: f.notebookId, canvasId: created.canvasId })).history;
    assert.equal(history.length, 2);
    const oldest = f.run(lease => canvasHistoryReadLocked(lease, { notebookId: f.notebookId, canvasId: created.canvasId, historyId: history.at(-1).id }));
    assert.equal(oldest.text, original.text);
    assert.deepEqual(f.run(lease => readPoliciesLocked(lease, f.notebookId)), beforePolicy);
    assert.equal(fs.readFileSync(path.join(f.root, 'notebooks', f.notebookId, 'Plan.canvas'), 'utf8'), read().text);
});

test('reading and saving an unchanged imported canvas preserves its exact BOM and CRLF bytes', t => {
    const f = prepared(t);
    const text = '\uFEFF' + JSON.stringify(document()) + '\r\n';
    const filename = path.join(f.root, 'notebooks', f.notebookId, 'Imported.canvas');
    fs.writeFileSync(filename, text);
    f.run(lease => invalidateNotebookCache(lease, f.notebookId));
    const canvasId = f.run(lease => listCanvasesLocked(lease, f.notebookId)).canvases[0].id;
    const imported = f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId })).canvas;
    assert.equal(imported.text, text);
    const unchanged = f.run(lease => updateCanvasLocked(lease, { notebookId: f.notebookId, canvasId, operationId: op('unchanged'),
        expectedRevision: imported.revision, document: imported.document, actor: 'owner' }));
    assert.equal(unchanged.status, 'no_change');
    assert.equal(fs.readFileSync(filename, 'utf8'), text);
});

test('external canvas edits and moves keep exact history and the same stable identity', t => {
    const f = prepared(t);
    const created = f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId, operationId: op('external'), title: 'External', document: document(), actor: 'owner' }));
    const filename = path.join(f.root, 'notebooks', f.notebookId, created.path);
    const changed = document();
    changed.nodes[0].text = 'Changed outside Neconyan.';
    const bytes = JSON.stringify(changed, null, 4) + '\r\n';
    fs.writeFileSync(filename, bytes);
    f.run(lease => invalidateNotebookCache(lease, f.notebookId));
    const read = f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId: created.canvasId })).canvas;
    assert.equal(read.text, bytes);
    const history = f.run(lease => canvasHistoryLocked(lease, { notebookId: f.notebookId, canvasId: created.canvasId })).history;
    assert.equal(history.length, 2);
    assert.equal(history[0].origin, 'external');
    fs.renameSync(filename, path.join(path.dirname(filename), 'Moved.canvas'));
    f.run(lease => invalidateNotebookCache(lease, f.notebookId));
    const moved = f.run(lease => listCanvasesLocked(lease, f.notebookId));
    assert.equal(moved.canvases.length, 1);
    assert.equal(moved.canvases[0].id, created.canvasId);
    assert.equal(moved.canvases[0].path, 'Moved.canvas');
    assert.equal(f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId: created.canvasId })).canvas.text, bytes);
});

test('malformed imported canvas files remain untouched and are never executed', t => {
    const f = prepared(t);
    const filename = path.join(f.root, 'notebooks', f.notebookId, 'Malformed.canvas');
    const text = '<script>neverExecuted()</script>';
    fs.writeFileSync(filename, text);
    f.run(lease => invalidateNotebookCache(lease, f.notebookId));
    const canvasId = f.run(lease => listCanvasesLocked(lease, f.notebookId)).canvases[0].id;
    assert.throws(() => f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId })), error => error.code === 'CANVAS_INVALID');
    assert.equal(fs.readFileSync(filename, 'utf8'), text);
});

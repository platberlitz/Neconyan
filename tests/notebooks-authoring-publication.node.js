import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { simulateAuthoringRename } from './authoring-rename-fixture.js';
import { readRoleplayFile, withRoleplayAccount } from '../src/roleplay-store.js';
import { authoringEvidence } from '../src/authoring-store.js';
import { ensureDefaultNotebookLocked, notebookControlRoot, pendingOperationsLocked } from '../src/notebooks/store.js';
import { createCanvasLocked, listCanvasesLocked, readCanvasLocked, canvasHistoryLocked } from '../src/notebooks/canvas-store.js';
import { recordObsidianFileLocked, obsidianHistoryLocked, obsidianHistoryFileLocked } from '../src/notebooks/obsidian-history.js';
import { sha256 } from '../src/notebooks/paths.js';

function prepared(t) {
    const f = fixture(t);
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const notebookId = run(lease => ensureDefaultNotebookLocked(lease).id);
    return { ...f, run, notebookId };
}

test('canvas checkpoint saves changed witness through a nested journal write before the renamed fault hook', t => {
    const f = prepared(t); simulateAuthoringRename(t);
    const operationId = 'canvas:changed-inode';
    const document = { nodes: [{ id: 'text', type: 'text', x: 0, y: 0, width: 300, height: 180, text: 'Kept exactly' }], edges: [] };
    assert.throws(() => f.run(lease => createCanvasLocked(lease, { notebookId: f.notebookId, operationId, title: 'Changed identity', document }, {
        fault: phase => { if (phase === 'renamed') throw new Error('Lost completion'); },
    })), /Lost completion/);
    const journalFile = path.join(notebookControlRoot(f.scope.directories.root, f.notebookId), 'canvas-operations', `${sha256(operationId)}.json`);
    const persisted = JSON.parse(fs.readFileSync(journalFile));
    assert.notEqual(persisted.published, true);
    assert.deepEqual(persisted.staged.after, authoringEvidence(readRoleplayFile(path.join(f.scope.directories.root, persisted.staged.relative))));
    const list = f.run(lease => listCanvasesLocked(lease, f.notebookId));
    assert.equal(list.warnings.length, 0);
    assert.equal(list.canvases.length, 1);
    const canvasId = list.canvases[0].id;
    assert.deepEqual(f.run(lease => readCanvasLocked(lease, { notebookId: f.notebookId, canvasId })).canvas.document, document);
    assert.equal(f.run(lease => canvasHistoryLocked(lease, { notebookId: f.notebookId, canvasId })).history.length, 1);
    assert.equal(f.run(lease => pendingOperationsLocked(lease)).length, 0);
});

for (const recoverPrepared of [false, true]) {
    test(`Obsidian saves the changed snapshot witness before index publication; recovery entry: ${recoverPrepared}`, t => {
        const f = prepared(t);
        let interruptIndex = true;
        simulateAuthoringRename(t, { afterRename(_from, to) {
            if (interruptIndex && String(to).replaceAll('\\', '/').endsWith('/obsidian-history/index.json')) {
                interruptIndex = false;
                throw new Error('Lost history index acknowledgement');
            }
        } });
        const bytes = Buffer.from([0, 1, 2, 255]);
        const file = { path: 'Binary.txt', hash: sha256(bytes), bytes, stat: null };
        if (recoverPrepared) {
            assert.throws(() => f.run(lease => recordObsidianFileLocked(lease, f.notebookId, file, { fault: phase => {
                if (phase === 'planned') throw new Error('Lost prepared acknowledgement');
            } })), /Lost prepared/);
            assert.throws(() => f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })), /Lost history index/);
        } else {
            assert.throws(() => f.run(lease => recordObsidianFileLocked(lease, f.notebookId, file)), /Lost history index/);
        }
        const pending = f.run(lease => pendingOperationsLocked(lease)).filter(entry => entry.plan?.type === 'obsidian-file-history');
        assert.equal(pending.length, 1);
        const saved = pending[0].plan.staged;
        assert.deepEqual(saved.after, authoringEvidence(readRoleplayFile(path.join(f.scope.directories.root, saved.relative))));
        const history = f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history;
        assert.equal(history.length, 1);
        assert.deepEqual(f.run(lease => obsidianHistoryFileLocked(lease, { notebookId: f.notebookId, historyId: history[0].id })).bytes, bytes);
        assert.equal(f.run(lease => pendingOperationsLocked(lease)).length, 0);
        f.run(lease => recordObsidianFileLocked(lease, f.notebookId, file));
        assert.equal(f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history.length, 1);
    });
}

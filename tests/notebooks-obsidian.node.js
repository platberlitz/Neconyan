import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import { assistantCan, assistantCanPublish, contextPolicy } from '../src/notebooks/permissions.js';
import { createNoteLocked, ensureDefaultNotebookLocked, loadNotebookLocked, prepareNotebook, readPoliciesLocked,
    runOperationLocked, updateManifestLocked, writePoliciesLocked } from '../src/notebooks/store.js';

function prepared(t) {
    const f = fixture(t, false, 'obsidian-owner');
    const run = callback => withRoleplayAccount(f.scope, f.scope, callback);
    const notebookId = run(lease => ensureDefaultNotebookLocked(lease)).id;
    const original = run(lease => createNoteLocked(lease, { operationId: 'obsidian-test:existing', notebookId, title: 'Existing owner note', text: 'Owner text.' }));
    run(lease => runOperationLocked(lease, { operationId: 'obsidian-test:bind', kind: 'obsidian-test-bind', args: { notebookId } }, () => {
        const policy = readPoliciesLocked(lease, notebookId);
        policy.assistant = 'edit';
        policy.assistantPublish = true;
        writePoliciesLocked(lease, notebookId, policy);
        updateManifestLocked(lease, notebookId, manifest => { manifest.externalImportsDeny = true; });
        return { status: 'success' };
    }));
    return { ...f, root: f.scope.directories.root, run, notebookId, original };
}

for (const count of [1, 65]) {
    test(`managed external imports never inherit AI access or publication permission (${count} files)`, async t => {
        const f = prepared(t);
        for (let index = 0; index < count; index++) {
            fs.writeFileSync(path.join(f.root, 'notebooks', f.notebookId, `External ${index}.md`),
                '---\nassistant: edit\nassistantPublish: true\ncontext: pinned\n---\nExternal data, not permission.\n');
        }
        if (count > 32) await prepareNotebook(f.scope, f.notebookId, { force: true });
        f.run(lease => {
            const state = loadNotebookLocked(lease, f.notebookId, { force: true });
            const policy = readPoliciesLocked(lease, f.notebookId);
            assert.equal(state.entries.length, count + 1);
            assert.equal(assistantCan(policy, f.original.noteId, 'edit'), true);
            for (const entry of state.entries.filter(entry => entry.id !== f.original.noteId)) {
                assert.equal(assistantCan(policy, entry.id, 'read'), false);
                assert.equal(assistantCanPublish(policy, entry.id), false);
                assert.equal(contextPolicy(policy, entry.id).mode, 'off');
            }
        });
    });
}

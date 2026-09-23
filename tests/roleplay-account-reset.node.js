import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { commitRoleplayLifecycleLocked, commitSingleChatWrite, bootstrapRoleplayAccount } from '../src/roleplay-lifecycle.js';
import { readRoleplayAccount, recreateRoleplayAccount, resetRoleplayAccount, roleplayStoreDirectory, withRoleplayAccount } from '../src/roleplay-store.js';
import { acceptJob, getJob, updateJob } from '../src/jobs/store.js';

const host = { prepare: records => ({ records, bytes: Buffer.from(records.map(row => JSON.stringify(row)).join('\n')) }), publish: () => {} };
const stateOf = f => withRoleplayAccount(f.scope, null, (_lease, current) => current);
const jobInput = { owner: 'fixture', type: 'test.job', submissionKey: 'job-1', intent: { value: 1 }, label: 'Job' };


test('reset starts a new data epoch, keeps receipts and old jobs, and rejects late writes', async t => {
    const f = fixture(t, false, 'fixture');
    const before = readRoleplayChat(f.scope, f.locator);
    const { job } = acceptJob(f.scope.directories, jobInput);
    const next = resetRoleplayAccount(f.scope, null, 'reset');
    assert.equal(next.accountId, f.scope.accountId);
    assert.equal(next.dataEpoch, f.scope.dataEpoch + 1);
    assert.equal(fs.existsSync(f.filename), false);
    const state = readRoleplayAccount(next);
    assert.equal(state.status, 'ready');
    assert.equal(state.pending, null);
    assert.deepEqual(state.paths, {});
    assert.equal(state.resources[before.instanceId].status, 'deleted');
    // Stale browser stamps and late callbacks from the old epoch are refused.
    assert.throws(() => withRoleplayAccount(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, () => null), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.throws(() => commitSingleChatWrite(f.scope, f.input(), host), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    const retired = path.join(roleplayStoreDirectory(f.scope), 'retired');
    const [folder] = fs.readdirSync(retired);
    assert.ok(fs.existsSync(path.join(retired, folder, 'jobs', 'index.json')));
    assert.equal(getJob(f.scope.directories, job.id), null);
    assert.throws(() => updateJob(f.scope.directories, job.id, { label: 'late' }));
    // Startup after a reset serves the new epoch normally.
    assert.equal(bootstrapRoleplayAccount({ owner: 'fixture', directories: f.scope.directories }, host).dataEpoch, next.dataEpoch);
});

test('an interrupted reset finishes at startup before anything else', async t => {
    const f = fixture(t, false, 'fixture');
    readRoleplayChat(f.scope, f.locator);
    const original = fs.rmSync;
    let calls = 0;
    fs.rmSync = (...args) => {
        if (!String(args[0]).includes('_roleplay') && calls++ === 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return original(...args);
    };
    try {
        assert.throws(() => resetRoleplayAccount(f.scope, null, 'reset'), { code: 'EBUSY' });
    } finally { fs.rmSync = original; }
    assert.throws(() => stateOf(f), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.throws(() => resetRoleplayAccount(f.scope, null, 'purge'), { code: 'ROLEPLAY_INTENT_CONFLICT' });
    const scope = bootstrapRoleplayAccount({ owner: 'fixture', directories: f.scope.directories }, host);
    assert.equal(scope.dataEpoch, f.scope.dataEpoch + 1);
    assert.equal(fs.existsSync(f.filename), false);
});

test('purge retires the account and recreation gives a fresh incarnation', async t => {
    const f = fixture(t, false, 'fixture');
    const before = readRoleplayChat(f.scope, f.locator);
    resetRoleplayAccount(f.scope, null, 'purge');
    assert.throws(() => stateOf(f), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.equal(bootstrapRoleplayAccount({ owner: 'fixture', directories: f.scope.directories }, host), null);
    assert.equal(resetRoleplayAccount(f.scope, null, 'purge').dataEpoch, f.scope.dataEpoch + 1);
    const fresh = recreateRoleplayAccount({ owner: 'fixture', directories: f.scope.directories });
    assert.notEqual(fresh.accountId, f.scope.accountId);
    assert.equal(fresh.dataEpoch, f.scope.dataEpoch + 2);
    const state = readRoleplayAccount(fresh);
    assert.equal(state.status, 'ready');
    assert.equal(state.resources[before.instanceId].status, 'deleted');
    assert.equal(bootstrapRoleplayAccount({ owner: 'fixture', directories: f.scope.directories }, host).accountId, fresh.accountId);
});

test('reset waits for an unsettled Roleplay operation', async t => {
    const f = fixture(t, false, 'fixture');
    readRoleplayChat(f.scope, f.locator);
    const failing = { clearDeferred: () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); } };
    assert.throws(() => withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'delete', action: 'chat-delete', intent: {}, steps: [{ op: 'move', kind: 'chat', locator: f.locator,
            destination: { ...f.locator, chat: 'Moved' } }] }, failing)), { code: 'EIO' });
    assert.notEqual(readRoleplayAccount(f.scope).pending, null);
    assert.throws(() => resetRoleplayAccount(f.scope, null, 'reset'), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(readRoleplayAccount(f.scope).status, 'ready');
});

test('retiring a deleted user keeps files, and recreation re-identifies them under a new account', async t => {
    const f = fixture(t, false, 'fixture');
    const before = readRoleplayChat(f.scope, f.locator);
    const { prepareNativeChatWrite, publishNativeChatWrite } = await import('../src/endpoints/chats.js');
    commitSingleChatWrite(f.scope, f.input(), { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite });
    assert.match(fs.readFileSync(f.filename, 'utf8'), /neconyan_roleplay/);
    resetRoleplayAccount(f.scope, null, 'retire');
    assert.ok(fs.existsSync(f.filename));
    assert.throws(() => stateOf(f), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.equal(bootstrapRoleplayAccount({ owner: 'fixture', directories: f.scope.directories }, host), null);
    const next = recreateRoleplayAccount(f.scope);
    assert.notEqual(next.accountId, f.scope.accountId);
    // The file still carries the old marker; it now starts a new identity instead of being refused as foreign.
    const after = readRoleplayChat(next, f.locator);
    assert.notEqual(after.instanceId, before.instanceId);
});

test('imports after a reset write files whose paths the old epoch tracked', async t => {
    const { importUserFile } = await import('../src/endpoints/users-private.js');
    const f = fixture(t, false, 'fixture');
    const bytes = fs.readFileSync(f.filename);
    readRoleplayChat(f.scope, f.locator);
    const next = resetRoleplayAccount(f.scope, null, 'reset');
    assert.equal(importUserFile(next, f.filename, bytes), true);
    assert.ok(readRoleplayChat(next, f.locator).instanceId);
});

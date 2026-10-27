import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { encodePreparedRoleplayState, resetRoleplayAccount, roleplayLease, roleplayStoreDirectory,
    withOfflineRoleplayAccount, withOwnedOfflineRoleplayAccount, withRoleplayAccount } from '../src/roleplay-store.js';
import { acquireDataRootOwner } from '../src/data-root-owner.js';
import { getChatFileLockPath } from '../src/chat-file-lock.js';
import { inspectTransferredRoleplayLocked, prepareTransferredRoleplayState } from '../src/roleplay-transfer-recovery.js';

function prepare(lease, device) {
    const held = roleplayLease(lease);
    const checked = inspectTransferredRoleplayLocked(lease);
    const receipt = { token: checked.report.token, backup: '/fixture/backup', dataEpoch: held.state.dataEpoch + 1,
        counts: checked.report.counts, skipped: checked.report.skipped.length, repairedAt: new Date().toISOString(), journals: [] };
    const ids = held.state.status === 'deleted' ? [] : checked.entries.map(() => crypto.randomUUID());
    const next = prepareTransferredRoleplayState(lease, checked, receipt, ids, device);
    return { checked, next, bytes: encodePreparedRoleplayState(lease, next) };
}

test('offline preparation projects identity without changing current files or ledger', t => {
    const f = fixture(t);
    f.source();
    const ledger = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const before = fs.readFileSync(ledger);
    const chat = fs.readFileSync(f.filename);
    const result = withOfflineRoleplayAccount(f.scope, lease => prepare(lease, roleplayLease(lease).identityFile.physical.dev));
    assert.deepEqual(fs.readFileSync(ledger), before);
    assert.deepEqual(fs.readFileSync(f.filename), chat);
    assert.equal(result.next.accountId, f.scope.accountId);
    assert.equal(result.next.dataEpoch, f.scope.dataEpoch + 1);
    assert.equal(result.next.status, 'ready');
    assert.equal(result.next.placement.birthtimeNs, '0');
    for (const resource of Object.values(result.next.resources)) assert.equal(resource.head.physical.birthtimeNs, '0');
    assert.equal(JSON.parse(result.bytes).state.dataEpoch, f.scope.dataEpoch + 1);
});

test('offline preparation preserves retired status and never exposes it as a normal account', t => {
    const f = fixture(t);
    f.source();
    const base = { owner: f.scope.owner, directories: f.scope.directories };
    resetRoleplayAccount(base, f.scope, 'retire');
    assert.throws(() => withRoleplayAccount(base, null, () => {}), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    const result = withOfflineRoleplayAccount(base, lease => prepare(lease, roleplayLease(lease).identityFile.physical.dev));
    assert.equal(result.next.status, 'deleted');
    assert.deepEqual(result.next.resources, {});
    assert.equal(JSON.parse(result.bytes).state.status, 'deleted');
});

test('offline root-only lease requires an actual live owner and refuses existing account locks', t => {
    const f = fixture(t);
    assert.throws(() => withOwnedOfflineRoleplayAccount({}, f.scope, () => {}), { code: 'DATA_ROOT_OWNED' });
    const owner = acquireDataRootOwner(f.root, 'repair');
    const before = fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'state.json'));
    const result = withOwnedOfflineRoleplayAccount(owner, f.scope, lease => roleplayLease(lease).state.accountId);
    assert.equal(result, f.scope.accountId);
    const lock = getChatFileLockPath(path.join(roleplayStoreDirectory(f.scope), 'state.json'));
    fs.mkdirSync(lock);
    assert.throws(() => withOwnedOfflineRoleplayAccount(owner, f.scope, () => {}), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    fs.rmdirSync(lock);
    assert.deepEqual(fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'state.json')), before);
    owner.release();
    assert.throws(() => withOwnedOfflineRoleplayAccount(owner, f.scope, () => {}), { code: 'DATA_ROOT_OWNED' });
});

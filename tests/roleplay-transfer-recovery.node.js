import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png, writeJournal } from './roleplay-transactions-fixture.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { captureRoleplayStorageSource, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { confirmRoleplayAccount, initialiseRoleplayAccount, readRoleplayAccount, readRoleplayFile, resetRoleplayAccount, roleplayLease, roleplayStoreDirectory, withRoleplayAccount } from '../src/roleplay-store.js';
import { bootstrapRoleplayAccount, commitRoleplayLifecycleLocked, commitSingleChatWrite } from '../src/roleplay-lifecycle.js';
import { roleplayNativeHost } from '../src/endpoints/chats.js';
import { inspectTransferredRoleplay, repairTransferredRoleplay } from '../src/roleplay-transfer-recovery.js';
import { getCookieSessionName } from '../src/users.js';
import { admitRoleplayJob, applyRoleplayJobEffect } from '../src/roleplay-jobs.js';

function replaceFile(filename) {
    fs.copyFileSync(filename, filename + '.copy');
    fs.renameSync(filename + '.copy', filename);
}

function repair(f) {
    const check = inspectTransferredRoleplay(f.scope);
    assert.equal(check.canRepair, true, JSON.stringify(check.issues));
    return repairTransferredRoleplay(f.scope, check.token);
}

for (const group of [false, true]) test(`copied ${group ? 'group' : 'solo'} files recover unchanged; old saves stay refused`, t => {
    const f = fixture(t, group);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    const old = captureRoleplayStorageSource(f.scope, f.locator);
    const bytes = fs.readFileSync(f.filename);
    const card = path.join(f.scope.directories.characters, 'Nova.png');
    replaceFile(f.filename); replaceFile(card);
    assert.throws(() => captureRoleplayStorageSource(f.scope, f.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const result = repair(f);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    const backup = path.join(result.backup, group ? 'groupChats/Source.jsonl' : 'chats/Nova/Source.jsonl');
    assert.deepEqual(fs.readFileSync(backup), bytes);
    assert.notEqual(fs.statSync(backup).ino, fs.statSync(f.filename).ino);
    assert.equal(result.dataEpoch, f.scope.dataEpoch + 1);
    const scope = { ...f.scope, dataEpoch: result.dataEpoch };
    readRoleplayEntity(scope, 'character', 'Nova.png');
    const current = captureRoleplayStorageSource(scope, f.locator);
    assert.notEqual(current.instanceId, old.instanceId);
    assert.throws(() => commitSingleChatWrite(f.scope, { operationKey: 'stale', source: old, mode: 'update', records: f.records }, roleplayNativeHost),
        { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.deepEqual(repairTransferredRoleplay(scope, result.token), result, 'a lost response can be retried without another repair');
    commitSingleChatWrite(scope, { operationKey: 'recovered-save', sourceKind: 'storage', source: current, mode: 'update',
        records: [...f.records, { name: 'Nova', is_user: false, mes: 'After repair' }] }, roleplayNativeHost);
    bootstrapRoleplayAccount(scope, roleplayNativeHost);
    assert.equal(captureRoleplayStorageSource(scope, f.locator).revision, 2);
    assert.deepEqual(fs.readFileSync(backup), bytes, 'the backup remains independent after later saves');
});

test('native chats recover even after their original tracking directory was moved aside', t => {
    const f = fixture(t);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    const bytes = fs.readFileSync(f.filename);
    const root = roleplayStoreDirectory(f.scope);
    fs.renameSync(root, root + '-original');
    f.scope = initialiseRoleplayAccount({ owner: f.scope.owner, directories: f.scope.directories });
    assert.throws(() => captureRoleplayStorageSource(f.scope, f.locator), { code: 'ROLEPLAY_FOREIGN_SOURCE' });
    const result = repair(f);
    const scope = { ...f.scope, dataEpoch: result.dataEpoch };
    assert.ok(captureRoleplayStorageSource(scope, f.locator).instanceId);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.ok(fs.existsSync(root + '-original/state.json'));
});

test('an interrupted operation is archived and never replayed after accepting current files', t => {
    const f = fixture(t);
    const filename = path.join(f.scope.directories.characters, 'Nova.png');
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const original = fs.renameSync;
    fs.renameSync = function (source, destination) {
        if (destination === filename && source.endsWith('.tmp')) throw Object.assign(new Error('interrupted'), { code: 'EIO' });
        return original.apply(fs, arguments);
    };
    try {
        assert.throws(() => withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
            operationKey: 'edit', action: 'character-update', intent: { avatar: 'Nova.png' },
            steps: [{ op: 'update', kind: 'character', locator: { avatar: 'Nova.png' }, bytes: writeCard(png, JSON.stringify({ name: 'Nova', description: 'Pending' })) }],
        })), { code: 'EIO' });
    } finally { fs.renameSync = original; }
    fs.writeFileSync(filename, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Transferred' })));
    assert.throws(() => bootstrapRoleplayAccount(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const bytes = fs.readFileSync(filename);
    const result = repair(f);
    assert.ok(JSON.parse(fs.readFileSync(path.join(result.backup, '_roleplay/state.json'))).state.pending);
    const scope = { ...f.scope, dataEpoch: result.dataEpoch };
    bootstrapRoleplayAccount(scope, roleplayNativeHost);
    assert.equal(readRoleplayAccount(scope).pending, null);
    assert.deepEqual(fs.readFileSync(filename), bytes);
});

test('archived undo journals cannot overwrite recovered chats or block later saves', t => {
    const f = fixture(t);
    f.source();
    const journal = writeJournal(f);
    const result = repair(f);
    assert.equal(fs.existsSync(journal.filename), false);
    assert.deepEqual(fs.readFileSync(path.join(result.backup, 'chats/Nova', path.basename(journal.filename))), Buffer.from(JSON.stringify(journal.record)));
    const scope = { ...f.scope, dataEpoch: result.dataEpoch };
    commitSingleChatWrite(scope, { operationKey: 'after-journal', sourceKind: 'storage', source: captureRoleplayStorageSource(scope, f.locator),
        mode: 'update', records: [...f.records, { name: 'Nova', mes: 'After repair' }] }, roleplayNativeHost);
});

test('changes between checking and repairing require a fresh check', t => {
    const f = fixture(t);
    const check = inspectTransferredRoleplay(f.scope);
    fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'User', mes: 'Later edit' }));
    const before = fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'state.json'));
    assert.throws(() => repairTransferredRoleplay(f.scope, check.token), { code: 'ROLEPLAY_RECOVERY_CHANGED' });
    assert.deepEqual(fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'state.json')), before);
});

test('invalid chats are reported and nothing is adopted', t => {
    const f = fixture(t);
    fs.appendFileSync(f.filename, '\n{"unfinished":');
    const check = inspectTransferredRoleplay(f.scope);
    assert.equal(check.canRepair, false);
    assert.equal(check.issues[0].file, 'chats/Nova/Source.jsonl');
    assert.throws(() => repairTransferredRoleplay(f.scope, check.token), { code: 'ROLEPLAY_RECOVERY_INVALID' });
    assert.equal(readRoleplayAccount(f.scope).dataEpoch, f.scope.dataEpoch);
});

for (const link of ['hard', 'symbolic']) test(`repair refuses ${link} links without touching their targets`, t => {
    const f = fixture(t);
    const other = path.join(f.scope.directories.chats, 'Nova', 'Other.jsonl');
    if (link === 'hard') fs.linkSync(f.filename, other);
    else fs.symlinkSync(f.filename, other);
    const before = fs.readFileSync(f.filename);
    assert.throws(() => inspectTransferredRoleplay(f.scope), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('backup failure leaves the old ledger and original files untouched', t => {
    const f = fixture(t);
    const check = inspectTransferredRoleplay(f.scope);
    const original = fs.writeFileSync;
    fs.writeFileSync = function (filename) {
        if (typeof filename === 'number') throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        return original.apply(fs, arguments);
    };
    try { assert.throws(() => repairTransferredRoleplay(f.scope, check.token), { code: 'ENOSPC' }); }
    finally { fs.writeFileSync = original; }
    assert.equal(readRoleplayAccount(f.scope).dataEpoch, f.scope.dataEpoch);
    assert.equal(inspectTransferredRoleplay(f.scope).token, check.token);
});

test('a changed file during backup refuses adoption and keeps its later bytes', t => {
    const f = fixture(t);
    const check = inspectTransferredRoleplay(f.scope);
    const original = fs.writeFileSync;
    let edited = false;
    fs.writeFileSync = function () {
        const result = original.apply(fs, arguments);
        if (!edited && typeof arguments[0] === 'number') {
            edited = true;
            fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'User', mes: 'During backup' }));
        }
        return result;
    };
    try { assert.throws(() => repairTransferredRoleplay(f.scope, check.token), { code: 'ROLEPLAY_RECOVERY_CHANGED' }); }
    finally { fs.writeFileSync = original; }
    assert.ok(fs.readFileSync(f.filename, 'utf8').includes('During backup'));
    assert.equal(readRoleplayAccount(f.scope).dataEpoch, f.scope.dataEpoch);
});

test('session cookies are stable for one installation and distinct for other roots and ports', () => {
    assert.equal(getCookieSessionName('/data/one', 8000), getCookieSessionName('/data/one', '8000'));
    assert.notEqual(getCookieSessionName('/data/one', 8000), getCookieSessionName('/data/two', 8000));
    assert.notEqual(getCookieSessionName('/data/one', 8000), getCookieSessionName('/data/one', 8001));
});

for (const afterRename of [false, true]) test(`interruption ${afterRename ? 'after' : 'before'} ledger publication can be retried without losing files`, t => {
    const f = fixture(t);
    f.source();
    const journal = writeJournal(f);
    const check = inspectTransferredRoleplay(f.scope);
    const bytes = fs.readFileSync(f.filename);
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const original = fs.renameSync;
    fs.renameSync = function (source, destination) {
        if (destination !== statePath) return original.apply(fs, arguments);
        if (afterRename) original.apply(fs, arguments);
        throw Object.assign(new Error('interrupted publication'), { code: 'EIO' });
    };
    try { assert.throws(() => repairTransferredRoleplay(f.scope, check.token), { code: 'ROLEPLAY_STORE_UNCERTAIN' }); }
    finally { fs.renameSync = original; }
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')).state;
    assert.equal(persisted.dataEpoch, f.scope.dataEpoch + Number(afterRename));
    assert.equal(fs.existsSync(journal.filename), true);
    const result = repairTransferredRoleplay(f.scope, check.token);
    assert.equal(result.dataEpoch, f.scope.dataEpoch + 1);
    assert.equal(fs.existsSync(journal.filename), false);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.deepEqual(fs.readFileSync(path.join(result.backup, 'chats/Nova/Source.jsonl')), bytes);
});

test('startup finishes interrupted journal retirement from the persisted repair receipt', t => {
    const f = fixture(t);
    f.source();
    const journal = writeJournal(f);
    const original = fs.unlinkSync;
    fs.unlinkSync = function (filename) {
        if (filename === journal.filename) throw Object.assign(new Error('interrupted cleanup'), { code: 'EIO' });
        return original.apply(fs, arguments);
    };
    try { assert.throws(() => repair(f), { code: 'EIO' }); }
    finally { fs.unlinkSync = original; }
    const current = bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    assert.equal(current.dataEpoch, f.scope.dataEpoch + 1);
    assert.equal(fs.existsSync(journal.filename), false);
    assert.ok(captureRoleplayStorageSource(current, f.locator));
});

test('repair tokens cannot be used for another account and later external changes remain refused', t => {
    const first = fixture(t);
    const second = fixture(t, false, 'other');
    const check = inspectTransferredRoleplay(first.scope);
    assert.throws(() => repairTransferredRoleplay(second.scope, check.token), { code: 'ROLEPLAY_RECOVERY_CHANGED' });
    const lateReply = first.input();
    const result = repairTransferredRoleplay(first.scope, inspectTransferredRoleplay(first.scope).token);
    const current = { ...first.scope, dataEpoch: result.dataEpoch };
    assert.throws(() => commitSingleChatWrite(current, lateReply, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    replaceFile(first.filename);
    assert.throws(() => captureRoleplayStorageSource(current, first.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('invalid groups block repair instead of leaving the group list broken', t => {
    const f = fixture(t, true);
    fs.writeFileSync(path.join(f.scope.directories.groups, 'group.json'), '{');
    const check = inspectTransferredRoleplay(f.scope);
    assert.equal(check.canRepair, false);
    assert.equal(check.issues[0].file, 'groups/group.json');
    assert.throws(() => repairTransferredRoleplay(f.scope, check.token), { code: 'ROLEPLAY_RECOVERY_INVALID' });
});

test('a reply accepted before repair cannot publish afterwards, even under the new account stamp', t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const job = admitRoleplayJob(f.scope, account, { operationKey: 'late-reply', effect: 'append', source: f.source(), request: { prompt: 'Hello' } });
    const bytes = fs.readFileSync(f.filename);
    const result = repair(f);
    const current = { ...f.scope, dataEpoch: result.dataEpoch };
    const effect = { operationKey: 'late-reply', jobId: job.jobId, output: { message: { name: 'Nova', mes: 'Late result' } } };
    assert.throws(() => applyRoleplayJobEffect(f.scope, account, effect, roleplayNativeHost), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.throws(() => applyRoleplayJobEffect(current, { ...account, dataEpoch: result.dataEpoch }, effect, roleplayNativeHost), { code: 'ROLEPLAY_JOB_REJECTED' });
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
});

test('an account reset retires a previous repair receipt', t => {
    const f = fixture(t);
    const result = repair(f);
    const current = resetRoleplayAccount({ ...f.scope, dataEpoch: result.dataEpoch }, null, 'reset');
    assert.equal(inspectTransferredRoleplay(current).lastRepair, null);
    assert.throws(() => repairTransferredRoleplay(current, result.token), { code: 'ROLEPLAY_RECOVERY_CHANGED' });
    assert.ok(fs.existsSync(result.backup), 'reset does not remove the independent repair backup');
});

test('unpublished repair evidence cannot retire a journal', t => {
    const f = fixture(t);
    f.source();
    const journal = writeJournal(f);
    const file = readRoleplayFile(journal.filename);
    withRoleplayAccount(f.scope, null, lease => {
        roleplayLease(lease).state.transferRecovery = { dataEpoch: f.scope.dataEpoch,
            journals: [{ library: 'chats', relative: 'chats/Nova/' + path.basename(journal.filename), rawHash: file.rawHash, physical: file.physical }] };
        confirmRoleplayAccount(lease);
        assert.equal(fs.existsSync(journal.filename), true);
    });
});

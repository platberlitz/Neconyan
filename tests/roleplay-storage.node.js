/* eslint playwright/expect-expect: off -- Uses node:assert with the existing disposable storage fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, writeJournal } from './roleplay-transactions-fixture.js';

const { withRoleplayAccount, roleplayStoreDirectory, readRoleplayAccount, readRoleplayFile, roleplayHash } = await import('../src/roleplay-store.js');
const { captureRoleplayStorageSource } = await import('../src/generation/roleplay-source.js');
const { commitSingleChatWrite, commitSingleChatWriteLocked, repairSingleChatWriteLocked, bootstrapRoleplayAccount, reconcileSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
const { roleplayNativeHost, roleplayBrowserHost } = await import('../src/endpoints/chats.js');
const { readChatJsonlStrict } = await import('../src/chat-recovery.js');

const account = f => ({ accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch });
const storageInput = (f, operationKey = 'storage-save') => ({ operationKey, mode: 'update', sourceKind: 'storage',
    source: captureRoleplayStorageSource(f.scope, f.locator), records: [...structuredClone(f.records), { name: 'Nova', mes: 'Saved change', is_user: false }],
    backup: { deferBackup: true } });

function changeDuringPublication(t, f, point, change) {
    let changed = false;
    const method = point === 'source snapshot' ? 'realpathSync' : 'renameSync';
    const original = fs[method];
    const mock = t.mock.method(fs, method, (...args) => {
        const result = original(...args);
        const matches = point === 'source snapshot' ? args[0] === f.filename : String(args[1]).endsWith('.latest.jsonl');
        if (!changed && matches) {
            changed = true;
            change();
        }
        return result;
    });
    return () => { mock.mock.restore(); assert.equal(changed, true); };
}

for (const group of [false, true]) {
    test(`${group ? 'group' : 'solo'} storage saves retain keyed receipts without generation dependencies`, t => {
        const f = fixture(t, group);
        const input = storageInput(f);
        fs.unlinkSync(path.join(f.scope.directories.characters, 'Nova.png'));
        fs.unlinkSync(path.join(f.scope.directories.groups, 'group.json'));
        const result = withRoleplayAccount(f.scope, account(f), lease => commitSingleChatWriteLocked(lease, input, roleplayBrowserHost));
        const saved = fs.readFileSync(f.filename);
        assert.equal(result.revision, 2);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 1);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 1);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, roleplayBrowserHost), result);
        assert.deepEqual(fs.readFileSync(f.filename), saved);
        assert.throws(() => commitSingleChatWrite(f.scope, { ...input, force: true }, roleplayBrowserHost), { code: 'ROLEPLAY_INTENT_CONFLICT' });
        assert.throws(() => commitSingleChatWrite(f.scope, { ...input, operationKey: 'stale', force: true }, roleplayBrowserHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        fs.unlinkSync(f.filename);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, roleplayBrowserHost), result);
        assert.equal(fs.existsSync(f.filename), false);
    });

    test(`${group ? 'group' : 'solo'} storage creation requires its exact vacancy and preserves replay identity`, t => {
        const f = fixture(t, group);
        const destination = { ...f.locator, chat: 'New' };
        const filename = path.join(path.dirname(f.filename), 'New.jsonl');
        fs.unlinkSync(path.join(f.scope.directories.characters, 'Nova.png'));
        fs.unlinkSync(path.join(f.scope.directories.groups, 'group.json'));
        const input = { operationKey: 'storage-create', sourceKind: 'storage', mode: 'create', destination,
            expectedVacancy: 0, records: f.records, backup: { deferBackup: true } };
        assert.throws(() => commitSingleChatWrite(f.scope, { ...input, expectedVacancy: 1 }, roleplayBrowserHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.equal(fs.existsSync(filename), false);
        const result = commitSingleChatWrite(f.scope, input, roleplayBrowserHost);
        assert.equal(result.mode, 'create');
        assert.equal(result.revision, 1);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, roleplayBrowserHost), result);
        assert.throws(() => commitSingleChatWrite(f.scope, { ...input, operationKey: 'occupied' }, roleplayBrowserHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 1);
    });
}

test('locked storage entry cannot bypass an expired lease or mismatched source kind', t => {
    const f = fixture(t);
    const input = storageInput(f);
    let expired;
    withRoleplayAccount(f.scope, account(f), lease => { expired = lease; });
    assert.throws(() => commitSingleChatWriteLocked(expired, input, roleplayBrowserHost), /active Roleplay account lock/);
    assert.throws(() => commitSingleChatWrite(f.scope, { ...input, sourceKind: 'unknown' }, roleplayBrowserHost), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => commitSingleChatWrite(f.scope, { ...input, sourceKind: undefined }, roleplayBrowserHost), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => commitSingleChatWrite(f.scope, { ...input, force: 'true' }, roleplayBrowserHost), { code: 'ROLEPLAY_INVALID' });
});

test('default generation intents keep their existing canonical replay identity', t => {
    const f = fixture(t);
    const input = f.input();
    const result = commitSingleChatWrite(f.scope, input, roleplayNativeHost);
    const expected = roleplayHash({ accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch, mode: input.mode, locator: f.locator,
        source: input.source, groupId: null, expectedVacancy: null, records: input.records, allowShrink: false, backup: input.backup });
    const receipt = Object.values(readRoleplayAccount(f.scope).submissions)[0];
    assert.equal(receipt.intentHash, expected);
    assert.deepEqual(receipt.outcome, result);
});

test('browser display equivalence preserves untouched legacy bytes while native preparation remains strict', t => {
    const f = fixture(t);
    const before = '\uFEFF' + f.records.map(row => '  ' + JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(f.filename, before);
    const input = storageInput(f);
    input.records = structuredClone(f.records);
    input.records[0].user_name = 'unused';
    input.records[0].character_name = 'unused';
    input.records[0].chat_metadata.neconyan_roleplay = { schema: 1, instanceId: 'not-authority' };
    const stats = fs.statSync(f.filename, { bigint: true });
    const result = commitSingleChatWrite(f.scope, input, roleplayBrowserHost);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, stats.mtimeNs);
    const marker = { schema: 1, instanceId: result.instanceId, revision: 2, writeId: result.writeId };
    assert.equal(roleplayNativeHost.prepare(input.records, { beforeBytes: Buffer.from(before), marker }).changed, true);
});

test('explicit forced storage saves preserve the overwritten chat and still require an exact current source', t => {
    const f = fixture(t);
    const input = storageInput(f);
    input.records = [structuredClone(f.records[0])];
    const before = fs.readFileSync(f.filename);
    assert.throws(() => commitSingleChatWrite(f.scope, input, roleplayBrowserHost), error => error.name === 'Error' && error.reason !== undefined);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 0);
    assert.equal(fs.existsSync(path.join(roleplayStoreDirectory(f.scope), 'pending')), false);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    const forced = { ...input, operationKey: 'confirmed-overwrite', force: true };
    const result = commitSingleChatWrite(f.scope, forced, roleplayBrowserHost);
    assert.equal(result.changed, true);
    const backup = fs.readdirSync(f.scope.directories.backups).find(name => name.startsWith('chat_forced_overwrite_'));
    assert.ok(backup);
    assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.backups, backup)), before);
    assert.deepEqual(commitSingleChatWrite(f.scope, forced, roleplayBrowserHost), result);
    assert.throws(() => commitSingleChatWrite(f.scope, { ...forced, force: false }, roleplayBrowserHost), { code: 'ROLEPLAY_INTENT_CONFLICT' });
});

for (const force of [false, true]) {
    test(`a late source edit cannot become the baseline of a ${force ? 'forced' : 'normal'} storage save`, t => {
        const f = fixture(t);
        const input = { ...storageInput(f), force };
        const edited = structuredClone(f.records);
        edited[1].mes = 'A separately saved edit';
        const bytes = Buffer.from(edited.map(row => JSON.stringify(row)).join('\n'));
        const finish = changeDuringPublication(t, f, 'source snapshot', () => fs.writeFileSync(f.filename, bytes));
        try {
            assert.throws(() => commitSingleChatWrite(f.scope, input, roleplayBrowserHost), error => error.chatWriteUncertain === true);
        } finally { finish(); }
        assert.deepEqual(fs.readFileSync(f.filename), bytes);
        const state = readRoleplayAccount(f.scope);
        assert.equal(state.pending.phase, 'prepared');
        assert.equal(Object.keys(state.submissions).length, 0);
        assert.equal(state.resources[input.source.instanceId].head.rawHash, input.source.rawHash);
        assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, roleplayBrowserHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    });
}

for (const point of ['source snapshot', 'recovery snapshot']) {
    for (const recorded of [true, false]) {
        test(`a ${recorded ? 'replaced' : 'new'} journal at the ${point} blocks storage publication`, t => {
            const f = fixture(t);
            const input = storageInput(f);
            assert.throws(() => commitSingleChatWrite(f.scope, input, { ...roleplayBrowserHost, publish() { throw new Error('Pause'); } }), /Pause/);
            const before = readRoleplayFile(f.filename);
            const journal = recorded ? writeJournal(f) : null;
            let replacement;
            const finish = changeDuringPublication(t, f, point, () => {
                if (journal) {
                    fs.writeFileSync(journal.filename + '.new', journal.bytes);
                    fs.renameSync(journal.filename + '.new', journal.filename);
                    replacement = { filename: journal.filename, ...readRoleplayFile(journal.filename) };
                } else replacement = writeJournal(f);
            });
            try {
                assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, roleplayBrowserHost), /explicit reconciliation/);
            } finally { finish(); }
            assert.deepEqual(readRoleplayFile(f.filename), before);
            assert.deepEqual(fs.readFileSync(replacement.filename), replacement.bytes);
            const state = readRoleplayAccount(f.scope);
            assert.equal(state.pending.phase, 'prepared');
            assert.equal(Object.keys(state.submissions).length, 0);
            assert.deepEqual(state.pending.journal?.physical ?? null, journal?.physical ?? null);
        });
    }
}

test('successive protected saves retain every distinct requested backup even at the same timestamp', t => {
    const f = fixture(t, false, 'immediate-storage-backups');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const saved = [];
    const backupBytes = () => fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_'))
        .map(name => fs.readFileSync(path.join(f.scope.directories.backups, name)));
    for (const mes of Array.from({ length: 6 }, (_, index) => `Saved result ${index}`)) {
        const input = storageInput(f, mes);
        input.records.at(-1).mes = mes;
        input.backup.deferBackup = false;
        commitSingleChatWrite(f.scope, input, roleplayBrowserHost);
        saved.push(fs.readFileSync(f.filename));
        const backups = backupBytes();
        assert.equal(backups.length, saved.length);
        assert.ok(saved.every(bytes => backups.some(backup => backup.equals(bytes))));
    }
    const unchanged = { ...storageInput(f, 'unchanged'), records: readChatJsonlStrict(f.filename).records, backup: { deferBackup: false } };
    assert.equal(commitSingleChatWrite(f.scope, unchanged, roleplayBrowserHost).changed, false);
    assert.equal(backupBytes().length, saved.length);
});

for (const chat of ['N'.repeat(192), '猫'.repeat(63) + 'abc']) {
    test(`long ${chat.startsWith('N') ? 'ASCII' : 'UTF-8'} chat names preserve regular, pre-write and forced backups`, t => {
        const f = fixture(t, true);
        const destination = { group: true, chat };
        const filename = path.join(f.scope.directories.groupChats, chat + '.jsonl');
        const create = { operationKey: 'long-create', sourceKind: 'storage', mode: 'create', destination,
            expectedVacancy: 0, records: f.records, backup: { deferBackup: false } };
        const backupBytes = prefix => fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith(prefix))
            .map(name => fs.readFileSync(path.join(f.scope.directories.backups, name)));
        commitSingleChatWrite(f.scope, create, roleplayBrowserHost);
        const created = fs.readFileSync(filename);
        assert.ok(backupBytes('chat_').some(bytes => bytes.equals(created)));

        const records = readChatJsonlStrict(filename).records;
        records.at(-1).mes = 'Changed long-name chat';
        commitSingleChatWrite(f.scope, { operationKey: 'long-update', mode: 'update', sourceKind: 'storage',
            source: captureRoleplayStorageSource(f.scope, destination), records, backup: { deferBackup: false } }, roleplayBrowserHost);
        const updated = fs.readFileSync(filename);
        assert.ok(backupBytes('chat_pre_write_').some(bytes => bytes.equals(created)));
        commitSingleChatWrite(f.scope, { operationKey: 'long-force', mode: 'update', sourceKind: 'storage', force: true,
            source: captureRoleplayStorageSource(f.scope, destination), records: [records[0]], backup: { deferBackup: false } }, roleplayBrowserHost);
        assert.ok(backupBytes('chat_forced_overwrite_').some(bytes => bytes.equals(updated)));
        const backups = fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_'));
        assert.ok(backups.every(name => Buffer.byteLength(name) <= 255 - 11));
        assert.equal(backups.filter(name => !name.startsWith('chat_pre_write_') && !name.startsWith('chat_forced_overwrite_')).length, 3);
    });
}

test('shortening long backup names does not merge distinct names with the same leading text', t => {
    const f = fixture(t, true);
    for (const ending of ['a', 'b']) {
        commitSingleChatWrite(f.scope, { operationKey: ending, sourceKind: 'storage', mode: 'create',
            destination: { group: true, chat: 'N'.repeat(191) + ending }, expectedVacancy: 0,
            records: f.records, backup: { deferBackup: false } }, roleplayBrowserHost);
    }
    const backups = fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_'));
    assert.equal(backups.length, 2);
    const prefixes = backups.map(name => name.replace(/_\d{8}-\d{6}_[0-9a-f-]{36}\.jsonl$/, ''));
    assert.equal(new Set(prefixes).size, 2);
});

test('recorded snapshot repair preserves the logical version and distinguishes repeated corruption', t => {
    const f = fixture(t);
    const source = captureRoleplayStorageSource(f.scope, f.locator);
    const snapshotBytes = fs.readFileSync(f.filename);
    const repairs = [];
    for (let occurrence = 0; occurrence < 2; occurrence++) {
        fs.writeFileSync(f.filename, '!same corruption');
        const damaged = readRoleplayFile(f.filename);
        const result = withRoleplayAccount(f.scope, account(f), lease => repairSingleChatWriteLocked(lease, { locator: f.locator, snapshotBytes }, roleplayNativeHost));
        repairs.push(result);
        assert.equal(result.changed, false);
        assert.equal(result.instanceId, source.instanceId);
        assert.equal(result.revision, source.revision);
        assert.deepEqual(fs.readFileSync(f.filename), snapshotBytes);
        assert.notDeepEqual(readRoleplayFile(f.filename).physical, damaged.physical);
        assert.equal(captureRoleplayStorageSource(f.scope, f.locator).instanceId, source.instanceId);
        assert.equal(fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'pending', result.writeId, 'chat.corrupt.jsonl'), 'utf8'), '!same corruption');
    }
    assert.notEqual(repairs[0].writeId, repairs[1].writeId);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 2);
});

for (const [name, alter] of [
    ['wrong snapshot', (f, input) => { input.snapshotBytes = Buffer.from('unrelated'); }],
    ['replaced inode', f => { fs.writeFileSync(f.filename + '.new', '!same corruption'); fs.renameSync(f.filename + '.new', f.filename); }],
    ['missing file', f => fs.unlinkSync(f.filename)],
    ['pending legacy journal', f => writeJournal(f)],
]) {
    test(`recorded snapshot repair refuses ${name} without publishing evidence or chat bytes`, t => {
        const f = fixture(t);
        captureRoleplayStorageSource(f.scope, f.locator);
        const input = { locator: f.locator, snapshotBytes: fs.readFileSync(f.filename) };
        fs.writeFileSync(f.filename, '!same corruption');
        alter(f, input);
        const before = readRoleplayFile(f.filename);
        const ledgerPath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
        const ledger = fs.readFileSync(ledgerPath);
        assert.throws(() => withRoleplayAccount(f.scope, account(f), lease => repairSingleChatWriteLocked(lease, input, roleplayNativeHost)));
        assert.deepEqual(readRoleplayFile(f.filename), before);
        assert.deepEqual(fs.readFileSync(ledgerPath), ledger);
        assert.equal(fs.existsSync(path.join(roleplayStoreDirectory(f.scope), 'pending')), false);
    });
}

test('explicit bootstrap reconciles saved storage work and preserves its completed receipt', t => {
    const f = fixture(t);
    const input = storageInput(f);
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...roleplayBrowserHost, publish() { throw new Error('paused'); } }), /paused/);
    const scope = bootstrapRoleplayAccount({ owner: f.scope.owner, directories: f.scope.directories }, roleplayNativeHost);
    assert.deepEqual(scope, f.scope);
    assert.equal(readRoleplayAccount(scope).pending, null);
    assert.equal(Object.keys(readRoleplayAccount(scope).submissions).length, 1);
    assert.equal(commitSingleChatWrite(scope, input, roleplayBrowserHost).rawHash, readRoleplayFile(f.filename).rawHash);
});

test('non-recovering chat reads leave a legacy journal and interrupted bytes untouched', t => {
    const f = fixture(t);
    const journal = writeJournal(f);
    fs.writeFileSync(f.filename, '!interrupted');
    const result = readChatJsonlStrict(f.filename, { recover: false });
    assert.equal(result.status, 'corrupt');
    assert.equal(fs.readFileSync(f.filename, 'utf8'), '!interrupted');
    assert.deepEqual(fs.readFileSync(journal.filename), journal.bytes);
});

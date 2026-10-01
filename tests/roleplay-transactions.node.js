/* eslint playwright/expect-expect: off -- Uses node:assert against real saved files. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fixture, memoryParent, png, writeJournal } from './roleplay-transactions-fixture.js';
import { canonical } from '../src/jobs/store.js';
import { setTimeout as delay } from 'node:timers/promises';

const { readRoleplayAccount, roleplayStoreDirectory, readRoleplayFile, withRoleplayAccountLock, roleplayLease, saveRoleplayAccount, createRoleplayDirectory,
    roleplayHash } = await import('../src/roleplay-store.js');
const { commitSingleChatWrite, reconcileSingleChatWrite, cleanupRoleplayReceipts, cleanupRoleplayReceiptsLocked } = await import('../src/roleplay-lifecycle.js');
const { FILE_WRITE_RECOVERY_MAX_BYTES } = await import('../src/util.js');
const { prepareNativeChatWrite, publishNativeChatWrite } = await import('../src/endpoints/chats.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { getChatFileLockPath } = await import('../src/chat-file-lock.js');
const { canonicalMemoryPaths } = await import('../src/mewmory/prepared-branch.js');
const { buildMemoryRecoveryGuard } = await import('../src/mewmory/store.js');
const { newState, syncSources } = await import('../src/mewmory/core.js');
const { captureRoleplaySource, captureRoleplayMessage, readRoleplayEntityLocked } = await import('../src/generation/roleplay-source.js');
const host = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite };

for (const group of [false, true]) {
    test(`${group ? 'group' : 'solo'} transaction commits exact output and preserves its receipt through later edits`, t => {
        const f = fixture(t, group);
        const input = f.input();
        const first = commitSingleChatWrite(f.scope, input, host);
        const saved = fs.readFileSync(f.filename);
        assert.equal(readRoleplayFile(f.filename).rawHash, first.rawHash);
        const state = readRoleplayAccount(f.scope);
        assert.equal(state.pending, null);
        assert.equal(state.resources[first.instanceId].revision, 2);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, host), first);
        assert.deepEqual(fs.readFileSync(f.filename), saved);
        const changed = saved.toString().split('\n').map(JSON.parse);
        changed.pop();
        changed[1].mes = 'A later manual edit';
        commitSingleChatWrite(f.scope, { operationKey: 'later-edit', mode: 'update', source: f.source(), records: changed, backup: { deferBackup: true } }, host);
        const later = fs.readFileSync(f.filename);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, host), first);
        assert.deepEqual(reconcileSingleChatWrite(f.scope, 'first', host), first);
        assert.deepEqual(fs.readFileSync(f.filename), later);
        assert.throws(() => commitSingleChatWrite(f.scope, { ...input, records: f.records }, host), { code: 'ROLEPLAY_INTENT_CONFLICT' });
    });
}

test('closed save receipts are dropped once their chat moves far enough ahead to refuse a replay', t => {
    const f = fixture(t);
    const input = f.input();
    const first = commitSingleChatWrite(f.scope, input, host);
    const firstKey = Object.keys(readRoleplayAccount(f.scope).submissions)[0];
    const edit = index => {
        const records = fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(JSON.parse);
        records[1].mes = `Later edit ${index}`;
        return commitSingleChatWrite(f.scope, { operationKey: `edit-${index}`, mode: 'update', source: f.source(), records, backup: { deferBackup: true } }, host);
    };
    for (let index = 1; index < 16; index++) edit(index);
    assert.ok(readRoleplayAccount(f.scope).submissions[firstKey]);
    assert.deepEqual(commitSingleChatWrite(f.scope, input, host), first);
    edit(16);
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.submissions[firstKey], undefined);
    assert.equal(Object.keys(state.submissions).length, 16);
    const saved = fs.readFileSync(f.filename);
    assert.throws(() => commitSingleChatWrite(f.scope, input, host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.filename), saved);
    for (let index = 17; index < 40; index++) edit(index);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 16);
});

test('transaction no-op preserves exact BOM/whitespace, inode and missing integrity', t => {
    const f = fixture(t);
    const raw = '\uFEFF' + f.records.map(row => '  ' + JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(f.filename, raw);
    const before = fs.statSync(f.filename, { bigint: true });
    let publications = 0;
    const result = commitSingleChatWrite(f.scope, { operationKey: 'no-op', mode: 'update', source: f.source(), records: f.records, backup: { deferBackup: true } }, { ...host, publish(options) {
        publications++;
        assert.equal(options.prepared.changed, false);
        assert.equal(options.deferBackup, true);
        return host.publish(options);
    } });
    assert.equal(publications, 1);
    assert.equal(result.changed, false);
    assert.equal(result.revision, 1);
    assert.equal(result.integrity, '');
    assert.equal(fs.readFileSync(f.filename, 'utf8'), raw);
    const after = fs.statSync(f.filename, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
});

function pauseBeforeWrite(f, input) {
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish() { throw new Error('Paused before publication'); } }), /Paused before publication/);
    const pending = readRoleplayAccount(f.scope).pending;
    assert.ok(pending);
    return pending;
}

function assertDamagedEvidence(f, mutate) {
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const baseline = fs.readFileSync(statePath);
    const chat = fs.readFileSync(f.filename);
    assert.throws(() => withRoleplayAccountLock(f.scope, lease => {
        mutate(roleplayLease(lease).state);
        assert.throws(() => saveRoleplayAccount(lease), { code: 'ROLEPLAY_STORE_DAMAGED' });
        assert.throws(() => roleplayLease(lease), { code: 'ROLEPLAY_STORE_DAMAGED' });
    }), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readFileSync(statePath), baseline);
    assert.deepEqual(fs.readFileSync(f.filename), chat);
    const { state } = JSON.parse(baseline);
    mutate(state);
    const malformed = JSON.stringify({ hash: roleplayHash(state), state });
    fs.writeFileSync(statePath, malformed);
    assert.throws(() => readRoleplayAccount(f.scope), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.throws(() => commitSingleChatWrite(f.scope, {}, host), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readFileSync(f.filename), chat);
    assert.equal(fs.readFileSync(statePath, 'utf8'), malformed);
    fs.writeFileSync(statePath, baseline);
}

for (const [name, finish] of [
    ['normal publication', (f, input) => commitSingleChatWrite(f.scope, input, host)],
    ['corrupt-file repair', (f, input) => {
        pauseBeforeWrite(f, input);
        fs.writeFileSync(f.filename, '!interrupted update');
        return reconcileSingleChatWrite(f.scope, input.operationKey, host);
    }],
    ['acknowledged publication', (f, input) => {
        assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
            host.publish(options);
            throw Object.assign(new Error('Acknowledgement interrupted'), { chatCommitted: true });
        } }), error => error.chatCommitted === true);
        assert.equal(readRoleplayAccount(f.scope).pending.phase, 'chat-applied');
        return reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish() { assert.fail('Acknowledged output must not be republished'); } });
    }],
]) {
    test(`admission reserves the full pending-record growth before ${name}`, t => {
        const f = fixture(t);
        const root = roleplayStoreDirectory(f.scope);
        const statePath = path.join(root, 'state.json');
        const initial = fs.readFileSync(statePath);
        const inputWithIntegrity = length => {
            fs.writeFileSync(statePath, initial);
            f.records[0].chat_metadata.integrity = 'x'.repeat(length);
            fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
            return f.input();
        };
        const pending = pauseBeforeWrite(f, inputWithIntegrity(60000));
        const physical = { dev: '9'.repeat(30), ino: '9'.repeat(30), birthtimeNs: '9'.repeat(30) };
        const progressed = { ...pending, phase: 'chat-applied', appliedPhysical: physical,
            repair: { rawHash: pending.after.rawHash, physical },
            journal: { rawHash: 'f'.repeat(64), physical, originalHash: pending.before.rawHash, nextHash: 'f'.repeat(64) } };
        const maximum = 65536 - (Buffer.byteLength(canonical(progressed)) - 60000);
        assert.ok(maximum > 60000);
        const tooLarge = inputWithIntegrity(maximum + 1);
        const before = fs.readFileSync(f.filename);
        const ledger = fs.readFileSync(statePath);
        const staged = fs.readdirSync(path.join(root, 'pending')).sort();
        assert.throws(() => commitSingleChatWrite(f.scope, tooLarge, host), { code: 'ROLEPLAY_STORE_FULL' });
        assert.deepEqual(fs.readFileSync(statePath), ledger);
        assert.deepEqual(fs.readFileSync(f.filename), before);
        assert.deepEqual(fs.readdirSync(path.join(root, 'pending')).sort(), staged);
        const result = finish(f, inputWithIntegrity(maximum));
        assert.equal(result.changed, true);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.equal(result.rawHash, readRoleplayFile(f.filename).rawHash);
        assert.deepEqual(readRoleplayAccount(f.scope).resources[result.instanceId].head.physical, readRoleplayFile(f.filename).physical);
    });
}

test('an unchanged closing save finishes the deferred backup without rewriting the chat', t => {
    const f = fixture(t, false, 'closing-backup');
    const backup = { deferBackup: true, deferSequenceId: 'sequence' };
    commitSingleChatWrite(f.scope, { ...f.input(), backup }, host);
    const regular = () => fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_'));
    assert.equal(regular().length, 0);
    const bytes = fs.readFileSync(f.filename);
    const stat = fs.statSync(f.filename, { bigint: true });
    const records = bytes.toString().split('\n').map(JSON.parse);
    const input = { operationKey: 'close-sequence', mode: 'update', source: f.source(), records, backup: { ...backup, deferBackup: false } };
    const result = commitSingleChatWrite(f.scope, input, host);
    assert.equal(result.changed, false);
    assert.equal(regular().length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.backups, regular()[0])), bytes);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.equal(fs.statSync(f.filename, { bigint: true }).ino, stat.ino);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, stat.mtimeNs);
    assert.deepEqual(commitSingleChatWrite(f.scope, input, { ...host, publish() { assert.fail('Closed receipt must not publish'); } }), result);
    commitSingleChatWrite(f.scope, { ...input, operationKey: 'next-sequence', source: f.source(), backup,
        records: [...records, { name: 'Nova', is_user: false, mes: 'A new run' }] }, host);
    assert.equal(fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_pre_write_nova_')).length, 2);
});

test('an unacknowledged unchanged save retries backup finalisation without duplicate backups', async t => {
    const f = fixture(t, false, 'retry-closing-backup');
    const input = { ...f.input(), records: f.records, backup: { deferBackup: false } };
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
        host.publish(options);
        throw new Error('Backup acknowledgement lost');
    } }), /Backup acknowledgement lost/);
    assert.equal(readRoleplayAccount(f.scope).pending.phase, 'prepared');
    const bytes = fs.readFileSync(f.filename);
    const stat = fs.statSync(f.filename, { bigint: true });
    const result = reconcileSingleChatWrite(f.scope, input.operationKey, host);
    assert.equal(result.changed, false);
    // Let the existing writer's ten-second trailing backup run before removing the fixture.
    await delay(10500);
    assert.equal(fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_')).length, 1);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, stat.mtimeNs);
});

test('an acknowledged unchanged save needs neither publication nor its temporary payload', t => {
    const f = fixture(t);
    const input = { ...f.input(), records: f.records };
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
        host.publish(options);
        throw Object.assign(new Error('No-op acknowledgement interrupted'), { chatCommitted: true });
    } }), error => error.chatCommitted === true);
    const pending = readRoleplayAccount(f.scope).pending;
    assert.equal(pending.phase, 'chat-applied');
    fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl'));
    assert.equal(reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish() { assert.fail('Acknowledged no-op must not publish'); } }).changed, false);
});

for (const [name, change, code] of [
    ['changed card', f => fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'Changed' }))), 'ROLEPLAY_SOURCE_CHANGED'],
    ['changed chat', f => fs.writeFileSync(f.filename, JSON.stringify({ chat_metadata: {}, manual: true })), 'ROLEPLAY_SOURCE_CHANGED'],
    ['missing chat', f => fs.unlinkSync(f.filename), 'ROLEPLAY_SOURCE_CHANGED'],
    ['missing payload', (f, pending) => fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl')), 'ROLEPLAY_STORE_DAMAGED'],
]) {
    test(`an unacknowledged unchanged save retains ${name} evidence`, t => {
        const f = fixture(t);
        const pending = pauseBeforeWrite(f, { ...f.input(), records: f.records });
        change(f, pending);
        const file = readRoleplayFile(f.filename);
        const evidence = readRoleplayAccount(f.scope);
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code });
        assert.deepEqual(readRoleplayFile(f.filename), file);
        assert.deepEqual(readRoleplayAccount(f.scope), evidence);
    });
}

for (const [name, mutate] of [
    ['backup option override', state => { state.pending.backup.allowShrink = true; }],
    ['missing owning dependency', state => { state.pending.source.dependencies = []; }],
    ['duplicate dependency', state => { state.pending.source.dependencies.push(structuredClone(state.pending.source.dependencies[0])); }],
    ['foreign target account', state => { state.resources[state.pending.instanceId].accountId = '00000000-0000-4000-8000-000000000000'; }],
    ['foreign target epoch', state => { state.resources[state.pending.instanceId].dataEpoch++; }],
    ['foreign dependency epoch', state => { state.resources[state.pending.source.dependencies[0].instanceId].dataEpoch++; }],
    ['missing current target path', state => { delete state.paths[roleplayHash([state.accountId, state.dataEpoch, 'chat', state.pending.locator])]; }],
    ['missing current dependency path', state => {
        const dependency = state.pending.source.dependencies[0];
        delete state.paths[roleplayHash([state.accountId, state.dataEpoch, dependency.kind, dependency.locator])];
    }],
    ['false unchanged result', state => {
        state.pending.changed = false;
        state.pending.after.revision = state.pending.before.revision;
        state.pending.after.writeId = state.pending.before.writeId;
    }],
]) {
    test(`protected pending evidence rejects ${name} on save and checksum-valid reload`, t => {
        const f = fixture(t);
        pauseBeforeWrite(f, f.input());
        assertDamagedEvidence(f, mutate);
    });
}

test('a solo pending dependency cannot be replaced by an unrelated recorded character', t => {
    const f = fixture(t);
    const other = path.join(f.scope.directories.characters, 'Other.png');
    fs.writeFileSync(other, writeCard(png, JSON.stringify({ name: 'Other', description: 'Unrelated' })));
    let dependency;
    withRoleplayAccountLock(f.scope, lease => {
        const { kind, instanceId, revision, contentHash, locator } = readRoleplayEntityLocked(lease, 'character', 'Other.png');
        dependency = { kind, instanceId, revision, contentHash, locator };
        saveRoleplayAccount(lease);
    });
    pauseBeforeWrite(f, f.input());
    assertDamagedEvidence(f, state => { state.pending.source.dependencies = [dependency]; });
});

for (const [name, mutate] of [
    ['result instance', receipt => { Object.values(receipt.effects)[0].result.instanceId = '00000000-0000-4000-8000-000000000000'; }],
    ['result revision', receipt => { Object.values(receipt.effects)[0].result.revision++; }],
    ['result checksum', receipt => { Object.values(receipt.effects)[0].result.rawHash = 'a'.repeat(64); }],
    ['effect write identity', receipt => { Object.values(receipt.effects)[0].writeId = '00000000-0000-4000-8000-000000000000'; }],
    ['effect intent', receipt => { Object.values(receipt.effects)[0].effectHash = 'a'.repeat(64); }],
    ['submission account', receipt => { receipt.accountId = '00000000-0000-4000-8000-000000000000'; }],
    ['submission epoch', receipt => { receipt.dataEpoch++; }],
    ['enclosing outcome', receipt => { receipt.outcome.changed = !receipt.outcome.changed; }],
]) {
    test(`a completed receipt refuses a disconnected ${name}`, t => {
        const f = fixture(t);
        commitSingleChatWrite(f.scope, f.input(), host);
        assertDamagedEvidence(f, state => { mutate(Object.values(state.submissions)[0]); });
    });
}

test('legacy integrity and string swipe selections keep their exact captured representation', t => {
    const f = fixture(t);
    f.records[0].chat_metadata.integrity = 'x'.repeat(65);
    f.records[2].swipe_id = '0';
    const bytes = f.records.map(row => JSON.stringify(row)).join('\n');
    fs.writeFileSync(f.filename, bytes);
    const stat = fs.statSync(f.filename, { bigint: true });
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 1 });
    assert.equal(source.message.selectedSwipeId, '0');
    assert.equal(source.message.selectedSwipeHash, roleplayHash('Answer'));
    const unchanged = commitSingleChatWrite(f.scope, { operationKey: 'legacy-noop', mode: 'update', source,
        records: f.records, backup: { deferBackup: true } }, host);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.integrity, f.records[0].chat_metadata.integrity);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), bytes);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, stat.mtimeNs);
    const updated = commitSingleChatWrite(f.scope, { ...f.input(), source }, host);
    assert.equal(updated.changed, true);
    assert.equal(updated.revision, 2);
    assert.equal(fs.statSync(f.filename, { bigint: true }).ino, stat.ino);
    assert.throws(() => captureRoleplayMessage([f.records[0], { ...f.records[2], swipe_id: {} }], 0), { code: 'ROLEPLAY_INVALID' });
});

for (const [name, change] of [
    ['traversal', locator => { locator.chat = '../Other'; }],
    ['another character', locator => { locator.avatar = 'Other.png'; }],
    ['the child itself', locator => { locator.chat = 'Source'; }],
    ['a different chat kind', locator => { locator.group = true; delete locator.avatar; }],
]) {
    test(`a prepared memory parent cannot name ${name}`, t => {
        const f = fixture(t);
        memoryParent(f);
        const input = f.input();
        input.records[0].chat_metadata.main_chat = 'Parent';
        pauseBeforeWrite(f, input);
        assertDamagedEvidence(f, state => { change(state.pending.memory.parentLocator); });
    });
}

test('pending records accept exactly 65536 canonical bytes and refuse 65537 before publication', t => {
    const f = fixture(t);
    pauseBeforeWrite(f, f.input());
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const baseline = fs.readFileSync(statePath);
    const pad = (state, size) => {
        state.pending.before.integrity = '';
        state.pending.before.integrity = 'x'.repeat(size - Buffer.byteLength(canonical(state.pending)));
        assert.equal(Buffer.byteLength(canonical(state.pending)), size);
    };
    for (const size of [65535, 65536]) {
        withRoleplayAccountLock(f.scope, lease => {
            pad(roleplayLease(lease).state, size);
            saveRoleplayAccount(lease);
        });
        assert.equal(Buffer.byteLength(canonical(readRoleplayAccount(f.scope).pending)), size);
        fs.writeFileSync(statePath, baseline);
    }
    assertDamagedEvidence(f, state => { pad(state, 65537); });
});

for (const [name, prepareChat] of [['still unchanged', () => {}], ['corrupt', filename => fs.writeFileSync(filename, '!interrupted update')]]) {
    test(`a ${name} group write refuses missing member dependencies without enrolment`, t => {
        const f = fixture(t, true);
        fs.writeFileSync(path.join(f.scope.directories.characters, 'Mira.png'), writeCard(png, JSON.stringify({ name: 'Mira', description: 'Member' })));
        fs.writeFileSync(path.join(f.scope.directories.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png', 'Mira.png'], chats: ['Source'] }));
        const pending = pauseBeforeWrite(f, f.input());
        assert.equal(pending.source.dependencies.length, 3);
        withRoleplayAccountLock(f.scope, lease => {
            const { state } = roleplayLease(lease);
            state.pending.source.dependencies = state.pending.source.dependencies.filter(item => item.locator.avatar !== 'Mira.png');
            saveRoleplayAccount(lease);
        });
        prepareChat(f.filename);
        const before = fs.readFileSync(f.filename);
        const evidence = readRoleplayAccount(f.scope);
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.deepEqual(fs.readFileSync(f.filename), before);
        assert.deepEqual(readRoleplayAccount(f.scope), evidence);
    });
}

test('corrupt-chat repair still refuses a changed prepared memory parent', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    pauseBeforeWrite(f, input);
    fs.writeFileSync(f.filename, '!interrupted update');
    parent.state.revision++;
    fs.writeFileSync(parent.paths.archive, JSON.stringify(parent.state));
    fs.writeFileSync(parent.paths.guard, JSON.stringify(buildMemoryRecoveryGuard(parent.state)));
    const before = fs.readFileSync(f.filename);
    const evidence = readRoleplayAccount(f.scope);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.deepEqual(readRoleplayAccount(f.scope), evidence);
});

test('a complete group dependency list publishes once and a receipt survives later deletion', t => {
    const f = fixture(t, true);
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Mira.png'), writeCard(png, JSON.stringify({ name: 'Mira', description: 'Member' })));
    fs.writeFileSync(path.join(f.scope.directories.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png', 'Mira.png'], chats: ['Source'] }));
    const input = f.input();
    assert.equal(input.source.dependencies.length, 3);
    const result = commitSingleChatWrite(f.scope, input, host);
    const receipt = Object.values(readRoleplayAccount(f.scope).submissions)[0];
    assert.deepEqual(Object.values(receipt.effects)[0].result, receipt.outcome);
    assert.equal(Object.values(receipt.effects)[0].writeId, result.writeId);
    fs.unlinkSync(f.filename);
    assert.deepEqual(commitSingleChatWrite(f.scope, input, host), result);
    assert.deepEqual(reconcileSingleChatWrite(f.scope, 'first', host), result);
    assert.equal(fs.existsSync(f.filename), false);
});

test('known completed output does not recheck dependencies that changed after publication', t => {
    const f = fixture(t);
    assert.throws(() => commitSingleChatWrite(f.scope, f.input(), { ...host, publish(options) {
        host.publish(options);
        throw new Error('Lost publication acknowledgement');
    } }), /Lost publication acknowledgement/);
    const before = fs.readFileSync(f.filename);
    fs.unlinkSync(path.join(f.scope.directories.characters, 'Nova.png'));
    const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { assert.fail('Output already exists'); } });
    assert.equal(result.rawHash, readRoleplayFile(f.filename).rawHash);
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('group source evidence must name the one recorded owning group', t => {
    const f = fixture(t, true);
    pauseBeforeWrite(f, f.input());
    assertDamagedEvidence(f, state => { state.pending.source.groupId = 'other'; });
});

test('a pending create requires a fresh instance and the exact recorded vacancy', t => {
    const f = fixture(t);
    const source = f.source();
    pauseBeforeWrite(f, { operationKey: 'first', mode: 'create', destination: { ...f.locator, chat: 'New' }, expectedVacancy: 0,
        records: f.records, backup: { deferBackup: true } });
    assertDamagedEvidence(f, state => { state.pending.instanceId = source.instanceId; });
    assertDamagedEvidence(f, state => { state.pending.expectedVacancy++; });
    assert.equal(fs.existsSync(path.join(path.dirname(f.filename), 'New.jsonl')), false);
});

for (const state of ['preparing', 'accepted', 'void']) {
    test(`a ${state} submission is not replayed as a completed chat write`, t => {
        const f = fixture(t);
        const input = f.input();
        commitSingleChatWrite(f.scope, input, host);
        withRoleplayAccountLock(f.scope, lease => {
            const receipt = Object.values(roleplayLease(lease).state.submissions)[0];
            receipt.state = state;
            receipt.effects = {};
            delete receipt.outcome;
            saveRoleplayAccount(lease);
        });
        const before = fs.readFileSync(f.filename);
        const evidence = readRoleplayAccount(f.scope);
        assert.throws(() => commitSingleChatWrite(f.scope, input, host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
        assert.deepEqual(fs.readFileSync(f.filename), before);
        assert.deepEqual(readRoleplayAccount(f.scope), evidence);
    });
}

test('branch memory uses the frozen identity after guard-only interruption and later parent changes', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', function (filename, flags, ...args) {
        if (filename === child.archive && flags === 'wx') throw Object.assign(new Error('Archive publication paused'), { code: 'EIO' });
        return open.call(this, filename, flags, ...args);
    });
    assert.throws(() => commitSingleChatWrite(f.scope, input, host), error => error.chatCommitted === true);
    t.mock.restoreAll();
    const pending = readRoleplayAccount(f.scope).pending;
    const guard = fs.readFileSync(child.guard);
    assert.equal(JSON.parse(guard).branchId, pending.memory.branchId);
    assert.equal(fs.existsSync(child.archive), false);
    parent.state.revision++;
    fs.writeFileSync(parent.paths.archive, JSON.stringify(parent.state));
    fs.writeFileSync(parent.paths.guard, JSON.stringify(buildMemoryRecoveryGuard(parent.state)));
    const before = fs.readFileSync(f.filename);
    reconcileSingleChatWrite(f.scope, input.operationKey, host);
    const saved = JSON.parse(fs.readFileSync(child.archive));
    assert.equal(saved.branchId, pending.memory.branchId);
    assert.equal(saved.storyId, parent.state.storyId);
    assert.deepEqual(fs.readFileSync(child.guard), guard);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('no-op chat can complete required memory capture without changing chat bytes', t => {
    const f = fixture(t);
    memoryParent(f);
    f.records[0].chat_metadata.main_chat = 'Parent';
    const bytes = '\uFEFF' + f.records.map(row => JSON.stringify(row)).join('\n');
    fs.writeFileSync(f.filename, bytes);
    const before = fs.statSync(f.filename, { bigint: true });
    const result = commitSingleChatWrite(f.scope, { ...f.input(), records: f.records }, host);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), bytes);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, before.mtimeNs);
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    assert.ok(JSON.parse(fs.readFileSync(child.archive)).branchId);
});

test('pre-existing incomplete memory and changed parent block chat publication', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    fs.writeFileSync(child.guard, '{}');
    const before = fs.readFileSync(f.filename);
    assert.throws(() => commitSingleChatWrite(f.scope, input, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    fs.unlinkSync(child.guard);
    pauseBeforeWrite(f, input);
    parent.state.revision++;
    fs.writeFileSync(parent.paths.archive, JSON.stringify(parent.state));
    fs.writeFileSync(parent.paths.guard, JSON.stringify(buildMemoryRecoveryGuard(parent.state)));
    assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('exact jsonl basenames select the correct parent memory without suffix normalisation', t => {
    const f = fixture(t);
    const wrong = memoryParent(f, 'Parent');
    const right = memoryParent(f, 'Parent.jsonl');
    assert.notEqual(wrong.paths.archive, right.paths.archive);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent.jsonl';
    commitSingleChatWrite(f.scope, input, host);
    const child = JSON.parse(fs.readFileSync(canonicalMemoryPaths(f.scope.directories, f.locator).archive));
    assert.equal(child.storyId, right.state.storyId);
    assert.notEqual(child.storyId, wrong.state.storyId);
    assert.equal(child.parent.locator.chat, 'Parent.jsonl');
});

test('numeric parent ids inherit memory and unusable parent names save without it', t => {
    const f = fixture(t);
    const parent = memoryParent(f, '1687345678901');
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 1687345678901;
    commitSingleChatWrite(f.scope, input, host);
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    assert.equal(JSON.parse(fs.readFileSync(child.archive)).storyId, parent.state.storyId);
    for (const [index, main_chat] of ['Nova: Branch', 'Trailing dot.', 'x'.repeat(300), '..', ['list'], { nested: true }, true].entries()) {
        const g = fixture(t, false, `unusable-${index}`);
        const saved = g.input();
        saved.records[0].chat_metadata.main_chat = main_chat;
        commitSingleChatWrite(g.scope, saved, host);
        assert.equal(fs.existsSync(canonicalMemoryPaths(g.scope.directories, g.locator).archive), false);
        assert.equal(readRoleplayAccount(g.scope).pending, null);
    }
    // A zero parent id still means 'no parent', as before, even when a chat named '0' has memory.
    const zero = fixture(t, false, 'zero-parent');
    memoryParent(zero, '0');
    const unset = zero.input();
    unset.records[0].chat_metadata.main_chat = 0;
    commitSingleChatWrite(zero.scope, unset, host);
    assert.equal(fs.existsSync(canonicalMemoryPaths(zero.scope.directories, zero.locator).archive), false);
});

test('a different child memory is retained when a pending capture resumes', t => {
    const f = fixture(t);
    memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    pauseBeforeWrite(f, input);
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    const other = syncSources(newState(child.locator), f.records.slice(1), []);
    fs.writeFileSync(child.archive, JSON.stringify(other));
    fs.writeFileSync(child.guard, JSON.stringify(buildMemoryRecoveryGuard(other)));
    const before = fs.readFileSync(child.archive);
    assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
    assert.deepEqual(fs.readFileSync(child.archive), before);
});

for (const kind of ['pair', 'archive', 'guard']) {
    for (const branch of [true, false]) {
        test(`fresh ${branch ? 'branch' : 'plain'} create refuses orphaned ${kind} memory`, t => {
            const f = fixture(t);
            memoryParent(f);
            const orphan = memoryParent(f, 'New');
            const destination = path.join(path.dirname(f.filename), 'New.jsonl');
            fs.unlinkSync(destination);
            if (kind === 'archive') fs.unlinkSync(orphan.paths.guard);
            if (kind === 'guard') fs.unlinkSync(orphan.paths.archive);
            const before = Object.fromEntries([orphan.paths.archive, orphan.paths.guard].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
            const records = structuredClone(f.records);
            if (branch) records[0].chat_metadata.main_chat = 'Parent';
            assert.throws(() => commitSingleChatWrite(f.scope, { operationKey: 'create-orphan', mode: 'create', destination: { ...f.locator, chat: 'New' },
                expectedVacancy: 0, records, backup: { deferBackup: true } }, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
            assert.equal(fs.existsSync(destination), false);
            assert.equal(readRoleplayAccount(f.scope).pending, null);
            assert.equal(fs.existsSync(path.join(roleplayStoreDirectory(f.scope), 'pending')), false);
            for (const [file, bytes] of Object.entries(before)) assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, bytes);
        });
    }
}

test('a create with no memory plan refuses an orphan appearing after preparation', t => {
    const f = fixture(t);
    const input = { operationKey: 'late-orphan', mode: 'create', destination: { ...f.locator, chat: 'New' }, expectedVacancy: 0,
        records: f.records, backup: { deferBackup: true } };
    pauseBeforeWrite(f, input);
    const orphan = memoryParent(f, 'New');
    const destination = path.join(path.dirname(f.filename), 'New.jsonl');
    fs.unlinkSync(destination);
    assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
    assert.equal(fs.existsSync(destination), false);
    assert.equal(JSON.parse(fs.readFileSync(orphan.paths.archive)).storyId, orphan.state.storyId);
});

for (const archiveOnly of [false, true]) {
    test(`retained ${archiveOnly ? 'archive-only' : 'paired'} child does not read its damaged parent`, t => {
        const f = fixture(t);
        const parent = memoryParent(f);
        const existing = memoryParent(f, 'Source');
        if (archiveOnly) fs.unlinkSync(existing.paths.guard);
        const input = f.input();
        input.records[0].chat_metadata.main_chat = 'Parent';
        fs.writeFileSync(parent.paths.guard, '{damaged');
        const open = fs.openSync;
        t.mock.method(fs, 'openSync', function (filename, ...args) {
            if ([parent.paths.guard, parent.paths.archive].includes(filename)) assert.fail('Retained child must not read its former parent');
            return open.call(this, filename, ...args);
        });
        const pending = pauseBeforeWrite(f, input);
        assert.equal(pending.memory.kind, 'existing');
        if (archiveOnly) assert.equal(pending.memory.child.guard, null);
        const bytes = fs.readFileSync(existing.paths.archive);
        reconcileSingleChatWrite(f.scope, input.operationKey, host);
        assert.deepEqual(fs.readFileSync(existing.paths.archive), bytes);
        assert.equal(fs.existsSync(existing.paths.guard), !archiveOnly);
    });
}

test('archive-only parent capture records absent guard and preserves non-UUID legacy identities', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    parent.state.storyId = 'legacy-story'; parent.state.branchId = 'legacy-branch';
    fs.writeFileSync(parent.paths.archive, JSON.stringify(parent.state));
    fs.unlinkSync(parent.paths.guard);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    const pending = pauseBeforeWrite(f, input);
    assert.equal(pending.memory.parent.guard, null);
    reconcileSingleChatWrite(f.scope, input.operationKey, host);
    const child = JSON.parse(fs.readFileSync(canonicalMemoryPaths(f.scope.directories, f.locator).archive));
    assert.equal(child.storyId, 'legacy-story');
    assert.equal(child.parent.branchId, 'legacy-branch');
    assert.equal(fs.existsSync(parent.paths.guard), false);
});

test('malformed story and branch identities refuse capture even with a matching guard', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    for (const key of ['storyId', 'branchId']) {
        for (const value of [undefined, null, {}, '', '   ']) {
            const invalid = { ...parent.state, [key]: value };
            fs.writeFileSync(parent.paths.archive, JSON.stringify(invalid));
            fs.writeFileSync(parent.paths.guard, JSON.stringify(buildMemoryRecoveryGuard(invalid)));
            assert.throws(() => commitSingleChatWrite(f.scope, input, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
            fs.unlinkSync(parent.paths.guard);
            assert.throws(() => commitSingleChatWrite(f.scope, input, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
        }
    }
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('an observed absent memory guard is not a wildcard when pending work resumes', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    fs.unlinkSync(parent.paths.guard);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    pauseBeforeWrite(f, input);
    fs.writeFileSync(parent.paths.guard, JSON.stringify(buildMemoryRecoveryGuard(parent.state)));
    const before = fs.readFileSync(f.filename);
    assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, host), { code: 'ROLEPLAY_MEMORY_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('memory unlock failure attempts all releases and leaves a reconcilable frozen pair', t => {
    const f = fixture(t);
    const parent = memoryParent(f);
    const input = f.input(); input.records[0].chat_metadata.main_chat = 'Parent';
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    const graceful = createRequire(new URL('../src/chat-file-lock.js', import.meta.url))('graceful-fs');
    const remove = graceful.rmdirSync;
    let injected = false;
    const released = [];
    t.mock.method(graceful, 'rmdirSync', function (filename, ...args) {
        const result = remove.call(this, filename, ...args);
        if (fs.existsSync(child.archive)) {
            released.push(filename);
            if (!injected) { injected = true; throw new Error('Memory unlock failed'); }
        }
        return result;
    });
    assert.throws(() => commitSingleChatWrite(f.scope, input, host), error => error.chatCommitted === true);
    t.mock.restoreAll();
    assert.equal(injected, true);
    assert.ok(released.includes(getChatFileLockPath(child.archive)));
    assert.ok(released.includes(getChatFileLockPath(parent.paths.archive)));
    const memory = fs.readFileSync(child.archive);
    reconcileSingleChatWrite(f.scope, input.operationKey, host);
    assert.deepEqual(fs.readFileSync(child.archive), memory);
});

test('pending transaction retries frozen output rather than preparing a replacement', t => {
    const f = fixture(t);
    const input = f.input();
    const pending = pauseBeforeWrite(f, input);
    const result = commitSingleChatWrite(f.scope, input, { ...host, prepare() { assert.fail('Preparation must not repeat'); } });
    assert.equal(result.rawHash, pending.after.rawHash);
    assert.equal(result.integrity, pending.after.integrity);
    assert.equal(readRoleplayFile(f.filename).rawHash, pending.after.rawHash);
});

test('a pending write refuses changed intent, another operation and a changed dependency', t => {
    const f = fixture(t);
    const input = f.input();
    pauseBeforeWrite(f, input);
    const before = fs.readFileSync(f.filename);
    assert.throws(() => commitSingleChatWrite(f.scope, { ...input, operationKey: 'different' }, host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.throws(() => commitSingleChatWrite(f.scope, { ...input, records: f.records }, host), { code: 'ROLEPLAY_INTENT_CONFLICT' });
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'Edited' })));
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

for (const phase of ['pending', 'receipt']) {
    test(`retry confirms an uncertain ${phase} ledger before writing or acknowledging`, t => {
        const f = fixture(t);
        const input = f.input();
        const root = roleplayStoreDirectory(f.scope);
        const inode = fs.statSync(root).ino;
        const fsync = fs.fsyncSync;
        let failures = 0;
        const mock = t.mock.method(fs, 'fsyncSync', fd => {
            if (fs.fstatSync(fd).ino === inode) {
                const { state } = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
                if ((phase === 'pending' && state.pending) || (phase === 'receipt' && Object.keys(state.submissions).length)) {
                    failures++;
                    throw Object.assign(new Error('Ledger directory flush failed'), { code: 'EIO' });
                }
            }
            return fsync(fd);
        });
        assert.throws(() => commitSingleChatWrite(f.scope, input, host));
        const bytes = fs.readFileSync(f.filename);
        const attempts = failures;
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host));
        assert.throws(() => commitSingleChatWrite(f.scope, input, host));
        assert.equal(failures, attempts + 2);
        assert.deepEqual(fs.readFileSync(f.filename), bytes);
        mock.mock.restore();
        const result = reconcileSingleChatWrite(f.scope, 'first', host);
        assert.equal(result.rawHash, readRoleplayFile(f.filename).rawHash);
    });
}

test('malformed pending source, anchors and bindings are refused without touching the chat', t => {
    const f = fixture(t);
    const input = f.input();
    pauseBeforeWrite(f, input);
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const baseline = fs.readFileSync(statePath);
    const chat = fs.readFileSync(f.filename);
    const digest = 'a'.repeat(64);
    const cases = [
        ['source account mismatch', pending => { pending.source.accountId = '00000000-0000-4000-8000-000000000000'; }],
        ['source locator mismatch', pending => { pending.source.locator = { ...pending.locator, chat: 'Other' }; }],
        ['dependency locator traversal', pending => { pending.source.dependencies[0].locator = { avatar: '../Nova.png' }; }],
        ['dependency unknown resource', pending => { pending.source.dependencies[0].instanceId = '00000000-0000-4000-8000-000000000000'; }],
        ['message anchor malformed', pending => {
            pending.source.message = { index: 0, recordHash: 'bad', selectedSwipeId: null, selectedSwipeHash: digest, selectedSwipeInfoHash: digest };
        }],
        ['before binding changed', pending => { pending.before.rawHash = digest; }],
        ['after revision unbound', pending => { pending.after.revision = pending.before.revision + 5; }],
        ['before physical malformed', pending => { pending.before.physical = { dev: '1' }; }],
        ['oversized pending', pending => { pending.source.dependencies = Array(600).fill(pending.source.dependencies[0]); }],
    ];
    for (const [name, mutate] of cases) {
        assert.throws(() => withRoleplayAccountLock(f.scope, lease => {
            mutate(roleplayLease(lease).state.pending);
            saveRoleplayAccount(lease);
        }), { code: 'ROLEPLAY_STORE_DAMAGED' }, `${name} must not save`);
        assert.deepEqual(fs.readFileSync(statePath), baseline, `${name} must leave the ledger untouched`);
        assert.deepEqual(fs.readFileSync(f.filename), chat, `${name} must leave the chat untouched`);
        const malformed = JSON.parse(baseline.toString());
        mutate(malformed.state.pending);
        fs.writeFileSync(statePath, JSON.stringify({ hash: roleplayHash(malformed.state), state: malformed.state }));
        assert.throws(() => readRoleplayAccount(f.scope), { code: 'ROLEPLAY_STORE_DAMAGED' }, `${name} must not load`);
        fs.writeFileSync(statePath, baseline);
    }
});

test('a committed lock-cleanup error records applied progress before retry', t => {
    const f = fixture(t);
    const input = f.input();
    const before = fs.readFileSync(f.filename);
    const gracefulFs = createRequire(new URL('../src/chat-file-lock.js', import.meta.url))('graceful-fs');
    const rmdir = gracefulFs.rmdirSync;
    let injected = false;
    const mock = t.mock.method(gracefulFs, 'rmdirSync', (filename, ...args) => {
        const result = rmdir(filename, ...args);
        if (!injected && filename === getChatFileLockPath(f.filename) && fs.readFileSync(f.filename).includes(Buffer.from('New result'))) {
            injected = true;
            throw Object.assign(new Error('Chat lock cleanup failed'), { code: 'EIO' });
        }
        return result;
    });
    assert.throws(() => commitSingleChatWrite(f.scope, input, host), error => error.chatCommitted === true);
    assert.equal(injected, true);
    mock.mock.restore();
    assert.equal(readRoleplayAccount(f.scope).pending.phase, 'chat-applied');
    fs.writeFileSync(f.filename, before);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('retry confirms an existing destination directory left by a failed parent flush', t => {
    const f = fixture(t);
    fs.unlinkSync(f.filename);
    const folder = path.dirname(f.filename);
    fs.rmdirSync(folder);
    const input = { operationKey: 'new-directory', mode: 'create', destination: f.locator, expectedVacancy: 0, records: f.records, backup: { deferBackup: true } };
    const inode = fs.statSync(f.scope.directories.chats).ino;
    const fsync = fs.fsyncSync;
    let failures = 0;
    const mock = t.mock.method(fs, 'fsyncSync', fd => {
        if (fs.fstatSync(fd).ino === inode && fs.existsSync(folder)) {
            failures++;
            throw Object.assign(new Error('Chat parent flush failed'), { code: 'EIO' });
        }
        return fsync(fd);
    });
    assert.throws(() => commitSingleChatWrite(f.scope, input, host), /Chat parent flush failed/);
    assert.equal(fs.existsSync(folder), true);
    const attempts = failures;
    assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, host), /Chat parent flush failed/);
    assert.equal(failures, attempts + 1);
    assert.equal(fs.existsSync(f.filename), false);
    mock.mock.restore();
    assert.equal(reconcileSingleChatWrite(f.scope, input.operationKey, host).rawHash, readRoleplayFile(f.filename).rawHash);
});

test('pending group publication rechecks competing ownership without enrolling the competitor', t => {
    const f = fixture(t, true);
    pauseBeforeWrite(f, f.input());
    const before = fs.readFileSync(f.filename);
    const resourceCount = Object.keys(readRoleplayAccount(f.scope).resources).length;
    fs.writeFileSync(path.join(f.scope.directories.groups, 'other.json'), JSON.stringify({ id: 'other', members: ['Nova.png'], chats: ['Source'] }));
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_GROUP_AMBIGUOUS' });
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, resourceCount);
});

test('transaction directory confirmation does not open ancestors above owned storage', t => {
    const f = fixture(t);
    const input = f.input();
    const open = fs.openSync;
    const ancestors = new Set();
    for (let ancestor = f.root; ; ancestor = path.dirname(ancestor)) {
        ancestors.add(ancestor);
        if (path.dirname(ancestor) === ancestor) break;
    }
    const mock = t.mock.method(fs, 'openSync', (filename, ...args) => {
        if (ancestors.has(String(filename))) throw Object.assign(new Error('Traversal-only ancestor'), { code: 'EACCES' });
        return open(filename, ...args);
    });
    const result = commitSingleChatWrite(f.scope, input, host);
    assert.equal(readRoleplayFile(f.filename).rawHash, result.rawHash);
    mock.mock.restore();
});

test('owned directory creation refuses parent traversal before creating an outside entry', t => {
    const f = fixture(t);
    const outside = path.join(f.root, 'outside');
    const owned = f.scope.directories.root;
    assert.throws(() => createRoleplayDirectory(owned + '/../outside', owned), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(fs.existsSync(outside), false);
});

test('known completed output finalises without a second write or its temporary payload', t => {
    const f = fixture(t);
    const input = f.input();
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
        host.publish(options);
        throw new Error('Lost publication acknowledgement');
    } }), /Lost publication acknowledgement/);
    const pending = readRoleplayAccount(f.scope).pending;
    const before = fs.statSync(f.filename, { bigint: true });
    fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl'));
    const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { assert.fail('Known output must not be republished'); } });
    assert.equal(result.rawHash, pending.after.rawHash);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, before.mtimeNs);
});

for (const changed of [true, false]) {
    test(`same-file corrupt ${changed ? 'changed' : 'unchanged'} save completes its backup through a no-op writer`, t => {
        const f = fixture(t, false, `repair-backup-${changed}`);
        const input = { ...f.input(), ...(!changed ? { records: f.records } : {}), backup: { deferBackup: false } };
        const pending = pauseBeforeWrite(f, input);
        fs.writeFileSync(f.filename, '!corrupt during write');
        const corrupt = readRoleplayFile(f.filename);
        let publications = 0;
        const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
            publications++;
            assert.equal(options.payloadPath, null);
            assert.equal(options.prepared.changed, false);
            const before = readRoleplayFile(f.filename);
            const stat = fs.statSync(f.filename, { bigint: true });
            const published = host.publish(options);
            assert.deepEqual(readRoleplayFile(f.filename), before);
            assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, stat.mtimeNs);
            return published;
        } });
        assert.equal(publications, 1);
        assert.equal(result.changed, changed);
        assert.equal(result.revision, pending.after.revision);
        assert.equal(result.rawHash, pending.after.rawHash);
        assert.notDeepEqual(readRoleplayFile(f.filename).physical, corrupt.physical);
        assert.deepEqual(readRoleplayAccount(f.scope).resources[result.instanceId].head.physical, readRoleplayFile(f.filename).physical);
        assert.deepEqual(fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.corrupt.jsonl')), corrupt.bytes);
        const backups = fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_'));
        assert.equal(backups.length, 1);
        assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.backups, backups[0])), readRoleplayFile(f.filename).bytes);
        assert.equal(f.source().rawHash, result.rawHash);
    });
}

function pauseAfterRestore(t, f) {
    pauseBeforeWrite(f, { ...f.input(), records: f.records });
    fs.writeFileSync(f.filename, '!interrupted no-op');
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
        rename(from, to);
        if (to === f.filename) throw new Error('Restoration acknowledgement lost');
    });
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), error => error.chatWriteUncertain === true);
    mock.mock.restore();
    const pending = readRoleplayAccount(f.scope).pending;
    assert.equal(pending.phase, 'prepared');
    assert.ok(pending.repair);
    assert.equal(readRoleplayFile(f.filename).rawHash, pending.after.rawHash);
    return pending;
}

test('restored output finalises without lost staging or newly changed character dependencies', t => {
    const f = fixture(t);
    const pending = pauseAfterRestore(t, f);
    fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl'));
    fs.unlinkSync(path.join(f.scope.directories.characters, 'Nova.png'));
    const before = readRoleplayFile(f.filename);
    const stat = fs.statSync(f.filename, { bigint: true });
    const result = reconcileSingleChatWrite(f.scope, 'first', host);
    assert.equal(result.changed, false);
    assert.equal(result.rawHash, before.rawHash);
    assert.deepEqual(readRoleplayFile(f.filename), before);
    assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, stat.mtimeNs);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('a restored finalisation acknowledgement records the replacement identity before retry', t => {
    const f = fixture(t);
    pauseAfterRestore(t, f);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
        host.publish(options);
        throw Object.assign(new Error('Finalisation acknowledgement interrupted'), { chatCommitted: true });
    } }), error => error.chatCommitted === true);
    const pending = readRoleplayAccount(f.scope).pending;
    assert.equal(pending.phase, 'chat-applied');
    assert.deepEqual(pending.appliedPhysical, readRoleplayFile(f.filename).physical);
    const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { assert.fail('Acknowledged finalisation must not repeat'); } });
    assert.equal(result.changed, false);
});

for (const [name, change] of [
    ['edited', f => fs.writeFileSync(f.filename, JSON.stringify({ chat_metadata: {}, later: true }))],
    ['deleted', f => fs.unlinkSync(f.filename)],
    ['corrupted again', f => fs.writeFileSync(f.filename, '!later damage')],
]) {
    test(`a restored output that was subsequently ${name} is never restored or finalised again`, t => {
        const f = fixture(t);
        pauseAfterRestore(t, f);
        change(f);
        const before = readRoleplayFile(f.filename);
        const evidence = readRoleplayAccount(f.scope);
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { assert.fail('Later output must not be finalised'); } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.deepEqual(readRoleplayFile(f.filename), before);
        assert.deepEqual(readRoleplayAccount(f.scope), evidence);
    });
}

test('an acknowledged chat-applied transaction cannot republish reverted or corrupt content', t => {
    const f = fixture(t);
    const input = f.input();
    const before = fs.readFileSync(f.filename);
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
        host.publish(options);
        throw new Error('Paused after publication');
    } }), /Paused after publication/);
    withRoleplayAccountLock(f.scope, lease => {
        const pending = roleplayLease(lease).state.pending;
        pending.phase = 'chat-applied';
        pending.appliedPhysical = readRoleplayFile(f.filename).physical;
        saveRoleplayAccount(lease);
    });
    for (const changed of [before, Buffer.from('!later damage')]) {
        fs.writeFileSync(f.filename, changed);
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.deepEqual(fs.readFileSync(f.filename), changed);
    }
});

for (const changed of ['valid', 'missing', 'replacement', 'journal', 'payload']) {
    test(`pending transaction retains ${changed} conflicting evidence`, t => {
        const f = fixture(t);
        const input = f.input();
        const pending = pauseBeforeWrite(f, input);
        if (changed === 'valid') fs.writeFileSync(f.filename, JSON.stringify({ chat_metadata: {}, manual: true }));
        if (changed === 'missing') fs.unlinkSync(f.filename);
        if (changed === 'replacement') {
            fs.copyFileSync(f.filename, f.filename + '.new');
            fs.renameSync(f.filename + '.new', f.filename);
        }
        if (changed === 'journal') fs.writeFileSync(f.filename + '.neconyan-write-recovery', 'unrelated evidence');
        if (changed === 'payload') fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl'));
        const before = fs.existsSync(f.filename) ? fs.readFileSync(f.filename) : null;
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host));
        assert.deepEqual(fs.existsSync(f.filename) ? fs.readFileSync(f.filename) : null, before);
        assert.equal(readRoleplayAccount(f.scope).pending.id, pending.id);
    });
}

for (const group of [false, true]) {
    test(`${group ? 'group' : 'solo'} create binds a new instance and acknowledges an exact retry`, t => {
        const f = fixture(t, group);
        const destination = { ...f.locator, chat: 'New' };
        const input = { operationKey: 'new-chat', mode: 'create', destination, expectedVacancy: 0,
            ...(group ? { groupId: 'group' } : {}), records: f.records, backup: { deferBackup: true } };
        const result = commitSingleChatWrite(f.scope, input, host);
        assert.equal(result.revision, 1);
        const created = path.join(path.dirname(f.filename), 'New.jsonl');
        assert.equal(readRoleplayFile(created).rawHash, result.rawHash);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, host), result);
        assert.throws(() => commitSingleChatWrite(f.scope, { ...input, operationKey: 'different-create' }, host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    });
}

for (const changed of [true, false]) {
    test(`matching journal survives ${changed ? 'changed' : 'unchanged'} publication until its closed receipt is durable`, t => {
        const f = fixture(t, false, `journal-${changed}`);
        const input = { ...f.input(), records: changed ? f.input().records : f.records, backup: { deferBackup: false } };
        const pending = pauseBeforeWrite(f, input);
        const journal = writeJournal(f);
        const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
        const unlink = fs.unlinkSync;
        const removed = [];
        t.mock.method(fs, 'unlinkSync', filename => {
            if (filename === journal.filename || String(filename).includes(pending.id)) {
                const { state } = JSON.parse(fs.readFileSync(statePath));
                assert.equal(state.pending, null);
                const receipt = state.submissions[pending.operationKeyHash];
                assert.equal(receipt.state, 'closed');
                assert.equal(Object.values(receipt.effects)[0].cleanup.journal.rawHash, journal.rawHash);
                removed.push(filename);
            }
            return unlink(filename);
        });
        const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
            const saved = readRoleplayAccount(f.scope).pending;
            assert.equal(saved.journal.rawHash, journal.rawHash);
            assert.deepEqual(options.expectedJournal, { rawHash: journal.rawHash, physical: journal.physical });
            assert.deepEqual(readRoleplayFile(journal.filename).bytes, journal.bytes);
            const published = host.publish(options);
            assert.deepEqual(readRoleplayFile(journal.filename).bytes, journal.bytes);
            return published;
        } });
        assert.equal(result.changed, changed);
        assert.equal(readRoleplayFile(f.filename).rawHash, pending.after.rawHash);
        assert.ok(removed.includes(journal.filename));
        assert.equal(fs.existsSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id)), false);
        assert.equal(fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_')).length, 1);
    });

    test(`matching journal repair finalises a ${changed ? 'changed' : 'unchanged'} chat and preserves corrupt evidence`, t => {
        const f = fixture(t, false, `journal-repair-${changed}`);
        const input = { ...f.input(), records: changed ? f.input().records : f.records, backup: { deferBackup: false } };
        const pending = pauseBeforeWrite(f, input);
        const revision = readRoleplayAccount(f.scope).revision;
        const journal = writeJournal(f);
        fs.writeFileSync(f.filename, '!interrupted legacy write');
        const corrupt = readRoleplayFile(f.filename);
        let calls = 0;
        const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
            calls++;
            const state = readRoleplayAccount(f.scope);
            assert.equal(state.revision, revision + 1, 'repair and journal are recorded together');
            assert.equal(state.pending.repair.rawHash, corrupt.rawHash);
            assert.equal(state.pending.journal.rawHash, journal.rawHash);
            assert.equal(options.payloadPath, null);
            assert.equal(options.prepared.changed, false);
            assert.deepEqual(options.expectedJournal, { rawHash: journal.rawHash, physical: journal.physical });
            return host.publish(options);
        } });
        assert.equal(calls, 1);
        assert.equal(result.changed, changed);
        assert.equal(result.rawHash, pending.after.rawHash);
        assert.equal(fs.existsSync(journal.filename), false);
        const directory = path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id);
        assert.deepEqual(fs.readdirSync(directory), ['chat.corrupt.jsonl']);
        assert.deepEqual(fs.readFileSync(path.join(directory, 'chat.corrupt.jsonl')), corrupt.bytes);
        assert.equal(fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_')).length, 1);
    });
}

for (const bytes of [Buffer.from('{"chat_metadata":{},"manual":true}'), Buffer.from('!completed but invalid legacy output')]) {
    test(`journal nextHash protects completed ${bytes[0] === 123 ? 'valid' : 'corrupt'} third-state output`, t => {
        const f = fixture(t);
        const pending = pauseBeforeWrite(f, f.input());
        const journal = writeJournal(f, { nextHash: crypto.createHash('sha256').update(bytes).digest('hex') });
        fs.writeFileSync(f.filename, bytes);
        const state = readRoleplayAccount(f.scope);
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.deepEqual(fs.readFileSync(f.filename), bytes);
        assert.deepEqual(readRoleplayAccount(f.scope), state);
        assert.deepEqual(readRoleplayFile(journal.filename).bytes, journal.bytes);
        assert.deepEqual(fs.readdirSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id)), ['chat.after.jsonl']);
    });

    for (const [name, change] of [
        ['missing', journal => {
            fs.unlinkSync(journal.filename);
            return () => assert.equal(fs.existsSync(journal.filename), false);
        }],
        ['replaced', journal => {
            fs.writeFileSync(journal.filename + '.new', 'Unrelated journal evidence');
            fs.renameSync(journal.filename + '.new', journal.filename);
            const observed = readRoleplayFile(journal.filename);
            return () => assert.deepEqual(readRoleplayFile(journal.filename), observed);
        }],
        ['hard-linked', journal => {
            fs.linkSync(journal.filename, journal.filename + '.link');
            return () => {
                assert.deepEqual(fs.readFileSync(journal.filename), journal.bytes);
                assert.equal(fs.statSync(journal.filename).nlink, 2);
            };
        }],
    ]) {
        test(`recorded nextHash retains ${bytes[0] === 123 ? 'valid' : 'corrupt'} third-state output with a ${name} journal`, t => {
            const f = fixture(t);
            const pending = pauseBeforeWrite(f, f.input());
            const journal = writeJournal(f, { nextHash: crypto.createHash('sha256').update(bytes).digest('hex') });
            assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { throw new Error('Journal recorded'); } }), /Journal recorded/);
            const state = readRoleplayAccount(f.scope);
            assert.equal(state.pending.journal.nextHash, journal.record.nextHash);
            const verifyJournal = change(journal);
            fs.writeFileSync(f.filename, bytes);
            const observed = readRoleplayFile(f.filename);
            assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
            assert.deepEqual(readRoleplayFile(f.filename), observed);
            assert.deepEqual(readRoleplayAccount(f.scope), state);
            assert.deepEqual(fs.readdirSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id)), ['chat.after.jsonl']);
            verifyJournal();
        });
    }
}

test('a journal whose next hash equals the exact before-state does not invent a third state', t => {
    const f = fixture(t);
    const pending = pauseBeforeWrite(f, f.input());
    writeJournal(f, { nextHash: pending.before.rawHash });
    const result = reconcileSingleChatWrite(f.scope, 'first', host);
    assert.equal(result.rawHash, pending.after.rawHash);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('missing recorded journal does not block a proven after-image', t => {
    const f = fixture(t);
    const pending = pauseBeforeWrite(f, f.input());
    const journal = writeJournal(f, { nextHash: pending.after.rawHash });
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { throw new Error('Journal recorded'); } }), /Journal recorded/);
    const payload = path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, pending.after.payload);
    fs.writeFileSync(f.filename, fs.readFileSync(payload));
    fs.unlinkSync(journal.filename);
    const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { assert.fail('Known after-image must not be republished'); } });
    assert.equal(result.rawHash, pending.after.rawHash);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

for (const code of ['ESTALE', 'EMLINK']) {
    test(`protected ${code} interruption retains partial bytes until recorded reconciliation`, t => {
        const f = fixture(t);
        const input = f.input();
        const before = readRoleplayFile(f.filename);
        const write = fs.writeSync;
        let writes = 0;
        const mock = t.mock.method(fs, 'writeSync', (fd, ...args) => {
            const stat = fs.fstatSync(fd, { bigint: true });
            if (String(stat.dev) === before.physical.dev && String(stat.ino) === before.physical.ino && ++writes === 2) {
                throw Object.assign(new Error('Interrupted active-file write'), { code });
            }
            return write(fd, ...args);
        });
        assert.throws(() => commitSingleChatWrite(f.scope, input, host), error => error.chatWriteUncertain === true);
        mock.mock.restore();
        assert.equal(writes, 2);
        const partial = readRoleplayFile(f.filename);
        assert.deepEqual(partial.bytes, Buffer.concat([Buffer.from([before.bytes[0] ^ 0xFF]), before.bytes.subarray(1)]));
        assert.deepEqual(partial.physical, before.physical);
        const pending = readRoleplayAccount(f.scope).pending;
        assert.equal(pending.phase, 'prepared');
        const result = reconcileSingleChatWrite(f.scope, 'first', host);
        assert.equal(result.rawHash, pending.after.rawHash);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.notDeepEqual(readRoleplayFile(f.filename).physical, before.physical);
        assert.deepEqual(fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.corrupt.jsonl')), partial.bytes);
    });
}

for (const [name, change] of [
    ['wrong original hash', (f, journal) => fs.writeFileSync(journal.filename, JSON.stringify({ ...journal.record, originalHash: '0'.repeat(64) }))],
    ['wrong inode', (f, journal) => fs.writeFileSync(journal.filename, JSON.stringify({ ...journal.record, ino: '0' }))],
    ['wrong birthtime', (f, journal) => fs.writeFileSync(journal.filename, JSON.stringify({ ...journal.record, birthtime: '0' }))],
    ['malformed base64', (f, journal) => fs.writeFileSync(journal.filename, JSON.stringify({ ...journal.record, originalData: '!!!!' }))],
    ['invalid UTF-8', (f, journal) => fs.writeFileSync(journal.filename, Buffer.from([0xff]))],
    ['symlink', (f, journal) => { fs.renameSync(journal.filename, journal.filename + '.real'); fs.symlinkSync(journal.filename + '.real', journal.filename); }],
    ['hard link', (f, journal) => fs.linkSync(journal.filename, journal.filename + '.link')],
    ['oversize file', (f, journal) => fs.truncateSync(journal.filename, FILE_WRITE_RECOVERY_MAX_BYTES + 1)],
]) {
    test(`a ${name} journal blocks writing without changing any evidence`, t => {
        const f = fixture(t);
        pauseBeforeWrite(f, f.input());
        const journal = writeJournal(f);
        change(f, journal);
        // Reading may refresh the access time under relatime; every other field is evidence.
        const evidence = () => Object.fromEntries(Object.entries(fs.lstatSync(journal.filename, { bigint: true })).filter(([key]) => !key.startsWith('atime')));
        const stat = evidence();
        const file = readRoleplayFile(f.filename);
        const state = readRoleplayAccount(f.scope);
        assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
        assert.deepEqual(evidence(), stat);
        assert.deepEqual(readRoleplayFile(f.filename), file);
        assert.deepEqual(readRoleplayAccount(f.scope), state);
    });
}

test('a recorded journal cannot be replaced, but confirmed absence keeps the writer strict', t => {
    const f = fixture(t);
    pauseBeforeWrite(f, f.input());
    const journal = writeJournal(f);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { throw new Error('Journal recorded'); } }), /Journal recorded/);
    const state = readRoleplayAccount(f.scope);
    fs.copyFileSync(journal.filename, journal.filename + '.new');
    fs.renameSync(journal.filename + '.new', journal.filename);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.deepEqual(readRoleplayAccount(f.scope), state);
    fs.unlinkSync(journal.filename);
    const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
        assert.equal(options.expectedJournal, null);
        return host.publish(options);
    } });
    assert.equal(result.rawHash, state.pending.after.rawHash);
});

test('recorded journal metadata must still agree with its exact decoded bytes', t => {
    const f = fixture(t);
    pauseBeforeWrite(f, f.input());
    const journal = writeJournal(f);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { throw new Error('Pause with journal'); } }), /Pause with journal/);
    withRoleplayAccountLock(f.scope, lease => {
        roleplayLease(lease).state.pending.journal.nextHash = '1'.repeat(64);
        saveRoleplayAccount(lease);
    });
    const state = readRoleplayAccount(f.scope);
    const file = readRoleplayFile(f.filename);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.deepEqual(readRoleplayAccount(f.scope), state);
    assert.deepEqual(readRoleplayFile(f.filename), file);
    assert.deepEqual(readRoleplayFile(journal.filename).bytes, journal.bytes);
});

test('post-publication journal replacement never inherits the recorded cleanup authority', t => {
    const f = fixture(t);
    pauseBeforeWrite(f, f.input());
    const journal = writeJournal(f);
    reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
        const result = host.publish(options);
        fs.copyFileSync(journal.filename, journal.filename + '.new');
        fs.renameSync(journal.filename + '.new', journal.filename);
        return result;
    } });
    const replacement = readRoleplayFile(journal.filename);
    assert.notDeepEqual(replacement.physical, journal.physical);
    cleanupRoleplayReceipts(f.scope);
    assert.deepEqual(readRoleplayFile(journal.filename), replacement);
});

test('pending and closed records without the new optional fields remain readable without inventing cleanup authority', t => {
    const f = fixture(t);
    const input = f.input();
    const pending = pauseBeforeWrite(f, input);
    withRoleplayAccountLock(f.scope, lease => {
        delete roleplayLease(lease).state.pending.journal;
        saveRoleplayAccount(lease);
    });
    const result = reconcileSingleChatWrite(f.scope, 'first', host);
    const directory = path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'chat.after.jsonl'), fs.readFileSync(f.filename));
    withRoleplayAccountLock(f.scope, lease => {
        delete Object.values(Object.values(roleplayLease(lease).state.submissions)[0].effects)[0].cleanup;
        saveRoleplayAccount(lease);
    });
    cleanupRoleplayReceipts(f.scope);
    assert.deepEqual(commitSingleChatWrite(f.scope, input, host), result);
    assert.deepEqual(fs.readdirSync(directory), ['chat.after.jsonl']);
});

test('journal cleanup does not recreate a deleted chat directory', t => {
    const f = fixture(t);
    pauseBeforeWrite(f, f.input());
    writeJournal(f);
    const unlink = fs.unlinkSync;
    const mock = t.mock.method(fs, 'unlinkSync', filename => {
        if (String(filename).endsWith('/chat.after.jsonl')) throw Object.assign(new Error('Pause cleanup'), { code: 'EACCES' });
        return unlink(filename);
    });
    reconcileSingleChatWrite(f.scope, 'first', host);
    mock.mock.restore();
    const directory = path.dirname(f.filename);
    fs.rmSync(directory, { recursive: true });
    const mkdir = fs.mkdirSync;
    t.mock.method(fs, 'mkdirSync', (filename, ...args) => { assert.notEqual(filename, directory); return mkdir(filename, ...args); });
    cleanupRoleplayReceipts(f.scope);
    assert.equal(fs.existsSync(directory), false);
});

test('known finalised output retains a newly arrived journal without granting cleanup authority', t => {
    const f = fixture(t);
    const input = f.input();
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
        host.publish(options);
        throw new Error('Acknowledgement lost');
    } }), /Acknowledgement lost/);
    const journal = writeJournal(f);
    fs.writeFileSync(journal.filename, 'Unrelated damaged evidence');
    const result = reconcileSingleChatWrite(f.scope, 'first', { ...host, publish() { assert.fail('Known output must not publish'); } });
    cleanupRoleplayReceipts(f.scope);
    assert.equal(fs.readFileSync(journal.filename, 'utf8'), 'Unrelated damaged evidence');
    const effect = Object.values(Object.values(readRoleplayAccount(f.scope).submissions)[0].effects)[0];
    assert.equal(effect.cleanup.journal, null);
    assert.equal(effect.result.rawHash, result.rawHash);
});

test('unacknowledged restored output cannot adopt a newly arrived journal', t => {
    const f = fixture(t);
    pauseAfterRestore(t, f);
    const journal = writeJournal(f);
    const file = readRoleplayFile(f.filename);
    const state = readRoleplayAccount(f.scope);
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.deepEqual(readRoleplayFile(f.filename), file);
    assert.deepEqual(readRoleplayFile(journal.filename).bytes, journal.bytes);
    assert.deepEqual(readRoleplayAccount(f.scope), state);
});

test('a create cannot adopt journal evidence from another chat', t => {
    const f = fixture(t);
    const input = { operationKey: 'new', mode: 'create', destination: { ...f.locator, chat: 'New' }, expectedVacancy: 0,
        records: f.records, backup: { deferBackup: true } };
    const pending = pauseBeforeWrite(f, input);
    const journal = writeJournal(f);
    const filename = path.join(path.dirname(f.filename), 'New.jsonl');
    fs.renameSync(journal.filename, filename + '.neconyan-write-recovery');
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'new', host), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(fs.existsSync(filename), false);
    assert.deepEqual(readRoleplayAccount(f.scope).pending, pending);
});

test('closed memory receipts remove only their reproducible payloads', t => {
    const f = fixture(t);
    memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    const pending = pauseBeforeWrite(f, input);
    const result = reconcileSingleChatWrite(f.scope, 'first', host);
    const child = canonicalMemoryPaths(f.scope.directories, f.locator);
    assert.equal(readRoleplayFile(child.archive).rawHash, pending.memory.archiveHash);
    assert.equal(readRoleplayFile(child.guard).rawHash, pending.memory.guardHash);
    assert.equal(fs.existsSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id)), false);
    assert.deepEqual(reconcileSingleChatWrite(f.scope, 'first', host), result);
});

for (const [name, alter] of [
    ['changed payload', (payload, directory) => fs.writeFileSync(payload, 'Different evidence')],
    ['unknown file', (payload, directory) => fs.writeFileSync(path.join(directory, 'notes.txt'), 'Keep this')],
    ['symlinked payload', payload => { fs.renameSync(payload, payload + '.real'); fs.symlinkSync(payload + '.real', payload); }],
    ['hard-linked payload', payload => fs.linkSync(payload, payload + '.link')],
    ['symlinked directory', (payload, directory) => { fs.renameSync(directory, directory + '.real'); fs.symlinkSync(directory + '.real', directory); }],
]) {
    test(`closed cleanup retains a ${name} and unknown transaction directories`, t => {
        const f = fixture(t);
        const pending = pauseBeforeWrite(f, f.input());
        const directory = path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id);
        const unknown = path.join(path.dirname(directory), '00000000-0000-4000-8000-000000000000');
        fs.mkdirSync(unknown);
        fs.writeFileSync(path.join(unknown, 'chat.after.jsonl'), 'Unknown ownership');
        reconcileSingleChatWrite(f.scope, 'first', { ...host, publish(options) {
            const result = host.publish(options);
            alter(options.payloadPath, directory);
            return result;
        } });
        const entries = fs.readdirSync(directory).sort();
        assert.ok(entries.length > 0);
        cleanupRoleplayReceipts(f.scope);
        assert.deepEqual(fs.readdirSync(directory).sort(), entries);
        assert.equal(fs.readFileSync(path.join(unknown, 'chat.after.jsonl'), 'utf8'), 'Unknown ownership');
        assert.equal(readRoleplayAccount(f.scope).pending, null);
    });
}

test('unsaved closure cannot authorise cleanup of a durable pending record', t => {
    const f = fixture(t);
    const pending = pauseBeforeWrite(f, f.input());
    const directory = path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id);
    withRoleplayAccountLock(f.scope, lease => {
        const state = roleplayLease(lease).state;
        state.pending = null;
        state.submissions = { fake: { state: 'closed', effects: { fake: { writeId: pending.id,
            cleanup: { payloads: { 'chat.after.jsonl': pending.after.rawHash }, journal: null } } } } };
        cleanupRoleplayReceiptsLocked(lease);
        assert.deepEqual(fs.readdirSync(directory), ['chat.after.jsonl']);
    });
    cleanupRoleplayReceipts(f.scope);
    assert.deepEqual(readRoleplayAccount(f.scope).pending, pending);
    assert.deepEqual(fs.readdirSync(directory), ['chat.after.jsonl']);
});

for (const remove of [false, true]) {
    test(`closed cleanup retries without reading a later ${remove ? 'deleted' : 'edited'} chat or rewriting its receipt`, t => {
        const f = fixture(t);
        const input = f.input();
        const pending = pauseBeforeWrite(f, input);
        const journal = writeJournal(f);
        const unlink = fs.unlinkSync;
        const mock = t.mock.method(fs, 'unlinkSync', filename => {
            if (String(filename).endsWith('/chat.after.jsonl')) throw Object.assign(new Error('Cleanup denied'), { code: 'EACCES' });
            return unlink(filename);
        });
        const result = reconcileSingleChatWrite(f.scope, 'first', host);
        mock.mock.restore();
        const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
        const receipt = fs.readFileSync(statePath);
        assert.equal(fs.existsSync(journal.filename), true);
        if (remove) fs.unlinkSync(f.filename);
        else fs.writeFileSync(f.filename, 'Later manual content');
        const open = fs.openSync, lstat = fs.lstatSync;
        t.mock.method(fs, 'openSync', (filename, ...args) => { assert.notEqual(filename, f.filename); return open(filename, ...args); });
        t.mock.method(fs, 'lstatSync', (filename, ...args) => { assert.notEqual(filename, f.filename); return lstat(filename, ...args); });
        assert.deepEqual(commitSingleChatWrite(f.scope, input, host), result);
        assert.deepEqual(reconcileSingleChatWrite(f.scope, 'first', host), result);
        cleanupRoleplayReceipts(f.scope);
        assert.deepEqual(fs.readFileSync(statePath), receipt);
        assert.equal(fs.existsSync(journal.filename), false);
        assert.equal(fs.existsSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id)), false);
    });
}

for (const [name, corrupt] of [
    ['unbound original hash', state => { state.pending.journal.originalHash = '0'.repeat(64); }],
    ['extra journal field', state => { state.pending.journal.extra = true; }],
    ['extra physical field', state => { state.pending.journal.physical.extra = true; }],
]) {
    test(`pending journal validation refuses ${name}`, t => {
        const f = fixture(t);
        pauseBeforeWrite(f, f.input());
        const journal = writeJournal(f);
        assertDamagedEvidence(f, state => {
            state.pending.journal = { rawHash: journal.rawHash, physical: structuredClone(journal.physical),
                originalHash: state.pending.before.rawHash, nextHash: journal.record.nextHash };
            corrupt(state);
        });
    });
}

for (const [name, corrupt] of [
    ['unknown payload', cleanup => { cleanup.payloads['chat.corrupt.jsonl'] = '0'.repeat(64); }],
    ['missing chat payload', cleanup => { delete cleanup.payloads['chat.after.jsonl']; }],
    ['unbound chat payload', cleanup => { cleanup.payloads['chat.after.jsonl'] = '0'.repeat(64); }],
    ['incomplete memory pair', cleanup => { cleanup.payloads['memory.archive.json'] = '0'.repeat(64); }],
    ['unsafe journal locator', cleanup => { cleanup.journal = { locator: { group: true, chat: '../Other' }, rawHash: '0'.repeat(64), physical: { dev: '1', ino: '2', birthtimeNs: '3' } }; }],
    ['extra cleanup field', cleanup => { cleanup.extra = true; }],
]) {
    test(`closed receipt validation refuses ${name}`, t => {
        const f = fixture(t);
        commitSingleChatWrite(f.scope, f.input(), host);
        assertDamagedEvidence(f, state => corrupt(Object.values(Object.values(state.submissions)[0].effects)[0].cleanup));
    });
}

/* eslint-disable no-restricted-imports */
/* eslint playwright/expect-expect: off -- Uses node:assert against HTTP responses and saved files. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture, writeJournal } from './roleplay-transactions-fixture.js';
import { router } from '../src/endpoints/chats.js';
import { getChatRecoveryPaths, createCharacterChatTarget, createGroupChatTarget } from '../src/chat-recovery.js';
import { readRoleplayAccount, readRoleplayFile, roleplayLease, roleplayStoreDirectory, saveRoleplayAccount, withRoleplayAccountLock } from '../src/roleplay-store.js';

async function endpointFixture(t, group = false) {
    const f = fixture(t, group);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories };
        next();
    });
    app.use('/api/chats', router);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    }));
    const base = `http://127.0.0.1:${server.address().port}/api/chats`;
    const fields = group ? { id: f.locator.chat } : { avatar_url: f.locator.avatar, file_name: f.locator.chat };
    async function post(route, body, headers = {}) {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json(), evidence: JSON.parse(response.headers.get('X-Neconyan-Roleplay') || 'null') };
    }
    const route = name => `${group ? '/group' : ''}/${name}`;
    const load = (extra = {}) => post(route('get'), { ...fields, ...extra });
    const save = body => post(route('save'), body);
    const write = (evidence, chat = f.records, operationKey = crypto.randomUUID()) => ({
        ...fields, chat, deferBackup: true,
        roleplay: { account: evidence.account, operationKey, ...(evidence.source ? { source: evidence.source } : { vacancy: evidence.vacancy }) },
    });
    return { ...f, fields, route, post, load, save, write };
}

for (const group of [false, true]) {
    const kind = group ? 'group' : 'solo';
    test(`${kind} HTTP loads enrol exact bytes and keyed saves replay their permanent result`, async t => {
        const f = await endpointFixture(t, group);
        const original = fs.readFileSync(f.filename);
        const before = fs.statSync(f.filename, { bigint: true });
        const loaded = await f.load();
        assert.equal(loaded.status, 200);
        assert.deepEqual(loaded.body, f.records);
        assert.deepEqual(loaded.evidence.account, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch });
        assert.deepEqual(loaded.evidence.locator, f.locator);
        assert.equal(loaded.evidence.source.rawHash, crypto.createHash('sha256').update(original).digest('hex'));
        assert.deepEqual(fs.readFileSync(f.filename), original);
        assert.equal(fs.statSync(f.filename, { bigint: true }).mtimeNs, before.mtimeNs);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 1);
        const request = f.write(loaded.evidence, [...f.records, { name: 'Nova', mes: 'HTTP result' }]);
        const saved = await f.save(request);
        assert.equal(saved.status, 200);
        assert.equal(saved.body.roleplay.source.revision, loaded.evidence.source.revision + 1);
        assert.equal(saved.body.roleplay.operationKey, request.roleplay.operationKey);
        assert.equal(saved.body.roleplay.changed, true);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 1);
        assert.equal((await f.save({ ...request, chat: [...request.chat, { mes: 'different intent' }] })).status, 409);
        fs.unlinkSync(f.filename);
        assert.deepEqual(await f.save(request), saved);
        assert.equal(fs.existsSync(f.filename), false);
    });

    test(`${kind} HTTP saves reject missing, malformed and stale authority even when forced`, async t => {
        const f = await endpointFixture(t, group);
        const initial = fs.readFileSync(f.filename);
        assert.equal((await f.save({ ...f.fields, chat: f.records, force: true })).status, 400);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
        const loaded = await f.load();
        const request = f.write(loaded.evidence, [...f.records, { name: 'Nova', mes: 'new head' }]);
        const malformed = structuredClone(request);
        malformed.roleplay.source.rawHash = 'not a hash';
        assert.equal((await f.save(malformed)).status, 400);
        assert.deepEqual(fs.readFileSync(f.filename), initial);
        const saved = await f.save(request);
        assert.equal(saved.status, 200);
        const stale = await f.save({ ...request, force: true, roleplay: { ...request.roleplay, operationKey: crypto.randomUUID() } });
        assert.equal(stale.status, 400);
        assert.equal(stale.body.error, 'integrity');
        assert.deepEqual(stale.body.roleplay.source, saved.body.roleplay.source);
        const overwritten = await f.save({ ...f.write(stale.body.roleplay, [f.records[0]]), force: true });
        assert.equal(overwritten.status, 200);
        const forced = fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_forced_overwrite_'));
        assert.equal(forced.length, 1);
        assert.match(fs.readFileSync(path.join(f.scope.directories.backups, forced[0]), 'utf8'), /new head/);
    });

    test(`${kind} HTTP creation requires a captured vacancy and uses an exact basename`, async t => {
        const f = await endpointFixture(t, group);
        const name = 'New.jsonl';
        const fields = group ? { id: name } : { avatar_url: f.locator.avatar, file_name: name };
        const vacant = await f.post(f.route('get'), { ...fields, allow_create: true });
        assert.equal(vacant.status, 200);
        assert.deepEqual(vacant.body, []);
        assert.equal(vacant.evidence.vacancy, 0);
        const request = { ...f.write(vacant.evidence), ...fields };
        const stale = { ...request, roleplay: { ...request.roleplay, vacancy: 1 } };
        assert.equal((await f.save(stale)).status, 400);
        const saved = await f.save(request);
        assert.equal(saved.status, 200);
        assert.equal(saved.body.roleplay.source.revision, 1);
        const filename = path.join(path.dirname(f.filename), name + '.jsonl');
        assert.equal(fs.existsSync(filename), true);
        assert.equal(fs.existsSync(path.join(path.dirname(f.filename), name)), false);
        assert.deepEqual(await f.save(request), saved);
        const anotherKey = { ...request, roleplay: { ...request.roleplay, operationKey: crypto.randomUUID() } };
        assert.equal((await f.save(anotherKey)).status, 400);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 1);
    });

    test(`${kind} HTTP source headers preserve Unicode names`, async t => {
        const f = await endpointFixture(t, group);
        const name = '東京🐈.jsonl';
        const fields = group ? { id: name } : { avatar_url: f.locator.avatar, file_name: name };
        const vacant = await f.post(f.route('get'), { ...fields, allow_create: true });
        assert.equal(vacant.status, 200);
        assert.equal(vacant.evidence.locator.chat, name);
        assert.equal((await f.save({ ...f.write(vacant.evidence), ...fields })).status, 200);
        const loaded = await f.post(f.route('get'), fields);
        assert.equal(loaded.status, 200);
        assert.equal(loaded.evidence.locator.chat, name);
    });

    test(`${kind} HTTP read repair requires the exact recorded snapshot and never recreates a deleted chat`, async t => {
        const f = await endpointFixture(t, group);
        const loaded = await f.load();
        const original = fs.readFileSync(f.filename);
        fs.writeFileSync(f.filename, '!interrupted bytes');
        const repaired = await f.load();
        assert.equal(repaired.status, 200);
        assert.deepEqual(repaired.body, loaded.body);
        assert.deepEqual(repaired.evidence, loaded.evidence);
        assert.deepEqual(fs.readFileSync(f.filename), original);
        const ledger = readRoleplayAccount(f.scope);
        const receipt = Object.values(ledger.submissions)[0];
        assert.equal(receipt.outcome.changed, false);
        assert.equal(receipt.outcome.revision, loaded.evidence.source.revision);
        const corrupt = path.join(roleplayStoreDirectory(f.scope), 'pending', receipt.outcome.writeId, 'chat.corrupt.jsonl');
        assert.equal(fs.readFileSync(corrupt, 'utf8'), '!interrupted bytes');
        fs.unlinkSync(f.filename);
        assert.equal((await f.load({ allow_create: true })).status, 404);
        assert.equal(fs.existsSync(f.filename), false);
    });

    test(`${kind} HTTP loads do not replay an undo journal beside a protected chat`, async t => {
        const f = await endpointFixture(t, group);
        const loaded = await f.load();
        const journal = writeJournal(f);
        assert.equal((await f.load()).status, 200);
        assert.deepEqual(fs.readFileSync(journal.filename), journal.bytes);
        assert.equal((await f.save(f.write(loaded.evidence))).status, 503);
        const changed = [...f.records, { name: 'Nova', mes: 'external state retained' }].map(JSON.stringify).join('\n');
        fs.writeFileSync(f.filename, changed);
        assert.equal((await f.load()).status, 409);
        assert.equal(fs.readFileSync(f.filename, 'utf8'), changed);
        assert.deepEqual(fs.readFileSync(journal.filename), journal.bytes);
    });

    test(`${kind} HTTP saves retain pending evidence and retry the identical request under a fresh lease`, async t => {
        const f = await endpointFixture(t, group);
        const loaded = await f.load();
        const request = f.write(loaded.evidence, [...f.records, { mes: 'retry result' }]);
        const before = fs.statSync(f.filename, { bigint: true });
        const originalWrite = fs.writeSync;
        const trap = t.mock.method(fs, 'writeSync', (descriptor, ...args) => {
            const current = fs.fstatSync(descriptor, { bigint: true });
            if (current.dev === before.dev && current.ino === before.ino) throw Object.assign(new Error('injected HTTP write failure'), { code: 'EIO' });
            return originalWrite(descriptor, ...args);
        });
        const failed = await f.save(request);
        trap.mock.restore();
        assert.equal(failed.status, 503);
        const pending = readRoleplayAccount(f.scope).pending;
        assert.equal(pending.phase, 'prepared');
        assert.equal((await f.load()).status, 503);
        assert.equal((await f.save({ ...request, roleplay: { ...request.roleplay, operationKey: crypto.randomUUID() } })).status, 503);
        const saved = await f.save(request);
        assert.equal(saved.status, 200);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.deepEqual(await f.save(request), saved);
    });

    test(`${kind} HTTP account versions never refresh stale write authority`, async t => {
        const f = await endpointFixture(t, group);
        const loaded = await f.load();
        const before = fs.readFileSync(f.filename);
        withRoleplayAccountLock(f.scope, lease => {
            roleplayLease(lease).state.dataEpoch++;
            saveRoleplayAccount(lease);
        });
        assert.equal((await f.save(f.write(loaded.evidence))).status, 409);
        assert.equal((await f.load({ roleplay: { account: loaded.evidence.account } })).status, 409);
        assert.deepEqual(fs.readFileSync(f.filename), before);
    });
}

test('HTTP chat paths are refused rather than silently sanitised', async t => {
    const f = await endpointFixture(t);
    assert.equal((await f.load({ file_name: '../Source' })).status, 400);
    const loaded = await f.load();
    assert.equal((await f.save({ ...f.write(loaded.evidence), file_name: 'Source/' })).status, 400);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 0);
});

test('HTTP names reserve room for the extension instead of reading a truncated alias', async t => {
    const f = await endpointFixture(t);
    const name = 'A'.repeat(250);
    const alias = path.join(path.dirname(f.filename), (name + '.jsonl').slice(0, 255));
    const bytes = fs.readFileSync(f.filename);
    fs.writeFileSync(alias, bytes);
    assert.equal((await f.load({ file_name: name })).status, 400);
    assert.deepEqual(fs.readFileSync(alias), bytes);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
});

test('HTTP discovery refuses missing protected storage without initialising it', async t => {
    const f = await endpointFixture(t);
    const store = roleplayStoreDirectory(f.scope);
    fs.rmSync(store, { recursive: true });
    assert.equal((await f.load()).status, 503);
    assert.equal(fs.existsSync(store), false);
});

test('HTTP repair does not accept a different or unsafe latest snapshot', async t => {
    const f = await endpointFixture(t);
    await f.load();
    const target = createCharacterChatTarget({ chatsDirectory: f.scope.directories.chats, backupDirectory: f.scope.directories.backups,
        owner: 'Nova', filename: 'Source.jsonl' });
    const { latestPath } = getChatRecoveryPaths(target);
    fs.writeFileSync(f.filename, '!corrupt');
    fs.writeFileSync(latestPath, [...f.records, { mes: 'unrecorded snapshot' }].map(JSON.stringify).join('\n'));
    assert.equal((await f.load()).status, 422);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), '!corrupt');
    assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 0);
});

test('group info retains the read-only entry for a damaged chat without authorising a save', async t => {
    const f = await endpointFixture(t, true);
    fs.writeFileSync(f.filename, '!broken legacy chat');
    const response = await f.post('/group/info', f.fields);
    assert.equal(response.status, 200);
    assert.equal(response.body.file_name, 'Source.jsonl');
    assert.equal(response.evidence, null);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
    const target = createGroupChatTarget({ groupChatsDirectory: f.scope.directories.groupChats, backupDirectory: f.scope.directories.backups, filename: 'Source.jsonl' });
    assert.equal(fs.existsSync(getChatRecoveryPaths(target).latestPath), false);
});

function groupSnapshotPath(f) {
    return getChatRecoveryPaths(createGroupChatTarget({ groupChatsDirectory: f.scope.directories.groupChats,
        backupDirectory: f.scope.directories.backups, filename: path.basename(f.filename) })).latestPath;
}

for (const [kind, suffix] of [['malformed JSON', Buffer.from('!broken')], ['invalid UTF-8', Buffer.from([0xff])]]) {
    test(`legacy preflight sees a native header before later ${kind}`, async t => {
        const f = await endpointFixture(t, true);
        const snapshot = groupSnapshotPath(f);
        fs.mkdirSync(path.dirname(snapshot), { recursive: true });
        const original = fs.readFileSync(f.filename);
        fs.writeFileSync(snapshot, original);
        const header = { ...f.records[0], chat_metadata: { neconyan_roleplay: { schema: 1, instanceId: crypto.randomUUID(), revision: 1, writeId: crypto.randomUUID() } } };
        const marked = Buffer.concat([Buffer.from('\ufeff\n' + JSON.stringify(header) + '\n'), suffix]);
        fs.writeFileSync(f.filename, marked);
        const before = readRoleplayAccount(f.scope);
        const response = await f.load();
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'ROLEPLAY_FOREIGN_SOURCE');
        assert.deepEqual(fs.readFileSync(f.filename), marked);
        assert.deepEqual(fs.readFileSync(snapshot), original);
        assert.deepEqual(readRoleplayAccount(f.scope), before);
    });
}

test('legacy preflight refuses moved undo evidence naming a protected physical identity', async t => {
    const f = await endpointFixture(t, true);
    assert.equal((await f.load()).status, 200);
    const journal = writeJournal(f);
    const moved = path.join(path.dirname(f.filename), 'Moved.jsonl');
    const journalPath = moved + '.neconyan-write-recovery';
    fs.unlinkSync(f.filename);
    fs.renameSync(journal.filename, journalPath);
    const before = readRoleplayAccount(f.scope);
    const response = await f.load({ id: 'Moved' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'ROLEPLAY_SOURCE_CHANGED');
    assert.equal(fs.existsSync(moved), false);
    assert.deepEqual(fs.readFileSync(journalPath), journal.bytes);
    assert.deepEqual(readRoleplayAccount(f.scope), before);
});

for (const [kind, recoveryFile] of [
    ['active', (_f, filename) => filename],
    ['snapshot', (f, filename) => groupSnapshotPath({ ...f, filename })],
]) {
    test(`legacy ${kind} preflight retains a protected file moved into the undo-record path`, async t => {
        const f = await endpointFixture(t, true);
        assert.equal((await f.load()).status, 200);
        const before = readRoleplayAccount(f.scope);
        const physical = Object.values(before.resources)[0].head.physical;
        const filename = path.join(path.dirname(f.filename), 'Untracked.jsonl');
        fs.writeFileSync(filename, '!broken active');
        const recovered = recoveryFile(f, filename);
        fs.mkdirSync(path.dirname(recovered), { recursive: true });
        fs.writeFileSync(recovered, f.records.map(JSON.stringify).join('\n'));
        const journal = writeJournal({ filename: recovered });
        fs.writeFileSync(f.filename, journal.bytes);
        fs.renameSync(f.filename, journal.filename);
        fs.unlinkSync(recovered);
        const evidence = readRoleplayFile(journal.filename);
        const activeBefore = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
        assert.deepEqual(evidence.physical, physical);
        const response = await f.load({ id: 'Untracked' });
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'ROLEPLAY_SOURCE_CHANGED');
        assert.equal(fs.existsSync(recovered), false);
        assert.deepEqual(fs.existsSync(filename) ? fs.readFileSync(filename) : null, activeBefore);
        assert.deepEqual(readRoleplayFile(journal.filename), evidence);
        assert.deepEqual(readRoleplayAccount(f.scope), before);
    });
}

for (const activeCorrupt of [false, true]) {
    test(`legacy preflight inspects snapshot undo evidence with ${activeCorrupt ? 'corrupt' : 'valid'} active content`, async t => {
        const f = await endpointFixture(t, true);
        const snapshot = groupSnapshotPath(f);
        fs.mkdirSync(path.dirname(snapshot), { recursive: true });
        const marked = structuredClone(f.records);
        marked[0].chat_metadata.neconyan_roleplay = { schema: 1, instanceId: crypto.randomUUID(), revision: 1, writeId: crypto.randomUUID() };
        fs.writeFileSync(snapshot, marked.map(JSON.stringify).join('\n'));
        const journal = writeJournal({ filename: snapshot });
        fs.writeFileSync(snapshot, '!broken snapshot');
        if (activeCorrupt) fs.writeFileSync(f.filename, '!broken active');
        const active = fs.readFileSync(f.filename);
        const before = readRoleplayAccount(f.scope);
        const response = await f.load();
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'ROLEPLAY_FOREIGN_SOURCE');
        assert.deepEqual(fs.readFileSync(f.filename), active);
        assert.equal(fs.readFileSync(snapshot, 'utf8'), '!broken snapshot');
        assert.deepEqual(fs.readFileSync(journal.filename), journal.bytes);
        assert.deepEqual(readRoleplayAccount(f.scope), before);
    });
}

test('unmarked legacy snapshot and undo evidence still recover before first enrolment', async t => {
    const f = await endpointFixture(t, true);
    const original = fs.readFileSync(f.filename);
    const snapshot = groupSnapshotPath(f);
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, original);
    const journal = writeJournal({ filename: snapshot });
    fs.writeFileSync(snapshot, '!broken snapshot');
    fs.writeFileSync(f.filename, '!broken active');
    const response = await f.load();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, f.records);
    assert.deepEqual(fs.readFileSync(f.filename), original);
    assert.equal(fs.existsSync(journal.filename), false);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 1);
});

for (const length of [223, 249]) {
    test(`HTTP discovery, writes and recorded repair preserve supported ${length}-character chat names`, async t => {
        const f = await endpointFixture(t, true);
        const name = 'R'.repeat(length);
        const filename = path.join(path.dirname(f.filename), name + '.jsonl');
        fs.copyFileSync(f.filename, filename);
        const loaded = await f.load({ id: name });
        assert.equal(loaded.status, 200);
        const saved = await f.save({ ...f.write(loaded.evidence, [...f.records, { mes: 'long-name update' }]), id: name });
        assert.equal(saved.status, 200);
        const before = fs.readFileSync(filename);
        fs.writeFileSync(filename, '!broken');
        const repaired = await f.load({ id: name });
        assert.equal(repaired.status, 200);
        assert.deepEqual(repaired.evidence.source, saved.body.roleplay.source);
        assert.deepEqual(fs.readFileSync(filename), before);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.equal((await f.load()).status, 200);
        const createdName = 'N'.repeat(length);
        const vacant = await f.load({ id: createdName, allow_create: true });
        assert.equal(vacant.status, 200);
        assert.equal((await f.save({ ...f.write(vacant.evidence), id: createdName })).status, 200);
        assert.equal(fs.existsSync(path.join(path.dirname(filename), createdName + '.jsonl')), true);
    });
}

test('load repair reports an unresolved result after admission even when publication finds a changed source', async t => {
    const f = await endpointFixture(t, true);
    await f.load();
    fs.writeFileSync(f.filename, '!broken');
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const changed = [...f.records, { mes: 'retained intervening state' }].map(JSON.stringify).join('\n');
    const originalRename = fs.renameSync;
    let injected = false;
    const trap = t.mock.method(fs, 'renameSync', (from, to) => {
        originalRename(from, to);
        if (to === statePath && !injected && JSON.parse(fs.readFileSync(statePath, 'utf8')).state.pending) {
            injected = true;
            fs.writeFileSync(f.filename, changed);
        }
    });
    const response = await f.load();
    trap.mock.restore();
    assert.equal(injected, true);
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'roleplay_recovery_required');
    assert.equal(response.body.code, 'ROLEPLAY_SOURCE_CHANGED');
    assert.equal(readRoleplayAccount(f.scope).pending.phase, 'prepared');
    assert.equal(fs.readFileSync(f.filename, 'utf8'), changed);
    assert.equal((await f.load()).status, 503);
});

for (const avatar of ['Nova.png extra.png', 'Nova|v2.png']) {
    test(`HTTP storage preserves the existing avatar path for ${avatar}`, { skip: process.platform === 'win32' && avatar.includes('|') }, async t => {
        const f = await endpointFixture(t);
        const owner = avatar.replace('.png', '');
        const directory = path.join(f.scope.directories.chats, owner);
        fs.renameSync(path.join(f.scope.directories.characters, 'Nova.png'), path.join(f.scope.directories.characters, avatar));
        fs.renameSync(path.dirname(f.filename), directory);
        const filename = path.join(directory, 'Source.jsonl');
        const original = fs.readFileSync(filename);
        const loaded = await f.load({ avatar_url: avatar, allow_create: true });
        assert.equal(loaded.status, 200);
        assert.deepEqual(loaded.body, f.records);
        assert.equal(loaded.evidence.locator.avatar, avatar);
        const saved = await f.save({ ...f.write(loaded.evidence, [...f.records, { mes: 'existing folder used' }]), avatar_url: avatar });
        assert.equal(saved.status, 200);
        assert.notDeepEqual(fs.readFileSync(filename), original);
        assert.equal(fs.readdirSync(f.scope.directories.chats).length, 1);
    });
}

test('unsafe optional snapshot keeps corrupt group info read-only without blocking the account', async t => {
    const f = await endpointFixture(t, true);
    await f.load();
    fs.writeFileSync(f.filename, '!broken');
    const snapshot = groupSnapshotPath(f);
    fs.unlinkSync(snapshot);
    fs.mkdirSync(snapshot);
    const before = readRoleplayAccount(f.scope);
    assert.equal((await f.load()).status, 422);
    const info = await f.post('/group/info', f.fields);
    assert.equal(info.status, 200);
    assert.equal(info.body.file_name, 'Source.jsonl');
    assert.equal(info.evidence, null);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), '!broken');
    assert.equal(fs.statSync(snapshot).isDirectory(), true);
    assert.deepEqual(readRoleplayAccount(f.scope), before);
});

/* eslint playwright/expect-expect: off -- Uses node:assert with disposable files. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath, recoverFileWriteSync } from '../src/util.js';

const configPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
setConfigFilePath(configPath);
const { mutateChat, prepareNativeChatWrite, publishNativeChatWrite } = await import('../src/endpoints/chats.js');
const { readRoleplayFile } = await import('../src/roleplay-store.js');
const { createCharacterChatTarget, createGroupChatTarget, getChatRecoveryPaths, readChatJsonlStrict, loadActiveChatWithRecovery, restoreChatSnapshotIfMatches } = await import('../src/chat-recovery.js');
const { readState, statePath, synchronize } = await import('../src/mewmory/store.js');
const { getChatFileLockPath } = await import('../src/chat-file-lock.js');
const gracefulFs = createRequire(new URL('../src/chat-file-lock.js', import.meta.url))('graceful-fs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const serialize = records => records.map(record => JSON.stringify(record)).join('\n');
const identity = records => records;

function fixture(t, group = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-chat-mutation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'), backups: path.join(root, 'backups') };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const locator = { group, avatar: 'Nova.png', chat: 'Source' };
    const recoveryTarget = group
        ? createGroupChatTarget({ groupChatsDirectory: directories.groupChats, backupDirectory: directories.backups, filename: 'Source.jsonl' })
        : createCharacterChatTarget({ chatsDirectory: directories.chats, backupDirectory: directories.backups, owner: 'Nova', filename: 'Source.jsonl' });
    const filePath = recoveryTarget.activePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const records = [{ user_name: 'User', unknown_header: { keep: true }, chat_metadata: { integrity: 'original' } },
        { name: 'User', is_user: true, mes: 'Question.', extra: { files: [{ url: '/file', name: 'Keep' }] } },
        { name: 'Nova', mes: 'Answer.', swipe_id: 0, swipes: ['Answer.', 'Alternative.'],
            swipe_info: [{ extra: { reasoning: 'Original thought.' } }, { extra: { retained: true } }],
            extra: { reasoning: 'Original thought.', media: [{ type: 'image', url: '/image' }] } }];
    fs.writeFileSync(filePath, serialize(records));
    const options = { filePath, expectedHash: hash(fs.readFileSync(filePath)), handle: path.basename(root), cardName: 'Nova',
        backupDirectory: directories.backups, recoveryTarget, mewmory: { directories, locator }, deferBackup: true };
    return { directories, locator, records, options,
        current: () => readChatJsonlStrict(filePath).records,
        refresh: () => { options.expectedHash = hash(fs.readFileSync(filePath)); } };
}

for (const group of [false, true]) {
    test(`native ${group ? 'group' : 'solo'} mutation preserves data and saves matching integrity/recovery`, t => {
        const f = fixture(t, group);
        const original = fs.readFileSync(f.options.filePath, 'utf8');
        const result = mutateChat(f.options, records => {
            records[0].chat_metadata.native = { saved: true };
            records.push({ name: 'Nova', mes: 'Native result.' });
            return records;
        });
        assert.deepEqual(result.records, f.current());
        assert.notEqual(result.integrity, 'original');
        assert.equal(result.integrity, result.records[0].chat_metadata.integrity);
        assert.deepEqual(result.records.slice(1, 3), f.records.slice(1));
        assert.deepEqual(result.records[0].unknown_header, f.records[0].unknown_header);
        const latest = getChatRecoveryPaths(f.options.recoveryTarget).latestPath;
        assert.equal(fs.readFileSync(latest, 'utf8'), fs.readFileSync(f.options.filePath, 'utf8'));
        const backups = fs.readdirSync(f.directories.backups).filter(name => name.startsWith('chat_pre_write_'));
        assert.equal(backups.length, 1);
        assert.equal(fs.readFileSync(path.join(f.directories.backups, backups[0]), 'utf8'), original);
    });
}

test('metadata-only native mutations preserve changes ignored by legacy load comparisons', t => {
    const f = fixture(t);
    const result = mutateChat(f.options, records => {
        records[0].unknown_header.keep = false;
        records[0].chat_metadata.chat_id_hash = 73;
        return records;
    });
    assert.equal(result.records[0].unknown_header.keep, false);
    assert.equal(result.records[0].chat_metadata.chat_id_hash, 73);
    assert.deepEqual(result.records.slice(1), f.records.slice(1));
});

test('legacy no-op preserves bytes and file identity; its first real change gets an integrity slug', t => {
    const f = fixture(t);
    const raw = '\n{ "name": "Legacy", "unknown_header": true }\r\n{"name":"Nova","mes":"café"}\r\n';
    fs.writeFileSync(f.options.filePath, raw);
    f.refresh();
    const before = fs.statSync(f.options.filePath, { bigint: true });
    const noOp = mutateChat(f.options, identity);
    const after = fs.statSync(f.options.filePath, { bigint: true });
    assert.equal(noOp.integrity, '');
    assert.equal(fs.readFileSync(f.options.filePath, 'utf8'), raw);
    for (const field of ['ino', 'mtimeNs', 'birthtimeNs']) assert.equal(after[field], before[field]);
    assert.deepEqual(noOp.records, f.current());
    const changed = mutateChat(f.options, records => { records[1].mes += '!'; return records; });
    assert.ok(changed.integrity);
    assert.equal(changed.records[0].unknown_header, true);
});

test('same-length stale source is rejected before callback or backup changes', t => {
    const f = fixture(t);
    fs.writeFileSync(f.options.filePath, serialize(f.records).replace('Answer.', 'Edited.'));
    let called = false;
    assert.throws(() => mutateChat(f.options, () => { called = true; }), { code: 'ESTALE' });
    assert.equal(called, false);
    assert.deepEqual(fs.readdirSync(f.directories.backups), []);
    assert.equal(f.current()[2].mes, 'Edited.');
});

test('native no-op keeps the UTF-8 marker in exact snapshots and pre-write backups', t => {
    const f = fixture(t);
    const raw = '\uFEFF' + serialize(f.records);
    fs.writeFileSync(f.options.filePath, raw);
    f.refresh();
    mutateChat(f.options, identity);
    assert.equal(fs.readFileSync(getChatRecoveryPaths(f.options.recoveryTarget).latestPath, 'utf8'), raw);
    mutateChat(f.options, records => { records[1].mes = 'Changed'; return records; });
    const backup = fs.readdirSync(f.directories.backups).find(name => name.startsWith('chat_pre_write_'));
    assert.equal(fs.readFileSync(path.join(f.directories.backups, backup), 'utf8'), raw);
});

test('unsafe ancestor cannot trigger recovery writes or remove recovery evidence', t => {
    const f = fixture(t);
    const stats = fs.statSync(f.options.filePath, { bigint: true });
    const original = fs.readFileSync(f.options.filePath);
    const recoveryPath = f.options.filePath + '.neconyan-write-recovery';
    const record = JSON.stringify({ version: 1, dev: String(stats.dev), ino: String(stats.ino), originalHash: hash(original),
        nextHash: hash('uncompleted'), originalData: original.toString('base64') });
    fs.writeFileSync(recoveryPath, record);
    fs.writeFileSync(f.options.filePath, 'partial write');
    const alias = path.join(f.directories.root, 'alias');
    fs.symlinkSync(path.dirname(f.options.filePath), alias, 'dir');
    let called = false;
    assert.throws(() => mutateChat({ ...f.options, filePath: path.join(alias, 'Source.jsonl'), recoveryTarget: null }, records => {
        called = true; return records;
    }));
    assert.equal(called, false);
    assert.equal(fs.readFileSync(f.options.filePath, 'utf8'), 'partial write');
    assert.equal(fs.readFileSync(recoveryPath, 'utf8'), record);
    recoverFileWriteSync(f.options.filePath);
    assert.deepEqual(mutateChat(f.options, identity).records, f.records);
});

test('post-flush cleanup failure cannot masquerade as an unapplied mutation', t => {
    const f = fixture(t);
    const unlink = fs.unlinkSync;
    const recoveryPath = f.options.filePath + '.neconyan-write-recovery';
    t.mock.method(fs, 'unlinkSync', (file, ...args) => {
        if (file === recoveryPath) throw new Error('Fixture cleanup failure');
        return unlink(file, ...args);
    });
    let failure;
    assert.throws(() => mutateChat({ ...f.options, recoveryTarget: null }, records => {
        records[1].mes = 'Committed despite cleanup error'; return records;
    }), error => { failure = error; return error.chatWriteUncertain === true && Boolean(error.integrity); });
    t.mock.restoreAll();
    assert.equal(f.current()[1].mes, 'Committed despite cleanup error');
    assert.equal(f.current()[0].chat_metadata.integrity, failure.integrity);
    assert.throws(() => mutateChat(f.options, identity), { code: 'ESTALE' });
});

test('partial write that later recovers the new snapshot reports an uncertain outcome', t => {
    const f = fixture(t);
    const write = fs.writeSync;
    let writes = 0;
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        if (fs.fstatSync(fd).ino === fs.statSync(f.options.filePath).ino && ++writes === 2) throw new Error('Fixture interrupted write');
        return write(fd, ...args);
    });
    let failure;
    assert.throws(() => mutateChat(f.options, records => { records[1].mes = 'Recovered new result'; return records; }), error => {
        failure = error; return error.chatWriteUncertain === true && Boolean(error.integrity);
    });
    t.mock.restoreAll();
    const restored = loadActiveChatWithRecovery(f.options.recoveryTarget);
    assert.equal(restored.records[1].mes, 'Recovered new result');
    assert.equal(restored.records[0].chat_metadata.integrity, failure.integrity);
});

for (const outcome of ['committed', 'uncertain', 'rejected']) {
    test(`lock-release failure preserves the ${outcome} mutation outcome`, t => {
        const f = fixture(t);
        const rmdir = gracefulFs.rmdirSync;
        const lockPath = getChatFileLockPath(f.options.filePath);
        let cleanupCalled = false;
        t.mock.method(gracefulFs, 'rmdirSync', (directory, ...args) => {
            if (directory === lockPath) { cleanupCalled = true; throw new Error('Fixture lock cleanup failure'); }
            return rmdir(directory, ...args);
        });
        const write = fs.writeSync;
        if (outcome === 'uncertain') t.mock.method(fs, 'writeSync', (fd, ...args) => {
            if (fs.fstatSync(fd).ino === fs.statSync(f.options.filePath).ino) throw new Error('Fixture uncertain write');
            return write(fd, ...args);
        });
        const rejected = new Error('Fixture rejected callback');
        let failure;
        assert.throws(() => mutateChat(f.options, records => {
            if (outcome === 'rejected') throw rejected;
            records[1].mes = 'Native result'; return records;
        }), error => { failure = error; return true; });
        t.mock.restoreAll();
        assert.equal(cleanupCalled, true);
        if (outcome === 'rejected') {
            assert.equal(failure, rejected);
            assert.deepEqual(f.current(), f.records);
        } else if (outcome === 'uncertain') {
            assert.equal(failure.chatWriteUncertain, true);
            assert.equal(failure.message, 'Fixture uncertain write');
            assert.ok(failure.integrity);
        } else {
            assert.equal(failure.chatCommitted, true);
            assert.equal(failure.cause.message, 'Fixture lock cleanup failure');
            assert.equal(f.current()[1].mes, 'Native result');
            assert.equal(f.current()[0].chat_metadata.integrity, failure.integrity);
        }
    });
}

for (const replacement of ['edit', 'replace', 'remove']) {
    test(`source ${replacement} during callback is refused before recovery or backup changes`, t => {
        const f = fixture(t);
        assert.throws(() => mutateChat(f.options, records => {
            if (replacement !== 'edit') fs.unlinkSync(f.options.filePath);
            if (replacement !== 'remove') fs.writeFileSync(f.options.filePath, serialize(f.records).replace('Question.', 'External.'));
            records.push({ name: 'Nova', mes: 'Must not land.' });
            return records;
        }), { code: 'ESTALE' });
        assert.deepEqual(fs.readdirSync(f.directories.backups), []);
        if (replacement !== 'remove') assert.equal(f.current()[1].mes, 'External.');
    });
}

for (const kind of ['missing', 'corrupt', 'utf8', 'directory', 'symlink', 'hardlink']) {
    test(`unsafe ${kind} source is never mutated`, t => {
        const f = fixture(t);
        const other = f.options.filePath + '.original';
        fs.renameSync(f.options.filePath, other);
        if (kind === 'corrupt') fs.writeFileSync(f.options.filePath, '{invalid');
        if (kind === 'utf8') fs.writeFileSync(f.options.filePath, Buffer.concat([Buffer.from('{"chat_metadata":{}}\n{"mes":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
        if (kind === 'directory') fs.mkdirSync(f.options.filePath);
        if (kind === 'symlink') fs.symlinkSync(other, f.options.filePath);
        if (kind === 'hardlink') fs.linkSync(other, f.options.filePath);
        if (['corrupt', 'utf8', 'hardlink', 'symlink'].includes(kind)) f.refresh();
        let called = false;
        assert.throws(() => mutateChat(f.options, records => { called = true; return records; }));
        assert.equal(called, false);
        assert.equal(fs.readFileSync(other, 'utf8'), serialize(f.records));
        assert.deepEqual(fs.readdirSync(f.directories.backups), []);
    });
}

test('invalid/async callback output releases the lock without a write', async t => {
    const f = fixture(t);
    let asyncCalled = false;
    for (const mutate of [() => null, () => [], () => [{ chat_metadata: [] }],
        records => { records[1].extra.bad = undefined; return records; },
        async records => { asyncCalled = true; return records; }, () => Promise.reject(new Error('Refused async failure')),
        () => { throw new Error('Callback failed'); }]) {
        assert.throws(() => mutateChat(f.options, mutate));
        assert.deepEqual(mutateChat(f.options, identity).records, f.records);
    }
    assert.equal(asyncCalled, false);
    await new Promise(resolve => setImmediate(resolve));
});

test('write failure releases the lock and does not report a completed mutation', t => {
    const f = fixture(t);
    const write = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        if (fs.fstatSync(fd).ino === fs.statSync(f.options.filePath).ino) throw new Error('Fixture write failure');
        return write(fd, ...args);
    });
    assert.throws(() => mutateChat(f.options, records => { records[1].mes = 'Changed'; return records; }), /Fixture write failure/);
    t.mock.restoreAll();
    // Recovery may have a prepared write to finish; read through the existing recovery contract.
    const source = readChatJsonlStrict(f.options.filePath);
    assert.equal(source.status, 'ok');
    f.refresh();
    assert.deepEqual(mutateChat(f.options, identity).records, source.records);
});

test('destructive mutation requires explicit permission and retains a pre-write backup', t => {
    const f = fixture(t);
    assert.throws(() => mutateChat(f.options, records => records.slice(0, 1)), /destructive/i);
    assert.deepEqual(fs.readdirSync(f.directories.backups), []);
    const result = mutateChat({ ...f.options, allowShrink: true }, records => records.slice(0, 1));
    assert.equal(result.records.length, 1);
    assert.equal(fs.readdirSync(f.directories.backups).filter(name => name.startsWith('chat_pre_write_')).length, 1);
});

for (const broken of [false, true]) {
    test(`branch memory ${broken ? 'failure identifies the already committed chat' : 'is captured before success'}`, t => {
        const f = fixture(t);
        const parent = synchronize(f.directories, f.locator);
        const branchPath = path.join(path.dirname(f.options.filePath), 'Branch.jsonl');
        fs.writeFileSync(branchPath, serialize(f.records));
        const branchLocator = { ...f.locator, chat: 'Branch' };
        const options = { ...f.options, filePath: branchPath, recoveryTarget: null,
            mewmory: { directories: f.directories, locator: branchLocator } };
        if (broken) fs.writeFileSync(statePath(f.directories, f.locator), '{corrupt');
        const run = () => mutateChat(options, records => { records[0].chat_metadata.main_chat = 'Source'; return records; });
        if (broken) {
            assert.throws(run, error => error.chatCommitted === true && Boolean(error.integrity) && Boolean(error.cause));
            assert.equal(readChatJsonlStrict(branchPath).records[0].chat_metadata.main_chat, 'Source');
            assert.throws(run, { code: 'ESTALE' });
        } else {
            run();
            const branch = readState(f.directories, branchLocator);
            assert.equal(branch.storyId, parent.storyId);
            assert.notEqual(branch.branchId, parent.branchId);
            assert.ok(branch.timeline.length);
        }
    });
}

test('native source check stays mandatory with legacy integrity checks disabled', t => {
    const f = fixture(t);
    const config = path.join(f.directories.root, 'config.yaml');
    fs.writeFileSync(config, 'backups:\n  chat:\n    checkIntegrity: false\n    enabled: false\n');
    const script = `
        import assert from 'node:assert/strict';
        import { setConfigFilePath } from ${JSON.stringify(new URL('../src/util.js', import.meta.url).href)};
        setConfigFilePath(${JSON.stringify(config)});
        const { mutateChat } = await import(${JSON.stringify(new URL('../src/endpoints/chats.js', import.meta.url).href)});
        assert.throws(() => mutateChat(${JSON.stringify({ ...f.options, expectedHash: '0'.repeat(64) })}, records => records), { code: 'ESTALE' });
        const result = mutateChat(${JSON.stringify(f.options)}, records => { records[1].mes = 'Changed'; return records; });
        assert.equal(result.records[1].mes, 'Changed');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
});

function managed(f, records, create = false) {
    const before = create ? null : readRoleplayFile(f.options.filePath);
    const marker = { schema: 1, instanceId: crypto.randomUUID(), revision: 2, writeId: crypto.randomUUID() };
    const prepared = prepareNativeChatWrite(records, { beforeBytes: before?.bytes ?? null, marker });
    const payloadPath = path.join(f.directories.root, 'chat.after.jsonl');
    fs.writeFileSync(payloadPath, prepared.serialized);
    return { ...f.options, before, prepared, payloadPath, payloadHash: hash(prepared.serialized) };
}

test('managed publication uses frozen bytes and integrity through the existing backup writer', t => {
    const f = fixture(t);
    const changed = structuredClone(f.records);
    changed[1].mes = 'Frozen replacement';
    const input = managed(f, changed);
    const result = publishNativeChatWrite(input);
    assert.equal(result.integrity, input.prepared.integrity);
    assert.equal(result.file.bytes.toString('utf8'), input.prepared.serialized);
    assert.deepEqual(result.file.physical, input.before.physical);
    assert.deepEqual(result.records, input.prepared.records);
    assert.equal(result.records[2].swipes[1], 'Alternative.');
    assert.equal(fs.existsSync(f.options.filePath + '.neconyan-write-recovery'), false);
    const backup = fs.readdirSync(f.directories.backups).find(name => name.startsWith('chat_pre_write_'));
    assert.equal(fs.readFileSync(path.join(f.directories.backups, backup), 'utf8'), serialize(f.records));
    assert.throws(() => publishNativeChatWrite(input), { code: 'ESTALE' });
});

test('managed no-op preserves BOM, whitespace, missing integrity and physical identity', t => {
    const f = fixture(t);
    const raw = '\uFEFF\n{ "name": "Legacy" }\r\n{"mes":"Original"}\n';
    fs.writeFileSync(f.options.filePath, raw);
    const input = managed(f, f.current());
    const before = fs.statSync(f.options.filePath, { bigint: true });
    const result = publishNativeChatWrite(input);
    assert.equal(input.prepared.changed, false);
    assert.equal(result.integrity, '');
    assert.equal(fs.readFileSync(f.options.filePath, 'utf8'), raw);
    assert.equal(fs.statSync(f.options.filePath, { bigint: true }).mtimeNs, before.mtimeNs);
    assert.equal(Object.hasOwn(result.records[0].chat_metadata, 'neconyan_roleplay'), false);
});

test('managed finalisation uses the proven file without a staged payload or any chat write', t => {
    const f = fixture(t);
    const input = { ...managed(f, f.records), payloadPath: null, deferBackup: false };
    const before = readRoleplayFile(f.options.filePath);
    const stat = fs.statSync(f.options.filePath, { bigint: true });
    const write = fs.writeSync, rename = fs.renameSync;
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        const current = fs.fstatSync(fd, { bigint: true });
        assert.equal(current.dev === stat.dev && current.ino === stat.ino, false, 'Finalisation must not rewrite the chat');
        return write(fd, ...args);
    });
    t.mock.method(fs, 'renameSync', (from, to) => {
        assert.notEqual(to, f.options.filePath, 'Finalisation must not replace the chat');
        return rename(from, to);
    });
    const result = publishNativeChatWrite(input);
    assert.deepEqual(result.file, before);
    assert.equal(fs.statSync(f.options.filePath, { bigint: true }).mtimeNs, stat.mtimeNs);
    const backups = fs.readdirSync(f.directories.backups).filter(name => name.startsWith('chat_nova_'));
    assert.equal(backups.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.directories.backups, backups[0])), before.bytes);
    assert.deepEqual(fs.readFileSync(getChatRecoveryPaths(f.options.recoveryTarget).latestPath), before.bytes);
});

test('managed finalisation cannot introduce changed bytes, a new file or a different source', t => {
    const f = fixture(t);
    const changed = managed(f, [...f.records, { mes: 'Must not land' }]);
    assert.throws(() => publishNativeChatWrite({ ...changed, payloadPath: null }), TypeError);
    assert.throws(() => publishNativeChatWrite({ ...changed, payloadPath: null, prepared: { ...changed.prepared, changed: false } }));
    const unchanged = { ...managed(f, f.records), payloadPath: null };
    assert.throws(() => publishNativeChatWrite({ ...unchanged, before: null }), TypeError);
    assert.throws(() => publishNativeChatWrite({ ...unchanged, before: { ...unchanged.before, rawHash: '0'.repeat(64) } }), { code: 'ESTALE' });
    assert.deepEqual(readRoleplayFile(f.options.filePath), unchanged.before);
    assert.deepEqual(fs.readdirSync(f.directories.backups), []);
});

test('managed writes never invoke generic recovery before inspecting an unrelated journal', t => {
    const f = fixture(t);
    const input = managed(f, [...f.records, { mes: 'Must not land' }]);
    const journal = f.options.filePath + '.neconyan-write-recovery';
    const raw = JSON.stringify({ version: 1, dev: input.before.physical.dev, ino: input.before.physical.ino,
        originalHash: input.before.rawHash, nextHash: hash('other'), originalData: input.before.bytes.toString('base64') });
    fs.writeFileSync(journal, raw);
    assert.throws(() => publishNativeChatWrite(input), /explicit reconciliation/);
    assert.equal(fs.readFileSync(journal, 'utf8'), raw);
    assert.deepEqual(fs.readFileSync(f.options.filePath), input.before.bytes);
    assert.deepEqual(fs.readdirSync(f.directories.backups), []);
});

for (const mode of ['changed', 'unchanged', 'finalisation']) {
    test(`managed ${mode} publication requires an exact journal handoff and retains the journal`, t => {
        const f = fixture(t);
        const input = managed(f, mode === 'changed' ? [...f.records, { mes: 'New result' }] : f.records);
        if (mode === 'finalisation') input.payloadPath = null;
        const journal = f.options.filePath + '.neconyan-write-recovery';
        fs.writeFileSync(journal, 'Previously classified evidence');
        const observed = readRoleplayFile(journal);
        input.expectedJournal = { rawHash: observed.rawHash, physical: observed.physical };
        assert.throws(() => publishNativeChatWrite({ ...input, expectedJournal: { ...input.expectedJournal, rawHash: '0'.repeat(64) } }));
        assert.equal(publishNativeChatWrite(input).file.rawHash, input.payloadHash);
        assert.deepEqual(readRoleplayFile(journal), observed);
    });
}

test('managed journal handoff rejects an identical-byte journal replaced during lock acquisition', t => {
    const f = fixture(t);
    const input = managed(f, [...f.records, { mes: 'Must not land' }]);
    const journal = f.options.filePath + '.neconyan-write-recovery';
    fs.writeFileSync(journal, 'Original evidence');
    input.expectedJournal = readRoleplayFile(journal);
    let replaced = false;
    const mkdir = fs.mkdirSync;
    t.mock.method(fs, 'mkdirSync', (filename, ...args) => {
        if (!replaced && filename === path.dirname(f.options.filePath)) {
            replaced = true;
            fs.copyFileSync(journal, journal + '.new');
            fs.renameSync(journal + '.new', journal);
        }
        return mkdir(filename, ...args);
    });
    assert.throws(() => publishNativeChatWrite(input), /explicit reconciliation/);
    assert.equal(replaced, true);
    assert.deepEqual(readRoleplayFile(f.options.filePath), input.before);
    assert.notDeepEqual(readRoleplayFile(journal).physical, input.expectedJournal.physical);
});

test('guarded restoration requires the exact journal and never removes it', t => {
    const f = fixture(t);
    const before = readRoleplayFile(f.options.filePath);
    const journal = f.options.filePath + '.neconyan-write-recovery';
    fs.writeFileSync(journal, 'Classified restoration evidence');
    const observed = readRoleplayFile(journal);
    const bytes = Buffer.from(serialize([...f.records, { mes: 'Frozen restored output' }]));
    const options = { bytes, expectedSnapshotHash: hash(bytes), expectedActive: before };
    assert.throws(() => restoreChatSnapshotIfMatches(f.options.recoveryTarget, options), { code: 'ESTALE' });
    const restored = restoreChatSnapshotIfMatches(f.options.recoveryTarget, { ...options, expectedJournal: observed });
    assert.equal(restored.rawHash, options.expectedSnapshotHash);
    assert.deepEqual(readRoleplayFile(journal), observed);
});

test('guarded restoration rechecks the journal immediately before replacement', t => {
    const f = fixture(t);
    const before = readRoleplayFile(f.options.filePath);
    const journal = f.options.filePath + '.neconyan-write-recovery';
    fs.writeFileSync(journal, 'Original recovery evidence');
    const observed = readRoleplayFile(journal);
    const bytes = Buffer.from(serialize([...f.records, { mes: 'Must not land' }]));
    const open = fs.openSync;
    let replaced = false;
    t.mock.method(fs, 'openSync', (filename, flags, ...args) => {
        if (!replaced && flags === 'wx' && path.dirname(String(filename)) === path.dirname(f.options.filePath)
            && path.basename(String(filename)).startsWith('.neconyan-write-')) {
            replaced = true;
            fs.copyFileSync(journal, journal + '.new');
            fs.renameSync(journal + '.new', journal);
        }
        return open(filename, flags, ...args);
    });
    assert.throws(() => restoreChatSnapshotIfMatches(f.options.recoveryTarget, {
        bytes, expectedSnapshotHash: hash(bytes), expectedActive: before, expectedJournal: observed,
    }), error => error.chatWriteUncertain === true);
    assert.equal(replaced, true);
    assert.deepEqual(readRoleplayFile(f.options.filePath), before);
    assert.notDeepEqual(readRoleplayFile(journal).physical, observed.physical);
});

test('managed interrupted write retains its staged after-image without optional snapshots', t => {
    const f = fixture(t);
    const input = { ...managed(f, [...f.records, { mes: 'Frozen result' }]), recoveryTarget: null };
    const write = fs.writeSync;
    let writes = 0;
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        if (String(fs.fstatSync(fd).ino) === input.before.physical.ino && ++writes === 2) throw new Error('Fixture managed interruption');
        return write(fd, ...args);
    });
    assert.throws(() => publishNativeChatWrite(input), error => error.chatWriteUncertain === true && error.integrity === input.prepared.integrity);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(input.payloadPath, 'utf8'), input.prepared.serialized);
    assert.equal(fs.existsSync(f.options.filePath + '.neconyan-write-recovery'), false);
    assert.equal(readChatJsonlStrict(f.options.filePath).status, 'corrupt');
});

for (const code of ['ESTALE', 'EMLINK']) {
    for (const protectedWrite of [true, false]) {
        test(`${code} preserves ${protectedWrite ? 'managed interrupted output' : 'legacy mutation rollback'}`, t => {
            const f = fixture(t);
            const input = managed(f, [...f.records, { mes: 'Frozen result' }]);
            const before = readRoleplayFile(f.options.filePath);
            const write = fs.writeSync;
            let writes = 0;
            const mock = t.mock.method(fs, 'writeSync', (fd, ...args) => {
                const stat = fs.fstatSync(fd, { bigint: true });
                if (String(stat.dev) === before.physical.dev && String(stat.ino) === before.physical.ino && ++writes === 2) {
                    throw Object.assign(new Error('Interrupted active-file write'), { code });
                }
                return write(fd, ...args);
            });
            const run = protectedWrite ? () => publishNativeChatWrite(input)
                : () => mutateChat(f.options, records => [...records, { mes: 'Legacy result' }]);
            assert.throws(run, error => error.chatWriteUncertain === true);
            mock.mock.restore();
            const partial = Buffer.concat([Buffer.from([before.bytes[0] ^ 0xFF]), before.bytes.subarray(1)]);
            assert.equal(writes, protectedWrite ? 2 : 3);
            assert.deepEqual(readRoleplayFile(f.options.filePath).physical, before.physical);
            assert.deepEqual(fs.readFileSync(f.options.filePath), protectedWrite ? partial : before.bytes);
            const backups = fs.readdirSync(f.directories.backups).filter(name => name.startsWith('chat_pre_write_'));
            assert.equal(backups.length, 1);
            assert.deepEqual(fs.readFileSync(path.join(f.directories.backups, backups[0])), before.bytes);
            assert.equal(fs.existsSync(f.options.filePath + '.neconyan-write-recovery'), false);
        });
    }
}

test('managed creation refuses collisions and preserves uncertain partial creations', t => {
    const f = fixture(t);
    const input = managed(f, f.records, true);
    assert.throws(() => publishNativeChatWrite(input), { code: 'ESTALE' });
    assert.deepEqual(fs.readdirSync(f.directories.backups), []);
    fs.unlinkSync(f.options.filePath);
    const write = fs.writeSync;
    let writes = 0;
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        if (fs.existsSync(f.options.filePath) && fs.fstatSync(fd).ino === fs.statSync(f.options.filePath).ino) {
            if (++writes === 1) return write(fd, args[0], args[1], 1, args[3]);
            throw new Error('Fixture interrupted creation');
        }
        return write(fd, ...args);
    });
    assert.throws(() => publishNativeChatWrite(input), error => error.chatWriteUncertain === true);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(f.options.filePath).length, 1);
    assert.throws(() => publishNativeChatWrite(input), { code: 'ESTALE' });
});

test('managed creation uses the prepared marker, strips foreign authority and skips ordinary memory capture', t => {
    const f = fixture(t);
    const records = structuredClone(f.records);
    records[0].chat_metadata.neconyan_roleplay = { foreign: true };
    records[0].chat_metadata.main_chat = 'Damaged parent';
    const input = managed(f, records, true);
    fs.unlinkSync(f.options.filePath);
    const result = publishNativeChatWrite(input);
    assert.equal(result.records[0].chat_metadata.neconyan_roleplay.schema, 1);
    assert.equal(result.records[0].chat_metadata.neconyan_roleplay.foreign, undefined);
    assert.equal(result.file.rawHash, input.payloadHash);
    assert.equal(result.records[0].chat_metadata.main_chat, 'Damaged parent');
});

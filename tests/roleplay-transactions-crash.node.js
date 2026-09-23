/* eslint playwright/expect-expect: off -- Node assertions verify real killed writer processes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, memoryParent, writeJournal } from './roleplay-transactions-fixture.js';

const { readRoleplayAccount, readRoleplayFile, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { commitSingleChatWrite, reconcileSingleChatWrite, cleanupRoleplayReceipts } = await import('../src/roleplay-lifecycle.js');
const { prepareNativeChatWrite, publishNativeChatWrite } = await import('../src/endpoints/chats.js');
const { canonicalMemoryPaths } = await import('../src/mewmory/prepared-branch.js');
const host = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite };
const worker = fileURLToPath(new URL('./roleplay-transactions-crash-worker.js', import.meta.url));

async function killAt(f, input, boundary, { filename = f.filename, memory, reconcile = false } = {}) {
    const specPath = path.join(f.root, 'crash-input.json');
    fs.writeFileSync(specPath, JSON.stringify({ scope: f.scope, input, boundary, filename, memory, reconcile }));
    const child = spawn(process.execPath, [worker, specPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`No ${boundary} pause: ${stdout}\n${stderr}`)), 10000);
            child.stdout.on('data', chunk => {
                stdout += chunk;
                if (stdout.includes(JSON.stringify({ boundary }))) {
                    clearTimeout(timer);
                    resolve();
                }
            });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Worker exited before kill (${code}, ${signal}): ${stdout}\n${stderr}`)); });
        });
        assert.equal(child.kill('SIGKILL'), true);
        assert.deepEqual(await exited, [null, 'SIGKILL']);
    } finally {
        // This completes before an error can reach the fixture's earlier-registered removal hook.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
    }
    // Test-only acceleration after verified death. Production's five-minute stale-lock policy is unchanged.
    let aged = 0;
    function ageDeadLocks(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const filename = path.join(directory, entry.name);
            if (/^\.sillybunny-chat-[a-f0-9]{64}\.lock$/.test(entry.name)) {
                const old = new Date(Date.now() - 600000);
                fs.utimesSync(filename, old, old);
                aged++;
            } else ageDeadLocks(filename);
        }
    }
    ageDeadLocks(f.root);
    assert.ok(aged > 0, 'the killed writer held real filesystem locks');
}

function noRewrite(filenames, operation) {
    const before = filenames.map(filename => ({ filename, file: readRoleplayFile(filename), stats: fs.statSync(filename, { bigint: true }) }));
    const write = fs.writeSync, rename = fs.renameSync;
    fs.writeSync = (fd, ...args) => {
        const stats = fs.fstatSync(fd, { bigint: true });
        assert.equal(before.some(file => file.stats.dev === stats.dev && file.stats.ino === stats.ino), false, 'reconciliation must not rewrite a published output');
        return write(fd, ...args);
    };
    fs.renameSync = (from, to) => {
        assert.equal(filenames.includes(to), false, 'reconciliation must not replace a published output');
        return rename(from, to);
    };
    let result;
    try { result = operation(); } finally { fs.writeSync = write; fs.renameSync = rename; }
    for (const previous of before) {
        assert.deepEqual(readRoleplayFile(previous.filename), previous.file);
        assert.equal(fs.statSync(previous.filename, { bigint: true }).mtimeNs, previous.stats.mtimeNs);
    }
    return result;
}

function assertFinished(f, result) {
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.pending, null);
    const receipts = Object.values(state.submissions);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'closed');
    assert.deepEqual(receipts[0].outcome, result);
    assert.deepEqual(Object.values(receipts[0].effects)[0].result, result);
    const file = readRoleplayFile(f.filename);
    const resource = state.resources[result.instanceId];
    assert.equal(resource.revision, result.revision);
    assert.equal(resource.head.rawHash, file.rawHash);
    assert.deepEqual(resource.head.physical, file.physical);
    assert.equal(f.source().instanceId, result.instanceId);
}

for (const boundary of ['payload-durable', 'pending-durable', 'partial-update', 'chat-durable', 'receipt-durable']) {
    test(`real writer death at ${boundary} preserves one exact chat outcome`, { timeout: 20000 }, async t => {
        const f = fixture(t);
        const input = f.input();
        const before = fs.readFileSync(f.filename);
        await killAt(f, input, boundary);
        const interrupted = readRoleplayAccount(f.scope);
        const pending = interrupted.pending;
        if (['payload-durable', 'pending-durable'].includes(boundary)) assert.deepEqual(fs.readFileSync(f.filename), before);
        if (boundary === 'payload-durable') {
            assert.equal(pending, null);
            assert.equal(Object.keys(interrupted.submissions).length, 0);
        } else if (boundary !== 'receipt-durable') assert.ok(pending);
        const alreadyApplied = ['chat-durable', 'receipt-durable'].includes(boundary);
        if (alreadyApplied) {
            const expectedHash = pending?.after.rawHash ?? Object.values(interrupted.submissions)[0].outcome.rawHash;
            assert.equal(readRoleplayFile(f.filename).rawHash, expectedHash, 'after-image exists before recovery');
        }
        const result = noRewrite(alreadyApplied ? [f.filename] : [], () => boundary === 'payload-durable'
            ? commitSingleChatWrite(f.scope, input, host)
            : reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, ...(alreadyApplied ? { publish() { assert.fail('Already-applied work cannot publish again'); } } : {}) }));
        const saved = readRoleplayFile(f.filename);
        assert.equal(saved.rawHash, result.rawHash);
        if (pending) {
            assert.equal(result.rawHash, pending.after.rawHash);
            assert.equal(result.integrity, pending.after.integrity);
        }
        assert.equal(saved.bytes.toString().split('\n').filter(row => JSON.parse(row).mes === 'New result').length, 1);
        assertFinished(f, result);
        assert.deepEqual(noRewrite([f.filename], () => commitSingleChatWrite(f.scope, input, host)), result);
        assert.deepEqual(readRoleplayFile(f.filename), saved);
    });
}

for (const mode of ['update', 'create']) {
    for (const boundary of ['chat-durable', 'backup-published']) {
        test(`real writer death at ${boundary} finishes the ${mode} backup without rewriting output`, { timeout: 20000 }, async t => {
            const f = fixture(t, false, `unacknowledged-backup-${mode}-${boundary}`);
            const filename = mode === 'update' ? f.filename : path.join(path.dirname(f.filename), 'New.jsonl');
            const input = mode === 'update' ? { ...f.input(), backup: { deferBackup: false } }
                : { operationKey: 'create', mode, destination: { ...f.locator, chat: 'New' }, expectedVacancy: 0,
                    records: f.records, backup: { deferBackup: false } };
            await killAt(f, input, boundary, { filename });
            const pending = readRoleplayAccount(f.scope).pending;
            const saved = readRoleplayFile(filename);
            assert.equal(pending.phase, 'prepared');
            assert.equal(saved.rawHash, pending.after.rawHash);
            const backups = () => fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_'));
            assert.equal(backups().length, boundary === 'chat-durable' ? 0 : 1);
            fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl'));
            let finalisations = 0;
            const result = noRewrite([filename], () => reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish(options) {
                finalisations++;
                assert.equal(options.payloadPath, null);
                assert.equal(options.prepared.changed, false);
                return host.publish(options);
            } }));
            assert.equal(finalisations, 1);
            assert.equal(result.changed, true);
            assert.equal(result.mode, mode);
            assert.equal(backups().length, 1);
            assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.backups, backups()[0])), saved.bytes);
            const state = readRoleplayAccount(f.scope);
            assert.equal(state.pending, null);
            assert.deepEqual(Object.values(state.submissions)[0].outcome, result);
            assert.deepEqual(noRewrite([filename], () => commitSingleChatWrite(f.scope, input, { ...host, publish() { assert.fail('Closed receipt must not publish'); } })), result);
        });
    }
}

for (const boundary of ['before-memory-guard', 'memory-guard-durable', 'memory-archive-durable']) {
    test(`real writer death at ${boundary} retains the frozen memory branch`, { timeout: 20000 }, async t => {
        const f = fixture(t);
        memoryParent(f);
        const input = f.input();
        input.records[0].chat_metadata.main_chat = 'Parent';
        const memory = canonicalMemoryPaths(f.scope.directories, f.locator);
        await killAt(f, input, boundary, { memory });
        const pending = readRoleplayAccount(f.scope).pending;
        assert.equal(pending.phase, 'chat-applied');
        const chat = readRoleplayFile(f.filename);
        assert.equal(chat.rawHash, pending.after.rawHash);
        assert.equal(fs.existsSync(memory.guard), boundary !== 'before-memory-guard');
        assert.equal(fs.existsSync(memory.archive), boundary === 'memory-archive-durable');
        const existing = [f.filename, ...[memory.guard, memory.archive].filter(filename => fs.existsSync(filename))];
        if (fs.existsSync(memory.guard)) assert.equal(readRoleplayFile(memory.guard).rawHash, pending.memory.guardHash);
        if (fs.existsSync(memory.archive)) assert.equal(readRoleplayFile(memory.archive).rawHash, pending.memory.archiveHash);
        const result = noRewrite(existing, () => reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish() { assert.fail('Chat was already published'); } }));
        assertFinished(f, result);
        assert.equal(readRoleplayFile(memory.archive).rawHash, pending.memory.archiveHash);
        assert.equal(readRoleplayFile(memory.guard).rawHash, pending.memory.guardHash);
        assert.equal(JSON.parse(fs.readFileSync(memory.archive)).branchId, pending.memory.branchId);
        assert.deepEqual(readRoleplayFile(f.filename), chat);
        assert.deepEqual(noRewrite([f.filename, memory.guard, memory.archive], () => commitSingleChatWrite(f.scope, input, host)), result);
    });
}

test('real writer death during exclusive creation retains partial evidence and refuses replay', { timeout: 20000 }, async t => {
    const f = fixture(t);
    const filename = path.join(path.dirname(f.filename), 'New.jsonl');
    const input = { operationKey: 'create', mode: 'create', destination: { ...f.locator, chat: 'New' }, expectedVacancy: 0,
        records: f.records, backup: { deferBackup: true } };
    await killAt(f, input, 'partial-create', { filename });
    const partial = readRoleplayFile(filename);
    assert.equal(partial.bytes.length, 1);
    const pending = readRoleplayAccount(f.scope).pending;
    assert.ok(pending);
    assert.throws(() => reconcileSingleChatWrite(f.scope, input.operationKey, host), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(readRoleplayFile(filename), partial);
    assert.deepEqual(readRoleplayAccount(f.scope).pending, pending);
});

for (const changed of [true, false]) {
    test(`real writer death after guarded ${changed ? 'changed' : 'unchanged'} restoration recognises the replacement inode`, { timeout: 20000 }, async t => {
        const f = fixture(t);
        const input = { ...f.input(), ...(!changed ? { records: f.records } : {}) };
        assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish() { throw new Error('Pause'); } }), /Pause/);
        const pending = readRoleplayAccount(f.scope).pending;
        const payloadPath = path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl');
        const expected = fs.readFileSync(payloadPath);
        fs.writeFileSync(f.filename, 'interrupted JSONL');
        const corrupt = readRoleplayFile(f.filename);
        await killAt(f, input, 'restore-published', { reconcile: true });
        const restored = readRoleplayFile(f.filename);
        assert.deepEqual(restored.bytes, expected);
        assert.notDeepEqual(restored.physical, corrupt.physical);
        assert.equal(readRoleplayAccount(f.scope).pending.repair.rawHash, corrupt.rawHash);
        fs.unlinkSync(payloadPath);
        let finalisations = 0;
        const result = noRewrite([f.filename], () => reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish(options) {
            finalisations++;
            assert.equal(options.payloadPath, null);
            assert.equal(options.prepared.changed, false);
            return host.publish(options);
        } }));
        assert.equal(finalisations, 1);
        assert.equal(result.changed, changed);
        assertFinished(f, result);
        assert.deepEqual(readRoleplayFile(f.filename), restored);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
    });
}

test('real writer death after a restored closing backup neither rewrites output nor duplicates its backup', { timeout: 20000 }, async t => {
    const f = fixture(t, false, 'restored-closing-backup');
    const backup = { deferBackup: true, deferSequenceId: 'sequence' };
    commitSingleChatWrite(f.scope, { ...f.input(), backup }, host);
    const bytes = fs.readFileSync(f.filename);
    const records = bytes.toString().split('\n').map(JSON.parse);
    const input = { operationKey: 'close-sequence', mode: 'update', source: f.source(), records, backup: { ...backup, deferBackup: false } };
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish() { throw new Error('Pause'); } }), /Pause/);
    fs.writeFileSync(f.filename, '!interrupted closing save');
    await killAt(f, input, 'backup-published', { reconcile: true });
    assert.equal(readRoleplayAccount(f.scope).pending.phase, 'prepared');
    const regular = () => fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_nova_'));
    assert.equal(regular().length, 1);
    const result = noRewrite([f.filename], () => reconcileSingleChatWrite(f.scope, input.operationKey, host));
    assert.equal(result.changed, false);
    assert.equal(regular().length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.backups, regular()[0])), bytes);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.deepEqual(commitSingleChatWrite(f.scope, input, { ...host, publish() { assert.fail('Closed receipt must not publish'); } }), result);
    commitSingleChatWrite(f.scope, { ...input, operationKey: 'next-sequence', source: f.source(), backup,
        records: [...records, { name: 'Nova', is_user: false, mes: 'A new run' }] }, host);
    assert.equal(fs.readdirSync(f.scope.directories.backups).filter(name => name.startsWith('chat_pre_write_nova_')).length, 2);
});

test('real writer death after recording a matching journal retains both exact before-images', { timeout: 20000 }, async t => {
    const f = fixture(t);
    const input = f.input();
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish() { throw new Error('Pause'); } }), /Pause/);
    const journal = writeJournal(f);
    const before = readRoleplayFile(f.filename);
    await killAt(f, input, 'journal-recorded', { reconcile: true });
    const pending = readRoleplayAccount(f.scope).pending;
    assert.equal(pending.journal.rawHash, journal.rawHash);
    assert.deepEqual(pending.journal.physical, journal.physical);
    assert.deepEqual(readRoleplayFile(f.filename), before);
    assert.deepEqual(readRoleplayFile(journal.filename), { bytes: journal.bytes, rawHash: journal.rawHash, physical: journal.physical });
    const result = reconcileSingleChatWrite(f.scope, input.operationKey, host);
    assertFinished(f, result);
    assert.equal(fs.existsSync(journal.filename), false);
});

for (const changed of [true, false]) {
    test(`real writer death after ${changed ? 'changed' : 'unchanged'} restoration keeps its recorded journal handoff`, { timeout: 20000 }, async t => {
        const f = fixture(t);
        const input = { ...f.input(), records: changed ? f.input().records : f.records };
        assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish() { throw new Error('Pause'); } }), /Pause/);
        const journal = writeJournal(f);
        fs.writeFileSync(f.filename, '!interrupted journal write');
        await killAt(f, input, 'restore-published', { reconcile: true });
        const pending = readRoleplayAccount(f.scope).pending;
        assert.equal(pending.journal.rawHash, journal.rawHash);
        assert.equal(fs.existsSync(journal.filename), true);
        fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id, 'chat.after.jsonl'));
        const result = noRewrite([f.filename], () => reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish(options) {
            assert.equal(options.payloadPath, null);
            assert.equal(options.prepared.changed, false);
            assert.deepEqual(options.expectedJournal, { rawHash: journal.rawHash, physical: journal.physical });
            return host.publish(options);
        } }));
        assert.equal(result.changed, changed);
        assertFinished(f, result);
        assert.equal(fs.existsSync(journal.filename), false);
    });
}

for (const boundary of ['receipt-durable', 'payload-unlinked', 'journal-unlinked']) {
    test(`real writer death at ${boundary} retries closed cleanup without accessing chat output`, { timeout: 20000 }, async t => {
        const f = fixture(t);
        memoryParent(f);
        const input = f.input();
        input.records[0].chat_metadata.main_chat = 'Parent';
        assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish() { throw new Error('Pause'); } }), /Pause/);
        const pending = readRoleplayAccount(f.scope).pending;
        const journal = writeJournal(f);
        fs.writeFileSync(f.filename, '!interrupted with frozen memory');
        await killAt(f, input, boundary, { reconcile: true });
        const state = readRoleplayAccount(f.scope);
        assert.equal(state.pending, null);
        const receipt = Object.values(state.submissions)[0];
        assert.equal(receipt.state, 'closed');
        assert.equal(Object.values(receipt.effects)[0].cleanup.journal.rawHash, journal.rawHash);
        assert.equal(fs.existsSync(journal.filename), boundary !== 'journal-unlinked');
        const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
        const savedReceipt = fs.readFileSync(statePath);
        const memory = canonicalMemoryPaths(f.scope.directories, f.locator);
        const result = noRewrite([f.filename, memory.guard, memory.archive], () => {
            const open = fs.openSync, lstat = fs.lstatSync;
            const openMock = t.mock.method(fs, 'openSync', (filename, ...args) => { assert.notEqual(filename, f.filename); return open(filename, ...args); });
            const statMock = t.mock.method(fs, 'lstatSync', (filename, ...args) => { assert.notEqual(filename, f.filename); return lstat(filename, ...args); });
            try {
                const value = reconcileSingleChatWrite(f.scope, input.operationKey, { ...host, publish() { assert.fail('Closed output cannot be published'); } });
                cleanupRoleplayReceipts(f.scope);
                return value;
            } finally { openMock.mock.restore(); statMock.mock.restore(); }
        });
        assert.deepEqual(result, receipt.outcome);
        assertFinished(f, result);
        assert.deepEqual(fs.readFileSync(statePath), savedReceipt);
        assert.equal(fs.existsSync(journal.filename), false);
        assert.deepEqual(fs.readdirSync(path.join(roleplayStoreDirectory(f.scope), 'pending', pending.id)), ['chat.corrupt.jsonl']);
    });
}

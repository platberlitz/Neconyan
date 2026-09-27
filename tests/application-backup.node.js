import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import yauzl from 'yauzl';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
const { captureAccountBackup } = await import('../src/operations/account-backup.js');
const { readOperation, admitOperation } = await import('../src/operations/store.js');
const { openSavedBinary } = await import('../src/operations/binary-files.js');
const { getJob } = await import('../src/jobs/store.js');
const { inspectRoleplayFile, readRoleplayFile, roleplayStoreDirectory, resetRoleplayAccount } = await import('../src/roleplay-store.js');

function setup(t, owner = 'fixture') {
    const f = fixture(t, false, owner);
    const base = { owner, directories: f.scope.directories };
    fs.writeFileSync(path.join(base.directories.root, 'settings.json'), JSON.stringify({ name1: 'User' }));
    const request = { user: { profile: { handle: owner }, directories: base.directories } };
    const context = job => ({ ...base, job: getJob(base.directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const accept = key => acceptApplicationOperation(request, { key, kind: 'account-backup', handle: owner });
    return { f, base, request, context, accept };
}

async function unzip(bytes) {
    return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        const files = {};
        zip.on('error', reject); zip.on('end', () => resolve(files));
        zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
            if (error) return reject(error);
            const chunks = [];
            stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => { files[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
        }));
        zip.readEntry();
    }));
}

function readDownload(base, key) {
    const output = openSavedBinary(base, key);
    try { return { ...output, bytes: fs.readFileSync(output.fd) }; }
    finally { fs.closeSync(output.fd); }
}

test('native backup retains exact chat alternatives and can be downloaded after job pruning', async t => {
    const p = setup(t); const original = fs.readFileSync(p.f.filename);
    const accepted = await p.accept('backup');
    await runOperation(p.context(accepted.job));
    const output = readDownload(p.base, 'backup');
    const files = await unzip(output.bytes);
    assert.deepEqual(files['chats/Nova/Source.jsonl'], original);
    assert.deepEqual(JSON.parse(files['chats/Nova/Source.jsonl'].toString().split('\n')[2]).swipes, ['Answer', 'Other']);
    assert.equal(Object.keys(files).some(name => name.startsWith('jobs/')), false);
    fs.unlinkSync(p.f.filename);
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    fs.rmSync(path.join(p.base.directories.root, 'jobs/artifacts'), { recursive: true });
    const duplicate = await p.accept('backup');
    assert.equal(duplicate.job, null);
    assert.equal(duplicate.record.state, 'completed');
    assert.deepEqual(readDownload(p.base, 'backup').bytes, output.bytes);
    assert.equal(fs.existsSync(p.f.filename), false);
});

test('backup refuses changed or linked sources without replacing the original account files', async t => {
    const p = setup(t); const accepted = await p.accept('changed');
    fs.writeFileSync(p.f.filename, 'A newer source.');
    await assert.rejects(runOperation(p.context(accepted.job)), /backup source changed/i);
    assert.equal(fs.readFileSync(p.f.filename, 'utf8'), 'A newer source.');
    assert.throws(() => openSavedBinary(p.base, 'changed'), /unavailable/);
    fs.symlinkSync(p.f.filename, path.join(p.base.directories.root, 'linked.jsonl'));
    await assert.rejects(p.accept('linked'), /linked source/);
    assert.equal(readOperation(p.base, 'linked'), null);
});

test('published backup recovery never rebuilds from later sources or recreates a deleted download', async t => {
    const p = setup(t); const accepted = await p.accept('lost-ack');
    await assert.rejects(runOperation(p.context(accepted.job), { afterBinaryPublication: () => { throw new Error('Lost publication acknowledgement'); } }), /Lost publication/);
    const partial = readOperation(p.base, 'lost-ack');
    const effect = partial.effects['binary:account-backup'];
    assert.ok(effect.publication);
    fs.unlinkSync(p.f.filename);
    await runOperation(p.context(accepted.job));
    const output = readDownload(p.base, 'lost-ack');
    assert.ok((await unzip(output.bytes))['chats/Nova/Source.jsonl']);
    fs.unlinkSync(output.filename);
    await runOperation(p.context(accepted.job));
    assert.equal(fs.existsSync(output.filename), false);
    assert.throws(() => openSavedBinary(p.base, 'lost-ack'), /replaced or removed/);
});

test('secret exposure policy is frozen before archive generation', async t => {
    const p = setup(t);
    fs.writeFileSync(path.join(p.base.directories.root, 'secrets.json'), '{"api":"private"}');
    fs.writeFileSync(path.join(p.base.directories.backups, 'secrets_migration_old.json'), '{"api":"older-private"}');
    const plan = captureAccountBackup(p.base, p.f.scope, { handle: p.base.owner }, { includeSecrets: false });
    const accepted = admitOperation(p.base, p.f.scope, { key: 'no-secrets', kind: 'account-backup', input: {}, plan, label: 'Test backup' });
    await runOperation(p.context(accepted.job));
    const files = await unzip(readDownload(p.base, 'no-secrets').bytes);
    assert.equal(files['secrets.json'], undefined);
    assert.equal(files['backups/secrets_migration_old.json'], undefined);
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'secrets.json'), 'utf8'), '{"api":"private"}');
});

test('binary downloads are account-bound and reset invalidates old download authority', async t => {
    const alice = setup(t, 'alice'); const bob = setup(t, 'bob');
    await assert.rejects(acceptApplicationOperation(alice.request, { key: 'foreign', kind: 'account-backup', handle: 'bob' }), /administrator/);
    const accepted = await alice.accept('owned'); await runOperation(alice.context(accepted.job));
    assert.throws(() => openSavedBinary(bob.base, 'owned'), /unavailable/);
    const filename = readDownload(alice.base, 'owned').filename;
    resetRoleplayAccount(alice.base, alice.f.scope, 'reset');
    assert.equal(fs.existsSync(filename), true);
    assert.throws(() => openSavedBinary(alice.base, 'owned'), /earlier account state/);
});

test('allocation corruption refuses another backup and preserves all previous binary evidence', async t => {
    const p = setup(t); const accepted = await p.accept('first'); await runOperation(p.context(accepted.job));
    const output = readDownload(p.base, 'first');
    const root = path.join(roleplayStoreDirectory(p.base), 'application-binaries');
    const filename = fs.readdirSync(root).find(name => name.endsWith('.json'));
    fs.writeFileSync(path.join(root, filename), 'damaged allocation');
    const second = await p.accept('second');
    await assert.rejects(runOperation(p.context(second.job)), /allocation needs recovery/);
    assert.deepEqual(fs.readFileSync(output.filename), output.bytes);
    assert.equal(fs.readFileSync(path.join(root, filename), 'utf8'), 'damaged allocation');
});

test('streaming inspection has the same physical and content evidence without retaining binary bytes', t => {
    const p = setup(t); const filename = path.join(p.base.directories.root, 'large.bin');
    fs.writeFileSync(filename, Buffer.alloc(3 * 1024 * 1024 + 17, 43));
    const read = readRoleplayFile(filename, 4 * 1024 * 1024);
    const inspected = inspectRoleplayFile(filename, 4 * 1024 * 1024);
    assert.equal(inspected.rawHash, read.rawHash);
    assert.deepEqual(inspected.physical, read.physical);
    assert.equal(inspected.size, read.bytes.length);
    assert.equal(inspected.bytes, undefined);
});

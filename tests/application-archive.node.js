import { authoringRenameTest, assertSavedAuthoring, simulateAuthoringRename } from './authoring-rename-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
const { readArchiveFile, readArchiveOrganization } = await import('../src/operations/archive.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');
const { publishAccountFile } = await import('../src/operations/file-publication.js');
const { roleplayHash } = await import('../src/roleplay-store.js');

function setup(t, owner = 'fixture') {
    const f = fixture(t, false, owner); const directories = f.scope.directories;
    directories.files = path.join(directories.root, 'user/files'); fs.mkdirSync(directories.files, { recursive: true });
    const base = { owner, directories }; const request = { user: { profile: { handle: owner }, directories } };
    const context = job => ({ ...base, job: getJob(directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const accept = (key, kind, input = {}) => acceptApplicationOperation(request, { key, kind, ...input });
    const run = async (key, kind, input = {}) => { const accepted = await accept(key, kind, input); await runOperation(context(accepted.job)); return readOperation(base, key); };
    return { f, base, request, context, accept, run };
}

test('archive metadata is retained after source deletion and job pruning without mutable pagination', async t => {
    const p = setup(t);
    const accepted = await p.accept('inventory', 'archive-inventory', { scope: 'archive' });
    fs.unlinkSync(p.f.filename);
    await runOperation(p.context(accepted.job));
    const saved = readOperation(p.base, 'inventory');
    assert.equal(saved.result.rows.length, 1);
    assert.equal(saved.result.rows[0].avatar, 'Nova.png');
    assert.equal(saved.result.rows[0].file_name, 'Source.jsonl');
    assert.throws(() => readArchiveFile(p.base, saved.key, saved.result.rows[0].archive_hash), /changed after/);
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    fs.rmSync(path.join(p.base.directories.root, 'jobs/artifacts'), { recursive: true });
    const duplicate = await p.accept('inventory', 'archive-inventory', { scope: 'archive' });
    assert.equal(duplicate.job, null);
    assert.deepEqual(duplicate.record.result, saved.result);
});

test('archive inventory keeps chat settings and long messages out of the saved plan and result', async t => {
    const p = setup(t);
    const header = { chat_metadata: { variables: { notes: 'v'.repeat(2 * 1024 * 1024) } } };
    fs.writeFileSync(p.f.filename, `${JSON.stringify(header)}\n${JSON.stringify({ mes: `  Opening   line\n${'word '.repeat(400)}`, send_date: 'June 2, 2026' })}\n`);
    const saved = await p.run('inventory', 'archive-inventory', { scope: 'archive' });
    assert.ok(Buffer.byteLength(JSON.stringify(saved.plan)) < 4096);
    assert.equal(Object.hasOwn(saved.plan.files[0].row, 'file_name'), false);
    const [row] = saved.result.rows;
    assert.equal(Object.hasOwn(row, 'chat_metadata'), false);
    assert.equal(row.mes.length, 180);
    assert.match(row.mes, /^Opening line word word .*\.\.\.$/);
    assert.deepEqual({ source: row._source, id: row.file_id, name: row.file_name, hash: row.archive_hash, items: row.chat_items },
        { source: 'archive-inventory', id: 'Source', name: 'Source.jsonl', hash: saved.plan.files[0].hash, items: 1 });
    assert.match(readArchiveFile(p.base, saved.key, row.archive_hash).bytes.toString(), /"variables"/);
});

test('saved orphan reads reject later file replacements and another account', async t => {
    const alice = setup(t, 'alice'); const bob = setup(t, 'bob');
    for (const p of [alice, bob]) {
        const directory = path.join(p.base.directories.chats, 'Missing'); fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'Orphan.jsonl'), `${JSON.stringify({ chat_metadata: {} })}\n${JSON.stringify({ mes: p.base.owner })}`);
    }
    const a = await alice.run('inventory', 'archive-inventory', { scope: 'orphans' });
    await bob.run('inventory', 'archive-inventory', { scope: 'orphans' });
    const hash = a.result.rows[0].archive_hash;
    assert.match(readArchiveFile(alice.base, a.key, hash).bytes.toString(), /alice/);
    // Identical relative paths are scoped by the authenticated account's permanent record.
    assert.match(readArchiveFile(bob.base, a.key, hash).bytes.toString(), /bob/);
    fs.unlinkSync(path.join(alice.base.directories.chats, 'Missing/Orphan.jsonl'));
    fs.writeFileSync(path.join(alice.base.directories.chats, 'Missing/Orphan.jsonl'), 'Later file');
    assert.throws(() => readArchiveFile(alice.base, a.key, hash), /changed after/);
    assert.throws(() => readArchiveFile(bob.base, 'alice-only', hash), /not in the saved/);
});

test('one saved content search covers linked and orphan chats and preserves damaged-line evidence', async t => {
    const p = setup(t); const directory = path.join(p.base.directories.chats, 'Missing'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'Orphan.jsonl'), '{}\n{"mes":"Lunar flowers"}\nBROKEN\n{"mes":"grow in gardens"}\n');
    const saved = await p.run('search', 'archive-search', { query: 'lunar gardens' });
    assert.equal(saved.result.rows.length, 1);
    assert.equal(saved.result.errors, 1);
    assert.equal(saved.result.rows[0].orphan_type, 'missing-character');
    assert.equal(saved.result.rows[0].mes, 'Lunar flowers');
});

test('archive exports retain the captured selected swipes and do not read a later replacement', async t => {
    const p = setup(t); const original = fs.readFileSync(p.f.filename, 'utf8');
    const accepted = await p.accept('export', 'archive-export', { is_group: false, avatar_url: 'Nova.png', file: 'Source.jsonl', format: 'jsonl' });
    fs.writeFileSync(p.f.filename, 'Later file');
    await runOperation(p.context(accepted.job));
    assert.equal(readOperation(p.base, 'export').result.result, original);
    assert.equal(fs.readFileSync(p.f.filename, 'utf8'), 'Later file');
});

authoringRenameTest('archive organisation publication recovers a lost acknowledgement without resurrecting a deleted file', async t => {
    const p = setup(t); const current = readArchiveOrganization(p.base);
    const accepted = await p.accept('organization', 'archive-organization', { revision: current.revision, organization: { version: 1, chats: {}, folders: [], savedViews: [] } });
    await assert.rejects(runOperation(p.context(accepted.job), { afterFilePublication: () => { throw new Error('Lost acknowledgement'); } }), /Lost acknowledgement/);
    assertSavedAuthoring(p.base.directories.root, readOperation(p.base, 'organization').effects);
    const file = path.join(p.base.directories.files, '_sbca_organization.json');
    assert.equal(fs.existsSync(file), true);
    await runOperation(p.context(accepted.job));
    const saved = readOperation(p.base, 'organization');
    assert.equal(saved.result.revision, readArchiveOrganization(p.base).revision);
    await assert.rejects(p.accept('stale', 'archive-organization', { revision: current.revision, organization: {} }), /changed in another window/);
    fs.unlinkSync(file);
    await runOperation(p.context(accepted.job));
    assert.equal(fs.existsSync(file), false);
});

for (const savesFirst of [false, true]) {
    test(`account-file witness and derived revision survive checkpoint failure only when actually persisted: ${savesFirst}`, async t => {
        const p = setup(t), current = readArchiveOrganization(p.base);
        const accepted = await p.accept('checkpoint', 'archive-organization', { revision: current.revision,
            organization: { version: 1, chats: {}, folders: [], savedViews: [] } });
        const context = p.context(accepted.job), plan = readOperation(p.base, 'checkpoint').plan;
        let published = false, injected = false;
        simulateAuthoringRename(t, { afterRename(_from, to) {
            if (path.basename(to) === '_sbca_organization.json') published = true;
        } });
        const rename = fs.renameSync;
        const failure = new Error('Checkpoint persistence fault');
        t.mock.method(fs, 'renameSync', (from, to) => {
            if (published && !injected && path.basename(path.dirname(to)) === 'operations') {
                injected = true;
                if (savesFirst) rename(from, to);
                throw failure;
            }
            return rename(from, to);
        });
        assert.throws(() => publishAccountFile(context, plan), error => error === failure);
        assert.equal(injected, true);
        const persisted = readOperation(p.base, 'checkpoint');
        assert.equal(persisted.effects.file.state, 'prepared');
        assert.equal(persisted.fileResult.revision, roleplayHash(persisted.effects.file.staged.after));
        const actual = readArchiveOrganization(p.base).revision;
        if (savesFirst) {
            assert.equal(persisted.fileResult.revision, actual);
            assertSavedAuthoring(p.base.directories.root, persisted.effects);
            assert.equal(publishAccountFile(context, plan).revision, actual);
        } else {
            assert.notEqual(persisted.fileResult.revision, actual);
            assert.throws(() => publishAccountFile(context, plan), { code: 'AUTHORING_SOURCE_CHANGED' });
            assert.equal(readArchiveOrganization(p.base).revision, actual);
        }
    });
}

test('ambiguous or malformed group ownership refuses an archive scan instead of inventing orphan status', async t => {
    const p = setup(t);
    fs.writeFileSync(path.join(p.base.directories.groups, 'one.json'), JSON.stringify({ id: 'one', chats: ['Scene'] }));
    fs.writeFileSync(path.join(p.base.directories.groups, 'two.json'), JSON.stringify({ id: 'two', chats: ['Scene'] }));
    await assert.rejects(p.accept('ambiguous', 'archive-inventory', { scope: 'all' }), /More than one group/);
    fs.unlinkSync(path.join(p.base.directories.groups, 'two.json'));
    fs.writeFileSync(path.join(p.base.directories.groups, 'one.json'), '{bad');
    await assert.rejects(p.accept('bad', 'archive-inventory', { scope: 'all' }), /could not be read/);
});

test('archive inventory refuses symbolic and hard-linked sources without issuing reusable file authority', async t => {
    const p = setup(t);
    const directory = path.join(p.base.directories.chats, 'Missing'); fs.mkdirSync(directory);
    const link = path.join(directory, 'Alias.jsonl');
    fs.symlinkSync(p.f.filename, link);
    await assert.rejects(p.accept('symbolic', 'archive-inventory', { scope: 'orphans' }));
    assert.equal(readOperation(p.base, 'symbolic'), null);
    fs.unlinkSync(link);
    fs.linkSync(p.f.filename, link);
    await assert.rejects(p.accept('hard', 'archive-inventory', { scope: 'orphans' }));
    assert.equal(readOperation(p.base, 'hard'), null);
    assert.equal(fs.existsSync(p.f.filename), true);
});

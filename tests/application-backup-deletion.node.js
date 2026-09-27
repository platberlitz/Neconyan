import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/backup-deletion.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');

function prepared(t) {
    const f = fixture(t, false, 'fixture');
    const directories = f.scope.directories;
    directories.backups = path.join(directories.root, 'backups');
    fs.mkdirSync(directories.backups, { recursive: true });
    const base = { owner: 'fixture', directories };
    const request = { user: { profile: { handle: 'fixture' }, directories } };
    const context = job => ({ ...base, job: getJob(directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const backup = (name, text = 'Old backup') => { const filename = path.join(directories.backups, name); fs.writeFileSync(filename, text); return filename; };
    return { base, request, context, backup };
}

test('one accepted cleanup removes every confirmed backup and survives job pruning', async t => {
    const p = prepared(t);
    const files = ['chat_a.jsonl', 'chat_b.jsonl', 'chat_c.jsonl'].map(name => p.backup(name));
    const kept = p.backup('chat_kept.jsonl', 'Not chosen');
    const accepted = await acceptApplicationOperation(p.request, { key: 'cleanup', kind: 'chat-backup-delete', names: ['chat_a.jsonl', 'chat_b.jsonl', 'chat_c.jsonl'] });
    await runOperation(p.context(accepted.job));
    assert.ok(files.every(file => !fs.existsSync(file)));
    assert.equal(fs.readFileSync(kept, 'utf8'), 'Not chosen');
    assert.equal(readOperation(p.base, 'cleanup').result.removed, 3);
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    const again = await acceptApplicationOperation(p.request, { key: 'cleanup', kind: 'chat-backup-delete', names: ['chat_a.jsonl', 'chat_b.jsonl', 'chat_c.jsonl'] });
    assert.equal(again.job, null);
    assert.equal(again.record.state, 'completed');
});

test('an interrupted cleanup finishes the saved deletions and keeps a later backup with the same name', async t => {
    const p = prepared(t);
    const first = p.backup('chat_first.jsonl'); const second = p.backup('chat_second.jsonl');
    const accepted = await acceptApplicationOperation(p.request, { key: 'cleanup', kind: 'chat-backup-delete', names: ['chat_first.jsonl', 'chat_second.jsonl'] });
    await assert.rejects(runOperation(p.context(accepted.job), { afterFileDeletion: () => { throw new Error('Simulated lost acknowledgement'); } }), /lost acknowledgement/);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.readFileSync(second, 'utf8'), 'Old backup');
    fs.writeFileSync(first, 'Later backup');
    await assert.rejects(runOperation(p.context(accepted.job)), /replaced/);
    assert.equal(fs.readFileSync(first, 'utf8'), 'Later backup');
    fs.unlinkSync(first);
    await runOperation(p.context(accepted.job));
    assert.equal(fs.existsSync(second), false);
    p.backup('chat_second.jsonl', 'Newer backup');
    await runOperation(p.context(accepted.job));
    assert.equal(fs.readFileSync(second, 'utf8'), 'Newer backup');
});

test('cleanup refuses missing, linked and non-backup names before deleting anything', async t => {
    const p = prepared(t);
    const kept = p.backup('chat_kept.jsonl');
    await assert.rejects(acceptApplicationOperation(p.request, { key: 'missing', kind: 'chat-backup-delete', names: ['chat_kept.jsonl', 'chat_gone.jsonl'] }), /no longer exists/);
    await assert.rejects(acceptApplicationOperation(p.request, { key: 'escape', kind: 'chat-backup-delete', names: ['../settings.json'] }), /distinct chat backups/);
    fs.symlinkSync(kept, path.join(p.base.directories.backups, 'chat_link.jsonl'));
    await assert.rejects(acceptApplicationOperation(p.request, { key: 'link', kind: 'chat-backup-delete', names: ['chat_link.jsonl'] }));
    assert.equal(fs.readFileSync(kept, 'utf8'), 'Old backup');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const { authoringEvidence, publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked, writeAuthoringFileLocked, withAuthoringBatchLocked } = await import('../src/authoring-store.js');

function prepared(t) {
    const f = fixture(t);
    const directory = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(directory);
    return { ...f, directory, locked: operation => withRoleplayAccount(f.scope, f.scope, operation) };
}

test('staged authoring changes bind the new physical file before publication and resume without replacing it twice', t => {
    const f = prepared(t), filename = path.join(f.directory, `${'l'.repeat(250)}.json`);
    fs.writeFileSync(filename, '{"old":true}');
    const staged = f.locked(lease => stageAuthoringFileLocked(lease, filename, '{"new":true}'));
    assert.equal(fs.readFileSync(filename, 'utf8'), '{"old":true}');
    const recovered = JSON.parse(JSON.stringify(staged));
    const first = f.locked(lease => publishAuthoringFileLocked(lease, recovered));
    assert.deepEqual(authoringEvidence(first), recovered.after);
    const again = f.locked(lease => publishAuthoringFileLocked(lease, recovered));
    assert.deepEqual(authoringEvidence(again), recovered.after);
    assert.equal(fs.existsSync(path.join(f.scope.directories.root, recovered.temporary)), false);
});

test('equal bytes at a different inode cannot stand in for an accepted authoring source or a prepared output', t => {
    const f = prepared(t), filename = path.join(f.directory, 'Book.json');
    fs.writeFileSync(filename, 'old');
    const staged = f.locked(lease => stageAuthoringFileLocked(lease, filename, 'new'));
    fs.writeFileSync(`${filename}.replacement`, 'old'); fs.renameSync(`${filename}.replacement`, filename);
    assert.throws(() => f.locked(lease => publishAuthoringFileLocked(lease, staged)), { code: 'AUTHORING_SOURCE_CHANGED' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'old');
    const fresh = path.join(f.directory, 'Fresh.json');
    const create = f.locked(lease => stageAuthoringFileLocked(lease, fresh, 'new', { expected: null }));
    fs.writeFileSync(fresh, 'new');
    assert.throws(() => f.locked(lease => publishAuthoringFileLocked(lease, create)), { code: 'AUTHORING_SOURCE_CHANGED' });
});

test('known pre-publication failure retains the old file and cleans only its own prepared bytes', t => {
    const f = prepared(t), filename = path.join(f.directory, 'Book.json');
    fs.writeFileSync(filename, 'old');
    const before = f.locked(lease => authoringEvidence(readAuthoringFileLocked(lease, filename)));
    assert.throws(() => f.locked(lease => writeAuthoringFileLocked(lease, filename, 'new', { expected: before, beforePublish: () => { throw new Error('Stopped before publication'); } })), /Stopped before publication/);
    assert.deepEqual(f.locked(lease => authoringEvidence(readAuthoringFileLocked(lease, filename))), before);
    assert.deepEqual(fs.readdirSync(f.directory), ['Book.json']);
    const outside = path.join(f.root, 'Outside.json'); fs.writeFileSync(outside, 'private');
    fs.symlinkSync(outside, path.join(f.directory, 'Alias.json'));
    assert.throws(() => f.locked(lease => writeAuthoringFileLocked(lease, path.join(f.directory, 'Alias.json'), 'bad')));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
});

test('a synchronous authoring batch coalesces folder flushes but still flushes and checks every file', t => {
    const f = prepared(t);
    const original = fs.fsyncSync;
    let files = 0, directories = 0;
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) directories++; else files++; return original(fd); };
    try {
        f.locked(lease => withAuthoringBatchLocked(lease, () => {
            for (let index = 0; index < 8; index++) writeAuthoringFileLocked(lease, path.join(f.directory, `Batch ${index}.json`), String(index), { expected: null });
        }));
    } finally { fs.fsyncSync = original; }
    assert.equal(files, 8, 'each exact temporary file is flushed once');
    assert.ok(directories < 16, `${directories} folder flushes`);
    for (let index = 0; index < 8; index++) assert.equal(fs.readFileSync(path.join(f.directory, `Batch ${index}.json`), 'utf8'), String(index));
    assert.throws(() => f.locked(lease => withAuthoringBatchLocked(lease, async () => {})), /must be synchronous/);
});

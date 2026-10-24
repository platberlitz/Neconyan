import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { simulateAuthoringRename } from './authoring-rename-fixture.js';
import { readRoleplayFile, withRoleplayAccount } from '../src/roleplay-store.js';
import { authoringEvidence, publishAuthoringFileLocked, stageAuthoringFileLocked, writeAuthoringFileLocked, withAuthoringBatchLocked } from '../src/authoring-store.js';

function prepared(t) {
    const f = fixture(t);
    const filename = path.join(f.scope.directories.root, 'worlds', 'A meaningful lorebook filename.json');
    const locked = run => withRoleplayAccount(f.scope, f.scope, run);
    const stage = () => locked(lease => stageAuthoringFileLocked(lease, filename, 'new contents', { expected: null }));
    const read = () => authoringEvidence(readRoleplayFile(filename));
    const publish = (staged, options) => locked(lease => publishAuthoringFileLocked(lease, staged, options));
    return { ...f, filename, locked, stage, read, publish };
}

test('a held rename checkpoints the final witness before returning and exact persisted replay needs no temporary', t => {
    const f = prepared(t), simulation = simulateAuthoringRename(t), staged = f.stage();
    const old = structuredClone(staged.after);
    let persisted, calls = 0;
    const published = f.publish(staged, { checkpoint() {
        calls++;
        assert.deepEqual(staged.after, f.read());
        assert.notEqual(staged.after.physical.ino, old.physical.ino);
        persisted = JSON.parse(JSON.stringify(staged));
    } });
    assert.equal(calls, 1);
    assert.equal(simulation.transitions.length, 1);
    assert.deepEqual(authoringEvidence(published), persisted.after);
    assert.deepEqual(f.publish(persisted).bytes, Buffer.from('new contents'));
    assert.equal(fs.existsSync(path.join(f.scope.directories.root, staged.temporary)), false);
    assert.throws(() => f.publish({ ...persisted, after: old }, { checkpoint: () => assert.fail('obsolete witness') }), { code: 'AUTHORING_SOURCE_CHANGED' });
});

for (const savesFirst of [false, true]) {
    test(`checkpoint failure restores the in-memory witness; disk save before throw: ${savesFirst}`, t => {
        const f = prepared(t); simulateAuthoringRename(t);
        const staged = f.stage(), original = JSON.parse(JSON.stringify(staged));
        let persisted = JSON.stringify(original);
        const failure = new Error('checkpoint failed');
        assert.throws(() => f.publish(staged, { checkpoint() {
            if (savesFirst) persisted = JSON.stringify(staged);
            throw failure;
        } }), error => error === failure);
        assert.deepEqual(staged, original);
        assert.equal(fs.readFileSync(f.filename, 'utf8'), 'new contents');
        assert.throws(() => f.publish(staged, { checkpoint: () => assert.fail('no repeated checkpoint from an obsolete witness') }), { code: 'AUTHORING_SOURCE_CHANGED' });
        const reloaded = JSON.parse(persisted);
        if (savesFirst) assert.deepEqual(authoringEvidence(f.publish(reloaded)), reloaded.after);
        else assert.throws(() => f.publish(reloaded, { checkpoint() {} }), { code: 'AUTHORING_SOURCE_CHANGED' });
    });
}

test('missing and declared asynchronous checkpoints refuse before rename; thenables refuse without granting replay', async t => {
    const f = prepared(t); simulateAuthoringRename(t);
    const staged = f.stage(), original = structuredClone(staged.after);
    for (const options of [undefined, { checkpoint: async () => {} }, { checkpoint: function* () {} }]) {
        assert.throws(() => f.publish(staged, options), { code: 'AUTHORING_CHECKPOINT_REQUIRED' });
        assert.equal(fs.existsSync(f.filename), false);
        assert.ok(fs.existsSync(path.join(f.scope.directories.root, staged.temporary)));
    }
    assert.throws(() => f.publish(staged, { checkpoint: () => Promise.reject(new Error('late failure')) }), { code: 'AUTHORING_CHECKPOINT_REQUIRED' });
    assert.deepEqual(staged.after, original);
    await Promise.resolve();
    assert.throws(() => f.publish(staged, { checkpoint() {} }), { code: 'AUTHORING_SOURCE_CHANGED' });
});

for (const field of ['dev', 'birthtimeNs']) {
    test(`a live rename cannot adopt changed ${field}`, t => {
        const f = prepared(t); simulateAuthoringRename(t, { field });
        const staged = f.stage();
        assert.throws(() => f.publish(staged, { checkpoint: () => assert.fail('invalid proof cannot be saved') }), { code: 'AUTHORING_SOURCE_CHANGED' });
    });
}

for (const change of ['same-byte replacement', 'bytes', 'size', 'hard link']) {
    test(`post-rename ${change} refuses without checkpointing`, t => {
        const f = prepared(t);
        simulateAuthoringRename(t, { afterRename(_from, to, { native }) {
            if (change === 'same-byte replacement') {
                fs.writeFileSync(`${to}.replacement`, fs.readFileSync(to));
                native.renameSync(`${to}.replacement`, to);
            } else if (change === 'hard link') fs.linkSync(to, `${to}.link`);
            else fs.writeFileSync(to, change === 'size' ? 'longer changed contents' : 'bad contents');
        } });
        const staged = f.stage();
        let checkpoints = 0;
        assert.throws(() => f.publish(staged, { checkpoint: () => { checkpoints++; } }),
            error => ['AUTHORING_SOURCE_CHANGED', 'ROLEPLAY_STORE_DAMAGED'].includes(error.code));
        assert.equal(checkpoints, 0, 'invalid proof cannot reach the checkpoint');
    });
}

test('same-byte staging substitution fails and retains the replacement', t => {
    const f = prepared(t), staged = f.stage();
    const temporary = path.join(f.scope.directories.root, staged.temporary);
    fs.writeFileSync(`${temporary}.replacement`, fs.readFileSync(temporary));
    fs.renameSync(`${temporary}.replacement`, temporary);
    assert.throws(() => f.publish(staged, { checkpoint() {} }), { code: 'AUTHORING_SOURCE_CHANGED' });
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'new contents');
    assert.equal(fs.existsSync(f.filename), false);
});

test('checkpointing cannot replace the destination while the original descriptor is held', t => {
    const f = prepared(t); simulateAuthoringRename(t);
    const staged = f.stage(), old = structuredClone(staged.after);
    assert.throws(() => f.publish(staged, { checkpoint() {
        fs.writeFileSync(`${f.filename}.replacement`, fs.readFileSync(f.filename));
        fs.renameSync(`${f.filename}.replacement`, f.filename);
    } }), error => ['AUTHORING_SOURCE_CHANGED', 'ROLEPLAY_STORE_DAMAGED'].includes(error.code));
    assert.deepEqual(staged.after, old);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'new contents');
});

test('nested direct journal checkpoints terminate, retain batch flushes and do not leak held descriptors', t => {
    const f = prepared(t); simulateAuthoringRename(t);
    const nativeOpen = fs.openSync, nativeClose = fs.closeSync, nativeFlush = fs.fsyncSync;
    const held = new Set(); let flushes = 0;
    t.mock.method(fs, 'openSync', (...args) => { const fd = nativeOpen(...args); held.add(fd); return fd; });
    t.mock.method(fs, 'closeSync', fd => { held.delete(fd); return nativeClose(fd); });
    t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isFile()) flushes++; return nativeFlush(fd); });
    f.locked(lease => withAuthoringBatchLocked(lease, () => {
        const staged = stageAuthoringFileLocked(lease, f.filename, 'new contents');
        publishAuthoringFileLocked(lease, staged, { checkpoint: () => {
            writeAuthoringFileLocked(lease, path.join(f.scope.directories.root, 'journal.json'), JSON.stringify(staged));
        } });
    }));
    assert.equal(flushes, 2, 'one exact-file flush for the output and one for the journal');
    assert.equal(held.size, 0);
    const final = f.read();
    const unchanged = f.locked(lease => writeAuthoringFileLocked(lease, f.filename, 'new contents'));
    assert.deepEqual(authoringEvidence(unchanged), final);
    assert.equal(flushes, 2, 'same-byte no-op does not open a publication handle or flush again');
    assert.equal(held.size, 0);
});

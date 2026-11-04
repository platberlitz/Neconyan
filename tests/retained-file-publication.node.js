import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectRoleplayFile } from '../src/roleplay-store.js';
import { publishRetainedFile } from '../src/operations/retained-file-publication.js';
import { simulateAuthoringRename } from './authoring-rename-fixture.js';

const evidence = file => ({ rawHash: file.rawHash, physical: file.physical });

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retained-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const temporary = path.join(root, 'input.pending'), destination = path.join(root, 'input.zip');
    fs.writeFileSync(temporary, 'retained bytes');
    const file = inspectRoleplayFile(temporary, 100, { flush: true });
    return { temporary, destination, file };
}

test('retained publication checkpoints the held post-rename identity before releasing its descriptor', t => {
    const f = fixture(t);
    simulateAuthoringRename(t, { matches: from => from === f.temporary });
    let saved;
    publishRetainedFile(f.temporary, f.destination, evidence(f.file), f.file.size, finalEvidence => {
        saved = structuredClone(finalEvidence);
        assert.deepEqual(saved, evidence(inspectRoleplayFile(f.destination, 100)));
        assert.notEqual(saved.physical.ino, f.file.physical.ino);
    });
    assert.deepEqual(saved, evidence(inspectRoleplayFile(f.destination, 100)));
});

for (const change of ['replacement', 'bytes', 'dev', 'birthtimeNs']) {
    test(`retained publication refuses ${change} during rename without saving new evidence`, t => {
        const f = fixture(t);
        simulateAuthoringRename(t, { matches: from => from === f.temporary,
            field: ['dev', 'birthtimeNs'].includes(change) ? change : 'ino',
            afterRename(_from, to, { native }) {
                if (change === 'replacement') {
                    fs.writeFileSync(`${to}.other`, fs.readFileSync(to));
                    native.renameSync(`${to}.other`, to);
                } else if (change === 'bytes') fs.writeFileSync(to, 'modified bytes');
            } });
        assert.throws(() => publishRetainedFile(f.temporary, f.destination, evidence(f.file), f.file.size,
            () => assert.fail('changed bytes or a different file must not be adopted')));
    });
}

test('a failed evidence checkpoint cannot turn a second rename attempt into a successful publication', t => {
    const f = fixture(t);
    simulateAuthoringRename(t, { matches: from => from === f.temporary });
    assert.throws(() => publishRetainedFile(f.temporary, f.destination, evidence(f.file), f.file.size,
        () => { throw new Error('checkpoint failed'); }), /checkpoint failed/);
    assert.notDeepEqual(evidence(inspectRoleplayFile(f.destination, 100)), evidence(f.file));
    assert.throws(() => publishRetainedFile(f.temporary, f.destination, evidence(f.file), f.file.size,
        () => assert.fail('missing original file cannot prove a live rename')));
});

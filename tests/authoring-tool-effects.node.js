import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { authoringEvidence, publishAuthoringFileLocked, readAuthoringFileLocked } = await import('../src/authoring-store.js');
const { publishNativeAuthoringFile } = await import('../src/generation/authoring-tool-effects.js');
const { admitNativeMediaJob, finishNativeMediaJob, withNativeMediaReceipt } = await import('../src/generation/media-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { roleplayHash, withRoleplayAccount } = await import('../src/roleplay-store.js');

function prepared(t) {
    const f = fixture(t), directories = f.scope.directories;
    fs.mkdirSync(directories.worlds = path.join(directories.root, 'worlds'));
    const filename = path.join(directories.worlds, 'Book.json');
    fs.writeFileSync(filename, JSON.stringify({ entries: { 1: { content: 'before' } } }));
    const source = f.source();
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const before = withRoleplayAccount(f.scope, account, lease => authoringEvidence(readAuthoringFileLocked(lease, filename)));
    const target = { kind: 'authoring', id: 'worlds/Book.json' };
    const admission = admitNativeMediaJob(f.scope, account, { operationKey: 'approved-book-action', source,
        kind: 'tool', request: { action: 'book-update', source: before }, target });
    releaseJob(directories, admission.jobId);
    const context = { owner: f.scope.owner, directories, job: getJob(directories, admission.jobId), signal: new AbortController().signal };
    return { ...f, account, filename, before, context, relative: 'worlds/Book.json' };
}

test('an approved authoring file publishes from a saved physical witness and survives lost completion status', t => {
    const f = prepared(t), bytes = Buffer.from(JSON.stringify({ entries: { 1: { content: 'after' } } }));
    assert.throws(() => publishNativeAuthoringFile(f.context, { relative: f.relative, before: f.before, bytes,
        beforePublish: () => { throw new Error('Stopped before rename'); } }), /Stopped before rename/);
    assert.equal(JSON.parse(fs.readFileSync(f.filename, 'utf8')).entries[1].content, 'before');
    const key = roleplayHash(['authoring', f.relative]);
    const staged = withNativeMediaReceipt(f.context, ({ value }) => value.effects[key].staged);
    const after = withNativeMediaReceipt(f.context, ({ lease }) => authoringEvidence(publishAuthoringFileLocked(lease, staged)));
    assert.equal(JSON.parse(fs.readFileSync(f.filename, 'utf8')).entries[1].content, 'after');
    assert.deepEqual(publishNativeAuthoringFile(f.context, { relative: f.relative, before: f.before, bytes }), after);
    assert.deepEqual(publishNativeAuthoringFile(f.context, { relative: f.relative, before: f.before, bytes }), after);
    assert.deepEqual(finishNativeMediaJob(f.context, { file: f.relative, after }), { result: { file: f.relative, after } });
});

test('a different inode or saved intention cannot be adopted for a prepared authoring file', t => {
    const f = prepared(t), bytes = Buffer.from('after');
    assert.throws(() => publishNativeAuthoringFile(f.context, { relative: f.relative, before: f.before, bytes,
        beforePublish: () => { throw new Error('Stopped before rename'); } }), /Stopped before rename/);
    assert.throws(() => publishNativeAuthoringFile(f.context, { relative: f.relative, before: f.before, bytes: Buffer.from('different') }), { code: 'TOOL_EFFECT_RECOVERY' });
    fs.writeFileSync(`${f.filename}.replacement`, fs.readFileSync(f.filename));
    fs.renameSync(`${f.filename}.replacement`, f.filename);
    assert.throws(() => publishNativeAuthoringFile(f.context, { relative: f.relative, before: f.before, bytes }), { code: 'AUTHORING_SOURCE_CHANGED' });
});

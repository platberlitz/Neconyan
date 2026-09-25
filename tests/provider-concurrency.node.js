import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptJob, getJob, markProviderUncertain, recoverJobs, setJobResume, updateJob } = await import('../src/jobs/store.js');
const { createProviderScope, providerNotDispatched, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } = await import('../src/jobs/artifacts.js');

function prepared(t) {
    const f = fixture(t);
    const directories = f.scope.directories;
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'concurrent-fixture', submissionKey: 'parallel', intent: {} });
    updateJob(directories, job.id, { state: 'running' });
    const context = { directories, job, owner: f.scope.owner, signal: new AbortController().signal };
    return { ...f, directories, job, context: { ...context, providerScope: createProviderScope(context) } };
}

function pending() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('one completed parallel provider cannot hide an unresolved sibling after restart', async t => {
    const f = prepared(t);
    const a = pending(), b = pending();
    let calls = 0;
    const first = providerStep(f.context, 'first', () => { calls++; return a.promise; });
    const second = providerStep(f.context, 'second', () => { calls++; return b.promise; });
    assert.equal(calls, 2);
    assert.deepEqual(getJob(f.directories, f.job.id).recoverySteps, ['provider:first', 'provider:second']);
    b.resolve({ text: 'Saved second result' });
    await second;
    assert.deepEqual(getJob(f.directories, f.job.id).recoverySteps, ['provider:first']);
    assert.equal(getJob(f.directories, f.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(f.directories, f.job.id, 'provider:second').text, 'Saved second result');
    const failed = assert.rejects(first, /Lost first response/);
    a.reject(new Error('Lost first response'));
    await failed;
    assert.equal(recoverJobs(f.directories).recoverable.length, 0);
    assert.equal(getJob(f.directories, f.job.id).state, 'interrupted');
    const restarted = { ...f.context, providerScope: createProviderScope(f.context) };
    for (const name of ['first', 'third']) await assert.rejects(providerStep(restarted, name, () => assert.fail('An uncertain call was repeated')),
        { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    assert.deepEqual(await providerStep(restarted, 'second', () => assert.fail('The saved sibling was repeated')), { text: 'Saved second result' });
    assert.equal(calls, 2);
});

test('only an owned live scope permits a different parallel call, never the same call', async t => {
    const f = prepared(t);
    const held = pending();
    const first = providerStep(f.context, 'first', () => held.promise);
    assert.equal(unresolvedProviderStep(f.directories, f.job.id), 'provider:first');
    await assert.rejects(providerStep(f.context, 'first', () => assert.fail('The same call entered twice')), { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    for (const scope of [{}, createProviderScope(f.context), undefined]) {
        await assert.rejects(providerStep({ ...f.context, providerScope: scope }, 'other', () => assert.fail('An unowned scope bypassed recovery')),
            { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    }
    await assert.rejects(providerStep(f.context, 'known-refusal', () => { throw providerNotDispatched(new Error('Not sent')); }), /Not sent/);
    assert.deepEqual(getJob(f.directories, f.job.id).recoverySteps, ['provider:first']);
    assert.equal(getJob(f.directories, f.job.id).recoverability, 'unknown-outcome');
    held.resolve({ text: 'Complete first' });
    await first;
    assert.deepEqual(getJob(f.directories, f.job.id).recoverySteps, []);
    assert.equal(getJob(f.directories, f.job.id).recoveryStep, null);
    assert.equal(await providerStep(f.context, 'known-refusal', () => 'Now sent once'), 'Now sent once');
});

test('startup checks every parallel receipt even when the last response was saved', t => {
    for (const complete of [false, true]) {
        const f = prepared(t);
        for (const name of ['one', 'two']) {
            setJobResume(f.directories, f.job.id, `provider:${name}`);
            markProviderUncertain(f.directories, f.job.id, { step: `provider:${name}` });
        }
        writeArtifact(f.directories, f.job.id, 'provider:two', { text: 'Last response' });
        if (complete) writeArtifact(f.directories, f.job.id, 'provider:one', { text: 'First response' });
        updateJob(f.directories, f.job.id, { recoverability: 'resumable' });
        const { recoverable: recovered } = recoverJobs(f.directories);
        assert.equal(recovered.length, complete ? 1 : 0);
        assert.equal(getJob(f.directories, f.job.id).state, complete ? 'queued' : 'interrupted');
    }
});

/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    acceptJob, dismissJob, explicitRetryRecovery, getJob, listJobs, readJobStore, recordReceipt, recoverJobs,
    requestCancellation, setJobState, updateJob, markProviderUncertain, markProviderSettled, setJobResume,
} = await import('../src/jobs/store.js');
const {
    CONCURRENCY, abortJob, canStart, capacity, noteOwner, ownerCount, registerHandler, runScheduledTick,
    setDirectoriesResolver, testExports,
} = await import('../src/jobs/runner.js');
const { registerTool, unregisterTool, invokeTool } = await import('../src/tools/registry.js');
const { createGenerationContext, resolveCredential } = await import('../src/generation/context.js');
const { isDefiniteProviderRefusal, providerNotDispatched, providerRefused, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } = await import('../src/jobs/artifacts.js');

const roots = [];

function tempDirectories(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `neconyan-jobs-${label}-`));
    roots.push(root);
    return { root };
}

process.on('exit', () => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function intent(extra = {}) {
    return { operation: 'roleplay-generate', target: { kind: 'chat', id: 'chat-a', branchId: 0 }, ...extra };
}

function waitFor(check, { timeoutMs = 3000, stepMs = 5 } = {}) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            let value;
            try { value = check(); } catch (error) { reject(error); return; }
            if (value) { resolve(value); return; }
            if (Date.now() - startedAt > timeoutMs) { reject(new Error('Timed out waiting for condition.')); return; }
            setTimeout(poll, stepMs);
        };
        poll();
    });
}

test('job acceptance deduplicates by submission key, conflicts on different intent and isolates owners', () => {
    const alice = tempDirectories('alice');
    const bob = tempDirectories('bob');
    const first = acceptJob(alice, { owner: 'alice', type: 'roleplay', submissionKey: 'send-1', intent: intent() });
    assert.equal(first.created, true);
    const repeated = acceptJob(alice, { owner: 'alice', type: 'roleplay', submissionKey: 'send-1', intent: intent() });
    assert.equal(repeated.created, false);
    assert.equal(repeated.job.id, first.job.id, 'the same submission must return the same job, not a second effect');
    assert.equal(Object.keys(readJobStore(alice).jobs).length, 1);

    assert.throws(() => acceptJob(alice, { owner: 'alice', type: 'roleplay', submissionKey: 'send-1', intent: intent({ message: 'different' }) }),
        error => error.status === 409 && error.code === 'JOB_SUBMISSION_CONFLICT');

    const bobJob = acceptJob(bob, { owner: 'bob', type: 'roleplay', submissionKey: 'send-1', intent: intent() });
    assert.notEqual(bobJob.job.id, first.job.id, 'owners must not share jobs even with identical keys');
    assert.equal(getJob(bob, first.job.id), null, 'another owner must not read this job');
    assert.equal(getJob(alice, first.job.id).owner, 'alice');
    for (const change of [{ type: 'other' }, { target: { kind: 'chat', id: 'elsewhere' } }, { config: { model: 'other' } }, { credentialRef: { profileId: 'other' } }, { automatic: true }, { mutating: false }]) {
        assert.throws(() => acceptJob(alice, { owner: 'alice', type: 'roleplay', submissionKey: 'send-1', intent: intent(), ...change }), error => error.status === 409);
    }
});

test('idle recovery does not create or rewrite a job ledger', () => {
    const directories = tempDirectories('idle-recovery');
    recoverJobs(directories);
    assert.equal(fs.existsSync(path.join(directories.root, 'jobs', 'index.json')), false);
    const job = acceptJob(directories, { owner: 'alice', type: 'idle-test', submissionKey: 'idle', intent: {} }).job;
    const before = fs.readFileSync(path.join(directories.root, 'jobs', 'index.json'), 'utf8');
    assert.equal(recoverJobs(directories).recoverable[0].id, job.id);
    assert.equal(fs.readFileSync(path.join(directories.root, 'jobs', 'index.json'), 'utf8'), before);
});

test('byte-cap pruning removes artifacts even below the job count limit', () => {
    const directories = tempDirectories('byte-prune');
    const ids = [];
    for (let index = 0; index < 4; index++) {
        const job = acceptJob(directories, { owner: 'alice', type: 'large-result', submissionKey: String(index), intent: {} }).job;
        ids.push(job.id);
        writeArtifact(directories, job.id, 'result', { text: 'saved' });
        updateJob(directories, job.id, { state: 'completed', result: { text: 'x'.repeat(1200 * 1024) } });
    }
    assert.equal(getJob(directories, ids[0]), null);
    assert.equal(fs.readdirSync(path.join(directories.root, 'jobs', 'artifacts')).length, listJobs(directories).length);
    assert.ok(getJob(directories, ids.at(-1)));
});

test('provider results survive cancellation and retry without growing the status ledger or repeating a call', async () => {
    const directories = tempDirectories('artifacts');
    const job = acceptJob(directories, { owner: 'alice', type: 'artifact-test', submissionKey: 'artifact', intent: {} }).job;
    const controller = new AbortController();
    let calls = 0;
    const context = { directories, job, signal: controller.signal };
    const result = await providerStep(context, 'first', async () => {
        calls++;
        assert.equal(getJob(directories, job.id).recoverability, 'unknown-outcome');
        return { text: 'x'.repeat(3 * 1024 * 1024) };
    });
    assert.equal((await providerStep(context, 'first', () => { throw new Error('Must not repeat'); })).text, result.text);
    assert.equal(calls, 1);
    assert.ok(fs.statSync(path.join(directories.root, 'jobs', 'index.json')).size < 4096);
    await assert.rejects(providerStep(context, 'late', async () => {
        requestCancellation(directories, job.id);
        controller.abort();
        return { text: 'late' };
    }), error => error.name === 'AbortError');
    assert.deepEqual(readArtifact(directories, job.id, 'provider:late'), { text: 'late' });
    assert.equal(getJob(directories, job.id).state, 'cancelled');
});

test('unknown provider results remain blocked after recovery until a saved receipt proves completion', async () => {
    const directories = tempDirectories('unknown-provider');
    const job = acceptJob(directories, { owner: 'alice', type: 'artifact-test', submissionKey: 'unknown', intent: {} }).job;
    const context = { directories, job, signal: new AbortController().signal };
    updateJob(directories, job.id, { state: 'running' });
    let calls = 0;
    await assert.rejects(providerStep(context, 'first', async () => {
        calls++;
        throw new Error('Provider response lost');
    }), /Provider response lost/);
    assert.equal(calls, 1);
    recoverJobs(directories);
    assert.equal(getJob(directories, job.id).state, 'interrupted');
    assert.equal(getJob(directories, job.id).recoverability, 'needs-retry');
    assert.equal(getJob(directories, job.id).recoveryStep, 'provider:first');
    for (const step of ['first', 'second']) {
        await assert.rejects(providerStep(context, step, () => { calls++; return { text: 'unsafe' }; }),
            { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    }
    assert.equal(calls, 1);
    writeArtifact(directories, job.id, 'provider:first', { text: 'saved completion' });
    assert.deepEqual(await providerStep(context, 'first', () => { throw new Error('Replayed completed provider'); }),
        { text: 'saved completion' });
    assert.deepEqual(await providerStep(context, 'second', () => { calls++; return { text: 'new work' }; }),
        { text: 'new work' });
    assert.equal(calls, 2);
    await assert.rejects(providerStep(context, 'known', () => {
        throw providerNotDispatched(new Error('No external request was sent'));
    }), /No external request was sent/);
    assert.equal(getJob(directories, job.id).recoveryStep, null);
    assert.deepEqual(await providerStep(context, 'known', () => { calls++; return { text: 'safe retry' }; }),
        { text: 'safe retry' });
    assert.equal(calls, 3);
});

test('a definite provider refusal settles its step, and an explicit retry releases unknown steps', async () => {
    assert.deepEqual([400, 401, 429, 503, 529].map(isDefiniteProviderRefusal), [true, true, true, true, true]);
    assert.deepEqual([undefined, 0, 408, 500, 502, 504].map(isDefiniteProviderRefusal), [false, false, false, false, false, false]);
    const directories = tempDirectories('refused-provider');
    const job = acceptJob(directories, { owner: 'alice', type: 'artifact-test', submissionKey: 'refused', intent: {} }).job;
    const context = { directories, job, signal: new AbortController().signal };
    updateJob(directories, job.id, { state: 'running' });
    await assert.rejects(providerStep(context, 'refused', () => {
        throw providerRefused(Object.assign(new Error('Service unavailable'), { providerStatus: 503 }));
    }), /Service unavailable/);
    assert.notEqual(getJob(directories, job.id).recoverability, 'unknown-outcome');
    assert.equal(unresolvedProviderStep(directories, job.id), undefined);
    await assert.rejects(providerStep(context, 'lost', () => { throw new Error('Connection reset'); }), /Connection reset/);
    assert.equal(getJob(directories, job.id).recoverability, 'unknown-outcome');
    assert.equal(unresolvedProviderStep(directories, job.id), 'provider:lost');
    updateJob(directories, job.id, current => explicitRetryRecovery(current));
    assert.equal(unresolvedProviderStep(directories, job.id), undefined);
    assert.deepEqual(await providerStep(context, 'lost', () => ({ text: 'asked again on purpose' })), { text: 'asked again on purpose' });
});

test('finished history makes room for new work and removes only expired artifacts', () => {
    const directories = tempDirectories('retention');
    const first = acceptJob(directories, { owner: 'alice', type: 'test', submissionKey: 'oldest', intent: {} }).job;
    writeArtifact(directories, first.id, 'result', { preserved: true });
    setJobState(directories, first.id, 'completed');
    updateJob(directories, first.id, current => ({ ...current, createdAt: 0 }));
    for (let index = 0; index < 201; index++) {
        const { job } = acceptJob(directories, { owner: 'alice', type: 'test', submissionKey: 'new-' + index, intent: {} });
        setJobState(directories, job.id, 'completed');
        assert.ok(getJob(directories, job.id));
    }
    assert.equal(getJob(directories, first.id), null);
    assert.deepEqual(fs.readdirSync(path.join(directories.root, 'jobs', 'artifacts')), []);
    assert.equal(fs.statSync(path.join(directories.root, 'jobs', 'index.json')).mode & 0o777, 0o600);
});

test('dismissal hides queued work from the list without stopping dispatch', async () => {
    const directories = tempDirectories('hidden-queued');
    const { job } = acceptJob(directories, { owner: 'hidden', type: 'hidden-test', submissionKey: 'hidden', intent: {} });
    registerHandler('hidden-test', async () => ({ ran: true }));
    setDirectoriesResolver(() => directories);
    noteOwner('hidden');
    dismissJob(directories, job.id);
    await runScheduledTick();
    await waitFor(() => getJob(directories, job.id).state === 'completed');
    assert.equal(listJobs(directories).length, 0);
    assert.equal(getJob(directories, job.id).result.ran, true);
});

test('every ledger accepted by the writer remains readable, and overflow leaves saved jobs intact', () => {
    const directories = tempDirectories('ledger-limit');
    const input = { owner: 'alice', type: 'roleplay', intent: { text: 'x'.repeat(1100 * 1024) } };
    const first = acceptJob(directories, { ...input, submissionKey: 'first' }).job;
    acceptJob(directories, { ...input, submissionKey: 'second' });
    assert.equal(listJobs(directories).length, 2);
    const before = readJobStore(directories).revision;
    const retry = acceptJob(directories, { ...input, submissionKey: 'first' });
    assert.equal(retry.job.id, first.id);
    assert.equal(readJobStore(directories).revision, before);
    assert.throws(() => acceptJob(directories, { ...input, submissionKey: 'overflow', intent: { text: 'x'.repeat(2000 * 1024) } }), error => error.code === 'JOB_STORE_FULL');
    assert.equal(getJob(directories, first.id).intent.text, input.intent.text);
    assert.equal(listJobs(directories).length, 2);
});

test('intents are typed and bounded, and key order does not defeat deduplication', () => {
    const directories = tempDirectories('types');
    const noisy = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'k', intent: { a: 1, b: { d: 1, c: 2 } } });
    const reordered = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'k', intent: { b: { c: 2, d: 1 }, a: 1 } });
    assert.equal(reordered.created, false, 'key order must not create a second job');
    assert.equal(reordered.job.id, noisy.job.id);

    assert.throws(() => acceptJob(directories, { owner: 'alice', type: 'Not A Type', submissionKey: 'x', intent: {} }), error => error.status === 400);
    assert.throws(() => acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: { object: true }, intent: {} }), error => error.status === 400);
    assert.throws(() => acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'y'.repeat(300), intent: {} }), error => error.status === 400);
    assert.throws(() => acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'z', intent: {} , target: { kind: 'row', id: 'x'.repeat(300) } }), error => error.status === 400);
    assert.throws(() => acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'w', intent: { blob: 'x'.repeat(2.5 * 1024 * 1024) } }), error => error.status === 400, 'an oversized intent is refused before it reaches the ledger');
    assert.throws(() => acceptJob(directories, { owner: '../escape', type: 'roleplay', submissionKey: 'v', intent: {} }), error => error.status === 400);
    assert.throws(() => acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'array', intent: [] }), error => error.status === 400);
    // Client-supplied resumption hints are ignored, never honoured.
    const sneaky = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'r', intent: {}, resume: 'repeat-provider', recoverability: 'resumable', stage: 'apply' });
    assert.equal(sneaky.job.resume, null);
    assert.equal(sneaky.job.recoverability, 'resumable', 'server sets the default, not the caller');
});

test('cancellation is durable before acknowledgement and a late completion stays cancelled', () => {
    const directories = tempDirectories('cancel');
    const queued = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'q', intent: intent() }).job;
    const cancelled = requestCancellation(directories, queued.id).job;
    assert.equal(cancelled.state, 'cancelled', 'a queued job is cancelled at once');
    assert.equal(cancelled.cancellation.requested, true, 'the request itself is saved');

    const running = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'r', intent: intent() }).job;
    updateJob(directories, running.id, { state: 'running' });
    requestCancellation(directories, running.id);
    const late = setJobState(directories, running.id, 'completed').job;
    assert.equal(late.state, 'cancelled', 'a reply that lands after a cancel must not report success');
});

test('restart recovery resumes only server-checkpointed work and interrupts unknown provider outcomes', () => {
    const directories = tempDirectories('recover');
    const queued = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'a', intent: intent() }).job;
    const checkpointed = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'b', intent: intent() }).job;
    setJobResume(directories, checkpointed.id, 'apply-reply');
    updateJob(directories, checkpointed.id, { state: 'running' });
    const claimed = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'c', intent: intent(), resume: 'fake', recoverability: 'resumable' }).job;
    updateJob(directories, claimed.id, { state: 'running' });
    const uncertain = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'd', intent: intent() }).job;
    markProviderUncertain(directories, uncertain.id, { step: 'send' });
    updateJob(directories, uncertain.id, { state: 'running' });
    const cancelled = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'e', intent: intent() }).job;
    updateJob(directories, cancelled.id, { state: 'running' });
    requestCancellation(directories, cancelled.id);

    const { recoverable } = recoverJobs(directories);
    const ids = recoverable.map(job => job.id);
    assert.ok(ids.includes(queued.id), 'queued work is recovered');
    assert.ok(ids.includes(checkpointed.id), 'work with a server-saved next step is recovered');
    assert.equal(getJob(directories, checkpointed.id).state, 'queued');
    assert.equal(getJob(directories, claimed.id).state, 'interrupted', 'a client cannot nominate its own resume step');
    const uncertainJob = getJob(directories, uncertain.id);
    assert.equal(uncertainJob.state, 'interrupted', 'an unqueryable provider result is not silently retried');
    assert.equal(uncertainJob.error.code, 'INTERRUPTED');
    assert.match(uncertainJob.error.message, /unknown/);
    assert.equal(getJob(directories, cancelled.id).state, 'cancelled');

    const settled = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'f', intent: intent() }).job;
    markProviderUncertain(directories, settled.id);
    markProviderSettled(directories, settled.id);
    assert.notEqual(getJob(directories, settled.id).recoverability, 'unknown-outcome', 'a saved result clears the uncertainty');

    const receipt = recordReceipt(directories, queued.id, { effect: 'message-saved', target: 'chat-a' }).job;
    assert.equal(receipt.receipts.length, 1);
    dismissJob(directories, queued.id);
    assert.equal(listJobs(directories, { owner: 'alice' }).some(job => job.id === queued.id), false);
});

test('a damaged ledger fails closed for that owner without stopping other accounts or the dispatcher', () => {
    const broken = tempDirectories('broken');
    const healthy = tempDirectories('healthy');
    acceptJob(healthy, { owner: 'healthy', type: 'roleplay', submissionKey: 'ok', intent: intent() });

    fs.mkdirSync(path.join(broken.root, 'jobs'), { recursive: true });
    const ledger = path.join(broken.root, 'jobs', 'index.json');
    fs.writeFileSync(ledger, '{"schema":1,"jobs":');
    const original = fs.readFileSync(ledger, 'utf8');

    assert.throws(() => readJobStore(broken), error => error.status === 409 && error.code === 'JOB_STORE_RECOVERABLE');
    assert.equal(fs.readFileSync(ledger, 'utf8'), original, 'the damaged ledger is left untouched, never reset to an empty one');
    assert.equal(readJobStore(healthy).jobs !== undefined, true, 'the healthy account is unaffected');
    assert.equal(listJobs(healthy, { owner: 'healthy' }).length, 1);

    // The interval must keep running for the healthy owner; the damaged owner
    // is skipped instead of rejecting the whole tick.
    setDirectoriesResolver(owner => (owner === 'broken' ? broken : healthy));
    noteOwner('broken');
    noteOwner('healthy');
    registerHandler('roleplay', () => ({ ok: true }));
    return runScheduledTick().then(() => {
        assert.ok(listJobs(healthy, { owner: 'healthy' }).some(job => job.state === 'completed' || job.state === 'running' || job.state === 'queued'));
    });
});

test('saved reviews survive restart and effect receipts are never truncated', () => {
    const directories = tempDirectories('review');
    const job = acceptJob(directories, { owner: 'alice', type: 'review', submissionKey: 'review', intent: {} }).job;
    updateJob(directories, job.id, { state: 'waiting', result: { proposal: 'saved' } });
    for (let item = 0; item < 101; item++) recordReceipt(directories, job.id, { item });
    recoverJobs(directories);
    assert.equal(getJob(directories, job.id).state, 'waiting');
    assert.equal(getJob(directories, job.id).receipts[0].item, 0);
    requestCancellation(directories, job.id);
    assert.equal(getJob(directories, job.id).state, 'cancelled');
});

test('a ledger damaged after scheduling and a failed directory lookup cannot reject background dispatch', async () => {
    const directories = tempDirectories('dispatch-race');
    const job = acceptJob(directories, { owner: 'alice', type: 'roleplay', submissionKey: 'read-failure', intent: {} }).job;
    fs.writeFileSync(path.join(directories.root, 'jobs', 'index.json'), 'broken');
    setDirectoriesResolver(() => directories);
    await assert.doesNotReject(testExports.runJob(job));
    setDirectoriesResolver(() => { throw new Error('directory unavailable'); });
    await assert.doesNotReject(testExports.runJob(job));
    assert.equal(capacity().global, 0);
});

test('dispatcher runs one operation per target, enforces the real per-user cap and aborts on cancel', async () => {
    const alice = tempDirectories('runner-alice');
    const bob = tempDirectories('runner-bob');
    const carol = tempDirectories('runner-carol');
    const erin = tempDirectories('runner-erin');
    const byOwner = { alice, bob, carol, erin };
    setDirectoriesResolver(owner => byOwner[owner] ?? tempDirectories(owner));

    let active = 0;
    let calls = 0;
    let targetConflict = false;
    let maxActive = 0;
    const activeTargets = new Set();
    registerHandler('blocked', ctx => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        const key = JSON.stringify(ctx.job.target);
        if (activeTargets.has(key)) targetConflict = true;
        activeTargets.add(key);
        return new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
                active -= 1;
                activeTargets.delete(key);
                reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            }, { once: true });
        });
    });
    for (const owner of Object.keys(byOwner)) noteOwner(owner);

    const targetA = { kind: 'chat', id: 'shared', branchId: 0 };
    const a1 = acceptJob(alice, { owner: 'alice', type: 'blocked', submissionKey: 's1', intent: intent({ n: 1 }), target: targetA }).job;
    const a2 = acceptJob(alice, { owner: 'alice', type: 'blocked', submissionKey: 's2', intent: intent({ n: 2 }), target: { kind: 'chat', id: 'alice-two', branchId: 0 } }).job;
    const a3 = acceptJob(alice, { owner: 'alice', type: 'blocked', submissionKey: 's3', intent: intent({ n: 3 }), target: { kind: 'chat', id: 'alice-three', branchId: 0 } }).job;
    const b1 = acceptJob(bob, { owner: 'bob', type: 'blocked', submissionKey: 's4', intent: intent({ n: 4 }), target: { kind: 'chat', id: 'bob-chat', branchId: 0 } }).job;
    const c1 = acceptJob(carol, { owner: 'carol', type: 'blocked', submissionKey: 's5', intent: intent({ n: 5 }), target: { kind: 'chat', id: 'carol-chat', branchId: 0 } }).job;
    const auto = acceptJob(erin, { owner: 'erin', type: 'blocked', submissionKey: 's6', intent: intent({ n: 6 }), target: { kind: 'chat', id: 'erin-chat', branchId: 0 }, automatic: true }).job;

    await runScheduledTick();
    await waitFor(() => capacity().global === 4);
    assert.equal(ownerCount('alice'), 2, 'the per-user cap really stops a third alice job, with three distinct targets');
    assert.equal(getJob(alice, a1.id).state, 'running');
    assert.equal(getJob(alice, a2.id).state, 'running');
    assert.equal(getJob(alice, a3.id).state, 'queued');
    assert.equal(getJob(bob, b1.id).state, 'running');
    assert.equal(getJob(carol, c1.id).state, 'running');
    assert.equal(getJob(erin, auto.id).state, 'queued', 'automatic work must not take the reserved slot');
    assert.equal(canStart({ ...auto, id: 'pure-check' }), false, 'the reserved slot is held back from automatic work');
    assert.equal(maxActive, 4);

    for (const [owner, job] of [['alice', a1], ['alice', a2], ['bob', b1], ['carol', c1], ['alice', a3]]) {
        requestCancellation(byOwner[owner], job.id);
        abortJob(job.id);
    }
    await waitFor(() => active === 0);
    for (const [directories, job] of [[alice, a1], [alice, a2], [bob, b1], [carol, c1], [alice, a3]]) {
        await waitFor(() => getJob(directories, job.id).state === 'cancelled');
    }
    assert.equal(targetConflict, false, 'two jobs touched the same target at the same time');

    const before = calls;
    acceptJob(alice, { owner: 'alice', type: 'blocked', submissionKey: 's1', intent: intent({ n: 1 }), target: targetA });
    assert.equal(calls, before);
    assert.equal(CONCURRENCY.perUser, 2);
});

test('dispatch rotates across owners so continuous work on one account does not starve later accounts', async () => {
    const owners = ['owner-a', 'owner-b', 'owner-c'];
    const dirs = Object.fromEntries(owners.map(owner => [owner, tempDirectories(`fair-${owner}`)]));
    setDirectoriesResolver(owner => dirs[owner]);
    const started = { 'owner-a': 0, 'owner-b': 0, 'owner-c': 0 };
    registerHandler('fair', ctx => {
        started[ctx.owner] += 1000;
        return { ok: true };
    });
    for (const owner of owners) {
        noteOwner(owner);
        // Each owner always has two queued jobs, so a greedy dispatcher would
        // keep re-picking the first owner every tick.
        acceptJob(dirs[owner], { owner, type: 'fair', submissionKey: 'p1', intent: intent({ n: 1 }), target: { kind: 'chat', id: `${owner}-1` } });
        acceptJob(dirs[owner], { owner, type: 'fair', submissionKey: 'p2', intent: intent({ n: 2 }), target: { kind: 'chat', id: `${owner}-2` } });
    }
    // Six ticks, three owners, per-user cap two: every owner must make progress.
    for (let i = 0; i < 6; i += 1) await runScheduledTick();
    await waitFor(() => owners.every(owner => started[owner] > 0), { timeoutMs: 2000 });
    assert.ok(owners.every(owner => started[owner] > 0), `every owner must be dispatched; got ${JSON.stringify(started)}`);
});

test('a failed initial write releases its slot and target lock', async () => {
    const directories = tempDirectories('failed-write');
    const target = { kind: 'chat', id: 'locked', branchId: 0 };
    const job = acceptJob(directories, { owner: 'alice', type: 'blocked', submissionKey: 'f1', intent: intent(), target }).job;
    const release = (await import('../src/chat-file-lock.js')).acquireChatFileLock;
    // Hold the job ledger lock so the runner's own running-state write fails.
    const path = (await import('node:path')).join(directories.root, 'jobs', 'index.json');
    const held = release(path);
    setDirectoriesResolver(() => directories);
    let ran = false;
    registerHandler('blocked', () => { ran = true; return {}; });
    await testExports.runJob(job);
    held();
    assert.equal(getJob(directories, job.id).state, 'queued', 'the failure is visible, not hidden');
    // The slot must be free again, so a fresh job on the same target can start.
    assert.equal(testExports.ownerCount('alice') ?? 0, 0);
    const job2 = acceptJob(directories, { owner: 'alice', type: 'blocked', submissionKey: 'f2', intent: intent({ n: 2 }), target }).job;
    await testExports.runJob(job2);
    assert.equal(ran, true, 'the target lock from the failed attempt was released');
});

test('a provider error that merely mentions aborted stays a visible failure', async () => {
    const directories = tempDirectories('aborted-word');
    setDirectoriesResolver(() => directories);
    registerHandler('flaky', () => Promise.reject(Object.assign(new Error('The request was aborted by the upstream provider.'), { status: 502 })));
    const job = acceptJob(directories, { owner: 'alice', type: 'flaky', submissionKey: 'a1', intent: intent(), target: { kind: 'chat', id: 'flaky' } }).job;
    await testExports.runJob(job);
    const saved = getJob(directories, job.id);
    assert.equal(saved.state, 'failed', 'a provider failure must not be disguised as a cancel');
    assert.match(saved.error.message, /aborted/);
    registerHandler('flaky', () => Promise.reject(Object.assign(new Error('Provider aborted independently.'), { name: 'AbortError', status: 502 })));
    const second = acceptJob(directories, { owner: 'alice', type: 'flaky', submissionKey: 'a2', intent: {} }).job;
    await testExports.runJob(second);
    assert.equal(getJob(directories, second.id).state, 'failed');
});

test('an unknown provider outcome is interrupted with an explicit retry, never auto-resubmitted', async () => {
    const directories = tempDirectories('uncertain');
    setDirectoriesResolver(() => directories);
    let calls = 0;
    registerHandler('uncertain', ctx => {
        calls += 1;
        throw Object.assign(new Error('The provider connection was lost.'), { recoverable: true });
    });
    const job = acceptJob(directories, { owner: 'alice', type: 'uncertain', submissionKey: 'u1', intent: intent(), target: { kind: 'chat', id: 'u' } }).job;
    await testExports.runJob(job);
    assert.equal(getJob(directories, job.id).state, 'interrupted');
    assert.equal(calls, 1, 'the provider is not called again automatically');
    await runScheduledTick();
    assert.equal(calls, 1, 'an interrupted job is not re-dispatched');
});

test('typed tool registry refuses unknown tools and missing permissions, validates input and receipts before and after its effect', async () => {
    const effects = [];
    registerTool({
        name: 'demo_tool',
        permission: 'chat-write',
        mutating: true,
        validate: args => (args.value ? null : 'A value is required.'),
        run: args => ({ effect: `wrote ${args.value}` }),
    });
    await assert.rejects(() => invokeTool('missing_tool', {}), error => error.status === 404);
    await assert.rejects(() => invokeTool('demo_tool', { value: 'x' }), error => error.status === 403);
    await assert.rejects(() => invokeTool('demo_tool', {}, { permissions: ['chat-write'] }), error => error.status === 400);
    const result = await invokeTool('demo_tool', { value: 'x' }, {
        permissions: ['chat-write'],
        receipt: entry => effects.push(entry),
    });
    assert.equal(result.effect, 'wrote x');
    assert.deepEqual(effects.map(entry => entry.phase), ['before', 'after'], 'the intent to write is saved before the native effect');
    assert.equal(effects[1].effect, 'wrote x');
    unregisterTool('demo_tool');
});

test('credential references resolve on the server and fail actionably when the saved profile is gone', () => {
    globalThis.DATA_ROOT = tempDirectories('credentials').root;
    assert.throws(() => createGenerationContext({ owner: '../escape' }), error => error.status === 400);
    const context = createGenerationContext({ owner: 'alice', credentialRef: { profileId: 'profile-1' } });
    assert.throws(() => resolveCredential(context), error => error.status === 409 && /connection profile/.test(error.message));
    assert.throws(() => resolveCredential(createGenerationContext({ owner: 'alice' })), error => error.code === 'JOB_PROFILE_MISSING');
});

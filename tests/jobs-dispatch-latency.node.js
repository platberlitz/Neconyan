/* eslint playwright/expect-expect: off -- Uses node:assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptJob, getJob, updateJob, mutateJobs, listJobs, jobKey } = await import('../src/jobs/store.js');
const { startJobsRunner, registerHandler } = await import('../src/jobs/runner.js');
const { subscribeJobsChanged } = await import('../src/jobs/notifications.js');

test('accepted jobs and released slots dispatch without waiting for the polling clock', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-dispatch-'));
    const directories = { root };
    const started = [];
    let finishFirst;
    const firstFinished = new Promise(resolve => { finishFirst = resolve; });
    registerHandler('latency-check', async ({ job }) => {
        started.push(job.id);
        if (started.length === 1) await firstFinished;
        return { saved: true };
    });
    const stop = startJobsRunner({ directoriesFor: () => directories, owners: () => ['latency-owner'] });
    t.after(() => { stop(); fs.rmSync(root, { recursive: true, force: true }); });
    // Allow initial recovery and its empty scan to finish. The interval never advances.
    await setImmediate();
    const submit = key => acceptJob(directories, { owner: 'latency-owner', type: 'latency-check',
        submissionKey: key, intent: {}, target: { kind: 'chat', id: 'same-chat' } }).job;
    const first = submit('first');
    const second = submit('second');
    await setImmediate();
    await setImmediate();
    assert.deepEqual(started, [first.id], 'An accepted job should start promptly while its shared target stays exclusive');
    finishFirst();
    for (let index = 0; index < 4; index++) await setImmediate();
    assert.deepEqual(started, [first.id, second.id], 'Releasing the target should dispatch the next job promptly');
    assert.equal(getJob(directories, second.id).state, 'completed');
});

test('a saved acceptance during an asynchronous scan is not lost', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-dispatch-race-'));
    const directoriesFor = owner => ({ root: path.join(root, owner) });
    const started = [];
    let releaseScan;
    let enterScan;
    const entered = new Promise(resolve => { enterScan = resolve; });
    const scanning = new Promise(resolve => { releaseScan = resolve; });
    registerHandler('latency-race', async ({ job }) => { started.push(job.id); });
    const stop = startJobsRunner({ directoriesFor, owners: () => ['first-owner', 'blocked-owner'],
        recoverWaiting: async () => { enterScan(); await scanning; } });
    t.after(() => { stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await setImmediate();
    const waiting = acceptJob(directoriesFor('blocked-owner'), { owner: 'blocked-owner', type: 'latency-race', submissionKey: 'waiting', intent: {} }).job;
    updateJob(directoriesFor('blocked-owner'), waiting.id, { state: 'waiting' });
    await entered;
    const accepted = acceptJob(directoriesFor('first-owner'), { owner: 'first-owner', type: 'latency-race', submissionKey: 'accepted', intent: {} }).job;
    await setImmediate();
    await setImmediate();
    releaseScan();
    for (let index = 0; index < 4; index++) await setImmediate();
    assert.deepEqual(started, [accepted.id]);
});

test('change hints follow committed writes, never failed or unchanged mutations', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-job-hints-'));
    const directories = { root };
    const changes = [];
    const unsubscribe = subscribeJobsChanged(change => {
        changes.push({ ...change, saved: listJobs(directories).map(job => job.state) });
    });
    t.after(() => { unsubscribe(); fs.rmSync(root, { recursive: true, force: true }); });
    const job = acceptJob(directories, { owner: 'hint-owner', type: 'latency-check', submissionKey: 'hint', intent: {} }).job;
    updateJob(directories, job.id, { state: 'running' });
    mutateJobs(directories, () => ({ changed: false }));
    assert.throws(() => mutateJobs(directories, () => { throw new Error('Refused'); }), /Refused/);
    assert.deepEqual(changes, [{ owner: 'hint-owner', queued: true, id: job.id, state: 'queued', saved: ['queued'] },
        { owner: 'hint-owner', queued: false, id: job.id, state: 'running', saved: ['running'] }]);
    mutateJobs(directories, store => { delete store.jobs[jobKey(job.id)]; });
    assert.deepEqual(changes.at(-1), { owner: 'hint-owner', queued: false, saved: [] });
});

test('a failed start-up recovery is tried again, so interrupted work does not stay running', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-recovery-retry-'));
    const directories = { root };
    const job = acceptJob(directories, { owner: 'retry-owner', type: 'latency-check', submissionKey: 'orphan', intent: {} }).job;
    updateJob(directories, job.id, { state: 'running' });
    const { acquireChatFileLock } = await import('../src/chat-file-lock.js');
    // Hold the ledger lock so the one start-up recovery attempt fails.
    const held = acquireChatFileLock(path.join(root, 'jobs', 'index.json'));
    const stop = startJobsRunner({ directoriesFor: () => directories, owners: () => ['retry-owner'] });
    t.after(() => { stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await setImmediate();
    held();
    assert.equal(getJob(directories, job.id).state, 'running');
    t.mock.timers.tick(6000);
    for (let index = 0; index < 4; index++) await setImmediate();
    assert.equal(getJob(directories, job.id).state, 'interrupted', 'the later attempt reconciles the record so Retry can reach it');
});

test('a waiting job whose recovery fails does not hold back queued work or overwrite a Stop', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-waiting-conflict-'));
    const directories = { root };
    const { acquireChatFileLock } = await import('../src/chat-file-lock.js');
    const { serverEvents } = await import('../src/server-events.js');
    const { requestCancellation } = await import('../src/jobs/store.js');
    const started = [];
    registerHandler('latency-conflict', async ({ job }) => { started.push(job.id); });
    const submit = key => acceptJob(directories, { owner: 'conflict-owner', type: 'latency-conflict', submissionKey: key, intent: {} }).job;
    const blocked = submit('blocked');
    const stopped = submit('stopped');
    updateJob(directories, blocked.id, { state: 'waiting' });
    updateJob(directories, stopped.id, { state: 'waiting' });
    let held = null;
    const release = () => { held?.(); held = null; };
    serverEvents.on('job-status-failed', release);
    const stop = startJobsRunner({ directoriesFor: () => directories, owners: () => ['conflict-owner'],
        recoverWaiting: async ({ job }) => {
            if (job.id === stopped.id) requestCancellation(directories, job.id);
            // The conflict write for this job meets a held ledger lock.
            else if (!started.length) held = acquireChatFileLock(path.join(root, 'jobs', 'index.json'));
            throw Object.assign(new Error('The saved review needs recovery.'), { status: 503 });
        } });
    t.after(() => { stop(); release(); serverEvents.off('job-status-failed', release); fs.rmSync(root, { recursive: true, force: true }); });
    await setImmediate();
    const queued = submit('queued');
    for (let index = 0; index < 6; index++) await setImmediate();
    assert.deepEqual(started, [queued.id], 'queued work still runs although the conflict could not be saved');
    assert.notEqual(getJob(directories, stopped.id).state, 'conflict', 'a Stop saved during recovery is kept');
});

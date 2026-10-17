import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptJob } from '../src/jobs/store.js';
import { readArtifact } from '../src/jobs/artifacts.js';
import { createRoleplayStreamPreview, publishRoleplayPreview, readRoleplayPreview } from '../src/generation/roleplay-preview.js';

function streamContext(owner = 'preview-test') {
    const parentJobId = randomUUID();
    const controller = new AbortController();
    const context = { owner, signal: controller.signal,
        job: { id: randomUUID(), intent: { request: { characterName: 'Nova', workflowCandidate: { parentJobId } } } } };
    const read = () => readRoleplayPreview({ owner, job: { id: parentJobId } });
    return { context, controller, read };
}

test('stream text publishes promptly while counts stay capped, content-driven and bounded by stop', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const { context, read } = streamContext();
    let calls = 0;
    const preview = createRoleplayStreamPreview(context, value => { calls++; return value.length; });
    preview.publish({ text: 'First', reasoning: 'Thought', generation: { model: 'accepted-model', source: 'custom' },
        gen_started: new Date(0).toISOString(), reasoning_duration: 1000, reasoning_finished: false });
    // The leading edge carries the first text and its counts immediately.
    assert.equal(read().text, 'First');
    assert.equal(read().token_count, 5);
    assert.equal(read().reasoning_tokens, 7);
    assert.equal(read().generation.model, 'accepted-model');
    assert.equal(calls, 2);
    for (let index = 0; index < 100; index++) preview.publish({ text: 'First and last', reasoning: 'Thought' });
    // The trailing text publish no longer waits for the 500ms counting window.
    t.mock.timers.tick(32);
    assert.equal(read().text, 'First');
    t.mock.timers.tick(1);
    assert.equal(read().text, 'First and last');
    assert.equal(calls, 2, 'counts wait for their own interval');
    assert.equal(read().token_count, 5, 'the previous count rides along until the recount');
    assert.equal(read().reasoning_duration, 1033, 'Reconnecting during a paused stream retains elapsed thinking time');
    // The paused stream's trailing count at 500ms recounts only the changed field.
    t.mock.timers.tick(467);
    assert.equal(read().token_count, 14);
    assert.equal(read().reasoning_tokens, 7);
    assert.equal(calls, 3, 'identical reasoning content is not recounted');
    assert.equal(read().text, 'First and last');
    // A leading-edge publish before stop is legitimate; stop must cancel the
    // trailing text and count timers scheduled inside the throttle windows.
    preview.publish({ text: 'Shown once' });
    preview.publish({ text: 'Never shown' });
    preview.stop();
    t.mock.timers.tick(5000);
    assert.equal(read().text, 'Shown once');
    assert.equal(calls, 3, 'stop ends every pending publication and timer');
    preview.publish({ text: 'Also never shown' });
    t.mock.timers.tick(5000);
    assert.equal(read().text, 'Shown once');
    assert.equal(calls, 3, 'a publish after stop does nothing');
});

test('a slow tokenizer stretches the count interval but never the text cadence', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const { context, read } = streamContext();
    let calls = 0;
    let slow = true;
    // The first count measures 80ms on this server, so counting backs off to 800ms.
    const count = value => { calls++; if (slow) { slow = false; t.mock.timers.tick(80); } return value.length; };
    const preview = createRoleplayStreamPreview(context, count);
    preview.publish({ text: 'a', reasoning: '' });
    assert.equal(read().text, 'a');
    assert.equal(calls, 2);
    preview.publish({ text: 'ab', reasoning: '' });
    assert.equal(read().text, 'ab', 'text is never gated on the stretched counting window');
    assert.equal(calls, 2);
    t.mock.timers.tick(799);
    assert.equal(calls, 2, 'no recount before the stretched interval');
    t.mock.timers.tick(1);
    assert.equal(calls, 3, 'only the changed text is recounted');
    assert.equal(read().token_count, 2);
    assert.equal(read().reasoning_tokens, 0);
});

test('a same-length rewrite is recounted because content, not length, drives counts', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const { context, read } = streamContext();
    let calls = 0;
    const preview = createRoleplayStreamPreview(context, value => { calls++; return value.length; });
    preview.publish({ text: 'aaaa', reasoning: '' });
    assert.equal(calls, 2);
    assert.equal(read().token_count, 4);
    preview.publish({ text: 'bbbb', reasoning: '' });
    t.mock.timers.tick(500);
    assert.equal(read().text, 'bbbb');
    assert.equal(calls, 3, 'same length, different content: the text is recounted');
    assert.equal(read().token_count, 4);
});

test('an aborted job stops preview publications', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const { context, controller, read } = streamContext();
    let calls = 0;
    const preview = createRoleplayStreamPreview(context, value => { calls++; return value.length; });
    preview.publish({ text: 'one', reasoning: '' });
    assert.equal(read().text, 'one');
    controller.abort();
    preview.publish({ text: 'two', reasoning: '' });
    t.mock.timers.tick(5000);
    assert.equal(read().text, 'one', 'nothing publishes after the abort');
    assert.equal(calls, 2);
});

test('each completed Companion survives reconnect without changing the main reply or another candidate', t => {
    const directories = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-preview-progress-')) };
    t.after(() => fs.rmSync(directories.root, { recursive: true, force: true }));
    const owner = 'preview-progress';
    const { job } = acceptJob(directories, { owner, type: 'roleplay.workflow', submissionKey: randomUUID(), intent: { operation: 'roleplay-generate' } });
    const context = { owner, directories, job: { id: randomUUID(), intent: { request: {
        characterName: 'Nova', workflowCandidate: { parentJobId: job.id },
    } } } };
    publishRoleplayPreview(context, { text: 'Finished reply', gen_finished: '2026-10-16T12:00:00.000Z', stage: 'agents' });
    const results = { early: { status: 'done', content: 'Ready' }, late: { status: 'pending', content: '' } };
    publishRoleplayPreview(context, { inChatAgentCompanionResults: results });
    const persisted = readArtifact(directories, job.id, 'roleplay-preview');
    assert.deepEqual(persisted.inChatAgentCompanionResults, results);
    assert.equal(persisted.text, 'Finished reply');
    assert.equal(persisted.gen_finished, '2026-10-16T12:00:00.000Z');
    assert.equal(persisted.stage, 'agents', 'Parallel Companions do not claim post-processing has finished');
    publishRoleplayPreview(context, { stage: 'companions' });
    assert.deepEqual(readRoleplayPreview({ owner, directories, job }).inChatAgentCompanionResults, results);
    context.job.id = randomUUID();
    publishRoleplayPreview(context, { text: 'Next candidate', stage: 'generating' });
    assert.equal(readRoleplayPreview({ owner, directories, job }).inChatAgentCompanionResults, undefined);
});

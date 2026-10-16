import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptJob } from '../src/jobs/store.js';
import { readArtifact } from '../src/jobs/artifacts.js';
import { createRoleplayStreamPreview, publishRoleplayPreview, readRoleplayPreview } from '../src/generation/roleplay-preview.js';

test('live counts are bounded, include a paused stream\'s last chunk, and stop with their provider call', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const parentJobId = randomUUID();
    const controller = new AbortController();
    const context = { owner: 'preview-test', signal: controller.signal,
        job: { id: randomUUID(), intent: { request: { characterName: 'Nova', workflowCandidate: { parentJobId } } } } };
    const read = () => readRoleplayPreview({ owner: context.owner, job: { id: parentJobId } });
    let calls = 0;
    const preview = createRoleplayStreamPreview(context, value => { calls++; return value.length; });
    preview.publish({ text: 'First', reasoning: 'Thought', generation: { model: 'accepted-model', source: 'custom' },
        gen_started: new Date(0).toISOString(), reasoning_duration: 1000, reasoning_finished: false });
    assert.equal(read().token_count, 5);
    assert.equal(read().reasoning_tokens, 7);
    assert.equal(read().generation.model, 'accepted-model');
    for (let index = 0; index < 100; index++) preview.publish({ text: 'First and last', reasoning: 'Thought' });
    assert.equal(calls, 2);
    t.mock.timers.tick(499);
    assert.equal(read().text, 'First');
    assert.equal(read().reasoning_duration, 1499, 'Reconnecting during a paused stream retains elapsed thinking time');
    t.mock.timers.tick(1);
    assert.equal(read().text, 'First and last');
    assert.equal(read().token_count, 14);
    assert.equal(calls, 4);
    preview.publish({ text: 'Never shown' });
    preview.stop();
    t.mock.timers.tick(500);
    assert.equal(read().text, 'First and last');
    assert.equal(calls, 4);
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

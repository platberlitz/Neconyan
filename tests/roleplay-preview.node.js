import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRoleplayStreamPreview, readRoleplayPreview } from '../src/generation/roleplay-preview.js';

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

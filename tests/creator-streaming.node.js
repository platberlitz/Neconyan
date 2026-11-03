import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorPrefill, joinCreatorPrefill } from '../public/scripts/creator/prefill.js';
import { collectGenerationStream } from '../public/scripts/generation-stream-result.js';

test('Catelier chooses the prefill for each attempted model without changing its settings', () => {
    const settings = { prefill: '{', partialPrefill: '<think>Plan carefully.</think>{"fields":' };
    for (const model of ['kimi-k3', 'moonshot/kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']) {
        assert.deepEqual(creatorPrefill(settings, model), { text: settings.partialPrefill, partial: true, reply: '{"fields":' });
    }
    assert.deepEqual(creatorPrefill(settings, 'other'), { text: '{', partial: false, reply: '{' });
    assert.equal(creatorPrefill({ prefill: '{', partialPrefill: '' }, 'kimi-k3').text, '{');
    assert.equal(creatorPrefill({ partialPrefill: '<think>Plan carefully.' }, 'kimi-k3').reply, '');
    assert.equal(settings.prefill, '{');
});

test('Catelier joins continuations and handles echoed prefixes without duplicating them', () => {
    assert.equal(joinCreatorPrefill('"fields":{}}', '{'), '{"fields":{}}');
    assert.equal(joinCreatorPrefill('{"fields":{}}', '{'), '{"fields":{}}');
    assert.equal(joinCreatorPrefill('{"fi', '{"fields":'), '{"fi');
    assert.equal(joinCreatorPrefill('', '{'), '');
});

test('Auxiliary streams report cumulative text and preserve length stops', async () => {
    const updates = [];
    const result = await collectGenerationStream(async function* () {
        yield { text: 'First', state: { reasoning: 'Plan' } };
        yield { text: 'First second', state: { finishReason: 'length' } };
        yield { text: 'First second', state: {} };
    }, { onChunk: chunk => updates.push(chunk.text) });
    assert.deepEqual(updates, ['First', 'First second', 'First second']);
    assert.equal(result.choices[0].finish_reason, 'length');
    assert.equal(result.choices[0].message.content, 'First second');
});

test('Auxiliary streams reject cut-short or blocked output and cancellation', async () => {
    for (const status of ['truncated', 'blocked', 'error']) {
        await assert.rejects(collectGenerationStream(async function* () {
            yield { text: '{"fields":{}}', state: { outcome: { status } } };
        }), /did not complete/);
    }
    const controller = new AbortController();
    await assert.rejects(collectGenerationStream(async function* () {
        yield { text: 'First', state: {} };
        controller.abort();
        yield { text: 'Late reply', state: {} };
    }, { signal: controller.signal }), { name: 'AbortError' });
});

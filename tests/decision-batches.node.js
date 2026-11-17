/* eslint playwright/expect-expect: off -- Node assertions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestDecisionBatches } from '../src/decision-batches.js';

const url = 'https://api.nano-gpt.com/api/v1/systemone';
const body = (model, count) => ({ model, state: 'A scene.', questions: Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`q_${i}`, { type: 'noul', instructions: `Memory ${i}`, criteria: { true: 'Relevant', false: 'Irrelevant' } }])) });

test('Nano-GPT batches question limits with stable IDs and combined usage', async () => {
    for (const [model, count, sizes] of [['eu-jev/eu-jeff-latest', 19, [8, 8, 3]], ['vllm-sr/decision-large', 65, [64, 1]], ['surogate/rune-26b-a4b', 257, [256, 1]]]) {
        const input = body(model, count);
        const calls = [];
        const result = await requestDecisionBatches(url, input, async batch => {
            calls.push(batch);
            return { answers: Object.fromEntries(Object.keys(batch.questions).map(id => [id, { noul: 0.9 }])), usage: { input_tokens: 10, output_tokens: 2 } };
        });
        assert.deepEqual(calls.map(batch => Object.keys(batch.questions).length), sizes);
        assert.deepEqual(Object.keys(result.answers), Object.keys(input.questions));
        assert.ok(Object.values(result.answers).every(answer => answer.noul === 0.9));
        assert.equal(result.usage.input_tokens, 10 * sizes.length);
        assert.equal(result.usage.output_tokens, 2 * sizes.length);
        assert.equal(Object.keys(input.questions).length, count);
    }
});

test('Nano-GPT body limits split before dispatch and reject an oversized scene before any call', async () => {
    const input = body('eu-jev/eu-jeff-latest', 2);
    for (const question of Object.values(input.questions)) question.instructions = '文'.repeat(50000);
    const calls = [];
    await requestDecisionBatches(url, input, async batch => { calls.push(batch); return { answers: {} }; });
    assert.deepEqual(calls.map(batch => Object.keys(batch.questions).length), [1, 1]);
    calls.length = 0;
    input.state = '文'.repeat(90000);
    await assert.rejects(requestDecisionBatches(url, input, async batch => calls.push(batch)), /too large/);
    assert.equal(calls.length, 0);
});

test('batch failures propagate and missing or refused answers stay invalid', async () => {
    let calls = 0;
    await assert.rejects(requestDecisionBatches(url, body('eu-jev/eu-jeff-latest', 19), async () => {
        if (++calls === 2) throw new Error('cancelled or HTTP failure');
        return { answers: {} };
    }), /cancelled or HTTP failure/);
    assert.equal(calls, 2);
    const data = await requestDecisionBatches(url, body('eu-jev/eu-jeff-latest', 9), async () => ({ answers: { q_0: { type: 'refusal' } } }));
    assert.deepEqual(data.answers.q_0, { type: 'refusal' });
    assert.equal(data.answers.q_8, undefined);
});

test('other providers and a single Nano-GPT request preserve raw responses', async () => {
    const response = { answers: { q_0: { noul: 0.8 } }, extra: 'receipt' };
    for (const [endpoint, input] of [[url, body('jaredpalmer/kev-9b', 1)], ['https://openrouter.ai/api/alpha/decisions', body('typesafe/jev-1.14', 130)]]) {
        let calls = 0;
        assert.equal(await requestDecisionBatches(endpoint, input, async sent => { calls++; assert.deepEqual(sent, input); return response; }), response);
        assert.equal(calls, 1);
    }
});

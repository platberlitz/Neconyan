import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGenerationOutcome, generationErrorEnvelope } from '../public/scripts/generation-outcome.js';
import { assembleGenerationStream } from '../src/generation/stream-result.js';
const event = value => `data: ${JSON.stringify(value)}\n\n`;
for (const [label, data] of Object.entries({
    openrouter: { choices: [{ finish_reason: 'content_filter' }] },
    nanogpt: { error: { code: 'content_policy_violation' } },
    claude: { delta: { stop_reason: 'refusal' } },
    claudeAdapter: { choices: [{ finish_reason: 'refusal' }] },
    gemini: { candidates: [{ finishReason: 'SAFETY' }] },
    geminiAdapter: { choices: [{ finish_reason: 'PROHIBITED_CONTENT' }] },
    geminiInput: { promptFeedback: { blockReason: 'BLOCKLIST' } },
})) test(`explicit ${label} block`, () => assert.equal(classifyGenerationOutcome(data)?.status, 'blocked'));
test('normal, unknown and textual refusals are not blocks; choice index owns the outcome', () => {
    for (const reason of ['stop', 'length', 'OTHER', null, 'unknown']) assert.equal(classifyGenerationOutcome({ choices: [{ finish_reason: reason }] }), null);
    assert.equal(classifyGenerationOutcome({ choices: [{ index: 1, finish_reason: 'content_filter' }, { index: 0, finish_reason: 'stop' }] }), null);
    assert.equal(classifyGenerationOutcome({ choices: [{ index: 1, finish_reason: 'content_filter' }] }, 1)?.status, 'blocked');
    assert.equal(classifyGenerationOutcome({ message: 'I cannot help.', status: 403 }), null);
    assert.equal(generationErrorEnvelope({ type: 'message_start', message: { role: 'assistant', content: [] } }), false);
    assert.equal(generationErrorEnvelope({ type: 'error', error: { message: 'Failed' } }), true);
});
test('blocked partial and empty streams finish without DONE, including blocked error events', () => {
    for (const prefix of ['', event({ choices: [{ delta: { content: 'Unfinished sentence with' } }] })]) {
        for (const suffix of [event({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }), 'event: error\n' + event({ error: { code: 'content_policy_violation' } })]) {
            const result = assembleGenerationStream(prefix + suffix);
            assert.equal(classifyGenerationOutcome(result)?.status, 'blocked');
            assert.equal(result.choices[0].message.content, prefix ? 'Unfinished sentence with' : '');
        }
    }
});
test('a successful primary ignores secondary filtered tools and preserves trailing usage', () => {
    const result = assembleGenerationStream(event({ choices: [{ index: 1, delta: { tool_calls: [{ bad: true }] }, finish_reason: 'content_filter' }, { index: 0, delta: { content: 'Main.' }, finish_reason: 'stop' }] }) + event({ usage: { total_tokens: 1 } }) + 'data: [DONE]\n\n');
    assert.equal(result.choices[0].message.content, 'Main.');
    assert.equal(classifyGenerationOutcome(result), null);
});
test('ordinary Anthropic start is successful and unknown explicit errors remain errors', () => {
    const result = assembleGenerationStream(event({ type: 'message_start', message: { role: 'assistant', content: [] } }) + event({ delta: { text: 'Hello.' } }) + event({ type: 'message_stop' }));
    assert.equal(result.choices[0].message.content, 'Hello.');
    assert.throws(() => assembleGenerationStream('event: error\n' + event({ error: { type: 'overloaded_error' } })), /rejected/);
});

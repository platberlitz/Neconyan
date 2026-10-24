import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGenerationOutcome, classifyGenerationOutcome, generationErrorEnvelope, messageAutomaticGenerationSuppressed,
    providerBlockedError } from '../public/scripts/generation-outcome.js';
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

const geminiErrors = ['MALFORMED_FUNCTION_CALL', 'MALFORMED_RESPONSE', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS',
    'MISSING_THOUGHT_SIGNATURE', 'PUP_LIMITED_DISABLED'];
const ordinaryEndings = ['STOP', 'MAX_TOKENS', 'CONTINUATION', 'LANGUAGE', 'ESCALATION', 'OTHER', 'FINISH_REASON_UNSPECIFIED',
    'NO_IMAGE', 'IMAGE_OTHER', 'tool_calls'];

test('a provider error finish classifies with the provider token for choices and candidates', () => {
    assert.deepEqual(classifyGenerationOutcome({ choices: [{ finish_reason: 'error' }] }), { version: 1, status: 'error', reason: 'error' });
    for (const reason of geminiErrors) {
        assert.deepEqual(classifyGenerationOutcome({ candidates: [{ finishReason: reason }] }), { version: 1, status: 'error', reason });
        assert.deepEqual(classifyGenerationOutcome({ choices: [{ finish_reason: reason }] }), { version: 1, status: 'error', reason });
    }
});

test('ordinary endings, other finish reasons and generic error envelopes stay unclassified', () => {
    for (const reason of ordinaryEndings) {
        assert.equal(classifyGenerationOutcome({ choices: [{ finish_reason: reason }] }), null);
        assert.equal(classifyGenerationOutcome({ candidates: [{ finishReason: reason }] }), null);
    }
    for (const reason of [null, 'stop', 'length', 'unknown']) assert.equal(classifyGenerationOutcome({ choices: [{ finish_reason: reason }] }), null);
    assert.equal(classifyGenerationOutcome({ error: { code: 'error' } }), null);
    assert.equal(classifyGenerationOutcome({ choices: [{ index: 1, finish_reason: 'error' }] }), null);
});

test('the Gemini empty-candidate error body classifies as an empty-text error', () => {
    const body = { error: { message: 'Gemini Candidate text empty' },
        choices: [{ finish_reason: 'MALFORMED_FUNCTION_CALL', message: { content: '' } }] };
    assert.deepEqual(classifyGenerationOutcome(body), { version: 1, status: 'error', reason: 'MALFORMED_FUNCTION_CALL' });
    assert.equal(body.choices[0].message.content, '');
});

test('a classified error outcome persists and keeps automatic work suppressed after reopening', () => {
    const message = { extra: {} };
    for (const outcome of [{ version: 1, status: 'error', reason: 'error' },
        { version: 1, status: 'error', reason: 'provider_error' }]) {
        applyGenerationOutcome(message, outcome);
        assert.deepEqual(message.extra.generation_outcome, outcome);
        assert.equal(messageAutomaticGenerationSuppressed(message), true);
    }
    for (const outcome of [null, undefined, { version: 1, status: 'unknown', reason: 'other' }, { version: 1, status: 'blocked', reason: 'unknown' }]) {
        applyGenerationOutcome(message, outcome);
        assert.equal(message.extra.generation_outcome, undefined);
        assert.equal(messageAutomaticGenerationSuppressed(message), false);
    }
});

test('a provider error keeps the blocked code and chooses its message by status', () => {
    const blocked = providerBlockedError({ version: 1, status: 'blocked', reason: 'content_filter' });
    const error = providerBlockedError({ version: 1, status: 'error', reason: 'error' });
    for (const value of [blocked, error]) {
        assert.equal(value.code, 'GENERATION_BLOCKED');
        assert.equal(value.status, 422);
    }
    assert.match(blocked.message, /content filter/);
    assert.match(error.message, /^The provider ended this reply with an error\. Automatic agents were not run\.$/);
    assert.notEqual(blocked.message, error.message);
});

test('an error finish keeps partial text, drops tools and re-emits the provider token', () => {
    const result = assembleGenerationStream(event({ choices: [{ delta: { content: 'Partial answer',
        tool_calls: [{ id: 'call-after-error' }] } }] }) + event({ choices: [{ delta: {}, finish_reason: 'error' }] }));
    assert.equal(result.choices[0].message.content, 'Partial answer');
    assert.equal(result.choices[0].finish_reason, 'error');
    assert.equal(result.choices[0].message.tool_calls, undefined);
    assert.deepEqual(classifyGenerationOutcome(result), { version: 1, status: 'error', reason: 'error' });
    const empty = assembleGenerationStream(event({ choices: [{ delta: {}, finish_reason: 'MALFORMED_RESPONSE' }] }));
    assert.equal(empty.choices[0].message.content, '');
    assert.equal(empty.choices[0].finish_reason, 'MALFORMED_RESPONSE');
});

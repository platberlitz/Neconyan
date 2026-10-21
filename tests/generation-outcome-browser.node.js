import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { classifyGenerationOutcome, generationErrorEnvelope, providerBlockedError } from '../public/scripts/generation-outcome.js';
const source = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const extract = name => source.slice(source.indexOf(`export function ${name}`), source.indexOf('\n/**', source.indexOf(`export function ${name}`))).replace('export function', 'function');
const eventSource = fs.readFileSync(new URL('../public/scripts/sse-stream.js', import.meta.url), 'utf8');
const EventSourceStream = vm.runInNewContext(eventSource.slice(eventSource.indexOf('class EventSourceStream'), eventSource.indexOf('/**\n * Gets a delay')) + '\nEventSourceStream;', { TextDecoderStream, TransformStream, MessageEvent });
const sandbox = { classifyGenerationOutcome, generationErrorEnvelope, providerBlockedError,
    getEventSourceStream: () => new EventSourceStream(),
    ToolManager: { parseToolCalls: (calls, parsed) => calls.push(...(parsed.choices?.[0]?.delta?.tool_calls ?? [])) },
    getStreamingReply: (parsed, state) => { state.reasoning += parsed.choices?.[0]?.delta?.reasoning ?? ''; return parsed.choices?.[0]?.delta?.content ?? parsed.delta?.text ?? ''; },
    isGenerationLengthFinish: data => data.choices?.[0]?.finish_reason === 'length', parseChatCompletionLogprobs: () => null,
    checkQuotaError: () => {}, checkModerationError: () => {}, toastr: { error() {} },
};
vm.createContext(sandbox);
vm.runInContext(extract('tryParseStreamingError') + '\n' + extract('readChatCompletionStream'), sandbox);
const encode = frame => 'data: ' + JSON.stringify(frame) + '\n\n';
async function read(raw, canMultiSwipe = true) {
    const bytes = new TextEncoder().encode(raw);
    const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
    let last;
    for await (const chunk of sandbox.readChatCompletionStream({ body, status: 200, statusText: 'OK' }, { canMultiSwipe })()) last = chunk;
    return last;
}
for (const together of [false, true]) test(`browser reader isolates primary from secondary reasoning/tools/filter (${together ? 'same frame' : 'separate frames'})`, async () => {
    const primary = { index: 0, delta: { content: 'Primary' }, finish_reason: 'stop' };
    const secondary = { index: 1, delta: { content: 'Secondary', reasoning: 'Secondary thought', tool_calls: [{ forbidden: true }] }, finish_reason: 'content_filter' };
    const result = await read((together ? encode({ choices: [secondary, primary] }) : encode({ choices: [secondary] }) + encode({ choices: [primary] })) + 'data: [DONE]\n\n');
    assert.equal(result.text, 'Primary');
    assert.equal(result.state.outcome, null);
    assert.equal(result.state.reasoning, '');
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.state.outcomes[1].status, 'blocked');
    assert.equal(result.swipes[0], 'Secondary');
});
test('browser reader retains primary block after usage and blocked errors, with split transport chunks', async () => {
    for (const final of [encode({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }), 'event: error\n' + encode({ error: { code: 'content_policy_violation' } })]) {
        const result = await read(encode({ choices: [{ delta: { content: 'Unfinished' } }] }) + final + encode({ usage: { total_tokens: 3 } }));
        assert.equal(result.text, 'Unfinished');
        assert.equal(result.state.outcome.status, 'blocked');
    }
});
test('browser reader preserves ordinary Anthropic stream and propagates genuine errors', async () => {
    const result = await read(encode({ type: 'message_start', message: { content: [] } }) + encode({ delta: { text: 'Hello' } }) + encode({ type: 'message_stop' }));
    assert.equal(result.text, 'Hello');
    await assert.rejects(read('event: error\n' + encode({ detail: 'unknown' })), /rejected/);
    assert.throws(() => sandbox.tryParseStreamingError({}, JSON.stringify({ error: { message: 'Error' } })), /Error/);
    assert.doesNotThrow(() => sandbox.tryParseStreamingError({}, 'not JSON'));
});

test('explicit error events and ordinary error envelopes each show one notice', async () => {
    const notices = [];
    sandbox.toastr.error = (...args) => notices.push(args);
    for (const raw of ['event: error\n' + encode({ detail: 'unavailable' }), encode({ error: { message: 'Unavailable' } })]) {
        notices.length = 0;
        await assert.rejects(read(raw));
        assert.equal(notices.length, 1);
        assert.ok(notices[0][0]);
        assert.notEqual(notices[0][0], 'OK');
    }
});

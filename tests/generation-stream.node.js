import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import './roleplay-transactions-fixture.js';
import { assembleGenerationStream } from '../src/generation/stream-result.js';
const { runBackendRequest } = await import('../src/endpoints/conversation-generation.js');
const { forwardFetchResponse } = await import('../src/util.js');
const { runTextGeneration } = await import('../src/generation/service.js');

const event = value => `data: ${JSON.stringify(value)}\n\n`;

test('native streaming waits for upstream completion and assembles reasoning', async () => {
    const chunks = [event({ choices: [{ delta: { content: 'Hel', reasoning_content: 'Why ' } }] }),
        event({ choices: [{ delta: { content: 'lo', reasoning_content: 'not?' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n'];
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from((async function* () {
            for (const chunk of chunks) { await new Promise(resolve => setTimeout(resolve, 5)); yield chunk; }
        })()) }, response, request);
    const response = await runBackendRequest({ headers: {}, socket: new EventEmitter() }, handler, { stream: true });
    assert.equal(response.choices[0].message.content, 'Hello');
    assert.equal(response.choices[0].message.reasoning_content, 'Why not?');
});

test('incomplete and malformed provider streams are never completed', async () => {
    const handler = (_, response) => { response.write(event({ choices: [{ delta: { content: 'partial' } }] })); response.end(); };
    await assert.rejects(runBackendRequest({}, handler, { stream: true }), /without a complete reply/);
    assert.throws(() => assembleGenerationStream('data: {invalid}\n\ndata: [DONE]\n\n'), /invalid event/);
    assert.throws(() => assembleGenerationStream('data: {"error":"provider refused"}\n\ndata: [DONE]\n\n'), /rejected/);
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { content: 'A'.repeat(2 * 1024 * 1024) } }] }) + 'data: [DONE]\n\n'), /limit/);
});

test('an upstream error after a completion marker does not commit a partial result', async () => {
    const failure = new Error('upstream connection failed');
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from((async function* () {
            yield event({ choices: [{ delta: { content: 'reply' }, finish_reason: 'stop' }] });
            throw failure;
        })()) }, response, request);
    await assert.rejects(runBackendRequest({}, handler, { stream: true }), /upstream connection failed/);
});

test('the capture refuses an oversized streamed response before saving it', async () => {
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from([event({ choices: [{ delta: { content: 'A'.repeat(2 * 1024 * 1024) } }] })]) }, response, request);
    await assert.rejects(runBackendRequest({}, handler, { stream: true }), /limit/);
});

test('cancelling a bound stream closes its upstream body without a saved reply', async () => {
    const controller = new AbortController();
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from((async function* () {
            yield event({ choices: [{ delta: { content: 'partial' } }] });
            controller.abort();
        })()) }, response, request);
    await assert.rejects(runBackendRequest({}, handler, { stream: true }, { signal: controller.signal }), error => error.status === 499);
});

test('provider formats preserve text, reasoning and signatures in a bounded result', () => {
    const response = assembleGenerationStream([
        event({ delta: { text: 'Claude ', thinking: 'Thought ' } }),
        event({ candidates: [{ content: { parts: [{ thought: true, text: 'idea' }, { text: 'Gemini', thoughtSignature: 'sig' }] }, finishReason: 'STOP' }] }),
        event({ delta: { message: { content: { text: 'Cohere' } } } }),
        'data: [DONE]\n\n',
    ].join(''));
    assert.equal(response.choices[0].message.content, 'Claude GeminiCohere');
    assert.equal(response.choices[0].message.reasoning_content, 'Thought idea');
    assert.equal(response.responseContent.parts.at(-1).thoughtSignature, 'sig');
});

test('the native Ollama text backend waits for its converted stream completion', async () => {
    const context = { owner: 'fixture', directories: { root: '/tmp/opencode' } };
    const result = await runTextGeneration({ context, backend: 'text', payload: {
        api_type: 'ollama', api_server: 'http://127.0.0.1:11434', prompt: 'Hi', model: 'fixture', stream: true,
    }, fetch: async (_url, options) => {
        assert.equal(JSON.parse(options.body).stream, true);
        return { ok: true, status: 200, body: Readable.from(['{"response":"Ollama ","done":false}', '{"response":"reply","done":true}']) };
    } });
    assert.equal(result.text, 'Ollama reply');
});

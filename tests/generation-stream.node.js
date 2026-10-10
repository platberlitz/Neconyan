import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import './roleplay-transactions-fixture.js';
import { assembleGenerationStream, createGenerationStream } from '../src/generation/stream-result.js';
import { MAX_GENERATION_STREAM_BYTES, MAX_GENERATION_TEXT_BYTES } from '../src/generation/stream-limits.js';
const { runBackendRequest, createCapturingResponse } = await import('../src/endpoints/conversation-generation.js');
const { handleChatCompletionsGenerate } = await import('../src/endpoints/backends/chat-completions.js');
const { forwardFetchResponse } = await import('../src/util.js');
const { runTextGeneration } = await import('../src/generation/service.js');

const event = value => `data: ${JSON.stringify(value)}\n\n`;

test('streamed tool-only replies collect split arguments and keep ordinary previews', async () => {
    const chunks = [
        { choices: [{ delta: { content: 'Here is the draft.', tool_calls: [{ index: 0, id: 'create', type: 'function', function: { name: 'CreateCharacter', arguments: '{"character":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"name":"Nova"}}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const updates = [];
    const result = await runBackendRequest({}, (_request, response) => response.end(chunks.map(event).join('')),
        { stream: true, tools: [{ type: 'function', function: { name: 'CreateCharacter' } }] }, { onStream: value => updates.push(value) });
    assert.equal(updates[0].text, 'Here is the draft.');
    assert.equal(result.choices[0].message.content, 'Here is the draft.');
    assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { character: { name: 'Nova' } });
    delete chunks[0].choices[0].delta.content;
    const toolOnly = assembleGenerationStream(chunks.map(event).join(''), { allowTools: true });
    assert.equal(toolOnly.choices[0].message.content, '');
    assert.equal(toolOnly.choices[0].message.tool_calls.length, 1);
    assert.throws(() => assembleGenerationStream(event(chunks[0]), { allowTools: true }), /JSON|complete/);
    assert.throws(() => assembleGenerationStream(event(chunks[0]) + 'data: [DONE]\n\n', { allowTools: true }), /JSON/);
    chunks[1].choices[0].delta.tool_calls[0].function.name = 'CreateCharacter';
    const repeated = assembleGenerationStream(chunks.map(event).join(''), { allowTools: true });
    assert.equal(repeated.choices[0].message.tool_calls[0].function.name, 'CreateCharacter', 'proxies that repeat the full name do not double it');
    const split = structuredClone(chunks);
    split[0].choices[0].delta.tool_calls[0].function.name = 'Create';
    split[1].choices[0].delta.tool_calls[0].function.name = 'Character';
    assert.equal(assembleGenerationStream(split.map(event).join(''), { allowTools: true }).choices[0].message.tool_calls[0].function.name, 'CreateCharacter');
});

test('Responses text streams without tools still assemble their text', () => {
    const chunks = [{ type: 'response.output_text.delta', delta: 'Hello ' }, { type: 'response.output_text.delta', delta: 'there.' }, { type: 'response.completed' }];
    assert.equal(assembleGenerationStream(chunks.map(event).join('')).choices[0].message.content, 'Hello there.');
});

test('native provider tool streams become the same reviewable calls', () => {
    const args = { character: { name: 'Nova' } };
    const providers = [
        [{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'create', name: 'CreateCharacter', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"character":' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":"Nova"}}' } }, { type: 'message_stop' }],
        [{ candidates: [{ content: { parts: [{ functionCall: { name: 'CreateCharacter', args } }] }, finishReason: 'STOP' }] }],
        [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'create', name: 'CreateCharacter', arguments: '' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(args) }, { type: 'response.completed' }],
    ];
    for (const chunks of providers) {
        const call = assembleGenerationStream(chunks.map(event).join(''), { allowTools: true }).choices[0].message.tool_calls[0];
        assert.equal(call.function.name, 'CreateCharacter');
        assert.deepEqual(JSON.parse(call.function.arguments), args);
        assert.throws(() => assembleGenerationStream(chunks.map(event).join('')), /cannot save/);
    }
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { tool_calls: Array.from({ length: 33 }, (_, index) => ({ index })) } }] }), { allowTools: true }), /too many/);
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { tool_calls: [{ index: -1 }] } }] }), { allowTools: true }), /index/);
});

test('a dropped model connection retains a readable reason without runtime details', async () => {
    let calls = 0;
    await assert.rejects(runBackendRequest({ headers: {}, user: { directories: { root: '/tmp/opencode' } } },
        handleChatCompletionsGenerate, { chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1',
            model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], stream: true },
        { anonymousCustom: true, fetch: async () => {
            calls++;
            throw Object.assign(new Error('The socket connection was closed unexpectedly. Pass verbose: true to fetch().'),
                { code: 'ECONNRESET', path: 'https://private.invalid/secret' });
        } }), error => {
        assert.equal(error.message, 'The connection to your model provider closed before a complete reply was received.');
        assert.equal(error.status, 502);
        assert.equal(error.providerStatus, 502);
        return true;
    });
    assert.equal(calls, 1);
});

test('a provider rejection keeps its explanation and ignores non-text error details', async () => {
    const refuse = body => (_request, response) => response.status(401).send(body);
    await assert.rejects(runBackendRequest({}, refuse({ error: { message: 'The selected API key has expired.' } }), { stream: false }),
        error => error.message === 'The selected API key has expired.' && error.status === 401);
    await assert.rejects(runBackendRequest({}, refuse({ error: { message: { secret: 'not an explanation' } } }), { stream: false }),
        error => error.message === 'The model provider could not complete the reply (HTTP 401).');
    await assert.rejects(runBackendRequest({}, (_request, response) => response.sendStatus(503), { stream: false }),
        error => error.message === 'The model provider could not complete the reply (HTTP 503).' && error.status === 502);
});

test('native streaming publishes the first text before the provider completes', async () => {
    const first = Promise.withResolvers(), finish = Promise.withResolvers();
    let completed = false;
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200,
        body: Readable.from((async function* () {
            yield event({ choices: [{ delta: { content: 'First' } }] });
            await finish.promise;
            yield event({ choices: [{ delta: { content: ' second' }, finish_reason: 'stop' }] });
        })()) }, response, request);
    const result = runBackendRequest({}, handler, { stream: true }, { onStream: value => first.resolve(value) })
        .then(value => { completed = true; return value; });
    try {
        assert.deepEqual(await first.promise, { text: 'First', reasoning: '' });
        assert.equal(completed, false);
    } finally { finish.resolve(); }
    assert.equal((await result).choices[0].message.content, 'First second');
    const updates = [];
    await assert.rejects(runBackendRequest({}, (_request, response) => {
        response.write(event({ choices: [{ delta: { content: 'Unfinished' } }] }));
        response.end();
    }, { stream: true }, { onStream: value => updates.push(value) }), /without a complete reply/);
    assert.equal(updates[0].text, 'Unfinished');
});

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

test('a provider refusal keeps its upstream status behind the safe client status', async () => {
    const refuse = body => async (_request, response) => response.status(502).send(body);
    const request = { headers: {}, socket: new EventEmitter() };
    await assert.rejects(runBackendRequest(request, refuse({ error: { message: 'busy' }, provider_status: 503 }), { stream: false }),
        error => error.status === 502 && error.providerStatus === 503);
    await assert.rejects(runBackendRequest(request, refuse({ error: true, status: 429, response: 'slow down' }), { stream: false }),
        error => error.providerStatus === 429);
    await assert.rejects(runBackendRequest(request, refuse({ error: true, status: 'ECONNRESET' }), { stream: false }),
        error => error.providerStatus === 502);
});

test('native streaming preserves a UTF-8 character split across network chunks', async () => {
    const bytes = Buffer.from(event({ choices: [{ delta: { content: 'Café 😺' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    const split = bytes.indexOf(Buffer.from('😺')) + 2;
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]) }, response, request);
    const response = await runBackendRequest({ headers: {}, socket: new EventEmitter() }, handler, { stream: true });
    assert.equal(response.choices[0].message.content, 'Café 😺');
    const invalid = async (request, capture) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"'), Buffer.from([0xc3]),
            Buffer.from('"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]) }, capture, request);
    await assert.rejects(runBackendRequest({ headers: {}, socket: new EventEmitter() }, invalid, { stream: true }), /UTF-8|encoded/);
});

test('incomplete and malformed provider streams are never completed', async () => {
    const handler = (_, response) => { response.write(event({ choices: [{ delta: { content: 'partial' } }] })); response.end(); };
    await assert.rejects(runBackendRequest({}, handler, { stream: true }), /without a complete reply/);
    assert.throws(() => assembleGenerationStream('data: {invalid}\n\ndata: [DONE]\n\n'), /invalid event/);
    assert.throws(() => assembleGenerationStream('data: {"error":"provider refused"}\n\ndata: [DONE]\n\n'), /rejected/);
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { content: 'A'.repeat(MAX_GENERATION_TEXT_BYTES + 1) } }] }) + 'data: [DONE]\n\n'), /text limit/);
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'stop' }] })
        + 'event: error\ndata: {"message":"provider failed"}\n\n'), /rejected/);
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'stop' }] })
        + 'data: [DONE]\n\nevent: error\ndata: {"message":"provider failed"}\n\n'), /rejected/);
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { content: 'Final' }, finish_reason: 'stop' }] })
        + 'data: [DONE]\n\n' + event({ choices: [{ delta: { content: ' late output' } }] })), /after completion/);
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

test('a Responses API stream without its completion event is refused', async () => {
    const run = body => runBackendRequest({ headers: {}, socket: new EventEmitter(), user: { directories: { root: '/tmp/opencode' } } },
        handleChatCompletionsGenerate, { chat_completion_source: 'openai_responses', model: 'gpt-5.4',
            messages: [{ role: 'user', content: 'Hi' }], reverse_proxy: 'https://provider.invalid/v1',
            proxy_password: 'test', stream: true }, { fetch: async () => ({ status: 200, statusText: 'OK', ok: true,
            body: Readable.from([body]) }) });
    await assert.rejects(run('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n'), /before completion/);
    await assert.rejects(run('data: {broken}\n\n'), /invalid event/);
    await assert.rejects(run('data: {"type":"response.failed"}\n\n'), /did not complete successfully/);
});

test('the capture refuses an oversized streamed response before saving it', async () => {
    const handler = async (request, response) => forwardFetchResponse({ ok: true, status: 200, statusText: 'OK',
        body: Readable.from([event({ choices: [{ delta: { content: 'A'.repeat(MAX_GENERATION_TEXT_BYTES + 1) } }] })]) }, response, request);
    await assert.rejects(runBackendRequest({}, handler, { stream: true }), /text limit/);
    const parser = createGenerationStream();
    const capture = createCapturingResponse({ stream: true });
    const keepalive = ':' + ' '.repeat(1024 * 1024 - 3) + '\n\n';
    for (let size = 0; size < MAX_GENERATION_STREAM_BYTES; size += Buffer.byteLength(keepalive)) {
        parser.push(keepalive);
        assert.equal(capture.write(keepalive), true);
    }
    assert.throws(() => parser.push(':\n\n'), /64 MiB transport limit/);
    assert.equal(capture.write(':\n\n'), false);
    assert.match(capture.streamError.message, /64 MiB transport limit/);
    assert.equal(capture.writableEnded, true);
});

test('32,000 small answer and thinking deltas can exceed 2 MiB of transfer metadata', async () => {
    const reasoning = 'thought '.repeat(24000);
    const text = 'response '.repeat(8000);
    const chunks = Array.from({ length: 32000 }, (_, index) => event({ id: 'long-generation-fixture',
        object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
            delta: index < 24000 ? { reasoning_content: 'thought ' } : { content: 'response ' } }] }));
    chunks.push('data: [DONE]\n\n');
    const transferBytes = chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk), 0);
    assert.ok(transferBytes > 2 * 1024 * 1024);
    assert.ok(transferBytes < MAX_GENERATION_STREAM_BYTES);
    for (const live of [false, true]) {
        let lastPreview;
        const result = await runBackendRequest({}, (_, response) => {
            for (const chunk of chunks) response.write(chunk);
            response.end();
        }, { stream: true }, live ? { onStream: value => { lastPreview = value; } } : {});
        assert.equal(result.choices[0].message.content, text);
        assert.equal(result.choices[0].message.reasoning_content, reasoning);
        if (live) assert.deepEqual(lastPreview, { text, reasoning });
    }
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
    const mistral = assembleGenerationStream(event({ choices: [{ delta: { content: [
        { thinking: [{ text: 'Private thought' }] },
    ] } }] }) + event({ choices: [{ delta: { content: 'Visible answer' }, finish_reason: 'stop' }] }));
    assert.equal(mistral.choices[0].message.content, 'Visible answer');
    assert.equal(mistral.choices[0].message.reasoning_content, 'Private thought');
});

test('a bound stream ignores other choices and refuses tool or image output instead of saving a partial reply', () => {
    const primary = assembleGenerationStream(event({ choices: [{ index: 1, delta: { content: 'Wrong reply' }, finish_reason: 'stop' }] })
        + event({ choices: [{ index: 0, delta: { content: 'Right reply' }, finish_reason: 'stop' }] }));
    assert.equal(primary.choices[0].message.content, 'Right reply');
    assert.throws(() => assembleGenerationStream(event({ choices: [{ delta: { content: 'Partial', tool_calls: [{ id: 'call' }] } }] })
        + 'data: [DONE]\n\n'), /cannot save/);
    assert.throws(() => assembleGenerationStream(event({ candidates: [{ content: { parts: [
        { text: 'Partial' }, { inlineData: { mimeType: 'image/png', data: 'abc' } },
    ] }, finishReason: 'STOP' }] })), /cannot save/);
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
    await assert.rejects(runTextGeneration({ context, backend: 'text', payload: {
        api_type: 'ollama', api_server: 'http://127.0.0.1:11434', prompt: 'Hi', model: 'fixture', stream: true,
    }, fetch: async () => ({ ok: true, status: 200, body: Readable.from(['{"response":"Partial","done":false}']) }) }),
    /before completion/);
    await assert.rejects(runTextGeneration({ context, backend: 'text', payload: {
        api_type: 'ollama', api_server: 'http://127.0.0.1:11434', prompt: 'Hi', model: 'fixture', stream: true,
    }, fetch: async () => ({ ok: true, status: 200, body: Readable.from(['{"response":"Partial","done":true}{incomplete']) }) }),
    /before completion/);
    const lines = ['{"response":"Ollama ","done":false}\n\n{"response":"reply","done":true}\n'];
    assert.equal((await runTextGeneration({ context, backend: 'text', payload: {
        api_type: 'ollama', api_server: 'http://127.0.0.1:11434', prompt: 'Hi', model: 'fixture', stream: true,
    }, fetch: async () => ({ ok: true, status: 200, body: Readable.from(lines) }) })).text, 'Ollama reply');
    await assert.rejects(runTextGeneration({ context, backend: 'text', payload: {
        api_type: 'ollama', api_server: 'http://127.0.0.1:11434', prompt: 'Hi', model: 'fixture', stream: true,
    }, fetch: async () => ({ ok: true, status: 200, body: Readable.from(['{"response":"Partial","done":false}\n{bad}\n']) }) }),
    /invalid event/);
});

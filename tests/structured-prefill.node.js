import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Response } from 'node-fetch';
import { fixture } from './roleplay-transactions-fixture.js';
import { compileStructuredPrefill, structuredPrefillDisplay, structuredPrefillRequest } from '../public/scripts/structured-prefill.js';
import { extractProviderReasoning } from '../public/scripts/generation-format.js';
const { createPrefillDecoder, decodePrefillStream, prepareStructuredPrefill } = await import('../src/structured-prefill.js');
const { runTextGeneration } = await import('../src/generation/service.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const settings = { enabled: true, min_chars_after_prefix: 0 };
const wire = text => JSON.stringify({ response: text });

test('templates constrain slots, newlines, banned phrases and end markers', () => {
    const compiled = compileStructuredPrefill('[[name]]: [[opt:calm|curious]]\n[[re:[A-Z]+]][[keep]][[num:-2-2]][[end]]ignored', {
        ...settings, anti_slop_ban_list: 'bad word',
    }, ['Nova']);
    const pattern = new RegExp(compiled.pattern);
    assert.ok(pattern.test('Nova: curious<NL>YES-2'));
    assert.ok(pattern.test('Nova: calm\nYES2'));
    assert.ok(!pattern.test('Other: calm\nYES2'));
    assert.ok(!pattern.test('Nova: calm\nYES3'));
    assert.ok(!pattern.test('Nova: calm\nYES2more'));
    assert.ok(!new RegExp(compileStructuredPrefill('Start', { ...settings, anti_slop_ban_list: 'bad word' }).pattern).test('Start BAD WORD'));
    assert.throws(() => compileStructuredPrefill('[[w:5-2]]', settings), /counts/);
    assert.throws(() => compileStructuredPrefill('[[unknown]]', settings), /Unknown/);
    const lines = new RegExp(compileStructuredPrefill('[[line:2]][[end]]', settings).pattern);
    assert.ok(lines.test('one<NL>two'));
    assert.ok(!lines.test('one<NL>two<NL>three'));
});

test('incremental JSON decoding preserves Unicode, escaped quotes and marker splits', () => {
    const compiled = compileStructuredPrefill('Hidden. [[keep]]', settings);
    const decoder = createPrefillDecoder(compiled);
    let text = ''; let metadata;
    const input = wire('Hidden. Hello "Nova"<NL>😺\\end').replace('😺', '\\ud83d\\ude3a');
    for (const char of input) { const value = decoder.push(char); text += value.text; metadata = value.metadata; }
    const last = decoder.finish(); text += last.text; metadata = last.metadata;
    assert.equal(text, 'Hidden. Hello "Nova"\n😺\\end');
    assert.equal(structuredPrefillDisplay(text, metadata), 'Hello "Nova"\n😺\\end');
    assert.equal(metadata.hidden_prefix, 'Hidden. ');
    assert.equal(metadata.pending, false);
});

test('Continue overlap is literal, removed exactly once, and mismatch is rejected', () => {
    const overlap = '[[keep]] 😺';
    const compiled = compileStructuredPrefill(overlap, { ...settings, hide_prefill_in_display: false }, [], { literal: true });
    assert.ok(new RegExp(compiled.pattern).test(overlap + ' next'));
    const decoder = createPrefillDecoder(compiled, overlap);
    assert.equal(decoder.push(wire(overlap + ' next')).text + decoder.finish().text, ' next');
    assert.throws(() => createPrefillDecoder(compiled, overlap).push(wire('wrong')), /overlap/);
});

test('raw regex matching has a bounded execution time', () => {
    const decoder = createPrefillDecoder(compileStructuredPrefill('[[re:(a+)+b]]', settings));
    assert.throws(() => decoder.push(wire('a'.repeat(500) + '!')), /too costly/);
});

test('quiet requests, unsupported providers, tools and existing schemas retain their format', () => {
    const payload = { chat_completion_source: 'custom' };
    assert.equal(structuredPrefillRequest(payload, settings, 'quiet'), null);
    assert.equal(structuredPrefillRequest({ ...payload, tools: [{}] }, settings, 'normal'), null);
    assert.equal(structuredPrefillRequest({ ...payload, json_schema: {} }, settings, 'normal'), null);
    assert.equal(structuredPrefillRequest({ chat_completion_source: 'unknown' }, settings, 'normal'), null);
    assert.equal(structuredPrefillRequest(payload, {}, 'normal'), null);
});

test('override preserves assistant history, while a known prefill is removed', async () => {
    for (const known of [false, true]) {
        const request = { body: { chat_completion_source: 'custom', messages: [{ role: 'assistant', content: 'Existing text' }],
            structured_prefill: { ...settings, type: 'normal', override_prefill_enabled: true, override_prefill_text: 'New starter', original_prefill: known ? 'Existing text' : '' } } };
        await prepareStructuredPrefill(request);
        assert.equal(request.body.messages.length, known ? 0 : 1);
        assert.ok(new RegExp(request.body.json_schema.value.properties.response.pattern).test('New starter response'));
    }
});

test('Continue keeps the saved message and removes only the configured literal overlap', async () => {
    const previous = 'Previous [[keep]] 😺';
    for (const count of [0, 10]) {
        const overlap = count ? [...previous].slice(-count).join('') : '';
        const request = { body: { chat_completion_source: 'custom', messages: [{ role: 'assistant', content: previous }],
            structured_prefill: { ...settings, type: 'continue', continue_overlap_chars: count } },
        fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: wire(overlap + ' next') }, finish_reason: 'stop' }] })) };
        await prepareStructuredPrefill(request);
        assert.equal(request.body.messages[0].content, previous);
        const schema = request.body.json_schema.value;
        assert.ok(new RegExp(schema.properties.response.pattern).test(overlap + ' next'));
        const response = await request.fetch('http://provider.invalid', { body: JSON.stringify({ response_format: { json_schema: { schema } } }) });
        const data = await response.json();
        assert.equal(data.choices[0].message.content, ' next');
        assert.equal(data.choices[0].structured_prefill.hidden_prefix, '');
    }
});

test('SSE choices decode independently, preserve reasoning, and reject a truncated envelope', async () => {
    const compiled = compileStructuredPrefill('Start ', settings);
    const event = choices => `data: ${JSON.stringify({ choices })}\r\n\r\n`;
    const input = event([{ index: 0, delta: { reasoning_content: 'Thinking' } }])
        + event([0, 1].map(index => ({ index, delta: { content: wire(`Start reply ${index}`) }, finish_reason: 'stop' }))) + 'data: [DONE]\n\n';
    let output = '';
    for await (const chunk of decodePrefillStream(Readable.from([...Buffer.from(input)].map(byte => Buffer.from([byte]))), compiled)) output += chunk;
    assert.match(output, /Thinking/);
    assert.match(output, /"content":"Start reply 0"/);
    assert.match(output, /"content":"Start reply 1"/);
    assert.match(output, /"hidden_prefix":"Start "/);
    let broken = '';
    for await (const chunk of decodePrefillStream(Readable.from([event([{ delta: { content: '{"response":"Partial' } }]), 'data: [DONE]\n\n']), compiled)) broken += chunk;
    assert.match(broken, /Partial/);
    assert.match(broken, /STRUCTURED_PREFILL_INVALID_RESPONSE/);
});

for (const stream of [false, true]) test(`real backend request returns decoded ${stream ? 'streamed' : 'buffered'} text and saved display metadata`, async t => {
    const f = fixture(t);
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1', model: 'fixture', stream,
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Start ' }],
        structured_prefill: { ...settings, type: 'normal' },
    }, fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
        assert.equal(body.response_format.type, 'json_schema');
        assert.ok(new RegExp(body.response_format.json_schema.schema.properties.response.pattern).test('Start reply'));
        const choice = { index: 0, finish_reason: 'stop', [stream ? 'delta' : 'message']: { content: wire('Start reply') } };
        return new Response(stream ? `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ choices: [choice] }),
            { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
    } });
    assert.equal(result.text, 'Start reply');
    assert.equal(result.response.choices[0].structured_prefill.hidden_prefix, 'Start ');
});

for (const reason of ['stop', 'content_filter']) for (const stream of [false, true]) test(`incomplete ${reason} ${stream ? 'streamed' : 'buffered'} replies preserve decoded partial text`, async t => {
    const f = fixture(t);
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1', model: 'fixture', stream,
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Start ' }],
        structured_prefill: { ...settings, type: 'normal' },
    }, fetch: async () => {
        const choice = { index: 0, finish_reason: reason, [stream ? 'delta' : 'message']: { content: '{"response":"Start partial' } };
        return new Response(stream ? `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ choices: [choice] }));
    } });
    assert.equal(result.text, 'Start partial');
    assert.ok(result.outcome);
    assert.equal(result.response.choices[0].structured_prefill.pending, false);
});

test('starter model uses its saved profile once and treats generated slot-looking text literally', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        oai_settings: {},
        power_user: { structured_prefill: settings },
        extension_settings: { connectionManager: { profiles: [{ id: 'starter', mode: 'cc', api: 'custom', model: 'starter-model', 'api-url': 'http://starter.invalid/v1' }] } },
    }));
    const calls = [];
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'custom', custom_url: 'http://main.invalid/v1', model: 'main-model', stream: false,
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '[[pg]]: [[keep]]' }],
        structured_prefill: { ...settings, type: 'normal', prefill_gen_enabled: true, prefill_gen_profile_id: 'starter', prefill_gen_extra_prompt: 'Write a starter.' },
    }, fetch: async (url, options) => {
        const body = JSON.parse(options.body); calls.push(body);
        if (calls.length === 1) {
            assert.equal(body.model, 'starter-model');
            assert.equal(body.response_format, undefined);
            assert.equal(body.messages.at(-1).content, 'Write a starter.');
            return new Response(JSON.stringify({ choices: [{ message: { content: '[[keep]]<NL>' }, finish_reason: 'stop' }] }));
        }
        assert.ok(new RegExp(body.response_format.json_schema.schema.properties.response.pattern).test('[[keep]]<NL>: reply'));
        return new Response(JSON.stringify({ choices: [{ message: { content: wire('[[keep]]<NL>: reply') }, finish_reason: 'stop' }] }));
    } });
    assert.equal(calls.length, 2);
    assert.equal(result.text, '[[keep]]<NL>: reply');
    assert.equal(result.response.choices[0].structured_prefill.hidden_prefix, '[[keep]]<NL>: ');
});

const nativeCases = {
    claude: {
        model: 'claude-sonnet-4-6', schema: body => body.output_config.format.schema,
        reply: content => ({ content: [{ type: 'thinking', thinking: 'Thinking' }, { type: 'text', text: content }], stop_reason: 'end_turn' }),
        events: content => [{ type: 'content_block_delta', delta: { thinking: 'Thinking' } },
            { type: 'content_block_delta', delta: { text: content } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
    },
    makersuite: {
        model: 'gemini-2.5-flash', schema: body => body.generationConfig.responseJsonSchema,
        reply: content => ({ candidates: [{ content: { parts: [{ thought: true, text: 'Thinking' }, { text: content, thoughtSignature: 'signed' }] }, finishReason: 'STOP' }] }),
        events: content => [{ candidates: [{ content: { parts: [{ thought: true, text: 'Thinking' }] } }] },
            { candidates: [{ content: { parts: [{ text: content, thoughtSignature: 'signed' }] }, finishReason: 'STOP' }] }],
    },
    cohere: {
        model: 'command-r-plus', schema: body => { assert.equal(body.response_format.type, 'json_object'); return body.response_format.schema; },
        reply: content => ({ message: { content: [{ type: 'text', text: content }], tool_plan: 'Thinking' }, finish_reason: 'COMPLETE' }),
        events: content => [{ type: 'content-delta', delta: { message: { tool_plan: 'Thinking' } } },
            { type: 'content-delta', delta: { message: { content: { text: content } } } }, { type: 'message-end', delta: { finish_reason: 'COMPLETE' } }],
    },
    openai_responses: {
        model: 'gpt-5', schema: body => body.text.format.schema,
        reply: content => ({ output: [{ type: 'reasoning', summary: [{ text: 'Thinking' }] }, { type: 'message', content: [{ type: 'output_text', text: content }] }], status: 'completed' }),
        events: content => [{ type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
            { type: 'response.output_text.delta', delta: content }, { type: 'response.completed', response: { status: 'completed' } }],
    },
};
for (const [source, native] of Object.entries(nativeCases)) for (const stream of [false, true]) {
    test(`${source} native ${stream ? 'stream' : 'buffered'} format preserves text, reasoning and prefix metadata`, async t => {
        const f = fixture(t);
        writeSecret(f.scope.directories, SECRET_KEYS.COHERE, 'fixture-only');
        const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
            chat_completion_source: source, reverse_proxy: 'http://provider.invalid/v1', proxy_password: 'fixture-only', model: native.model,
            stream, max_tokens: 1024, include_reasoning: true,
            messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Start ' }],
            structured_prefill: { ...settings, type: 'normal' },
        }, fetch: async (url, options) => {
            const outgoing = JSON.parse(options.body);
            assert.ok(new RegExp(native.schema(outgoing).properties.response.pattern).test('Start reply'));
            const content = wire('Start reply');
            return new Response(stream ? native.events(content).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(native.reply(content)),
                { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
        } });
        assert.equal(result.text, 'Start reply');
        assert.equal(result.response.choices[0].structured_prefill.hidden_prefix, 'Start ');
        assert.equal(extractProviderReasoning(result.response, { mainApi: 'openai', chatCompletionSource: source }), 'Thinking');
        if (source === 'makersuite') assert.equal(result.response.choices[0].message.reasoning_details[0].data, 'signed');
    });
}

test('instruction mode supports connections without schema parameters', async t => {
    const f = fixture(t);
    writeSecret(f.scope.directories, SECRET_KEYS.DEEPSEEK, 'fixture-only');
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'deepseek', model: 'deepseek-chat', stream: false,
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Start ' }],
        structured_prefill: { ...settings, type: 'normal', output_method: 'instructions' },
    }, fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.response_format, undefined);
        assert.match(JSON.stringify(body.messages), /Return only a JSON object/);
        assert.match(JSON.stringify(body.messages), /Start/);
        return new Response(JSON.stringify({ choices: [{ message: { content: wire('Start reply') }, finish_reason: 'stop' }] }));
    } });
    assert.equal(result.text, 'Start reply');
    assert.equal(result.response.choices[0].structured_prefill.hidden_prefix, 'Start ');
});

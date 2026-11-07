import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Response } from 'node-fetch';
import { fixture } from './roleplay-transactions-fixture.js';
import { compileStructuredPrefill, continuedPrefillMetadata, structuredPrefillDisplay, structuredPrefillRequest, structuredPrefillStatus, STRUCTURED_PREFILL_PRESETS } from '../public/scripts/structured-prefill.js';
import { extractProviderReasoning } from '../public/scripts/generation-format.js';
import { resolveCustomStoppingStrings } from '../public/scripts/chat-request-controls.js';
const { createPrefillDecoder, decodePrefillStream, prepareStructuredPrefill } = await import('../src/structured-prefill.js');
const { runTextGeneration } = await import('../src/generation/service.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const settings = { enabled: true, min_chars_after_prefix: 0 };
const wire = text => JSON.stringify({ response: text });

test('starter stops are captured once with chat substitutions and survive backend normalisation', () => {
    const expanded = resolveCustomStoppingStrings({ custom_stopping_strings: '["{{char}}:STOP"]', custom_stopping_strings_macro: true }, (...args) => {
        assert.equal(args.length, 1, 'Array indexes and the stop list must not replace the chat names');
        return args[0].replace('{{char}}', 'Nova');
    });
    assert.deepEqual(expanded, ['Nova:STOP']);
    const payload = { chat_completion_source: 'nanogpt', stop: ['Older client stop'] };
    const config = structuredPrefillRequest(payload, { ...settings, prefill_gen_stop: '{{user}}:', starter_stopping_strings: ['Alex:', '', null] }, 'normal', text => text.replace('{{user}}', 'Alex'));
    assert.equal(config.prefill_gen_stop, 'Alex:');
    assert.deepEqual(config.starter_stopping_strings, ['Alex:']);
    assert.deepEqual(structuredPrefillRequest(payload, config, 'normal').starter_stopping_strings, ['Alex:']);
    assert.deepEqual(structuredPrefillRequest(payload, settings, 'normal').starter_stopping_strings, ['Older client stop']);
    assert.match(structuredPrefillStatus({ verification: 'matched', starter: 'generated' }), /Starter model supplied the opening/);
});

test('Continue records its new check without exposing the original hidden prefix', () => {
    const previous = { hidden_prefix: 'Private. ', verification: 'matched', history_removed: false };
    const next = { hidden_prefix: '', verification: 'mismatch', source: 'custom', continuation: true, pending: true };
    const merged = continuedPrefillMetadata(previous, next);
    assert.equal(merged.verification, 'mismatch');
    assert.equal(merged.pending, false);
    assert.equal(structuredPrefillDisplay('Private. Visible continuation.', merged), 'Visible continuation.');
    assert.equal(continuedPrefillMetadata({ history_removed: true }, next).history_removed, true);
    assert.equal(previous.verification, 'matched');
});

test('recorded checks validate the whole reply, not merely a JSON envelope or opening', () => {
    for (const [reply, expected] of [['Start enough', 'matched'], ['Start no', 'mismatch'], ['Wrong enough', 'mismatch'], ['Start gazed', 'mismatch'], ['Start stargaze', 'matched']]) {
        const decoder = createPrefillDecoder(compileStructuredPrefill('Start ', { ...settings, min_chars_after_prefix: 5, anti_slop_ban_list: 'gaze' }));
        const first = decoder.push(wire(reply));
        const last = decoder.finish();
        assert.equal(first.text + last.text, reply);
        assert.equal(last.metadata.verification, expected);
        assert.equal(last.metadata.accepted, true);
    }
    const decoder = createPrefillDecoder(compileStructuredPrefill('Start\n', settings));
    decoder.push(wire('Start<NL>reply'));
    assert.equal(decoder.finish().metadata.verification, 'matched');
    assert.match(structuredPrefillStatus({ verification: 'mismatch', method: 'instructions' }), /does not match.*best effort/);
    assert.match(structuredPrefillStatus({ verification: 'failed' }), /not confirmed/);
});

test('word-start bans span the prefix boundary and line slots default to one', () => {
    const pattern = new RegExp(compileStructuredPrefill('A ga', { ...settings, anti_slop_ban_list: 'gaze\n...' }).pattern);
    assert.equal(pattern.test('A gazed'), false);
    assert.equal(pattern.test('A garden stargaze'), true);
    assert.equal(pattern.test('A garden...'), false);
    const line = new RegExp(compileStructuredPrefill('[[line]][[end]]', settings).pattern);
    assert.equal(line.test('one line'), true);
    assert.equal(line.test('one<NL>two'), false);
});

test('bundled presets contain working examples without enabling themselves', () => {
    const openings = ['"Let us go"', '*opens the window*', 'Curious: ', 'Scene note: checks the weather<NL>', 'Opens the window'];
    assert.equal(STRUCTURED_PREFILL_PRESETS.length, 5);
    STRUCTURED_PREFILL_PRESETS.forEach((preset, index) => {
        const compiled = compileStructuredPrefill(preset.override_prefill_text, preset, [], { generated: 'Opens the window' });
        assert.equal(preset.enabled, false);
        assert.ok(new RegExp(compiled.pattern).test(openings[index] + 'The scene continues. '.repeat(8)), preset.name);
    });
});

test('history removal strips only the generated prefix once and preserves later edits', () => {
    const compiled = compileStructuredPrefill('Scene note: [[thought]]\n[[keep]]', { ...settings, remove_prefill_from_history: true });
    const decoder = createPrefillDecoder(compiled);
    let text = '';
    for (const chunk of ['{"response":"Scene note: watches', ' the rain<NL>', 'Hello there"}']) text += decoder.push(chunk).text;
    const last = decoder.finish(); text += last.text;
    assert.equal(text, 'Hello there');
    assert.equal(last.metadata.history_removed, true);
    assert.equal(last.metadata.hidden_prefix, '');
    assert.equal(last.metadata.verification, 'matched');
    assert.equal(structuredPrefillDisplay('Scene note: my later edit', last.metadata), 'Scene note: my later edit');
});

test('chat history is not consumed as a prefill; Claude field fallback is transactional', async () => {
    const messages = [{ role: 'assistant', content: 'Real chat reply' }];
    const request = { body: { chat_completion_source: 'claude', messages, assistant_prefill: 'Nova: Start ', char_name: 'Nova',
        structured_prefill: { ...settings, type: 'normal', last_assistant: 'Real chat reply' } } };
    await prepareStructuredPrefill(request);
    assert.deepEqual(request.body.messages, messages);
    assert.equal(request.body.assistant_prefill, undefined);
    assert.ok(new RegExp(request.body.json_schema.value.properties.response.pattern).test('Start reply'));
    const skipped = { body: { chat_completion_source: 'claude', messages, structured_prefill: { ...settings, type: 'normal', last_assistant: 'Real chat reply' } } };
    await prepareStructuredPrefill(skipped);
    assert.equal(skipped.body.json_schema, undefined);
    assert.deepEqual(skipped.body.messages, messages);
    const invalid = { body: { chat_completion_source: 'claude', messages, assistant_prefill: '[[bad]]',
        structured_prefill: { ...settings, type: 'normal', last_assistant: 'Real chat reply' } } };
    await assert.rejects(prepareStructuredPrefill(invalid), /Unknown/);
    assert.equal(invalid.body.assistant_prefill, '[[bad]]');
    assert.deepEqual(invalid.body.messages, messages);
});

test('a failed starter continues with an empty slot and records a warning', async t => {
    const f = fixture(t);
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'custom', custom_url: 'http://main.invalid/v1', model: 'main-model', stream: false,
        messages: [{ role: 'assistant', content: '[[pg]]Start ' }],
        structured_prefill: { ...settings, type: 'normal', prefill_gen_enabled: true },
    }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: wire('Start reply') }, finish_reason: 'stop' }] })) });
    assert.equal(result.text, 'Start reply');
    const metadata = result.response.choices[0].structured_prefill;
    assert.equal(metadata.verification, 'matched');
    assert.match(metadata.warnings[0], /starter model failed/);
    assert.equal(metadata.model, 'main-model');
});

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
    const checked = createPrefillDecoder(compileStructuredPrefill('[[re:(a+)+b]]', { ...settings, hide_prefill_in_display: false }));
    checked.push(wire('a'.repeat(500) + '!'));
    assert.equal(checked.finish().metadata.verification, 'unchecked');
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

for (const api of ['custom', 'nanogpt']) test(`${api} starter uses its saved profile with default stop macros and treats generated slots literally`, async t => {
    const f = fixture(t);
    const secretId = writeSecret(f.scope.directories, SECRET_KEYS.NANOGPT, 'fixture-only');
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        oai_settings: {},
        power_user: { structured_prefill: settings, custom_stopping_strings_macro: true, custom_stopping_strings: '["{{user}}:", "{{getvar::stop}}"]' },
        extension_settings: { connectionManager: { profiles: [{ id: 'starter', mode: 'cc', api, model: 'mistral-small', 'secret-id': api === 'nanogpt' ? secretId : undefined, 'api-url': 'http://starter.invalid/v1' }] } },
    }));
    const calls = [];
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'custom', custom_url: 'http://main.invalid/v1', model: 'main-model', stream: false,
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '[[pg]]: [[keep]]' }],
        structured_prefill: { ...settings, type: 'normal', prefill_gen_enabled: true, prefill_gen_profile_id: 'starter', prefill_gen_extra_prompt: 'Write a starter.',
            starter_stopping_strings: ['Alex:', 'End scene'], prefill_gen_stop: 'END' },
    }, fetch: async (url, options) => {
        const body = JSON.parse(options.body); calls.push(body);
        if (calls.length === 1) {
            assert.equal(body.model, 'mistral-small');
            assert.deepEqual(body.stop, ['Alex:', 'End scene', 'END']);
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
    assert.equal(result.response.choices[0].structured_prefill.starter, 'generated');
});

test('a starter profile without a saved model reports how to fix it without sending a starter request', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ oai_settings: {},
        extension_settings: { connectionManager: { profiles: [{ id: 'starter', mode: 'cc', api: 'nanogpt', model: null }] } } }));
    let calls = 0;
    const result = await runTextGeneration({ context: f.scope, backend: 'chat', payload: {
        chat_completion_source: 'custom', custom_url: 'http://main.invalid/v1', model: 'main-model',
        messages: [{ role: 'user', content: 'Hello' }],
        structured_prefill: { ...settings, type: 'normal', override_prefill_enabled: true, override_prefill_text: '[[pg]]', prefill_gen_enabled: true, prefill_gen_profile_id: 'starter' },
    }, fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: wire('Main reply') }, finish_reason: 'stop' }] }));
    } });
    assert.equal(calls, 1);
    assert.equal(result.text, 'Main reply');
    assert.match(result.response.choices[0].structured_prefill.warnings.join(' '), /Save a model in this connection profile/);
    assert.equal(result.response.choices[0].structured_prefill.starter, 'failed');
});

test('cancelling the starter does not fall back to a main request', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ oai_settings: {},
        extension_settings: { connectionManager: { profiles: [{ id: 'starter', mode: 'cc', api: 'custom', model: 'starter-model', 'api-url': 'http://starter.invalid/v1' }] } } }));
    const controller = new AbortController();
    let calls = 0;
    const request = { generationSignal: controller.signal, user: { profile: { handle: f.scope.owner }, directories: f.scope.directories },
        body: { chat_completion_source: 'custom', messages: [{ role: 'assistant', content: '[[pg]]Start ' }],
            structured_prefill: { ...settings, type: 'normal', prefill_gen_enabled: true, prefill_gen_profile_id: 'starter' } },
        fetch: async () => { calls++; controller.abort(); throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); } };
    await assert.rejects(prepareStructuredPrefill(request), error => error.code === 'PREFILL_CANCELLED');
    assert.equal(calls, 1);
    assert.equal(request.body.json_schema, undefined);
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

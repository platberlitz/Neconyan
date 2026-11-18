import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { runTextGeneration, runChatProfile } = await import('../src/generation/service.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { createCapturingResponse } = await import('../src/endpoints/conversation-generation.js');
const { handleChatCompletionsGenerate } = await import('../src/endpoints/backends/chat-completions.js');
const { acceptJob, getJob } = await import('../src/jobs/store.js');
const { registerHandler, setDirectoriesResolver, testExports: runner } = await import('../src/jobs/runner.js');

test('a structured provider reason survives the real non-streamed handler and generation service', async t => {
    const f = fixture(t);
    let calls = 0;
    await assert.rejects(runTextGeneration({ context: f.scope, backend: 'chat', anonymousCustom: true,
        payload: { chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1', model: 'fixture',
            messages: [{ role: 'user', content: 'Hello' }], stream: false },
        fetch: async () => {
            calls++;
            return { ok: false, status: 400, statusText: 'Bad Request',
                text: async () => JSON.stringify({ error: { message: 'The selected reasoning effort exceeds this model\'s supported range.' } }) };
        } }),
    error => {
        assert.equal(calls, 1);
        assert.equal(error.message, 'The selected reasoning effort exceeds this model\'s supported range.');
        assert.equal(error.status, 400);
        assert.equal(error.providerStatus, 400);
        return true;
    });
});

test('non-streamed diagnostics stay safe in HTTP responses, generation errors, failed jobs and logs', async t => {
    const f = fixture(t);
    const secret = 'fixture-private-credential', header = 'fixture-private-header';
    const prompt = 'PRIVATE PROMPT: the blue violets bloom across the quiet courtyard tonight.';
    writeSecret(f.scope.directories, SECRET_KEYS.CUSTOM, secret);
    const payload = { chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1', model: 'fixture', stream: false,
        messages: [{ role: 'user', content: prompt }], custom_include_headers: `X-Private: ${header}` };
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
    const cases = [
        { body: JSON.stringify({ error: { message: 'reasoning.effort must be one of [\'low\', \'medium\', \'high\'].' } }), expected: 'reasoning.effort must be one of [\'low\', \'medium\', \'high\'].' },
        { body: JSON.stringify({ error: { message: 'reasoning.effort must be one of ["low", "medium", "high"].' } }), expected: 'reasoning.effort must be one of ["low", "medium", "high"].' },
        { body: JSON.stringify({ error: { message: `Invalid credentials: ${secret}; ${header}; Bearer unrelated-bearer; Basic dW5yZWxhdGVk; https://alice:password@example.invalid/path?key=query-secret` }, unrelated: prompt }), expected: 'Invalid credentials:', prefix: true },
        { body: JSON.stringify({ error: { message: 'Rejected: ' + prompt } }), expected: 'Bad Request' },
        { body: JSON.stringify({ message: 'Rejected near blue violets bloom across the quiet courtyard.' }), expected: 'Bad Request' },
        { body: JSON.stringify({ error: { message: '<html>' + prompt + secret + '</html>' } }), expected: 'Bad Request' },
        { body: '<html>' + prompt + secret + header + '</html>', expected: 'Bad Request' },
        { body: '{"error":{"message":"' + secret + prompt, expected: 'Bad Request' },
        { body: JSON.stringify(prompt + secret), expected: 'Bad Request' },
        { body: JSON.stringify({ error: { message: { secret, prompt } } }), expected: 'Bad Request' },
        { body: '', expected: 'Bad Request' },
        { prompt: 'PIN 1234', body: JSON.stringify({ error: { message: 'Rejected: PIN 1234' } }), expected: 'Bad Request' },
        { prompt: 'secret42', body: JSON.stringify({ message: 'Invalid secret42' }), expected: 'Bad Request' },
        { prompt: 'PIN 1234', body: '{}', statusText: 'Rejected: PIN 1234', expected: 'The model provider could not complete the reply (HTTP 400).' },
        { prompt: 'secret42', body: '{malformed', statusText: 'Invalid secret42', expected: 'The model provider could not complete the reply (HTTP 400).' },
        { prompt: 'PIN 1234', body: JSON.stringify({ error: 'Rejected: PIN 1234' }), statusText: 'Rejected: PIN 1234', expected: 'The model provider could not complete the reply (HTTP 400).' },
    ];
    setDirectoriesResolver(() => f.scope.directories);
    for (const [index, entry] of cases.entries()) {
        const casePayload = { ...structuredClone(payload), messages: [{ role: 'user', content: entry.prompt ?? prompt }] };
        let calls = 0;
        const fetch = async (_url, config) => {
            calls++;
            assert.equal(config.headers.Authorization, 'Bearer ' + secret);
            assert.equal(config.headers['X-Private'], header);
            return { ok: false, status: 400, statusText: entry.statusText ?? 'Bad Request', text: async () => entry.body };
        };
        const capture = createCapturingResponse();
        await handleChatCompletionsGenerate({ body: structuredClone(casePayload), headers: {}, socket: new EventEmitter(),
            user: { directories: f.scope.directories }, fetch }, capture);
        assert.equal(capture.statusCode, 400);
        assert.equal(capture.body.provider_status, 400);
        if (entry.prefix) assert.ok(capture.body.error.message.startsWith(entry.expected));
        else assert.equal(capture.body.error.message, entry.expected);
        assert.ok(capture.body.error.message.length <= 500);
        let serviceError;
        await assert.rejects(runTextGeneration({ context: f.scope, backend: 'chat', payload: structuredClone(casePayload), fetch }), error => {
            serviceError = error;
            assert.equal(error.message, capture.body.error.message);
            assert.equal(error.status, 400);
            assert.equal(error.providerStatus, 400);
            return true;
        });
        registerHandler('fixture.provider-diagnostic', () => runTextGeneration({ context: f.scope, backend: 'chat', payload: structuredClone(casePayload), fetch }));
        const job = acceptJob(f.scope.directories, { owner: f.scope.owner, type: 'fixture.provider-diagnostic', submissionKey: `diagnostic-${index}`, intent: {} }).job;
        await runner.runJob(job);
        const saved = getJob(f.scope.directories, job.id);
        assert.equal(saved.state, 'failed');
        assert.equal(saved.error.message, serviceError.message);
        assert.equal(saved.error.status, 400);
        assert.equal(calls, 3);
        const visible = JSON.stringify([capture.body, saved.error, logs]);
        for (const value of [secret, header, prompt, 'blue violets bloom across', 'unrelated-bearer', 'dW5yZWxhdGVk', 'alice', 'password@', 'query-secret', '<html>']) {
            assert.equal(visible.includes(value), false, value);
        }
        if (entry.prompt) assert.equal(visible.includes(entry.prompt), false, entry.prompt);
    }
    assert.equal(logs.length, cases.length * 3);
});

test('safe diagnostics preserve quota flags, upstream statuses and empty-status fallback', async t => {
    const f = fixture(t);
    for (const status of [400, 429, 502, 503]) {
        const payload = { chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1', model: 'fixture', stream: false,
            messages: [{ role: 'user', content: 'Hello' }] };
        const body = { error: { type: status === 429 ? 'insufficient_quota' : 'server_error', message: 'The requested output budget exceeds this model\'s maximum.' } };
        const fetch = async () => ({ ok: false, status, statusText: '', text: async () => JSON.stringify(body) });
        const capture = createCapturingResponse();
        await handleChatCompletionsGenerate({ body: structuredClone(payload), anonymousCustom: true, headers: {}, socket: new EventEmitter(),
            user: { directories: f.scope.directories }, fetch }, capture);
        assert.equal(capture.statusCode, status < 500 ? status : 502);
        assert.equal(capture.body.provider_status, status);
        assert.equal(capture.body.quota_error, status === 429);
        assert.equal(capture.body.error.message, body.error.message);
        await assert.rejects(runTextGeneration({ context: f.scope, backend: 'chat', anonymousCustom: true, payload, fetch }), error => {
            assert.equal(error.message, body.error.message);
            assert.equal(error.status, status < 500 ? status : 502);
            assert.equal(error.providerStatus, status);
            return true;
        });
        const empty = createCapturingResponse();
        await handleChatCompletionsGenerate({ body: structuredClone(payload), anonymousCustom: true, headers: {}, socket: new EventEmitter(),
            user: { directories: f.scope.directories }, fetch: async () => ({ ok: false, status, statusText: '', text: async () => '{}' }) }, empty);
        assert.equal(empty.body.error.message, `The model provider could not complete the reply (HTTP ${status}).`);
    }
});

for (const source of ['openrouter', 'nanogpt']) for (const stream of [false, true]) {
    test(`${source} structured HTTP policy rejection survives ${stream ? 'streaming' : 'JSON'} transport`, async t => {
        const f = fixture(t);
        writeSecret(f.scope.directories, source === 'openrouter' ? SECRET_KEYS.OPENROUTER : SECRET_KEYS.NANOGPT, 'fake-fixture-key');
        let calls = 0;
        const result = await runTextGeneration({ context: f.scope, backend: 'chat',
            payload: { chat_completion_source: source, model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], stream },
            fetch: async () => {
                calls++;
                return { ok: false, status: 400, statusText: 'Bad Request', headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ error: { code: 'content_policy_violation', message: 'Fixture policy' } }),
                    body: Readable.from([JSON.stringify({ error: { code: 'content_policy_violation', message: 'Fixture policy' } })]) };
            } });
        assert.equal(result.outcome?.status, 'blocked');
        assert.equal(result.text, '');
        assert.equal(calls, 1);
    });
}

test('shared profile clean-up preserves blocked incomplete sentences and saves empty blocked results', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ power_user: { trim_sentences: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'fixture', mode: 'cc', api: 'custom', model: 'fixture', 'api-url': 'http://provider.invalid/v1' }] } },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1' } }));
    const binding = { kind: 'profile', ...captureChatProfile(f.scope.directories, 'fixture') };
    for (const text of ['An unfinished sentence with', '']) {
        const result = await runChatProfile({ context: f.scope, binding, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 32,
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'content_filter' }] }) }) });
        assert.equal(result.text, text);
        assert.equal(result.outcome.status, 'blocked');
    }
});

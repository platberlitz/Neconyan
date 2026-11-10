import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { runChatProfile, runTextGeneration } = await import('../src/generation/service.js');
const { assembleGenerationStream } = await import('../src/generation/stream-result.js');
const { runBackendRequest } = await import('../src/endpoints/conversation-generation.js');
const { handleChatCompletionsGenerate } = await import('../src/endpoints/backends/chat-completions.js');

let root;
const quiet = {};
before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-transport-audit-'));
    for (const level of ['info', 'debug', 'warn', 'error']) {
        quiet[level] = console[level];
        console[level] = () => {};
    }
});
after(() => {
    Object.assign(console, quiet);
    fs.rmSync(root, { recursive: true, force: true });
});

const messages = [{ role: 'user', content: 'Hi' }];
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Reply' } }] }));

async function sendThroughProfile(profile) {
    const directories = { root: fs.mkdtempSync(path.join(root, 'account-')) };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        main_api: 'openai',
        oai_settings: {
            chat_completion_source: 'custom', custom_url: 'http://endpoint-a.invalid/v1', custom_model: 'model-a',
            custom_include_headers: 'Authorization: Bearer KEY-FOR-ENDPOINT-A',
            custom_include_body: 'api_key: BODY-KEY-FOR-A\ntemperature: 1.9',
        },
        power_user: { custom_stopping_strings: '[]' },
        extension_settings: { connectionManager: { profiles: [profile] } },
    }));
    let sent;
    await runChatProfile({
        context: { owner: 'a', directories }, binding: captureChatProfile(directories, profile.id), messages, maxTokens: 50,
        fetch: async (url, request) => {
            sent = { url: String(url), headers: request.headers, body: JSON.parse(request.body) };
            return reply();
        },
    });
    return sent;
}

test('a saved profile sends its own private headers and body, never the active connection\'s', async () => {
    const sent = await sendThroughProfile({
        id: 'p', mode: 'cc', api: 'custom', model: 'model-b', 'api-url': 'http://endpoint-b.invalid/v1',
        'custom-include-headers': 'Authorization: Bearer KEY-FOR-ENDPOINT-B', 'custom-include-body': 'api_key: BODY-KEY-FOR-B',
    });
    assert.equal(sent.url, 'http://endpoint-b.invalid/v1/chat/completions');
    assert.equal(sent.headers.Authorization, 'Bearer KEY-FOR-ENDPOINT-B');
    assert.equal(sent.body.api_key, 'BODY-KEY-FOR-B');
    assert.equal(sent.body.temperature, undefined);
});

test('a saved profile without private headers does not borrow the active connection\'s', async () => {
    const sent = await sendThroughProfile({ id: 'p', mode: 'cc', api: 'custom', model: 'model-b', 'api-url': 'http://endpoint-b.invalid/v1' });
    assert.equal(sent.url, 'http://endpoint-b.invalid/v1/chat/completions');
    assert.equal(sent.headers.Authorization, undefined);
    assert.equal(sent.body.api_key, undefined);
    assert.doesNotMatch(JSON.stringify(sent), /ENDPOINT-A|KEY-FOR-A/);
});

const textRun = (payload, chunks) => runTextGeneration({
    context: { owner: 'fixture', directories: { root } }, backend: 'text', payload: { prompt: 'Hi', stream: true, ...payload },
    fetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: new Map(), body: Readable.from(chunks) }),
});

test('a llama.cpp stream that ends with stop:true is a finished reply', async () => {
    const stream = 'data: {"content":"Hello","stop":false}\n\ndata: {"content":" there","stop":false}\n\n'
        + 'data: {"content":"","stop":true,"stop_type":"eos"}\n\n';
    assert.equal(assembleGenerationStream(stream).choices[0].text, 'Hello there');
    assert.throws(() => assembleGenerationStream('data: {"content":"Hello","stop":false}\n\n'), /before it was finished/);
    const result = await textRun({ api_type: 'llamacpp', api_server: 'http://127.0.0.1:8080' }, [Buffer.from(stream)]);
    assert.equal(result.text, 'Hello there');
});

test('an Ollama reply keeps a character that arrives split across two chunks', async () => {
    const line = Buffer.from('{"response":"Café 😺","done":true}\n');
    const cut = line.indexOf(Buffer.from('😺')) + 2;
    const result = await textRun({ api_type: 'ollama', api_server: 'http://127.0.0.1:11434', model: 'm' }, [line.subarray(0, cut), line.subarray(cut)]);
    assert.equal(result.text, 'Café 😺');
});

test('an Ollama error sent inside the stream is reported with its reason', async () => {
    await assert.rejects(
        textRun({ api_type: 'ollama', api_server: 'http://127.0.0.1:11434', model: 'm' }, [Buffer.from('{"response":"Par","done":false}\n{"error":"out of memory"}\n')]),
        /out of memory/,
    );
});

test('a Responses API reply keeps a character that arrives split across two chunks', async () => {
    const sse = Buffer.from('data: {"type":"response.output_text.delta","delta":"Café 😺"}\n\ndata: {"type":"response.completed","response":{}}\n\n');
    const cut = sse.indexOf(Buffer.from('😺')) + 2;
    const result = await runBackendRequest(
        { headers: {}, socket: new EventEmitter(), user: { directories: { root } } },
        handleChatCompletionsGenerate,
        { chat_completion_source: 'openai_responses', model: 'gpt-5.4', messages, reverse_proxy: 'https://provider.invalid/v1', proxy_password: 'test', stream: true },
        { fetch: async () => ({ status: 200, statusText: 'OK', ok: true, body: Readable.from([sse.subarray(0, cut), sse.subarray(cut)]) }) },
    );
    assert.equal(result.choices[0].text, 'Café 😺');
});

test('a failed Google AI Studio connection does not write the API key to the server log', async () => {
    const account = fs.mkdtempSync(path.join(root, 'google-'));
    fs.writeFileSync(path.join(account, 'secrets.json'), JSON.stringify({ api_key_makersuite: [{ id: 'k', value: 'AIzaSECRET-GOOGLE-KEY-123', active: true }] }));
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(value => (value instanceof Error ? value.message : String(value))).join(' '));
    let requested = '';
    try {
        await assert.rejects(runBackendRequest(
            { user: { profile: { handle: 'a' }, directories: { root: account } }, headers: {} },
            handleChatCompletionsGenerate,
            { chat_completion_source: 'makersuite', model: 'gemini-2.5-flash', messages, secret_id: 'k', stream: true },
            { fetch: async url => { requested = String(url); throw new Error(`request to ${url} failed, reason: connect ECONNREFUSED`); }, boundProfile: true },
        ));
    } finally {
        console.error = original;
    }
    assert.match(requested, /key=AIzaSECRET-GOOGLE-KEY-123/);
    assert.ok(logged.some(line => line.includes('key=[redacted]')));
    assert.ok(logged.every(line => !line.includes('AIzaSECRET')));
});

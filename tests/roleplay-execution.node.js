/* eslint playwright/expect-expect: off -- Checks saved receipts and files with node:assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { getJob, releaseJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { testExports: runner } = await import('../src/jobs/runner.js');
const { readRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { runChatProfile } = await import('../src/generation/service.js');

function accepted(t, effect = 'append', anchor = {}) {
    const f = fixture(t);
    const source = captureRoleplaySource(f.scope, { locator: f.locator, ...anchor });
    const request = { binding: { profileId: 'bound', fingerprint: 'saved' }, messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 32, characterName: 'Nova', userName: 'User' };
    const stamp = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const { jobId } = admitRoleplayJob(f.scope, stamp, { operationKey: 'reply', effect, source, request });
    releaseJob(f.scope.directories, jobId);
    const job = getJob(f.scope.directories, jobId);
    const context = { job, directories: f.scope.directories, owner: f.scope.owner, signal: new AbortController().signal };
    return { f, context };
}

test('a bound server reply retains its reasoning and commits a single recorded append', async t => {
    const { f, context } = accepted(t);
    let calls = 0;
    const generate = async ({ beforeDispatch, binding, messages }) => {
        beforeDispatch();
        assert.equal(binding.profileId, 'bound');
        assert.equal(messages[0].content, 'Hello');
        calls++;
        return { text: 'Answered', response: { choices: [{ message: { reasoning_content: 'Thought' } }] } };
    };
    const first = await runRoleplayReplyJob(context, { generate });
    const saved = readRoleplayChat(f.scope, f.locator);
    assert.equal(saved.records.at(-1).mes, 'Answered');
    assert.equal(saved.records.at(-1).extra.reasoning, 'Thought');
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.equal(readArtifact(f.scope.directories, context.job.id, 'roleplay-output').message.mes, 'Answered');
    assert.deepEqual(await runRoleplayReplyJob(context, { generate }), first);
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).revision, saved.revision);
});

test('bound provider metadata keeps an encrypted reasoning signature on the recorded reply', async t => {
    const { f, context } = accepted(t);
    await runRoleplayReplyJob(context, { generate: async () => ({ text: 'With signature',
        generation: { backend: 'chat', source: 'openrouter', showThoughts: true },
        response: { choices: [{ message: { reasoning: 'Explanation', reasoning_details: [
            { id: 'tool_noise', type: 'reasoning.encrypted', data: 'skip' },
            { id: 'thought', type: 'reasoning.encrypted', data: 'saved signature' },
        ] } }] },
    }) });
    const extra = readRoleplayChat(f.scope, f.locator).records.at(-1).extra;
    assert.equal(extra.reasoning, 'Explanation');
    assert.equal(extra.reasoning_signature, 'saved signature');
});

test('a saved active Custom request runs through the real provider transport and stores only the reply', async t => {
    const f = fixture(t);
    const settings = { _settingsRevision: 1, main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture', show_thoughts: true,
            custom_include_headers: 'Authorization: Bearer private-header', custom_include_body: 'api_key: private-body' },
        power_user: { custom_stopping_strings: '[]' } };
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify(settings));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'real-provider', effect: 'append', source,
        request: { binding, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 32, characterName: 'Nova' } });
    releaseJob(f.scope.directories, jobId);
    let calls = 0;
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner,
        signal: new AbortController().signal };
    const generate = options => runChatProfile({ ...options, fetch: async (url, request) => {
        calls++;
        assert.equal(url, 'http://127.0.0.1:6000/chat/completions');
        assert.equal(request.headers.Authorization, 'Bearer private-header');
        assert.equal(JSON.parse(request.body).api_key, 'private-body');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Real bound reply', reasoning_content: 'Private thought' } }] }));
    } });
    await runRoleplayReplyJob(context, { generate });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Real bound reply');
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).extra.reasoning, 'Private thought');
    assert.equal(calls, 1);
    const artifacts = path.join(f.scope.directories.root, 'jobs', 'artifacts');
    for (const entry of fs.readdirSync(artifacts, { recursive: true })) {
        const filename = path.join(artifacts, entry);
        if (fs.statSync(filename).isFile()) assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /private-header|private-body/);
    }
});

test('a bound custom request applies safe controls and refuses connection or authentication changes before dispatch', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture' },
        power_user: { custom_stopping_strings: '[]' } }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const request = { binding, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 32, characterName: 'Nova',
        modelOverride: 'second-model', overridePayload: { top_p: 0.63 } };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'safe-controls', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    let calls = 0;
    const run = (context, fetchImpl) => runRoleplayReplyJob(context, {
        generate: options => runChatProfile({ ...options, fetch: fetchImpl }),
    });
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner,
        signal: new AbortController().signal };
    await run(context, async (url, init) => {
        calls++;
        assert.equal(url, 'http://127.0.0.1:6000/chat/completions');
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'second-model');
        assert.equal(body.top_p, 0.63);
        assert.equal(body.max_tokens, 32);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Bound answer' } }] }));
    });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Bound answer');

    for (const overridePayload of [{ custom_include_headers: 'Authorization: Bearer private' },
        { chat_completion_source: 'openai' }, { api_server: 'https://other.invalid' }, { max_tokens: 9999 }]) {
        const { jobId: refusedId } = admitRoleplayJob(f.scope, account, {
            operationKey: `refuse-${Object.keys(overridePayload)[0]}`, effect: 'append',
            source: captureRoleplaySource(f.scope, { locator: f.locator }), request: { ...request, overridePayload },
        });
        releaseJob(f.scope.directories, refusedId);
        await assert.rejects(run({ ...context, job: getJob(f.scope.directories, refusedId) }, async () => {
            calls++; throw new Error('The provider must not be reached.');
        }), { code: 'ROLEPLAY_INVALID' });
    }
    assert.equal(calls, 1);
});

test('a bound Custom stream completes before a Roleplay effect and refuses a truncated paid result', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture', show_thoughts: true },
        power_user: { custom_stopping_strings: '[]' } }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const request = { binding, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 32, characterName: 'Nova', stream: true };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'real-stream', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner,
        signal: new AbortController().signal };
    let complete = false;
    const generate = options => runChatProfile({ ...options, fetch: async (_, config) => {
        assert.equal(JSON.parse(config.body).stream, true);
        return { ok: true, status: 200, statusText: 'OK', body: Readable.from((async function* () {
            yield 'data: {"choices":[{"delta":{"reasoning_content":"Thought ","content":"Part "}}]}\n\n';
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
            yield 'data: {"choices":[{"delta":{"content":"two"},"finish_reason":"stop"}]}\n\n';
            complete = true;
            yield 'data: [DONE]\n\n';
        })()) };
    } });
    await runRoleplayReplyJob(context, { generate });
    assert.equal(complete, true);
    const last = readRoleplayChat(f.scope, f.locator).records.at(-1);
    assert.equal(last.mes, 'Part two');
    assert.equal(last.extra.reasoning, 'Thought ');
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-output').message.mes, last.mes);
});

test('a truncated bound provider stream interrupts the job without saving a partial reply', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture' },
        power_user: { custom_stopping_strings: '[]' } }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'truncated-stream', effect: 'append', source,
        request: { binding, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 32, characterName: 'Nova', stream: true } });
    releaseJob(f.scope.directories, jobId);
    const { registerRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
    const { setDirectoriesResolver } = await import('../src/jobs/runner.js');
    registerRoleplayReplyJob({ generate: options => runChatProfile({ ...options, fetch: async () => ({
        ok: true, status: 200, statusText: 'OK', body: Readable.from(['data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n']),
    }) }) });
    setDirectoriesResolver(() => f.scope.directories);
    try {
        await runner.runJob(getJob(f.scope.directories, jobId));
        const job = getJob(f.scope.directories, jobId);
        assert.equal(job.state, 'interrupted');
        assert.equal(job.recoverability, 'unknown-outcome');
        assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
        assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-output'), undefined);
        assert.equal(recoverJobs(f.scope.directories).recoverable.length, 0);
    } finally {
        registerRoleplayReplyJob();
        setDirectoriesResolver(null);
    }
});

test('a bound reply respects disabled reasoning while retaining the generated text', async t => {
    const { f, context } = accepted(t);
    await runRoleplayReplyJob(context, { generate: async () => ({ text: 'Visible',
        generation: { backend: 'chat', source: 'custom', showThoughts: false },
        response: { choices: [{ message: { reasoning_content: 'Hidden' } }] },
    }) });
    const saved = readRoleplayChat(f.scope, f.locator).records.at(-1);
    assert.equal(saved.mes, 'Visible');
    assert.equal(saved.extra.reasoning, undefined);
});

test('a stale source is refused before any provider work', async t => {
    const { f, context } = accepted(t);
    fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'Someone', mes: 'Unrelated edit' }));
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => { calls++; return { text: 'bad' }; } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls, 0);
    assert.equal(readArtifact(f.scope.directories, context.job.id, 'roleplay-output'), undefined);
});

test('a saved answer does not repeat provider work when the chat changes before delivery', async t => {
    const { f, context } = accepted(t);
    let calls = 0;
    const generate = async ({ beforeDispatch }) => {
        beforeDispatch();
        calls++;
        fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'Someone', mes: 'Changed' }));
        return { text: 'Paid answer', response: {} };
    };
    await assert.rejects(runRoleplayReplyJob(context, { generate }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(readArtifact(f.scope.directories, context.job.id, 'roleplay-output').message.mes, 'Paid answer');
    await assert.rejects(runRoleplayReplyJob(context, { generate }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls, 1);
});

test('a swipe keeps reasoning with its selected version', async t => {
    const { f, context } = accepted(t, 'swipe', { message: 1 });
    await runRoleplayReplyJob(context, { generate: async () => ({ text: 'Another', response: { content: [{ type: 'thinking', thinking: 'Why' }] } }) });
    const message = readRoleplayChat(f.scope, f.locator).records[2];
    assert.equal(message.swipe_id, 2);
    assert.equal(message.swipe_info[2].extra.reasoning, 'Why');
    assert.equal(message.extra.reasoning, 'Why');
});

test('a result larger than the saved message limit is refused without modifying the chat', async t => {
    const { f, context } = accepted(t);
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => ({ text: 'a'.repeat(256 * 1024 + 1), response: {} }) }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
    assert.equal(readArtifact(f.scope.directories, context.job.id, 'roleplay-output'), undefined);
});

test('an unknown provider outcome interrupts a real worker job and is not dispatched again', async t => {
    const { f, context } = accepted(t);
    let calls = 0;
    const generate = async ({ jobContext }) => {
        const { providerStep } = await import('../src/jobs/artifacts.js');
        return providerStep(jobContext, 'unknown-paid-result', async () => { calls++; throw new Error('Connection lost after sending.'); });
    };
    const { registerRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
    const { setDirectoriesResolver } = await import('../src/jobs/runner.js');
    registerRoleplayReplyJob({ generate });
    setDirectoriesResolver(() => f.scope.directories);
    try {
        await runner.runJob(context.job);
        assert.equal(calls, 1);
        assert.equal(getJob(f.scope.directories, context.job.id).state, 'interrupted');
        assert.equal(getJob(f.scope.directories, context.job.id).recoverability, 'unknown-outcome');
        assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
        assert.equal(readArtifact(f.scope.directories, context.job.id, 'roleplay-output'), undefined);
        assert.equal(recoverJobs(f.scope.directories).recoverable.length, 0);
        updateJob(f.scope.directories, context.job.id, { state: 'running' });
        assert.equal(getJob(f.scope.directories, context.job.id).state, 'running');
        assert.equal(recoverJobs(f.scope.directories).recoverable.length, 0);
        assert.equal(getJob(f.scope.directories, context.job.id).state, 'interrupted');
        assert.equal(calls, 1);
    } finally {
        registerRoleplayReplyJob();
        setDirectoriesResolver(null);
    }
});

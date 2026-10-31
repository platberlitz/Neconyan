/* eslint playwright/expect-expect: off -- Checks saved receipts and files with node:assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { admitRoleplayJob, applyRoleplayJobEffect } = await import('../src/roleplay-jobs.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { acceptJob, getJob, releaseJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { testExports: runner } = await import('../src/jobs/runner.js');
const { readRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { enableMewmoryHiding } = await import('./mewmory-hiding-fixture.js');

function accepted(t, effect = 'append', anchor = {}, { history = 0 } = {}) {
    const f = fixture(t);
    if (history) {
        f.records.splice(1, 0, ...Array.from({ length: history }, (_, index) => ({
            name: index % 2 === 0 ? 'User' : 'Nova', is_user: index % 2 === 0,
            mes: 'history ' + index + ' ' + 'accumulated history remains saved. '.repeat(100), extra: {},
        })));
        fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    }
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

test('a server reply clears the older history once the Mewmory trigger is reached in its single recorded write', async t => {
    const f = fixture(t);
    const history = Array.from({ length: 40 }, (_, index) => ({
        name: index % 2 === 0 ? 'User' : 'Nova', is_user: index % 2 === 0,
        mes: 'history ' + index + ' ' + 'lorem ipsum dolor sit amet '.repeat(20), extra: {},
    }));
    f.records.splice(1, 0, ...history);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    enableMewmoryHiding(f.scope.directories, f.locator, { autoHideTokens: 1024 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'bound', fingerprint: 'saved' }, messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 32, characterName: 'Nova', userName: 'User' };
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'server-hiding', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner,
        signal: new AbortController().signal };
    const revisions = readRoleplayChat(f.scope, f.locator).revision;
    let calls = 0;
    const reply = 'Fresh reply ' + 'detail '.repeat(120);
    const first = await runRoleplayReplyJob(context, { generate: async () => { calls++; return { text: reply }; } });
    const saved = readRoleplayChat(f.scope, f.locator);
    assert.equal(calls, 1);
    assert.equal(saved.revision, revisions + 1);
    assert.equal(saved.records.at(-1).mes, reply);
    assert.ok(!saved.records.at(-1).is_system);
    const rows = saved.records.slice(1);
    const firstVisible = rows.findIndex(row => !row.is_system);
    assert.equal(firstVisible, rows.length - 1, 'every older visible message is cleared in one pass');
    assert.ok(rows.slice(0, firstVisible).every(row => row.is_system && row.extra?.mewmoryKeepHidden === true));
    assert.ok(rows.slice(firstVisible).every(row => !row.is_system));
    assert.deepEqual(await runRoleplayReplyJob(context, { generate: async () => { calls++; return { text: 'Again' }; } }), first);
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).revision, saved.revision);
});

test('a forged Roleplay job cannot spend on providers before its permanent admission is checked', async t => {
    const { f, context } = accepted(t);
    const intent = structuredClone(context.job.intent);
    intent.roleplay.operationKey = 'not-admitted';
    const { job } = acceptJob(f.scope.directories, { owner: f.scope.owner, type: 'roleplay.reply', submissionKey: 'forged', intent });
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob({ ...context, job }, { generate: async () => { calls++; return { text: 'Unpaid only' }; } }));
    assert.equal(calls, 0);
    assert.equal(readArtifact(f.scope.directories, job.id, 'roleplay-output'), undefined);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
    const altered = structuredClone(context.job);
    altered.intent.request.maxTokens++;
    await assert.rejects(runRoleplayReplyJob({ ...context, job: altered }, { generate: async () => { calls++; return { text: 'Changed intent' }; } }));
    assert.equal(calls, 0);
});

test('a saved null output cannot be mistaken for an absent result and repeat paid work', async t => {
    const { f, context } = accepted(t);
    writeArtifact(f.scope.directories, context.job.id, 'roleplay-output', null);
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => {
        calls++;
        return { text: 'Second provider call' };
    } }), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(calls, 0);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
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
    const extra = readRoleplayChat(f.scope, f.locator).records.at(-1).extra;
    assert.equal(extra.model, 'fixture');
    assert.equal(extra.api, 'custom');
    assert.ok(extra.token_count > 0);
    assert.ok(extra.reasoning_tokens > 0);
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
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).extra.model, 'second-model');

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
            yield 'data: {"choices":[{"delta":{"reasoning_content":"Thought "}}]}\n\n';
            await new Promise(resolve => setTimeout(resolve, 10));
            yield 'data: {"choices":[{"delta":{"content":"Part "}}]}\n\n';
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
    assert.ok(last.extra.reasoning_duration > 0);
    assert.ok(last.extra.reasoning_duration < Date.parse(last.gen_finished) - Date.parse(last.gen_started));
    assert.equal(last.extra.model, 'fixture');
    assert.equal(last.extra.api, 'custom');
    assert.ok(last.extra.token_count > 0);
    assert.ok(last.extra.reasoning_tokens > 0);
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

test('thinking-only provider results are kept once without successful delivery or another paid call', async t => {
    for (const stream of [false, true]) for (const reason of ['stop', 'length']) {
        await t.test(`${stream ? 'stream' : 'JSON'} ${reason}`, async t => {
            const f = fixture(t);
            fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
                main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
                oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture', show_thoughts: true },
                power_user: { custom_stopping_strings: '[]' } }));
            const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
            const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
            const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'thinking-only', effect: 'append',
                source: captureRoleplaySource(f.scope, { locator: f.locator }),
                request: { binding, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 32, characterName: 'Nova', stream } });
            releaseJob(f.scope.directories, jobId);
            const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner,
                signal: new AbortController().signal };
            const usage = { prompt_tokens: 12, completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 32 } };
            let calls = 0;
            const generate = options => runChatProfile({ ...options, fetch: async () => {
                calls++;
                const message = { content: '', reasoning_content: 'A paid thought, without an answer.' };
                return stream ? { ok: true, status: 200, statusText: 'OK', body: Readable.from([
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: message }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n',
                ]) } : new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: reason }], usage }));
            } });
            const checkFailure = error => {
                assert.equal(error.code, 'GENERATION_NO_ANSWER');
                assert.match(error.message, /thinking but no reply text/);
                assert.equal(error.message.includes('output limit'), reason === 'length');
                return true;
            };
            await assert.rejects(runRoleplayReplyJob(context, { generate }), checkFailure);
            const saved = readRoleplayChat(f.scope, f.locator);
            assert.equal(saved.records.length, f.records.length + 1);
            const last = saved.records.at(-1);
            assert.equal(last.mes, '');
            assert.equal(last.extra.reasoning, 'A paid thought, without an answer.');
            assert.equal(last.extra.generation_finish_reason, reason);
            assert.deepEqual(last.extra.generation_usage, usage);
            assert.equal(last.extra.generation_outcome.status, 'error');
            assert.equal(last.extra.roleplay_kept_reply.reason, 'failed');
            assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-main-complete'), undefined);
            assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-output'), undefined);
            const reference = readArtifact(f.scope.directories, jobId, 'roleplay-main-provider');
            assert.equal(readArtifact(f.scope.directories, jobId, reference.step).response.choices[0].finish_reason, reason);
            await assert.rejects(runRoleplayReplyJob({ ...context, job: getJob(f.scope.directories, jobId) }, { generate }), checkFailure);
            assert.equal(readRoleplayChat(f.scope, f.locator).revision, saved.revision);
            assert.equal(calls, 1);
        });
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

test('native replies separate configured inline thinking before delivery and preserve visible prose', async t => {
    const cases = [
        { name: 'closed thinking', content: '<think>Inline thought.</think>', reason: 'stop', text: '', thinking: 'Inline thought.' },
        { name: 'unclosed thinking', content: '<think>Inline thought.', reason: 'length', text: '', thinking: 'Inline thought.' },
        { name: 'mixed prose', content: '<think>Inline thought.</think>The door opens and', reason: 'length', text: 'The door opens and', thinking: 'Inline thought.' },
        { name: 'disabled parsing', content: '<think>Literal text.</think>', reason: 'stop', autoParse: false, text: '<think>Literal text.</think>' },
        { name: 'hidden thinking only', content: '', field: 'Paid hidden thought.', reason: 'length', showThoughts: false, text: '', thinking: 'Paid hidden thought.' },
        { name: 'hidden thinking with prose', content: 'The visible reply.', field: 'Hidden thought.', reason: 'stop', showThoughts: false, text: 'The visible reply.' },
    ];
    for (const stream of [false, true]) for (const scenario of cases) {
        await t.test(`${stream ? 'SSE' : 'JSON'} ${scenario.name}`, async t => {
            const f = fixture(t);
            fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
                main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
                oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture',
                    show_thoughts: scenario.showThoughts !== false },
                power_user: { custom_stopping_strings: '[]', reasoning: { auto_parse: scenario.autoParse !== false,
                    prefix: '<think>', suffix: '</think>' } } }));
            const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
            const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
            const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'inline-thinking', effect: 'append',
                source: captureRoleplaySource(f.scope, { locator: f.locator }),
                request: { binding, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 32, characterName: 'Nova', stream } });
            releaseJob(f.scope.directories, jobId);
            const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner,
                signal: new AbortController().signal };
            let calls = 0;
            const generate = options => runChatProfile({ ...options, fetch: async () => {
                calls++;
                const message = { content: scenario.content, ...(scenario.field ? { reasoning_content: scenario.field } : {}) };
                return stream ? { ok: true, status: 200, statusText: 'OK', body: Readable.from([
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: message }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: scenario.reason }] })}\n\n`,
                    'data: [DONE]\n\n',
                ]) } : new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: scenario.reason }] }));
            } });
            for (let attempt = 0; attempt < 2; attempt++) {
                if (!scenario.text) await assert.rejects(runRoleplayReplyJob(context, { generate }), { code: 'GENERATION_NO_ANSWER' });
                else await runRoleplayReplyJob(context, { generate });
            }
            const saved = readRoleplayChat(f.scope, f.locator).records;
            assert.equal(saved.length, f.records.length + 1);
            assert.equal(saved.at(-1).mes, scenario.text);
            assert.equal(saved.at(-1).extra.reasoning, scenario.thinking);
            assert.equal(Boolean(readArtifact(f.scope.directories, jobId, 'roleplay-main-complete')), Boolean(scenario.text));
            assert.equal(calls, 1);
            const reference = readArtifact(f.scope.directories, jobId, 'roleplay-main-provider');
            const provider = readArtifact(f.scope.directories, jobId, reference.step);
            assert.equal(provider.text, scenario.text);
            assert.equal(provider.response.choices[0].message.content, scenario.content, 'the paid provider response stays intact');
        });
    }
});

test('a stale source is refused before any provider work', async t => {
    const { f, context } = accepted(t);
    fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'Someone', mes: 'Unrelated edit' }));
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => { calls++; return { text: 'bad' }; } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls, 0);
    assert.equal(readArtifact(f.scope.directories, context.job.id, 'roleplay-output'), undefined);
});

test('a bound swipe follows a renamed chat and tolerates an unrelated later append', async t => {
    const { f, context } = accepted(t, 'swipe', { message: 41 }, { history: 40 });
    const { commitRoleplayLifecycleLocked } = await import('../src/roleplay-lifecycle.js');
    const { withRoleplayAccount } = await import('../src/roleplay-store.js');
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const destination = { ...f.locator, chat: 'Renamed' };
    withRoleplayAccount(f.scope, account, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'rename', action: 'chat-rename', intent: { destination },
        steps: [{ op: 'move', kind: 'chat', locator: f.locator, destination }],
    }));
    enableMewmoryHiding(f.scope.directories, destination, { autoHideTokens: 1024 });
    const later = admitRoleplayJob(f.scope, account, { operationKey: 'later', effect: 'append',
        source: captureRoleplaySource(f.scope, { locator: destination }), request: { prompt: 'later' } });
    applyRoleplayJobEffect(f.scope, account, { operationKey: 'later', jobId: later.jobId,
        output: { message: { name: 'Nova', mes: 'Unrelated' } } }, roleplayNativeHost);
    let calls = 0;
    await runRoleplayReplyJob(context, { generate: async ({ beforeDispatch }) => {
        beforeDispatch();
        calls++;
        return { text: 'Bound swipe', response: {} };
    } });
    const saved = readRoleplayChat(f.scope, destination);
    assert.equal(saved.records[42].mes, 'Bound swipe');
    assert.equal(saved.records.at(-1).mes, 'Unrelated');
    assert.ok(saved.records.slice(1, 42).every(record => record.is_system && record.extra?.mewmoryKeepHidden === true),
        'the renamed chat should still clear its older backlog');
    assert.ok(!saved.records[42].is_system, 'a fresh swipe Mewmory has not read yet stays in the prompt');
    assert.ok(!saved.records.at(-1).is_system);
    assert.equal(calls, 1);
});

test('a changed selected swipe is refused before provider work', async t => {
    const { f, context } = accepted(t, 'swipe', { message: 1 });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const changed = admitRoleplayJob(f.scope, account, { operationKey: 'changed', effect: 'swipe',
        source: captureRoleplaySource(f.scope, { locator: f.locator, message: 1 }), request: { prompt: 'changed' } });
    applyRoleplayJobEffect(f.scope, account, { operationKey: 'changed', jobId: changed.jobId, output: { text: 'Different' } }, roleplayNativeHost);
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => { calls++; return { text: 'Wrong', response: {} }; } }),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls, 0);
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
    const timing = { gen_started: '2026-10-05T12:00:00.000Z', gen_finished: '2026-10-05T12:00:05.000Z' };
    await runRoleplayReplyJob(context, { generate: async () => ({ text: 'Another',
        response: { choices: [{ message: { reasoning_content: 'Why' } }] },
        generation: { backend: 'chat', source: 'custom', model: 'thinking-model', showThoughts: true,
            ...timing, reasoning_duration: 3000 } }) });
    const message = readRoleplayChat(f.scope, f.locator).records[2];
    assert.equal(message.swipe_id, 2);
    assert.equal(message.swipe_info[2].extra.reasoning, 'Why');
    assert.equal(message.extra.reasoning, 'Why');
    for (const version of [message, message.swipe_info[2]]) {
        assert.equal(version.extra.reasoning_duration, 3000);
        assert.equal(version.gen_started, timing.gen_started);
        assert.equal(version.gen_finished, timing.gen_finished);
    }
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

test('a Custom pre-dispatch refusal validates the final body once, sends nothing and settles its step', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture' },
        power_user: { custom_stopping_strings: '[]' } }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const accepted = acceptJob(f.scope.directories, { owner: f.scope.owner, type: 'custom-predispatch', submissionKey: 'predispatch', intent: {} }).job;
    const context = { directories: f.scope.directories, owner: f.scope.owner, job: accepted, signal: new AbortController().signal };
    let checks = 0, validations = 0, transports = 0;
    const steps = [];
    await assert.rejects(runChatProfile({ context, jobContext: context, binding, messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 32, characterName: 'Nova', userName: 'User', stream: false, generationType: 'normal',
        validatePrompt: async () => { validations++; },
        beforeDispatch: async () => {
            checks++;
            throw Object.assign(new Error('The saved source changed.'), { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 });
        },
        onProviderStep: step => steps.push(step),
        fetch: async () => { transports++; return new Response(JSON.stringify({ choices: [{ message: { content: 'Must not arrive' } }] })); },
    }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(validations, 1, 'the final serialised body is validated once in the pre-fetch wrapper');
    assert.equal(checks, 1, 'exactly one pre-dispatch source check ran');
    assert.equal(transports, 0, 'no transport request was made');
    assert.equal(steps.length, 1);
    assert.equal(readArtifact(f.scope.directories, accepted.id, steps[0]), undefined);
    const after = getJob(f.scope.directories, accepted.id);
    assert.equal(after.resume, null);
    assert.deepEqual(after.recoverySteps, []);
    assert.equal(after.recoverability, 'settled');
});

test('native blocked reply saves its provider proof and replays without another request', async t => {
    const { f, context } = accepted(t);
    let calls = 0;
    const generate = async options => {
        calls++;
        const step = 'provider:' + 'c'.repeat(64);
        await options.onProviderStep(step);
        const result = { text: 'Unfinished sentence with', response: { choices: [{ finish_reason: 'content_filter', message: { content: 'Unfinished sentence with' } }] } };
        writeArtifact(f.scope.directories, context.job.id, step, result);
        return result;
    };
    const first = await runRoleplayReplyJob(context, { generate });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Unfinished sentence with');
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).extra.generation_outcome.status, 'blocked');
    assert.deepEqual(await runRoleplayReplyJob(context, { generate }), first);
    assert.equal(calls, 1);
});

test('native no-text block retains a definite provider result and cannot redispatch on replay', async t => {
    const { f, context } = accepted(t);
    let calls = 0;
    const generate = async options => {
        calls++;
        const step = 'provider:' + 'd'.repeat(64);
        await options.onProviderStep(step);
        const result = { text: '', response: { choices: [{ finish_reason: 'content_filter', message: { content: '', reasoning_content: 'Before the refusal' } }] } };
        writeArtifact(f.scope.directories, context.job.id, step, result);
        return result;
    };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(runRoleplayReplyJob(context, { generate }), { code: 'GENERATION_BLOCKED' });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
});

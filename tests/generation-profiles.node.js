import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { createChatGenerationParameters } from '../public/scripts/chat-provider-parameters.js';
import { textgen_types } from '../public/scripts/text-provider-parameters.js';
import { providerSettings, instructSettings, promptMessages, expectedPrompts } from './fixtures/text-generation-baseline.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { captureChatProfile, captureGenerationBinding, buildChatProfileRequest, resolveGenerationProfile } = await import('../src/generation/profiles.js');
const { runChatProfile, runTextGeneration, validateActiveGenerationContext } = await import('../src/generation/service.js');
const { acceptJob, getJob, markProviderUncertain, recoverJobs, setJobState } = await import('../src/jobs/store.js');
const { buildTextProfileRequest, resolveTextTokenizer } = await import('../src/generation/text-request.js');
const { createMacroEnvironment } = await import('../src/macros/index.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { hash } = await import('../src/mewmory/core.js');

test('acknowledged Kobold uses the saved endpoint and samplers exactly once', async t => {
    const fixture = textFixture(t);
    const previous = process.env.SILLYTAVERN_REQUESTOVERRIDES;
    process.env.SILLYTAVERN_REQUESTOVERRIDES = JSON.stringify([{ hosts: ['127.0.0.1:6000'], headers: { Authorization: 'Bearer unbound-key' } }]);
    t.after(() => { if (previous === undefined) delete process.env.SILLYTAVERN_REQUESTOVERRIDES; else process.env.SILLYTAVERN_REQUESTOVERRIDES = previous; });
    fixture.settings._settingsRevision = 41;
    fixture.settings.main_api = 'kobold';
    fixture.settings.active_generation = { api: 'kobold' };
    fixture.settings.kai_settings = { api_server: 'http://127.0.0.1:6000/api', preset_settings: 'gui' };
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 41 });
    assert.equal(binding.backend, 'kobold');
    let calls = 0;
    const options = { context: { owner: 'tester', directories: fixture.directories }, binding,
        messages: [{ role: 'user', content: 'Hello' }], maxTokens: 73, userName: 'Sam', characterName: 'Ada',
        fetch: async (url, request) => {
            calls++;
            assert.equal(url, 'http://127.0.0.1:6000/api/v1/generate');
            assert.equal(request.headers.Authorization, undefined);
            const body = JSON.parse(request.body);
            assert.equal(body.max_length, 73);
            assert.equal(body.max_context_length, 8192);
            assert.match(body.prompt, /Sam: Hello/);
            return new Response(JSON.stringify({ results: [{ text: 'Ada: Done' }] }));
        } };
    assert.equal((await runChatProfile(options)).text, 'Done');
    assert.equal(calls, 1);
    fixture.settings.kai_settings.api_server = 'http://127.0.0.1:7000/api'; fixture.save();
    await assert.rejects(runChatProfile(options), /changed/);
    assert.equal(calls, 1);
    fixture.settings.kai_settings.api_server = 'http://127.0.0.1:6000/api'; fixture.save();
    await assert.rejects(runChatProfile({ ...options, stream: true }), /completion marker/);
    assert.equal(calls, 1);
});

test('acknowledged NovelAI uses its saved model, server-side token and clean reply', async t => {
    const fixture = textFixture(t);
    fixture.settings._settingsRevision = 42;
    fixture.settings.main_api = 'novel';
    fixture.settings.active_generation = { api: 'novel' };
    fixture.settings.nai_settings = { model_novel: 'fixture-model', preset_settings_novel: 'gui', temperature: 1,
        min_length: 1, tail_free_sampling: 0.975, repetition_penalty: 2.25, repetition_penalty_range: 2048,
        repetition_penalty_slope: 0.09, repetition_penalty_frequency: 0, repetition_penalty_presence: 0.005,
        top_a: 0.08, top_p: 0.75, top_k: 10, min_p: 0, math1_temp: 1, math1_quad: 0,
        math1_quad_entropy_scale: 0, typical_p: 0.975, banned_tokens: '', logit_bias: [], order: [1, 5, 0, 2, 3, 4] };
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_novel: [{ id: 'selected', value: 'private-token', active: true }] }));
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 42 });
    assert.equal(binding.backend, 'novel');
    let calls = 0;
    const options = { context: { owner: 'tester', directories: fixture.directories }, binding,
        messages: [{ role: 'user', content: 'Hello' }], maxTokens: 73, userName: 'Sam', characterName: 'Ada',
        fetch: async (url, request) => {
            calls++;
            assert.equal(url, 'https://api.novelai.net/ai/generate');
            assert.equal(request.headers.Authorization, 'Bearer private-token');
            const body = JSON.parse(request.body);
            assert.equal(body.model, 'fixture-model');
            assert.equal(body.parameters.max_length, 73);
            assert.ok(['temperature', 'top_k', 'repetition_penalty', 'tail_free_sampling']
                .every(name => Number.isFinite(body.parameters[name])));
            assert.match(body.input, /Sam: Hello/);
            return new Response(JSON.stringify({ output: 'Ada: Done' }));
        } };
    assert.equal((await runChatProfile(options)).text, 'Done');
    assert.equal(calls, 1);
    fixture.settings.nai_settings.temperature = 2; fixture.save();
    await assert.rejects(runChatProfile(options), /changed/);
    assert.equal(calls, 1);
    fixture.settings.nai_settings.temperature = 1; fixture.save();
    await assert.rejects(runChatProfile({ ...options, stream: true }), /completion marker/);
    assert.equal(calls, 1);
    fixture.settings.nai_settings.model_novel = 'kayra'; fixture.save();
    const kayra = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 42 });
    for (const [tier, expected] of [[3, 250], [1, 150]]) {
        let statusCalls = 0;
        let generationCalls = 0;
        const result = await runChatProfile({ ...options, binding: kayra, maxTokens: 300, fetch: async (url, request) => {
            assert.equal(request.headers.Authorization, 'Bearer private-token');
            if (url.endsWith('/user/subscription')) {
                statusCalls++;
                assert.equal(request.method, 'GET');
                return new Response(JSON.stringify({ tier }));
            }
            generationCalls++;
            assert.equal(url, 'https://text.novelai.net/ai/generate');
            assert.equal(JSON.parse(request.body).parameters.max_length, expected);
            return new Response(JSON.stringify({ output: 'Ada: Done' }));
        } });
        assert.equal(result.text, 'Done');
        assert.equal(statusCalls, 1);
        assert.equal(generationCalls, 1);
    }
    let generationCalls = 0;
    await assert.rejects(runChatProfile({ ...options, binding: kayra, maxTokens: 300, fetch: async url => {
        if (url.endsWith('/user/subscription')) return new Response(JSON.stringify({ tier: null }));
        generationCalls++;
        return new Response(JSON.stringify({ output: 'unexpected' }));
    } }), /account tier/);
    assert.equal(generationCalls, 0);
    delete fixture.settings.nai_settings.top_k; fixture.save();
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 42 }), /complete NovelAI/);
});

test('acknowledged Horde saves its task ID before polling and never submits it twice', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 43, main_api: 'koboldhorde',
        active_generation: { api: 'koboldhorde' },
        kai_settings: { preset_settings: 'gui', rep_pen: 1, rep_pen_range: 0, rep_pen_slope: 0.9, temp: 1,
            tfs: 1, top_a: 1, top_k: 0, top_p: 1, min_p: 0, typical: 1, sampler_order: [0, 1, 2] },
        horde_settings: { models: ['test-worker'], trusted_workers_only: true } });
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_horde: [{ id: 'selected', value: 'horde-private', active: true }] }));
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 43 });
    const job = acceptJob(fixture.directories, { owner: 'tester', type: 'roleplay.reply', submissionKey: 'horde-bound', intent: {} }).job;
    setJobState(fixture.directories, job.id, 'running');
    let submits = 0;
    let polls = 0;
    const options = { context: { owner: 'tester', directories: fixture.directories }, binding, jobContext: {
        job, directories: fixture.directories, signal: new AbortController().signal },
    messages: [{ role: 'user', content: 'Hello' }], maxTokens: 73, userName: 'Sam', characterName: 'Ada',
    fetch: async (url, request) => {
        if (String(url).endsWith('/async')) {
            submits++;
            assert.equal(request.headers.apikey, 'horde-private');
            const body = JSON.parse(request.body);
            assert.deepEqual(body.models, ['test-worker']);
            assert.equal(body.params.max_length, 73);
            assert.equal(body.params.prompt, undefined);
            return new Response(JSON.stringify({ id: 'known-task' }));
        }
        polls++;
        assert.ok(String(url).endsWith('/known-task'));
        if (polls === 1) throw new Error('Polling connection dropped');
        return new Response(JSON.stringify({ done: true, generations: [{ text: 'Ada: Done' }] }));
    } };
    await assert.rejects(runChatProfile(options), /conversation generation failed/);
    assert.equal(submits, 1);
    assert.equal(getJob(fixture.directories, job.id).recoverability, 'resumable');
    markProviderUncertain(fixture.directories, job.id, { step: getJob(fixture.directories, job.id).resume });
    assert.equal(getJob(fixture.directories, job.id).recoverability, 'unknown-outcome');
    assert.ok(recoverJobs(fixture.directories).recoverable.some(item => item.id === job.id));
    fixture.settings.horde_settings.models = ['another-worker']; fixture.save();
    assert.equal((await runChatProfile(options)).text, 'Done');
    assert.equal(submits, 1);
    assert.equal(polls, 2);
    assert.equal((await runChatProfile(options)).text, 'Done');
    assert.equal(submits, 1);
    const artifacts = path.join(fixture.root, 'jobs', 'artifacts');
    for (const entry of fs.readdirSync(artifacts, { recursive: true })) {
        const filename = path.join(artifacts, entry);
        if (fs.statSync(filename).isFile()) assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /horde-private/);
    }
    fixture.settings.horde_settings.models = ['test-worker']; fixture.save();
    const unknown = acceptJob(fixture.directories, { owner: 'tester', type: 'roleplay.reply', submissionKey: 'horde-unknown', intent: {} }).job;
    setJobState(fixture.directories, unknown.id, 'running');
    await assert.rejects(runChatProfile({ ...options, jobContext: { ...options.jobContext, job: unknown },
        fetch: async () => { submits++; throw new Error('Task acceptance is unknown'); } }), /conversation generation failed/);
    assert.equal(getJob(fixture.directories, unknown.id).recoverability, 'unknown-outcome');
    assert.ok(!recoverJobs(fixture.directories).recoverable.some(item => item.id === unknown.id));
    assert.equal(getJob(fixture.directories, unknown.id).state, 'interrupted');
});

test('Horde GUI mode uses worker defaults and malformed Kobold samplers refuse before dispatch', async t => {
    const fixture = textFixture(t);
    fixture.settings._settingsRevision = 44;
    fixture.settings.main_api = 'koboldhorde';
    fixture.settings.active_generation = { api: 'koboldhorde' };
    fixture.settings.kai_settings = { preset_settings: 'gui' };
    fixture.settings.horde_settings = { models: ['test-worker'] };
    fixture.save();
    const horde = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 44 });
    const job = acceptJob(fixture.directories, { owner: 'tester', type: 'roleplay.reply', submissionKey: 'horde-gui', intent: {} }).job;
    const base = { context: { owner: 'tester', directories: fixture.directories }, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 73 };
    let calls = 0;
    const result = await runChatProfile({ ...base, binding: horde, jobContext: { job, directories: fixture.directories, signal: new AbortController().signal },
        fetch: async (url, request) => {
            calls++;
            if (String(url).endsWith('/async')) {
                const body = JSON.parse(request.body);
                assert.deepEqual(body.params, { max_length: 73, max_context_length: 8192, n: 1,
                    frmtadsnsp: false, frmtrmblln: false, frmtrmspch: false, frmttriminc: false });
                return new Response(JSON.stringify({ id: 'gui-task' }));
            }
            return new Response(JSON.stringify({ done: true, generations: [{ text: 'Worker reply' }] }));
        } });
    assert.equal(result.text, 'Worker reply');
    assert.equal(calls, 2);

    fixture.settings.main_api = 'kobold';
    fixture.settings.active_generation = { api: 'kobold' };
    fixture.settings.kai_settings = { api_server: 'http://127.0.0.1:6000', preset_settings: '', temp: 'invalid' };
    fixture.save();
    const kobold = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 44 });
    await assert.rejects(runChatProfile({ ...base, binding: kobold, fetch: () => assert.fail('Malformed samplers must not reach a provider') }),
        /complete Kobold sampler controls/);
});

test('saved text Meower requests omit sampler and instruct formatting together', async t => {
    const fixture = textFixture(t);
    fixture.settings.power_user.instruct = { ...instructSettings, enabled: true };
    fixture.settings.power_user.custom_stopping_strings = '["<stop>"]';
    const material = fixture.material();
    const request = await buildTextProfileRequest({ owner: 'tester', directories: fixture.directories }, material,
        [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Write posts' }], 100,
        { rawOptions: { includePreset: false, includeInstruct: false } });
    assert.equal(request.prompt, 'Rules\n\nWrite posts');
    assert.equal(request.temperature, undefined);
    assert.equal(request.stop, undefined);
    assert.equal(request.max_new_tokens, 100);
    assert.equal(request.api_server, 'http://127.0.0.1:5000');
});

function textFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-text-controls-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const profile = { id: 'text', mode: 'tc', api: 'llamacpp', model: 'fixture', 'api-url': 'http://127.0.0.1:5000' };
    const settings = { max_context: 8192, textgenerationwebui_settings: { ...providerSettings, banned_tokens: '', global_banned_tokens: '', logit_bias: [],
        send_banned_tokens: true, dry_sequence_breakers: '[]', negative_prompt: '' },
    power_user: { custom_stopping_strings: '[]' }, extension_settings: { connectionManager: { profiles: [profile] } } };
    const directories = { root };
    const save = () => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    const capture = () => { save(); return captureChatProfile(directories, profile.id); };
    const material = () => resolveGenerationProfile(directories, capture());
    return { root, profile, settings, directories, save, capture, material };
}

for (const backend of ['chat', 'text']) test(`explicit saved-active ${backend} capture ignores the selected profile and preset`, async t => {
    const fixture = textFixture(t);
    const settings = fixture.settings;
    settings._settingsRevision = 17;
    settings.main_api = backend === 'text' ? 'textgenerationwebui' : 'openai';
    settings.active_generation = { api: settings.main_api, source: backend === 'text' ? 'llamacpp' : 'custom',
        model: 'active-model', serverUrl: 'http://127.0.0.1:6000' };
    settings.oai_settings = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'active-model', temp_openai: 0.21, openai_max_tokens: 999,
        reverse_proxy: '', proxy_password: '' };
    settings.textgenerationwebui_settings.type = 'llamacpp';
    settings.textgenerationwebui_settings.temp = 0.21;
    settings.textgenerationwebui_settings.preset = 'missing-and-not-to-be-reloaded';
    settings.textgenerationwebui_settings.openrouter_service_tier = 'priority';
    settings.power_user.instruct = { ...instructSettings, enabled: true };
    settings.extension_settings.connectionManager.selectedProfile = 'wrong';
    settings.proxies = [{ name: 'Unselected', source: 'custom', url: 'https://unused.invalid', password: 'unused' }];
    fixture.profile.preset = 'missing';
    fixture.save();
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }), /not acknowledged/);
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 16 }), /not acknowledged/);
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 17 });
    assert.equal(binding.kind, 'active');
    assert.equal(binding.profileId, undefined);
    assert.equal(binding.backend, backend);
    const material = resolveGenerationProfile(fixture.directories, binding);
    assert.equal(material.profile.model, 'active-model');
    assert.equal(material.preset, undefined);
    if (backend === 'text') {
        assert.equal(material.active.api_server, 'http://127.0.0.1:6000');
        assert.equal(material.active.temp, 0.21);
        assert.equal(material.instruct.enabled, true);
        assert.equal(material.active.openrouter_service_tier, 'priority');
    } else {
        const payload = await buildChatProfileRequest(fixture.directories, binding, [{ role: 'user', content: 'Hello' }], 73,
            async controls => ({ generate_data: { temperature: controls.temp_openai, max_tokens: controls.openai_max_tokens, custom_url: controls.custom_url } }));
        assert.equal(payload.temperature, 0.21);
        assert.equal(payload.max_tokens, 73);
        assert.equal(payload.custom_url, 'http://127.0.0.1:6000');
        assert.equal(payload.reverse_proxy, '');
    }
    settings.extension_settings.connectionManager.selectedProfile = 'another-wrong-profile';
    fixture.save();
    assert.equal(resolveGenerationProfile(fixture.directories, binding).fingerprint, binding.fingerprint);
    settings.power_user.instruct.input_sequence = 'changed';
    fixture.save();
    assert.throws(() => resolveGenerationProfile(fixture.directories, binding), /changed/);
});

for (const backend of ['chat', 'text']) test(`saved-active ${backend} executes raw formatting and retains its cleaned result`, async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: backend === 'text' ? 'textgenerationwebui' : 'openai',
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'active-model', temp_openai: 0.21, openai_max_tokens: 999 } });
    fixture.settings.active_generation = { api: fixture.settings.main_api, source: backend === 'text' ? 'llamacpp' : 'custom', model: 'active-model', serverUrl: 'http://127.0.0.1:6000' };
    fixture.settings.textgenerationwebui_settings.type = 'llamacpp';
    fixture.settings.power_user = { instruct: structuredClone(instructSettings), context: { names_as_stop_strings: true }, custom_stopping_strings: '["<stop>"]', trim_spaces: true, auto_fix_generated_markdown: true };
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
    const job = acceptJob(fixture.directories, { owner: 'tester', type: 'roleplay.reply', submissionKey: 'active', intent: {} }).job;
    let calls = 0;
    const options = { context: { owner: 'tester', directories: fixture.directories }, binding, messages: promptMessages, maxTokens: 73,
        userName: 'Sam', characterName: 'Ada', macroEnvironment: { evaluate: value => value.replaceAll('{{char}}', 'Ada').replaceAll('{{user}}', 'Sam') },
        rawOptions: { systemPrompt: ' Story {{char}} ', prefill: ' {{user}} ', quietToLoud: true }, jobContext: { job, directories: fixture.directories, signal: new AbortController().signal },
        fetch: async (url, request) => {
            calls++;
            assert.ok(String(url).startsWith('http://127.0.0.1:6000/'));
            const body = JSON.parse(request.body);
            if (backend === 'text') { assert.equal(body.prompt, expectedPrompts.raw); assert.ok(body.stop.includes('\nSam:')); }
            else assert.deepEqual(body.messages, expectedPrompts.chat);
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Ada: * hello *<sto' } }] }) };
        } };
    assert.equal((await runChatProfile(options)).text, '*hello*');
    fixture.settings.main_api = 'unsupported'; fixture.save();
    assert.equal((await runChatProfile(options)).text, '*hello*');
    assert.equal(calls, 1);
});

test('stock text destinations do not inherit an unrelated active URL', t => {
    const fixture = textFixture(t);
    const defaults = { mancer: 'https://neuro.mancer.tech', togetherai: 'https://api.together.xyz', infermaticai: 'https://api.totalgpt.ai',
        dreamgen: 'https://dreamgen.com', openrouter: 'https://openrouter.ai/api', featherless: 'https://api.featherless.ai/v1' };
    fixture.settings.textgenerationwebui_settings.api_server = 'https://wrong.invalid';
    for (const [source, url] of Object.entries(defaults)) {
        fixture.profile.api = source;
        fixture.profile['secret-id'] = 'selected';
        fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ [`api_key_${source}`]: [{ id: 'selected', value: 'private', active: true }] }));
        delete fixture.profile['api-url'];
        assert.equal(fixture.material().active.api_server, url);
        fixture.profile['api-url'] = 'https://explicit.invalid';
        assert.equal(fixture.material().active.api_server, 'https://explicit.invalid');
        fixture.profile.exclude = ['api-url'];
        assert.equal(fixture.material().active.api_server, url);
        delete fixture.profile.exclude;
    }
});

test('active Custom keeps saved authentication out of artefacts and enforces final limits', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture-model' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture-model',
            temp_openai: 1, custom_include_headers: 'Authorization: Bearer header-private',
            custom_include_body: 'api_key: body-private\nmax_tokens: 9000' } });
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
    const job = acceptJob(fixture.directories, { owner: 'alice', type: 'roleplay.reply', submissionKey: 'custom-auth', intent: {} }).job;
    const options = { context: { owner: 'alice', directories: fixture.directories }, binding,
        messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73, rawOptions: { temperature: 0 },
        jobContext: { job, directories: fixture.directories, signal: new AbortController().signal },
        fetch: async (_url, request) => {
            const body = JSON.parse(request.body);
            assert.equal(body.max_tokens, 73);
            assert.equal(body.temperature, 0);
            assert.equal(body.api_key, 'body-private');
            assert.equal(request.headers.Authorization, 'Bearer header-private');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Reply' } }] }));
        } };
    assert.equal((await runChatProfile(options)).text, 'Reply');
    for (const entry of fs.readdirSync(path.join(fixture.root, 'jobs', 'artifacts'), { recursive: true })) {
        const filename = path.join(fixture.root, 'jobs', 'artifacts', entry);
        if (fs.statSync(filename).isFile()) assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /header-private|body-private/);
    }
    await assert.rejects(runChatProfile({ ...options, overridePayload: { custom_include_headers: 'Authorization: unsafe' } }), /Save authentication overrides/);
    fixture.settings.oai_settings.custom_url = 'http://user:private@localhost:6000'; fixture.save();
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }), /without embedded credentials/);
});

test('a saved Chat Completion request retains its bound structured-output controls', async t => {
    const fixture = textFixture(t);
    fixture.profile.mode = 'cc';
    fixture.profile.api = 'custom';
    fixture.profile.model = 'fixture';
    fixture.profile['api-url'] = 'http://127.0.0.1:6000';
    fixture.settings.oai_settings = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000' };
    fixture.save();
    const binding = captureChatProfile(fixture.directories, fixture.profile.id);
    let calls = 0;
    const result = await runChatProfile({ context: { owner: 'alice', directories: fixture.directories }, binding,
        messages: [{ role: 'user', content: 'Reply as JSON' }], maxTokens: 73,
        rawOptions: { jsonSchema: { name: 'Reply', value: { type: 'object', properties: { text: { type: 'string' } } } } },
        fetch: async (_url, request) => {
            calls++;
            const body = JSON.parse(request.body);
            assert.ok(body.json_schema || body.response_format, 'the saved schema must reach the provider');
            return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"saved"}' } }] }));
        } });
    assert.equal(result.text, '{"text":"saved"}');
    assert.equal(calls, 1);
    await assert.rejects(runChatProfile({ context: { owner: 'alice', directories: fixture.directories }, binding,
        messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73, rawOptions: { prefill: 'ignored' },
        fetch: async () => { calls++; throw new Error('Should not reach the provider.'); } }),
    /requires the acknowledged active connection/);
    assert.equal(calls, 1);
});

test('active provider extraction preserves native text blocks and schema responses', async t => {
    const fixture = textFixture(t);
    const cases = [
        ['cohere', { message: { content: [{ type: 'text', text: 'Cohere reply' }] } }, 'Cohere reply'],
        ['claude', { content: [{ type: 'thinking', thinking: 'Private thought' }, { type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] }, 'First\n\nSecond'],
        ['mistralai', { choices: [{ message: { content: [{ type: 'text', text: 'Structured reply' }] } }] }, 'Structured reply'],
        ['custom', { choices: [], text: 'Fallback text' }, 'Fallback text'],
    ];
    for (const [source, response, expected] of cases) {
        Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
            active_generation: { api: 'openai', source, model: 'fixture-model' },
            oai_settings: { chat_completion_source: source, custom_url: 'http://127.0.0.1:6000', reverse_proxy: 'http://127.0.0.1:6000', proxy_password: 'private', openai_max_tokens: 999 } });
        fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ [`api_key_${source}`]: [{ id: 'selected', value: 'private', active: true }] }));
        fixture.save();
        const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
        const options = { context: { owner: 'alice', directories: fixture.directories }, binding,
            messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73,
            fetch: async () => new Response(JSON.stringify(response)) };
        assert.equal((await runChatProfile(options)).text, expected, source);
        if (source === 'claude') {
            const object = { text: 'Character: * keep spaces *' };
            const result = await runChatProfile({ ...options, rawOptions: { jsonSchema: { name: 'answer', value: { type: 'object' } } },
                fetch: async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'answer', input: object }] })) });
            assert.deepEqual(JSON.parse(result.text), object);
        }
    }
});

test('active output transformations preserve scope, order and refusal before dispatch', async t => {
    const fixture = textFixture(t);
    const script = (findRegex, replaceString, extra = {}) => ({ findRegex, replaceString, placement: [2], ...extra });
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture', regexPreset: { api: 'openai', name: 'Current' } },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture',
            extensions: { regex_scripts: [script('Beta', 'Gamma')] } } });
    Object.assign(fixture.settings.extension_settings, {
        regex: [script('(Alpha)', 'Beta'), script('Beta', 'Wrong', { markdownOnly: true }), script('Beta', 'Wrong', { disabled: true })],
        preset_allowed_regex: { openai: ['Current'] }, character_allowed_regex: ['ada.png'],
    });
    fixture.save();
    let calls = 0;
    const options = { context: { owner: 'alice', directories: fixture.directories },
        binding: captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }),
        messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73,
        macroEnvironment: createMacroEnvironment({ extra: { characterAvatar: 'ada.png',
            character: { extensions: { regex_scripts: [script('Gamma', 'Final')] } } } }),
        fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'Alpha' } }] })); },
    };
    assert.equal((await runChatProfile(options)).text, 'Final');
    assert.equal(calls, 1);
    await assert.rejects(runChatProfile({ ...options, macroEnvironment: undefined }), /captured character/);
    assert.equal(calls, 1);
    fixture.settings.extension_settings.regex.push(script('Final', '{{setvar::unsafe::1}}'));
    fixture.save();
    options.binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
    await assert.rejects(runChatProfile(options), /Macro-dependent/);
    assert.equal(calls, 1);
    fixture.settings.extension_settings.disabledExtensions = ['regex']; fixture.save();
    assert.throws(() => resolveGenerationProfile(fixture.directories, options.binding), /changed/);
    options.binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
    assert.equal((await runChatProfile(options)).text, 'Alpha');
});

test('active Custom binds the selected endpoint key, including an existing keyless ID', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'typed-model' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'typed-model' },
        selected_custom_endpoint_preset: { name: 'Saved endpoint', secretId: 'endpoint-a', url: 'https://unused.invalid', model: 'wrong' } });
    fixture.save();
    for (const value of ['endpoint-key', '']) {
        fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_custom: [
            { id: 'endpoint-a', value, active: false }, { id: 'other-b', value: 'wrong-key', active: true },
        ] }));
        const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
        const payload = await buildChatProfileRequest(fixture.directories, binding, [{ role: 'user', content: 'Hello' }], 73,
            async settings => ({ generate_data: { custom_url: settings.custom_url } }));
        assert.equal(payload.secret_id, 'endpoint-a');
        assert.equal(payload.model, 'typed-model');
        await runTextGeneration({ context: { owner: 'alice', directories: fixture.directories }, backend: 'chat', payload,
            fetch: async (url, request) => {
                assert.equal(url, 'http://127.0.0.1:6000/chat/completions');
                assert.equal(request.headers.Authorization, value ? 'Bearer endpoint-key' : undefined);
                return new Response(JSON.stringify({ choices: [{ message: { content: 'Reply' } }] }));
            } });
    }
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_custom: [{ id: 'other-b', value: 'wrong-key', active: true }] }));
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }), /key.*unavailable/);
});

test('active OpenRouter preserves website-default model and provider quantisations', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'openrouter', model: null },
        oai_settings: { chat_completion_source: 'openrouter', openrouter_model: 'OR_Website', openrouter_quantizations: ['int4'] } });
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_openrouter: [{ id: 'selected', value: 'private', active: true }] }));
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 });
    const payload = await buildChatProfileRequest(fixture.directories, binding, [{ role: 'user', content: 'Hello' }], 73,
        async settings => ({ generate_data: { quantizations: settings.openrouter_quantizations } }));
    assert.equal(payload.model, null);
    await runTextGeneration({ context: { owner: 'alice', directories: fixture.directories }, backend: 'chat', payload,
        fetch: async (_url, request) => {
            const body = JSON.parse(request.body);
            assert.equal(body.model, null);
            assert.deepEqual(body.provider.quantizations, ['int4']);
            assert.equal(request.headers.Authorization, 'Bearer private');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Reply' } }] }));
        } });
    fixture.settings.oai_settings.openrouter_model = 'some-model';
    fixture.save();
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }), /Save a model/);
});

test('an empty active text destination cannot become a hosted default', t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'textgenerationwebui',
        active_generation: { api: 'textgenerationwebui', source: 'openrouter', model: 'saved', serverUrl: '' } });
    fixture.settings.textgenerationwebui_settings.type = 'openrouter';
    fixture.save();
    assert.throws(() => captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }), /server URL/);
});

test('malformed saved instruct, stop and bias controls fail during capture', t => {
    const fixture = textFixture(t);
    fixture.profile['instruct-state'] = true;
    for (const invalid of [{ instruct: { stop_sequence: 7 } }, { instruct: { input_suffix: 7 } }, { context: { chat_start: 7 } }, { custom_stopping_strings: '[7]' }, { custom_stopping_strings: 'not JSON' }]) {
        fixture.settings.power_user = invalid;
        assert.throws(fixture.capture, error => error.status === 409);
    }
    fixture.settings.power_user = {};
    fixture.settings.textgenerationwebui_settings.logit_bias = [{ text: 'word', value: 'invalid' }];
    assert.throws(fixture.capture, error => error.status === 409);
});

test('active Azure rejects embedded credentials and text capture rejects invalid IDs or an empty Ollama model', t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'azure_openai', model: 'saved' },
        oai_settings: { chat_completion_source: 'azure_openai', azure_base_url: 'https://azure.invalid', azure_deployment_name: 'saved', azure_api_version: '2025-01-01' } });
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_azure_openai: [{ id: 'selected', value: 'private', active: true }] }));
    const capture = () => { fixture.save(); return captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }); };
    assert.equal(capture().kind, 'active');
    for (const field of ['azure_base_url', 'azure_deployment_name', 'azure_api_version']) {
        const saved = fixture.settings.oai_settings[field];
        delete fixture.settings.oai_settings[field];
        assert.throws(capture, /Azure/i);
        fixture.settings.oai_settings[field] = saved;
    }
    fixture.settings.oai_settings.azure_base_url = 'https://user:private@azure.invalid';
    assert.throws(capture, /embedded credentials/);
    fixture.settings.textgenerationwebui_settings.banned_tokens = '[oops]';
    assert.throws(fixture.capture, /token.*invalid/i);
    fixture.settings.textgenerationwebui_settings.banned_tokens = '';
    fixture.settings.textgenerationwebui_settings.logit_bias = [{ text: '[false]', value: 0 }];
    assert.throws(fixture.capture, /token.*invalid/i);
    fixture.settings.textgenerationwebui_settings.logit_bias = [{ text: '[{{user}}]', value: 0 }];
    assert.throws(fixture.capture, /token.*invalid/i);
    fixture.settings.textgenerationwebui_settings.logit_bias = [];
    fixture.profile.api = 'ollama'; fixture.profile.model = '';
    assert.throws(fixture.capture, /model/i);
    fixture.profile.api = 'llamacpp';
    assert.equal(fixture.capture().backend, 'text');
});

test('active capability checks cover indirect macros and refuse dynamic regex only when applicable', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'saved' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000' } });
    fixture.settings.power_user.experimental_macro_engine = true;
    const capture = () => { fixture.save(); return captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }); };
    let calls = 0;
    const options = { context: { owner: 'alice', directories: fixture.directories }, binding: capture(), maxTokens: 73,
        macroEnvironment: createMacroEnvironment(), fetch: async () => {
            calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"User: * original *"}' } }] }));
        } };
    for (const content of ['{{if isMobile}}phone{{else}}desktop{{/if}}', '{{if::isMobile}}phone{{else}}desktop{{/if}}',
        '{{if {{reverse::eliboMsi}}}}phone{{else}}desktop{{/if}}', '{{if {{hasExtension::regex}}}}yes{{/if}}']) {
        await assert.rejects(runChatProfile({ ...options, messages: [{ role: 'user', content }] }), /not available|cannot.*server|requires.*browser/i);
    }
    assert.equal(calls, 0);
    for (const findRegex of ['<GROUP>', '<CHARIFNOTGROUP>']) {
        fixture.settings.extension_settings.regex = [{ findRegex, replaceString: 'replacement', substituteRegex: 1, placement: [2] }];
        options.binding = capture();
        await assert.rejects(runChatProfile({ ...options, messages: [{ role: 'user', content: 'hello' }] }), /Macro-dependent/i);
    }
    for (const replaceString of ['<USER>', '<GROUP>', '<CHARIFNOTGROUP>', '$1', '{{match}}', '$<name>']) {
        fixture.settings.extension_settings.regex = [{ findRegex: '(hello)', replaceString, placement: [2] }];
        options.binding = capture();
        await assert.rejects(runChatProfile({ ...options, messages: [{ role: 'user', content: 'hello' }] }), /Macro-dependent|capture-dependent/i);
    }
    assert.equal(calls, 0);
    const result = await runChatProfile({ ...options, messages: [{ role: 'user', content: 'hello' }],
        rawOptions: { jsonSchema: { name: 'Reply', value: { type: 'object', properties: { text: { type: 'string' } } } } } });
    assert.equal(result.text, '{"text":"User: * original *"}');
    assert.equal(calls, 1);
});

test('active preflight resolves token bans in isolated state and ignores unused Chat text controls', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'textgenerationwebui',
        active_generation: { api: 'textgenerationwebui', source: 'llamacpp', model: 'saved', serverUrl: 'http://127.0.0.1:6000' } });
    fixture.settings.power_user.experimental_macro_engine = true;
    fixture.settings.textgenerationwebui_settings.banned_tokens = '{{getvar::ban}}';
    fixture.settings.textgenerationwebui_settings.type = 'llamacpp';
    const material = () => {
        fixture.save();
        return resolveGenerationProfile(fixture.directories, captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }));
    };
    const env = createMacroEnvironment({ variables: { local: { ban: '[oops]', count: '0' } } });
    await assert.rejects(validateActiveGenerationContext(material(), env, [{ role: 'user', content: '{{incvar::count}}Hello' }]), /token.*invalid/i);
    assert.equal(env.evaluate('{{getvar::count}}'), '0');
    env.evaluate('{{setvar::ban::[17]}}');
    await validateActiveGenerationContext(material(), env, [{ role: 'user', content: '{{incvar::count}}Hello' }]);
    assert.equal(env.evaluate('{{getvar::count}}'), '0');
    Object.assign(fixture.settings, { main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'saved' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000' } });
    Object.assign(fixture.settings.power_user, { instruct: { enabled: true, input_sequence: '{{isMobile}}' },
        custom_stopping_strings_macro: false, custom_stopping_strings: '["{{isMobile}}"]' });
    let calls = 0;
    const bindingMaterial = material();
    await validateActiveGenerationContext(bindingMaterial, env, [{ role: 'user', content: 'Hello' }]);
    const result = await runChatProfile({ context: { owner: 'alice', directories: fixture.directories },
        binding: captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }), messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 73, macroEnvironment: env, fetch: async (_url, request) => {
            calls++;
            assert.ok(JSON.parse(request.body).stop.includes('{{isMobile}}'));
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Valid reply' } }] }));
        } });
    assert.equal(result.text, 'Valid reply');
    assert.equal(calls, 1);
});

test('active validation includes cleanup stop passes and the actual response limit without changing caller state', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'saved' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000' } });
    Object.assign(fixture.settings.power_user, { experimental_macro_engine: true, custom_stopping_strings_macro: true,
        custom_stopping_strings: JSON.stringify(['{{if .seen}}{{input}}{{else}}{{setvar::seen::true}}END{{/if}}']) });
    const capture = () => { fixture.save(); return captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }); };
    let calls = 0;
    let persisted = 0;
    const env = createMacroEnvironment({}, {}, { onVariableChange: () => persisted++ });
    const options = { context: { owner: 'alice', directories: fixture.directories }, maxTokens: 73,
        messages: [{ role: 'user', content: 'Hello' }], macroEnvironment: env,
        fetch: async (_url, request) => {
            calls++;
            assert.deepEqual(JSON.parse(request.body).logit_bias, [[73, false]]);
            return new Response(JSON.stringify({ choices: [{ text: 'Valid reply.' }] }));
        } };
    await assert.rejects(runChatProfile({ ...options, binding: capture() }), /input.*unavailable/);
    assert.equal(env.evaluate('{{getvar::seen}}'), '');
    assert.equal(persisted, 0);
    Object.assign(fixture.settings, { main_api: 'textgenerationwebui', active_generation: {
        api: 'textgenerationwebui', source: 'llamacpp', model: 'saved', serverUrl: 'http://127.0.0.1:6000' } });
    fixture.settings.textgenerationwebui_settings.type = 'llamacpp';
    fixture.settings.power_user.custom_stopping_strings = JSON.stringify([
        '{{if .third}}{{input}}{{else}}{{if .second}}{{setvar::third::true}}{{else}}{{if .first}}{{setvar::second::true}}{{else}}{{setvar::first::true}}{{/if}}{{/if}}END{{/if}}',
    ]);
    await assert.rejects(runChatProfile({ ...options, binding: capture() }), /input.*unavailable/);
    assert.equal(env.evaluate('{{getvar::first}}'), '');
    assert.equal(persisted, 0);
    assert.equal(calls, 0);
    fixture.settings.power_user.custom_stopping_strings = '[]';
    fixture.settings.textgenerationwebui_settings.banned_tokens = '[{{maxResponseTokens}}]';
    assert.equal((await runChatProfile({ ...options, binding: capture() })).text, 'Valid reply.');
    assert.equal(calls, 1);
    assert.equal(persisted, 0);
});

test('active validation preserves assistant roles, overrides and prefill-before-input ordering', async t => {
    const fixture = textFixture(t);
    Object.assign(fixture.settings, { _settingsRevision: 3, main_api: 'textgenerationwebui',
        active_generation: { api: 'textgenerationwebui', source: 'llamacpp', model: 'saved', serverUrl: 'http://127.0.0.1:6000' } });
    fixture.settings.textgenerationwebui_settings.type = 'llamacpp';
    fixture.settings.power_user.experimental_macro_engine = true;
    fixture.settings.power_user.instruct = { ...instructSettings, enabled: true, macro: true, output_suffix: '{{isMobile}}' };
    const capture = () => { fixture.save(); return captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 3 }); };
    const transcript = [{ role: 'assistant', content: 'An earlier reply.' }, { role: 'user', content: 'Next question.' }];
    let calls = 0;
    const options = { context: { owner: 'alice', directories: fixture.directories }, maxTokens: 73,
        macroEnvironment: createMacroEnvironment(), fetch: async () => {
            calls++; return new Response(JSON.stringify({ choices: [{ text: 'Valid reply.' }] }));
        } };
    await assert.rejects(runChatProfile({ ...options, binding: capture(), messages: transcript }), /isMobile.*unavailable/);
    assert.equal((await runChatProfile({ ...options, binding: capture(), messages: transcript, rawOptions: { instructOverride: true } })).text, 'Valid reply.');
    fixture.settings.power_user.instruct.output_suffix = '{{setvar::ban::[oops]}}';
    fixture.settings.textgenerationwebui_settings.banned_tokens = '{{getvar::ban}}';
    await assert.rejects(runChatProfile({ ...options, binding: capture(), messages: transcript }), /token.*invalid/i);
    Object.assign(fixture.settings, { main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'saved' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000' } });
    await assert.rejects(runChatProfile({ ...options, binding: capture(), messages: '{{if .flag}}{{input}}{{/if}}',
        rawOptions: { prefill: '{{setvar::flag::true}}' } }), /input.*unavailable/);
    fixture.settings.power_user.experimental_macro_engine = false;
    await assert.rejects(runChatProfile({ ...options, binding: capture(), messages: '{{isMobile}}' }), /isMobile.*unavailable/);
    assert.equal(calls, 1);
});

test('prompt macros precede token bans and consume request-local banned words once', async t => {
    const fixture = textFixture(t);
    fixture.profile['instruct-state'] = true;
    fixture.settings.power_user = { tokenizer: 'api_textgenerationwebui', instruct: { macro: true, input_sequence: '{{setvar::ban::after}}{{banned "hidden"}}' } };
    fixture.settings.textgenerationwebui_settings.banned_tokens = '{{getvar::ban}}';
    const material = fixture.material();
    const macroEnvironment = createMacroEnvironment({ names: { user: 'Sam', char: 'Ada' }, extra: { mainApi: 'textgenerationwebui' } });
    const words = [];
    const payload = await buildTextProfileRequest({ owner: 'alice', directories: fixture.directories }, material, [{ role: 'user', content: 'Hello' }], 73, {
        macroEnvironment, fetch: async (_url, request) => {
            words.push(JSON.parse(request.body).content);
            return new Response(JSON.stringify({ tokens: [17] }));
        },
    });
    assert.deepEqual(words, ['after', 'hidden']);
    assert.deepEqual(payload.logit_bias, [[17, false]]);
    assert.deepEqual(macroEnvironment.extra.bannedWords, []);
});

test('prepared text requests preserve random seeds and macros across recovery', async t => {
    const fixture = textFixture(t);
    fixture.profile.api = 'huggingface';
    fixture.profile['secret-id'] = 'selected';
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_huggingface: [{ id: 'selected', value: 'private', active: true }] }));
    fixture.settings.power_user.custom_stopping_strings = '["{{random::one::two}}"]';
    fixture.settings.power_user.custom_stopping_strings_macro = true;
    const binding = fixture.capture();
    const context = { owner: 'alice', directories: fixture.directories };
    const job = acceptJob(fixture.directories, { owner: 'alice', type: 'test.profile', submissionKey: 'recovery', intent: {} }).job;
    const jobContext = { ...context, job, signal: new AbortController().signal };
    const options = { context, binding, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 73,
        ephemeralStops: [], userName: 'User', characterName: 'Character', groupNames: [], modelOverride: '', overridePayload: {} };
    const key = hash({ binding, messages: options.messages, maxTokens: 73, ephemeralStops: [], userName: 'User', characterName: 'Character', groupNames: [], modelOverride: '', overridePayload: {} });
    const prepared = await buildTextProfileRequest(context, fixture.material(), options.messages, 73, { macroEnvironment: createMacroEnvironment() });
    writeArtifact(fixture.directories, job.id, 'text-request:' + key, prepared);
    let calls = 0;
    const run = () => runChatProfile({ ...options, jobContext, macroEnvironment: { evaluate: () => { throw new Error('Prepared macros must not run twice'); } },
        fetch: async (_url, request) => {
            calls++;
            const body = JSON.parse(request.body);
            assert.equal(body.seed, prepared.seed);
            assert.deepEqual(body.stop, prepared.stop);
            return new Response(JSON.stringify({ choices: [{ text: 'Recovered' }] }));
        } });
    assert.equal((await run()).text, 'Recovered');
    fixture.settings.extension_settings.connectionManager.profiles = [];
    fixture.save();
    assert.equal((await run()).text, 'Recovered');
    assert.equal(calls, 1);
    assert.deepEqual(readArtifact(fixture.directories, job.id, 'text-request:' + key), JSON.parse(JSON.stringify(prepared)));
});

test('named template macros use bound settings and omit only empty resolved stops', async t => {
    const fixture = textFixture(t);
    fixture.profile['instruct-state'] = true;
    fixture.settings.power_user = { instruct: { input_sequence: '<bound-user>', macro: true }, context: { chat_start: '<bound-chat>' },
        custom_stopping_strings: '["{{instructInput}}","{{chatStart}}","{{getvar::optionalStop}}","ordinary"," "]', custom_stopping_strings_macro: true };
    const captured = { instruct: { input_sequence: '<active-user>' }, context: { chat_start: '<active-chat>' } };
    const original = structuredClone(captured);
    const environment = createMacroEnvironment({ extra: { powerUser: captured } });
    const payload = await buildTextProfileRequest({ owner: 'alice', directories: fixture.directories }, fixture.material(), [{ role: 'user', content: 'Hello' }], 73, { macroEnvironment: environment });
    assert.ok(payload.prompt.startsWith('<bound-user>'));
    assert.ok(payload.stop.includes('<bound-user>'));
    assert.ok(payload.stop.includes('<bound-chat>'));
    assert.ok(payload.stop.includes('ordinary'));
    assert.ok(payload.stop.includes(' '));
    assert.ok(!payload.stop.includes(''));
    assert.ok(!payload.stop.includes('<active-user>'));
    assert.deepEqual(captured, original);
});

test('text cancellation stops remote tokenisation and sends Kobold its abort request', async t => {
    const fixture = textFixture(t);
    for (const stage of ['tokenisation', 'generation']) {
        fixture.profile.api = 'koboldcpp';
        fixture.settings.power_user.tokenizer = 'api_textgenerationwebui';
        fixture.settings.textgenerationwebui_settings.banned_tokens = stage === 'tokenisation' ? 'word' : '';
        const binding = fixture.capture();
        const controller = new AbortController();
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        const urls = [];
        const pending = runChatProfile({ context: { owner: 'alice', directories: fixture.directories }, binding,
            messages: [{ role: 'user', content: 'Hello' }], maxTokens: 73, signal: controller.signal,
            fetch: async (url, request) => {
                urls.push(url);
                if (url.endsWith('/abort')) return new Response('{}');
                started();
                return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
            } });
        await ready;
        controller.abort();
        await assert.rejects(pending, error => error.status === 499 || error.name === 'AbortError');
        if (stage === 'tokenisation') assert.deepEqual(urls, ['http://127.0.0.1:5000/api/extra/tokencount']);
        else assert.deepEqual(urls, ['http://127.0.0.1:5000/v1/completions', 'http://127.0.0.1:5000/api/extra/abort']);
    }
});

test('text response extraction preserves text precedence and omits structured reasoning', async t => {
    const fixture = textFixture(t);
    const binding = fixture.capture();
    for (const [response, expected] of [
        [{ choices: [{ text: 'Text', message: { content: 'Wrong' } }] }, 'Text'],
        [{ choices: [{ message: { content: [{ type: 'reasoning', text: 'Hidden' }, { type: 'text', text: 'Visible' }] } }] }, 'Visible'],
        [[{ content: 'Array reply' }], 'Array reply'],
        [{ response: 'Ollama reply' }, 'Ollama reply'],
        [{ content: 'Llama reply' }, 'Llama reply'],
    ]) {
        const result = await runChatProfile({ context: { owner: 'alice', directories: fixture.directories }, binding,
            messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73, fetch: async () => new Response(JSON.stringify(response)) });
        assert.equal(result.text, expected);
    }
});

test('saved tokenizer keys and hosted model selection never follow the active provider', async t => {
    for (const [key, expected] of [['command_r', 'command-r'], [16, 'command-r'], ['command_a', 'command-a'], ['19', 'command-a'],
        ['nerd', 'nerdstash'], ['nerd2', 'nerdstash_v2'], ['api_textgenerationwebui', 'remote'], [9, 'remote']]) {
        assert.equal(resolveTextTokenizer(key, 'llamacpp', 'unused'), expected);
    }
    assert.equal(resolveTextTokenizer('best_match', 'togetherai', 'meta-llama/Llama-3.1-8B'), 'llama3');
    assert.equal(resolveTextTokenizer(99, 'dreamgen', 'lucid-v1-medium'), 'mistral');
    assert.equal(resolveTextTokenizer(99, 'togetherai', 'mistralai/Mistral-Nemo-Instruct-2407'), 'nemo');
    assert.equal(resolveTextTokenizer(99, 'togetherai', 'mistralai/Pixtral-12B-2409'), 'nemo');
    assert.equal(resolveTextTokenizer(99, 'togetherai', 'mistralai/Mistral-7B-Instruct'), 'mistral');
    assert.throws(() => resolveTextTokenizer('best_match', 'togetherai', 'unknown'), error => error.status === 409);
    const fixture = textFixture(t);
    fixture.settings.power_user.tokenizer = 'gpt2';
    fixture.settings.textgenerationwebui_settings.banned_tokens = 'hello';
    fixture.settings.textgenerationwebui_settings.logit_bias = [{ text: 'world', value: -2 }];
    const payload = await buildTextProfileRequest({ owner: 'alice', directories: fixture.directories }, fixture.material(), [{ role: 'user', content: 'Hi' }], 73);
    assert.deepEqual(payload.logit_bias, [[995, -2], [31373, false]]);
});

test('saved service tiers override presets, honour Default and exclusions, and permit explicit request overrides', async t => {
    const fixture = textFixture(t);
    fixture.profile.api = 'openrouter-text';
    fixture.profile['secret-id'] = 'selected';
    fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify({ api_key_openrouter: [{ id: 'selected', value: 'private', active: true }] }));
    fixture.settings.textgenerationwebui_settings.openrouter_service_tier = 'priority';
    const build = (overridePayload = {}) => buildTextProfileRequest({ owner: 'alice', directories: fixture.directories }, fixture.material(), [{ role: 'user', content: 'Hi' }], 73, { overridePayload });
    fixture.profile['service-tier'] = 'flex';
    assert.equal((await build()).service_tier, 'flex');
    fixture.profile['service-tier'] = 'default';
    assert.ok(!(await build()).service_tier);
    fixture.profile.exclude = ['service-tier'];
    assert.ok(!(await build()).service_tier);
    assert.equal((await build({ service_tier: 'priority' })).service_tier, 'priority');
});

test('named tokenisation and generation reject unbound host credentials and keep selected-key rotation', async t => {
    const fixture = textFixture(t);
    const previous = process.env.SILLYTAVERN_REQUESTOVERRIDES;
    process.env.SILLYTAVERN_REQUESTOVERRIDES = JSON.stringify([{ hosts: ['127.0.0.1:5000'], headers: { Authorization: 'Bearer wrong-host', 'X-Unbound': 'private' } }]);
    t.after(() => { if (previous === undefined) delete process.env.SILLYTAVERN_REQUESTOVERRIDES; else process.env.SILLYTAVERN_REQUESTOVERRIDES = previous; });
    fixture.profile['secret-id'] = 'selected';
    const secrets = { api_key_llamacpp: [{ id: 'selected', value: 'chosen', active: false }, { id: 'active', value: 'wrong-active', active: true }] };
    const saveSecrets = () => fs.writeFileSync(path.join(fixture.root, 'secrets.json'), JSON.stringify(secrets));
    saveSecrets();
    fixture.settings.power_user.tokenizer = 'api_current';
    fixture.settings.textgenerationwebui_settings.banned_tokens = 'word';
    const binding = fixture.capture();
    const calls = [];
    const options = { context: { owner: 'alice', directories: fixture.directories }, binding, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73,
        fetch: async (url, request) => {
            calls.push(url);
            assert.equal(request.headers.Authorization, `Bearer ${secrets.api_key_llamacpp[0].value}`);
            assert.equal(request.headers['X-Unbound'], undefined);
            return new Response(JSON.stringify(url.endsWith('/tokenize') ? { tokens: [17] } : { content: 'Reply' }));
        } };
    await runChatProfile(options);
    secrets.api_key_llamacpp[0].value = 'rotated';
    saveSecrets();
    await runChatProfile(options);
    assert.equal(calls.length, 4);
    delete fixture.profile['secret-id'];
    await runChatProfile({ ...options, binding: fixture.capture(), fetch: async (url, request) => {
        assert.equal(request.headers.Authorization, undefined);
        assert.equal(request.headers['X-Unbound'], undefined);
        return new Response(JSON.stringify(url.endsWith('/tokenize') ? { tokens: [17] } : { content: 'Anonymous' }));
    } });
});

test('required stop macros fail before dispatch rather than silently disappearing', async t => {
    const fixture = textFixture(t);
    fixture.settings.power_user = { custom_stopping_strings: '["{{getvar::required}}"]', custom_stopping_strings_macro: true };
    await assert.rejects(runChatProfile({ context: { owner: 'alice', directories: fixture.directories }, binding: fixture.capture(),
        messages: [{ role: 'user', content: 'Hi' }], maxTokens: 73, fetch: () => assert.fail('No generation before required macros resolve') }), /captured chat macro context/);
});

test('saved chat profiles bind preset controls without storing credentials or following later settings', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-profile-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, openAI_Settings: path.join(root, 'presets') };
    fs.mkdirSync(directories.openAI_Settings);
    const settings = {
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'custom', model: 'bound-model', preset: 'chosen', proxy: 'private', 'request-reasoning': false }] } },
        proxies: [{ name: 'private', url: 'https://proxy.invalid', password: 'private-credential' }],
        oai_settings: { chat_completion_source: 'openai', temp_openai: 0.9, freq_pen_openai: 0, pres_pen_openai: 0, top_p_openai: 1, typical_p_openai: 1, show_thoughts: true, n: 1 },
    };
    const save = () => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    save();
    fs.writeFileSync(path.join(directories.openAI_Settings, 'chosen.json'), JSON.stringify({ temperature: 0.25, openai_max_tokens: 999, reasoning_effort: 'high' }));
    const binding = captureChatProfile(directories, 'saved');
    assert.deepEqual(Object.keys(binding).sort(), ['fingerprint', 'profileId']);
    assert.ok(!JSON.stringify(binding).includes('private-credential'));
    const generate = (controls, model, type, messages) => createChatGenerationParameters(controls, model, type, messages, {
        appendReasoning: value => value, userName: 'User', characterName: 'Character', getGroupNames: () => [],
        getLogitBias: async () => ({}), getStoppingStrings: () => [], getIncludeReasoning: () => Boolean(controls.show_thoughts),
        getReasoningEffort: () => controls.reasoning_effort, getVerbosity: () => undefined,
        canPerformToolCalls: () => false, registerTools: async () => {}, reverseProxySources: ['custom'], validateReverseProxy: async () => {},
        getAssistantPrefill: () => '', getServiceTier: async () => undefined, getSamplerMetadata: () => undefined,
    });
    const build = () => buildChatProfileRequest(directories, binding, [{ role: 'user', content: 'Hello' }], 120, generate);
    const request = await build();
    assert.equal(request.model, 'bound-model');
    assert.equal(request.temperature, 0.25);
    assert.equal(request.max_tokens, 120);
    assert.equal(request.include_reasoning, false);
    assert.equal(request.reasoning_effort, 'high');
    assert.equal(request.proxy_password, 'private-credential');
    const meower = await buildChatProfileRequest(directories, binding, [{ role: 'user', content: 'Meower' }], 120,
        () => assert.fail('Meower must omit the sampler preset'), { rawOptions: { includePreset: false } });
    assert.equal(meower.temperature, undefined);
    assert.equal(meower.reasoning_effort, 'high');
    assert.equal(meower.include_reasoning, false);
    settings.proxies[0].password = 'rotated-credential';
    settings.unrelatedSetting = true;
    save();
    assert.equal((await build()).proxy_password, 'rotated-credential');
    settings.oai_settings.temp_openai = 0.8;
    save();
    await assert.rejects(build, error => error.status === 409 && /changed/.test(error.message));
    delete settings.extension_settings.connectionManager.profiles[0].preset;
    save();
    const raw = await buildChatProfileRequest(directories, captureChatProfile(directories, 'saved'),
        [{ role: 'user', content: 'No preset' }], 70, () => assert.fail('A profile without a preset must not inherit preset samplers.'));
    assert.equal(raw.max_tokens, 70);
    assert.equal(raw.stream, false);
    assert.equal(raw.temperature, undefined);
    assert.equal(raw.stop, undefined);
    assert.equal(raw.__connectionProfileRequestFields, undefined);
    settings.extension_settings.connectionManager.profiles = [];
    save();
    await assert.rejects(build, error => error.status === 409 && /no longer exists/.test(error.message));
    assert.throws(() => captureChatProfile({ root: path.join(root, 'other-user') }, 'saved'), error => error.status === 409);
});

test('profiles resolve by saved name and carry prompt post-processing like the browser', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-profile-name-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, openAI_Settings: path.join(root, 'presets') };
    fs.mkdirSync(directories.openAI_Settings);
    const settings = {
        extension_settings: { connectionManager: { profiles: [
            { id: 'id-one', name: 'Named', api: 'custom', model: 'bound-model', 'prompt-post-processing': 'merge' },
            { id: 'id-two', name: 'Named', api: 'custom', model: 'other-model' },
        ] } },
        oai_settings: { chat_completion_source: 'openai', temp_openai: 1, top_p_openai: 1, n: 1 },
    };
    const save = () => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    save();

    assert.throws(() => captureChatProfile(directories, 'Named'), error => error.status === 409 && /More than one/.test(error.message));

    settings.extension_settings.connectionManager.profiles.pop();
    save();
    const binding = captureChatProfile(directories, 'Named');
    assert.equal(binding.profileId, 'id-one');
    const request = await buildChatProfileRequest(directories, binding, [{ role: 'user', content: 'Hi' }], 50, () => ({ stream: false, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 }));
    assert.equal(request.model, 'bound-model');
    assert.equal(request.custom_prompt_post_processing, 'merge');
});

for (const source of Object.values(textgen_types)) {
    test(`saved text profile ${source} uses its instruct preset and provider transport`, async t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-text-profile-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const directories = { root, textGen_Settings: path.join(root, 'presets'), instruct: path.join(root, 'instruct') };
        fs.mkdirSync(directories.textGen_Settings);
        fs.mkdirSync(directories.instruct);
        const keyed = ['mancer', 'togetherai', 'infermaticai', 'dreamgen', 'openrouter', 'featherless', 'huggingface'].includes(source);
        const profile = { id: 'saved-text', name: 'Saved text', mode: 'tc', api: source === 'openrouter' ? 'openrouter-text' : source,
            model: 'fixture-model', preset: 'chosen', instruct: 'chosen', 'api-url': 'http://127.0.0.1:5000', ...(keyed ? { 'secret-id': 'chosen-key' } : {}) };
        const settings = { max_context: 8192, textgenerationwebui_settings: { ...providerSettings, type: 'wrong-active-provider' },
            power_user: { custom_stopping_strings: '["END"]', tokenizer: 3 },
            extension_settings: { connectionManager: { selectedProfile: 'decoy', profiles: [profile] } } };
        const save = () => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
        save();
        fs.writeFileSync(path.join(directories.textGen_Settings, 'chosen.json'), JSON.stringify({ temp: 0.25, genamt: 999, max_length: 8192, logit_bias: [{ text: '[9]', value: -2 }], banned_tokens: '[4,5]', global_banned_tokens: '', send_banned_tokens: true }));
        fs.writeFileSync(path.join(directories.instruct, 'chosen.json'), JSON.stringify(instructSettings));
        fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({ [`api_key_${source}`]: [{ id: 'chosen-key', value: 'private-key', active: true }] }));
        const binding = captureChatProfile(directories, 'Saved text');
        assert.equal(binding.profileId, 'saved-text');
        assert.equal(binding.backend, 'text');
        assert.ok(!JSON.stringify(binding).includes('private-key'));
        const job = acceptJob(directories, { owner: 'alice', type: 'test.text-profile', submissionKey: source, intent: {} }).job;
        const controller = new AbortController();
        let calls = 0;
        const options = { context: { owner: 'alice', directories }, binding, messages: structuredClone(promptMessages), maxTokens: 73,
            userName: 'Sam', characterName: 'Ada', macroEnvironment: { evaluate: value => value.replaceAll('{{char}}', 'Ada').replaceAll('{{user}}', 'Sam') },
            jobContext: { directories, job, signal: controller.signal },
            fetch: async (url, request) => {
                calls++;
                assert.ok(url.startsWith('http://127.0.0.1:5000/'));
                const body = JSON.parse(request.body);
                assert.equal(body.prompt, expectedPrompts.scoped);
                const controls = source === 'ollama' ? body.options : body;
                for (const field of ['max_tokens', 'max_new_tokens', 'n_predict', 'num_predict']) {
                    if (controls[field] !== undefined) assert.equal(controls[field], 73);
                }
                assert.equal(request.headers.Authorization, keyed ? 'Bearer private-key' : undefined);
                return new Response(JSON.stringify({ choices: [{ text: 'Bound reply' }] }));
            } };
        assert.equal((await runChatProfile(options)).text, 'Bound reply');
        settings.extension_settings.connectionManager.profiles = [];
        save();
        assert.equal((await runChatProfile(options)).text, 'Bound reply');
        assert.equal(calls, 1);
        for (const entry of fs.readdirSync(path.join(root, 'jobs', 'artifacts'), { recursive: true })) {
            const filename = path.join(root, 'jobs', 'artifacts', entry);
            if (fs.statSync(filename).isFile()) assert.ok(!fs.readFileSync(filename, 'utf8').includes('private-key'));
        }
    });
}

test('server profile execution uses saved controls, caches completed calls and propagates job cancellation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-profile-execution-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, openAI_Settings: path.join(root, 'presets') };
    fs.mkdirSync(directories.openAI_Settings);
    fs.writeFileSync(path.join(directories.openAI_Settings, 'saved.json'), JSON.stringify({ temperature: 0.2 }));
    const settings = {
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', preset: 'saved', proxy: 'local' }] } },
        proxies: [{ name: 'local', url: 'https://provider.invalid/v1', password: 'private-token' }],
        oai_settings: { chat_completion_source: 'openai', temp_openai: 1, top_p_openai: 1, n: 1 },
        power_user: { custom_stopping_strings: '["END"]', collapse_newlines: true, trim_spaces: true },
    };
    const save = () => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    save();
    const binding = captureChatProfile(directories, 'saved');
    const job = acceptJob(directories, { owner: 'alice', type: 'test.profile', submissionKey: 'profile', intent: {} }).job;
    const controller = new AbortController();
    const jobContext = { owner: 'alice', directories, job, signal: controller.signal };
    let calls = 0;
    const options = {
        context: { owner: 'alice', directories }, binding, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 80, jobContext,
        fetch: async (url, request) => {
            calls++;
            assert.equal(url, 'https://provider.invalid/v1/chat/completions');
            const body = JSON.parse(request.body);
            assert.equal(body.temperature, 0.2);
            assert.equal(body.max_tokens, 80);
            assert.deepEqual(body.stop, ['END']);
            assert.equal(getJob(directories, job.id).recoverability, 'unknown-outcome');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Character: Saved\n\nreplyEN' } }] }));
        },
    };
    assert.equal((await runChatProfile(options)).text, 'Saved\nreply');
    settings.proxies[0].password = 'rotated-token';
    save();
    assert.equal((await runChatProfile(options)).text, 'Saved\nreply');
    assert.equal(calls, 1);
    assert.ok(!fs.readFileSync(path.join(root, 'jobs', 'index.json'), 'utf8').includes('private-token'));
    settings.power_user.collapse_newlines = false;
    save();
    assert.notEqual(captureChatProfile(directories, 'saved').fingerprint, binding.fingerprint);
    settings.power_user.collapse_newlines = true;
    save();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = runChatProfile({ ...options, messages: [{ role: 'user', content: 'Second call' }], fetch: async (_url, request) => {
        started();
        return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    } });
    await ready;
    controller.abort();
    await assert.rejects(pending, error => error.status === 499 || error.name === 'AbortError');
});

test('named chat preparation survives a stop before dispatch without expanding macros again', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-named-prepared-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, openAI_Settings: path.join(root, 'presets') };
    fs.mkdirSync(directories.openAI_Settings);
    fs.writeFileSync(path.join(directories.openAI_Settings, 'saved.json'), JSON.stringify({ temperature: 0.2 }));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o', preset: 'saved', proxy: 'local' }] } },
        proxies: [{ name: 'local', url: 'https://provider.invalid/v1', password: 'private-token' }],
        oai_settings: { chat_completion_source: 'openai', temp_openai: 1, top_p_openai: 1, n: 1 },
        power_user: { custom_stopping_strings: '["{{random::one::two}}"]', custom_stopping_strings_macro: true },
    }));
    const binding = captureChatProfile(directories, 'saved');
    const job = acceptJob(directories, { owner: 'alice', type: 'test.profile', submissionKey: 'prepared', intent: {} }).job;
    const options = { context: { owner: 'alice', directories }, binding, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 80,
        jobContext: { owner: 'alice', directories, job, signal: new AbortController().signal } };
    await assert.rejects(runChatProfile({ ...options, macroEnvironment: createMacroEnvironment(),
        onProviderStep: () => { throw new Error('Simulated exit before dispatch'); }, fetch: () => assert.fail('Not dispatched') }), /Simulated exit/);
    const result = await runChatProfile({ ...options, macroEnvironment: { evaluate: () => assert.fail('Saved stops must not reroll') },
        fetch: async (_url, request) => {
            assert.ok(['one', 'two'].includes(JSON.parse(request.body).stop[0]));
            assert.equal(request.headers.Authorization, 'Bearer private-token');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Known reply' } }] }));
        } });
    assert.equal(result.text, 'Known reply');
});

test('legacy prompt controls survive a pre-dispatch restart without repeating macros', async t => {
    const fixture = textFixture(t);
    fixture.settings._settingsRevision = 1;
    fixture.settings.main_api = 'kobold';
    fixture.settings.active_generation = { api: 'kobold' };
    fixture.settings.kai_settings = { api_server: 'http://127.0.0.1:6000/api', preset_settings: 'gui' };
    fixture.settings.power_user = { custom_stopping_strings: '["{{random::one::two}}"]', custom_stopping_strings_macro: true };
    fixture.save();
    const binding = captureGenerationBinding(fixture.directories, { kind: 'active' }, { settingsRevision: 1 });
    const context = { owner: 'alice', directories: fixture.directories };
    const job = acceptJob(fixture.directories, { owner: 'alice', type: 'test.profile', submissionKey: 'legacy-prepared', intent: {} }).job;
    const options = { context, binding, messages: [], preparedText: 'Saved prompt', maxTokens: 30,
        jobContext: { ...context, job, signal: new AbortController().signal } };
    await assert.rejects(runChatProfile({ ...options, macroEnvironment: createMacroEnvironment(),
        onProviderStep: () => { throw Error('Simulated exit'); }, fetch: () => assert.fail('Not dispatched') }), /Simulated exit/);
    assert.equal((await runChatProfile({ ...options, macroEnvironment: { evaluate: () => assert.fail('Must reuse the saved controls') },
        fetch: async (_url, request) => {
            assert.equal(JSON.parse(request.body).prompt, 'Saved prompt');
            return new Response(JSON.stringify({ results: [{ text: 'Recovered' }] }));
        } })).text, 'Recovered');
});

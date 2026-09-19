import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { createChatGenerationParameters } from '../public/scripts/chat-provider-parameters.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { captureChatProfile, buildChatProfileRequest } = await import('../src/generation/profiles.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { acceptJob, getJob } = await import('../src/jobs/store.js');

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
    const request = await buildChatProfileRequest(directories, binding, [{ role: 'user', content: 'Hi' }], 50, () => ({ stream: false, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 }));
    assert.equal(request.model, 'bound-model');
    assert.equal(request.custom_prompt_post_processing, 'merge');
});

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
        power_user: { custom_stopping_strings: '["END"]' },
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
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Saved reply' } }] }));
        },
    };
    assert.equal((await runChatProfile(options)).text, 'Saved reply');
    settings.proxies[0].password = 'rotated-token';
    save();
    assert.equal((await runChatProfile(options)).text, 'Saved reply');
    assert.equal(calls, 1);
    assert.ok(!fs.readFileSync(path.join(root, 'jobs', 'index.json'), 'utf8').includes('private-token'));
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

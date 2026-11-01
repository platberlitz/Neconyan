import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { createChatGenerationParameters } from '../public/scripts/chat-provider-parameters.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';
import { getNativeReasoningRoute } from '../public/scripts/chat-reasoning-capabilities.js';
import { extractMessageFromData, extractProviderReasoning } from '../public/scripts/generation-format.js';

const nodeFetchMock = jest.fn(() => { throw new Error('Unexpected unmocked provider request'); });
await jest.unstable_mockModule('node-fetch', () => ({ default: nodeFetchMock }));

describe('Chat Completion sampler wire filtering', () => {
    let server;
    let baseUrl;
    let capturedBody;
    let userRoot;
    let handleChatCompletionsGenerate;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sampler-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const backend = await import('../src/endpoints/backends/chat-completions.js');
        const { router } = backend;
        handleChatCompletionsGenerate = backend.handleChatCompletionsGenerate;
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sampler-user-'));
        tempDirs.push(userRoot);
        const secrets = new SecretManager({ root: userRoot, backups: userRoot });
        for (const key of [SECRET_KEYS.OPENAI, SECRET_KEYS.OPENROUTER, SECRET_KEYS.NANOGPT, SECRET_KEYS.COHERE, SECRET_KEYS.WORKERS_AI, SECRET_KEYS.LINKAPI,
            SECRET_KEYS.MAKERSUITE, SECRET_KEYS.VERTEXAI, SECRET_KEYS.DEEPSEEK, SECRET_KEYS.MOONSHOT, SECRET_KEYS.ZAI,
            SECRET_KEYS.MINIMAX, SECRET_KEYS.MISTRALAI, SECRET_KEYS.GROQ, SECRET_KEYS.AIMLAPI, SECRET_KEYS.FIREWORKS]) {
            secrets.writeSecret(key, `${key}-test-key`);
        }

        secrets.writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, JSON.stringify({ project_id: 'fixture-project', client_email: 'fixture@example.invalid', private_key: 'fixture-not-a-key' }));

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
            next();
        });
        app.use('/api/backends/chat-completions', router);
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        capturedBody = undefined;
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            const result = String(url).includes(':generateContent')
                ? { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }
                : String(url).endsWith('/responses')
                    ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }
                    : { choices: [{ message: { content: 'ok' } }] };
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
        for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    });

    function request(source, overrides = {}) {
        return fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: source,
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: false,
                max_tokens: 32,
                temperature: 1.4,
                top_p: 0.8,
                frequency_penalty: 0.4,
                presence_penalty: 0.3,
                top_k: 40,
                min_p: 0.2,
                top_a: 0.1,
                typical_p: 0.6,
                repetition_penalty: 1.4,
                seed: 9,
                ...overrides,
            }),
        });
    }

    test('OpenRouter keeps only its conservative fields without exact model metadata', async () => {
        expect((await request(CHAT_COMPLETION_SOURCES.OPENROUTER)).status).toBe(200);
        expect(capturedBody).toEqual(expect.objectContaining({ temperature: 1.4, top_p: 0.8, frequency_penalty: 0.4, presence_penalty: 0.3, seed: 9 }));
        for (const key of ['top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty', 'model_sampler_metadata']) {
            expect(capturedBody).not.toHaveProperty(key);
        }
    });

    test('OpenRouter rejects an unsupported saved effort without dispatch, then sends the deliberate supported value', async () => {
        const model_sampler_metadata = { source: 'openrouter', model: 'test-model', reasoning: { supported_efforts: ['high', 'max'] } };
        const invalid = await request('openrouter', { reasoning_effort: 'low', model_sampler_metadata });
        expect(invalid.status).toBe(400);
        expect((await invalid.json()).error).toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT', supported_reasoning_efforts: ['high', 'max'] });
        expect(nodeFetchMock).not.toHaveBeenCalled();
        const valid = await request('openrouter', { reasoning_effort: 'high', model_sampler_metadata,
            provider: ['chosen-provider'], allow_fallbacks: false, include_reasoning: false });
        expect(valid.status).toBe(200);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        expect(String(nodeFetchMock.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(capturedBody.reasoning).toEqual(expect.objectContaining({ effort: 'high', exclude: true }));
        expect(capturedBody.provider).toEqual(expect.objectContaining({ order: ['chosen-provider'], allow_fallbacks: false }));
        expect(capturedBody).not.toHaveProperty('model_sampler_metadata');
    });

    test('OpenRouter Claude-family requests retain the chosen effort from the shared builder through the imported handler', async () => {
        const model = 'anthropic/claude-sonnet-5';
        const build = async (effort, reasoning) => {
            const metadata = { source: 'openrouter', model, reasoning };
            const settings = { chat_completion_source: 'openrouter', reasoning_effort: effort, temp_openai: 1,
                top_p_openai: 1, freq_pen_openai: 0, pres_pen_openai: 0, typical_p_openai: 1, n: 1, openai_max_tokens: 32 };
            const { generate_data: data } = await createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
                appendReasoning: messages => messages, userName: 'User', characterName: 'Character', getGroupNames: () => [],
                getLogitBias: async () => ({}), getStoppingStrings: () => [], getIncludeReasoning: () => false,
                getReasoningEffort: snapshot => resolveChatReasoningEffort(settings, model, undefined, snapshot),
                getVerbosity: () => undefined, canPerformToolCalls: () => false, registerTools: async () => {},
                reverseProxySources: [], validateReverseProxy: () => {}, getAssistantPrefill: () => '',
                getServiceTier: async () => undefined, getSamplerMetadata: () => metadata,
            });
            return data;
        };
        const supported = await request('openrouter', await build('high', { supported_efforts: ['high', 'max'], mandatory: true }));
        expect(supported.status).toBe(200);
        expect(capturedBody.reasoning).toEqual(expect.objectContaining({ effort: 'high', exclude: true }));
        expect(capturedBody).not.toHaveProperty('temperature');
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        nodeFetchMock.mockClear();
        for (const [effort, reasoning] of [['low', { supported_efforts: ['high', 'max'] }], ['none', { supported_efforts: ['future'], mandatory: true }]]) {
            const rejected = await request('openrouter', await build(effort, reasoning));
            expect(rejected.status).toBe(400);
            expect((await rejected.json()).error.code).toBe('UNSUPPORTED_REASONING_EFFORT');
        }
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test.each([['min', 'minimal'], ['MINIMAL', 'minimal'], ['none', 'none'], ['auto', undefined], ['AUTO', undefined]])(
        'OpenRouter covered raw effort %s reaches the wire as %s', async (effort, wire) => {
            const model_sampler_metadata = { source: 'openrouter', model: 'test-model', reasoning: { supported_efforts: ['minimal', 'high', 'none'] } };
            const response = await request('openrouter', { reasoning_effort: effort, model_sampler_metadata });
            expect(response.status).toBe(200);
            expect(capturedBody.reasoning.effort).toBe(wire);
            expect(capturedBody).not.toHaveProperty('model_sampler_metadata');
        },
    );

    test('OpenRouter rejects raw Minimum when not declared and honours mandatory reasoning with unknown efforts', async () => {
        for (const reasoning of [{ supported_efforts: ['high'] }, { supported_efforts: ['future'], mandatory: true }]) {
            const response = await request('openrouter', { reasoning_effort: reasoning.mandatory ? 'none' : 'min',
                model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning } });
            expect(response.status).toBe(400);
            expect((await response.json()).error.code).toBe('UNSUPPORTED_REASONING_EFFORT');
        }
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test('OpenRouter rejects explicit no-selector overrides but dispatches omission', async () => {
        const model_sampler_metadata = { source: 'openrouter', model: 'test-model', reasoning: { mandatory: true } };
        const rejected = await request('openrouter', { reasoning_effort: 'high', model_sampler_metadata });
        expect(rejected.status).toBe(400);
        expect((await rejected.json()).error.message).toMatch(/Remove the effort override or choose another model/);
        expect(nodeFetchMock).not.toHaveBeenCalled();
        const accepted = await request('openrouter', { model_sampler_metadata, include_reasoning: false });
        expect(accepted.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ exclude: true });
    });

    test('OpenRouter stale and absent metadata retain legacy raw request compatibility', async () => {
        for (const model_sampler_metadata of [undefined, { source: 'openrouter', model: 'test-model:free', reasoning: { supported_efforts: ['high'] } }]) {
            const response = await request('openrouter', { reasoning_effort: 'low', model_sampler_metadata });
            expect(response.status).toBe(200);
            expect(capturedBody.reasoning.effort).toBe('low');
            expect(capturedBody).not.toHaveProperty('model_sampler_metadata');
        }
    });

    async function buildNative(source, model, effort, routeOverrides = {}) {
        const settings = { chat_completion_source: source, reasoning_effort: effort, temp_openai: 1, top_p_openai: 1,
            freq_pen_openai: 0, pres_pen_openai: 0, typical_p_openai: 1, n: 1, openai_max_tokens: 32,
            vertexai_auth_mode: 'express', zai_endpoint: 'common', minimax_endpoint: 'global', ...routeOverrides };
        const route = getNativeReasoningRoute(settings, { googleApiVersion: 'v1beta' });
        const { generate_data } = await createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
            appendReasoning: messages => messages, userName: 'User', characterName: 'Character', getGroupNames: () => [],
            getLogitBias: async () => ({}), getStoppingStrings: () => [], getIncludeReasoning: () => false,
            getReasoningEffort: metadata => resolveChatReasoningEffort(settings, model, undefined, metadata, route),
            getVerbosity: () => undefined, canPerformToolCalls: () => false, registerTools: async () => {},
            reverseProxySources: ['openai', 'openai_responses', 'makersuite', 'vertexai', 'deepseek', 'moonshot', 'zai', 'mistralai'],
            validateReverseProxy: () => {}, getAssistantPrefill: () => '', getServiceTier: async () => undefined, getSamplerMetadata: () => undefined,
        });
        return generate_data;
    }

    test.each([
        ['openai', 'gpt-5.1', 'none', 'reasoning_effort', 'none'],
        ['openai_responses', 'gpt-5.1', 'none', 'reasoning.effort', 'none'],
        ['makersuite', 'gemini-3.8-flash', 'low', 'generationConfig.thinkingConfig.thinkingLevel', 'low'],
        ['vertexai', 'gemini-3-flash-preview', 'min', 'generationConfig.thinkingConfig.thinkingLevel', 'minimal'],
        ['deepseek', 'deepseek-v4-pro', 'none', 'reasoning_effort', 'none'],
        ['moonshot', 'kimi-k3', 'low', 'reasoning_effort', 'low'],
        ['zai', 'glm-5.3', 'high', 'reasoning_effort', 'high'],
        ['minimax', 'MiniMax-M3.1-Flash', 'high', 'reasoning_effort', 'high'],
        ['mistralai', 'mistral-small-2603', 'none', 'reasoning_effort', 'none'],
        ['groq', 'openai/gpt-oss-20b', 'medium', 'reasoning_effort', 'medium'],
        ['aimlapi', 'openai/gpt-oss-20b', 'low', 'reasoning_effort', 'low'],
        ['fireworks', 'accounts/fireworks/models/gpt-oss-20b', 'high', 'reasoning_effort', 'high'],
    ])('%s %s carries deliberate %s through the real builder and handler', async (source, model, effort, field, expected) => {
        const response = await request(source, await buildNative(source, model, effort));
        expect(response.status).toBe(200);
        expect(capturedBody).toHaveProperty(field, expected);
        expect(capturedBody).not.toHaveProperty('model_sampler_metadata');
        const thinkingTypes = { zai: 'enabled' };
        expect(capturedBody.thinking?.type).toBe(thinkingTypes[source]);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        const hosts = { openai: 'api.openai.com', openai_responses: 'api.openai.com', makersuite: 'generativelanguage.googleapis.com',
            vertexai: 'us-central1-aiplatform.googleapis.com', deepseek: 'api.deepseek.com', moonshot: 'api.moonshot.ai',
            zai: 'api.z.ai', minimax: 'api.minimax.io', mistralai: 'api.mistral.ai', groq: 'api.groq.com',
            aimlapi: 'api.aimlapi.com', fireworks: 'api.fireworks.ai' };
        const url = new URL(String(nodeFetchMock.mock.calls[0][0]));
        expect(url.hostname).toBe(hosts[source]);
        const paths = { openai: '/v1/chat/completions', openai_responses: '/v1/responses',
            makersuite: '/v1beta/models/gemini-3.8-flash:generateContent',
            vertexai: '/v1/publishers/google/models/gemini-3-flash-preview:generateContent',
            deepseek: '/beta/chat/completions', moonshot: '/v1/chat/completions', zai: '/api/paas/v4/chat/completions',
            minimax: '/v1/chat/completions', mistralai: '/v1/chat/completions', groq: '/openai/v1/chat/completions',
            aimlapi: '/v1/chat/completions', fireworks: '/inference/v1/chat/completions' };
        expect(url.pathname).toBe(paths[source]);
    });

    test.each([
        ['openai', 'gpt-5', 'none'], ['openai_responses', 'gpt-6-astra', 'none'],
        ['makersuite', 'gemini-3.8-flash', 'none'], ['vertexai', 'gemini-3-flash-preview', 'max'],
        ['deepseek', 'deepseek-v4-pro', 'medium'], ['moonshot', 'kimi-k3', 'none'], ['zai', 'glm-5.3', 'medium'],
        ['minimax', 'MiniMax-M3.1-Flash', 'none'], ['mistralai', 'mistral-small-2603', 'low'],
        ['groq', 'openai/gpt-oss-20b', 'max'], ['aimlapi', 'openai/gpt-oss-20b', 'none'],
        ['fireworks', 'accounts/fireworks/models/gpt-oss-20b', 'max'],
    ])('%s %s rejects final unsupported %s before inference', async (source, model, effort) => {
        const response = await request(source, await buildNative(source, model, effort));
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('UNSUPPORTED_REASONING_EFFORT');
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test('DeepSeek None strips outgoing reasoning from a clone and enables non-thinking log probabilities', async () => {
        const messages = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '', reasoning_content: 'Private thought',
            tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'probe', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-fixture', content: 'Tool result' }];
        const tools = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
        const original = structuredClone(messages);
        const req = Object.assign(new EventEmitter(), { user: { directories: { root: userRoot, backups: userRoot } },
            body: { chat_completion_source: 'deepseek', model: 'deepseek-v4-pro', messages, tools, stream: false,
                max_tokens: 32, reasoning_effort: 'none', logprobs: 3 } });
        const res = Object.assign(new EventEmitter(), { status() { return this; }, send: jest.fn(), json: jest.fn() });
        await handleChatCompletionsGenerate(req, res);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        expect(capturedBody.reasoning_effort).toBe('none');
        expect(capturedBody.logprobs).toBe(true);
        expect(capturedBody.top_logprobs).toBe(3);
        expect(capturedBody.messages.every(message => !Object.hasOwn(message, 'reasoning_content'))).toBe(true);
        expect(capturedBody.messages.find(message => message.tool_calls)?.tool_calls[0].id).toBe('call-fixture');
        expect(capturedBody.messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'call-fixture', content: 'Tool result' });
        expect(messages).toEqual(original);
    });

    test('DeepSeek native exact guard and legacy proxy and unlisted models keep their own effort behaviour', async () => {
        const invalid = await request('deepseek', { model: 'deepseek-v4-pro', reasoning_effort: 'min' });
        expect(invalid.status).toBe(400);
        expect((await invalid.json()).error.code).toBe('UNSUPPORTED_REASONING_EFFORT');
        expect(nodeFetchMock).not.toHaveBeenCalled();
        for (const fields of [{ model: 'deepseek-v4-flash' },
            { model: 'deepseek-v4-pro', reverse_proxy: 'https://fixture.invalid/v1', proxy_password: 'fixture' }]) {
            expect((await request('deepseek', { ...fields, reasoning_effort: 'min' })).status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe('minimal');
            expect((await request('deepseek', { ...fields, reasoning_effort: 'none' })).status).toBe(200);
            expect(capturedBody.reasoning_effort).toBeUndefined();
        }
        expect((await request('deepseek', { model: 'deepseek-chat', reasoning_effort: 'high' })).status).toBe(200);
        expect(capturedBody.reasoning_effort).toBeUndefined();
    });

    test('DeepSeek enabled and proxied None preserve their existing thinking behaviour', async () => {
        const messages = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '',
            tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'probe', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-fixture', content: 'done' }];
        const tools = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
        expect((await request('deepseek', { model: 'deepseek-v4-pro', reasoning_effort: 'high', messages, tools, logprobs: 3 })).status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('high');
        expect(capturedBody.logprobs).toBeUndefined();
        expect(capturedBody.messages.find(message => message.tool_calls)?.reasoning_content).toBe('');
        nodeFetchMock.mockClear();
        expect((await request('deepseek', { model: 'deepseek-v4-pro', messages, tools, logprobs: 3 })).status).toBe(200);
        expect(capturedBody.reasoning_effort).toBeUndefined();
        expect(capturedBody.logprobs).toBeUndefined();
        expect(capturedBody.messages.find(message => message.tool_calls)?.reasoning_content).toBe('');
        nodeFetchMock.mockClear();
        expect((await request('deepseek', { model: 'deepseek-v4-pro', reasoning_effort: 'none', messages, tools, logprobs: 3,
            reverse_proxy: 'https://fixture.invalid/v1', proxy_password: 'fixture' })).status).toBe(200);
        expect(new URL(String(nodeFetchMock.mock.calls[0][0])).hostname).toBe('fixture.invalid');
        expect(capturedBody.reasoning_effort).toBeUndefined();
        expect(capturedBody.logprobs).toBeUndefined();
        expect(capturedBody.messages.find(message => message.tool_calls)?.reasoning_content).toBe('');
    });

    test.each([['min', 'minimal'], ['MINIMAL', 'minimal'], ['auto', undefined], ['AUTO', undefined]])(
        'native OpenAI raw %s is forwarded as %s after validation', async (effort, expected) => {
            expect((await request('openai', { model: 'gpt-5', reasoning_effort: effort })).status).toBe(200);
            expect(capturedBody.reasoning_effort).toBe(expected);
            expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        },
    );

    test('Groq accepts its documented opaque default only with exact spelling', async () => {
        expect((await request('groq', { model: 'qwen/qwen3.8-27b', reasoning_effort: 'default' })).status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('default');
        nodeFetchMock.mockClear();
        expect((await request('groq', { model: 'qwen/qwen3.8-27b', reasoning_effort: 'Default' })).status).toBe(400);
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test('a missing browser Google marker still preserves None for authoritative rejection', async () => {
        const settings = { chat_completion_source: 'makersuite', reasoning_effort: 'none' };
        const route = getNativeReasoningRoute(settings);
        expect(resolveChatReasoningEffort(settings, 'gemini-3.8-flash', undefined, undefined, route)).toBe('none');
        expect((await request('makersuite', { model: 'gemini-3.8-flash', reasoning_effort: 'none' })).status).toBe(400);
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test.each([
        ['minimax', 'MiniMax-M3.1-Flash', { minimax_endpoint: 'cn' }, 'api.minimaxi.com', '/v1/chat/completions', undefined],
        ['zai', 'glm-5.3', { zai_endpoint: 'coding' }, 'api.z.ai', '/api/coding/paas/v4/chat/completions', 'low'],
        ['mistralai', 'mistral-small-2603', { reverse_proxy: 'https://fixture.invalid/v1', proxy_password: 'fixture' }, 'fixture.invalid', '/v1/chat/completions', undefined],
    ])('%s endpoint or proxy keeps legacy behaviour outside the native contract', async (source, model, fields, host, expectedPath, expectedEffort) => {
        const response = await request(source, { model, reasoning_effort: 'low', ...fields });
        expect(response.status).toBe(200);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        const url = new URL(String(nodeFetchMock.mock.calls[0][0]));
        expect(url.hostname).toBe(host);
        expect(capturedBody.reasoning_effort).toBe(expectedEffort);
        expect(url.pathname).toBe(expectedPath);
    });

    test('Mistral non-stream responses keep thinking separate from the visible answer', async () => {
        for (const [effort, content, expectedReasoning] of [
            ['high', [{ type: 'thinking', thinking: [{ type: 'text', text: 'Fixture thought' }] }, { type: 'text', text: 'Fixture answer' }], 'Fixture thought'],
            ['none', 'Fixture answer', ''],
        ]) {
            nodeFetchMock.mockImplementation(async (_url, options) => {
                capturedBody = JSON.parse(options.body);
                return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
            });
            const response = await request('mistralai', await buildNative('mistralai', 'mistral-small-2603', effort));
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(capturedBody.reasoning_effort).toBe(effort);
            expect(extractMessageFromData(data, 'openai', { excludeReasoning: true })).toBe('Fixture answer');
            expect(extractProviderReasoning(data, { mainApi: 'openai', chatCompletionSource: 'mistralai' })).toBe(expectedReasoning);
        }
        expect(nodeFetchMock).toHaveBeenCalledTimes(2);
    });

    test('unrelated saved proxy values do not alter the native Groq route', async () => {
        const data = await buildNative('groq', 'openai/gpt-oss-20b', 'high', {
            reverse_proxy: 'https://fixture.invalid/v1', custom_url: 'https://fixture.invalid/custom',
        });
        const response = await request('groq', data);
        expect(response.status).toBe(200);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        expect(String(nodeFetchMock.mock.calls[0][0])).toBe('https://api.groq.com/openai/v1/chat/completions');
        expect(capturedBody.reasoning_effort).toBe('high');
    });

    test('Vertex full auth uses its native v1 route and validates before authentication', async () => {
        const sign = jest.spyOn(crypto, 'createSign').mockReturnValue({ update() {}, sign: () => 'fixture-signature' });
        try {
            nodeFetchMock.mockImplementation(async (url, options) => {
                if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'fixture-token' }));
                capturedBody = JSON.parse(options.body);
                return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
            });
            const data = { ...await buildNative('vertexai', 'gemini-3-flash-preview', 'high'), vertexai_auth_mode: 'full' };
            expect((await request('vertexai', data)).status).toBe(200);
            expect(nodeFetchMock).toHaveBeenCalledTimes(2);
            expect(String(nodeFetchMock.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
            expect(String(nodeFetchMock.mock.calls[1][0])).toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-central1/publishers/google/models/gemini-3-flash-preview:generateContent');
            expect(capturedBody.generationConfig.thinkingConfig.thinkingLevel).toBe('high');
            nodeFetchMock.mockClear();
            expect((await request('vertexai', { ...data, reasoning_effort: 'max' })).status).toBe(400);
            expect(nodeFetchMock).not.toHaveBeenCalled();
        } finally {
            sign.mockRestore();
        }
    });

    test('Google status reports the server version only for the direct route', async () => {
        nodeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        ] })));
        const status = fields => fetch(`${baseUrl}/api/backends/chat-completions/status`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_completion_source: 'makersuite', ...fields }),
        });
        const direct = await (await status({})).json();
        expect(direct.reasoning_context).toEqual({ source: 'makersuite', apiVersion: 'v1beta' });
        expect(String(nodeFetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com/v1beta/models');
        const proxy = await (await status({ reverse_proxy: 'https://fixture.invalid', proxy_password: 'fixture' })).json();
        expect(proxy.reasoning_context).toBeUndefined();
        expect(String(nodeFetchMock.mock.calls[1][0])).toContain('fixture.invalid/v1beta/models');
        expect(nodeFetchMock).toHaveBeenCalledTimes(2);
    });

    test('Google uses authoritative server version for final validation, not a client marker', async () => {
        const oldVersion = process.env.SILLYTAVERN_GEMINI_APIVERSION;
        try {
            process.env.SILLYTAVERN_GEMINI_APIVERSION = 'v1';
            const data = await buildNative('makersuite', 'gemini-3.8-flash', 'none');
            expect((await request('makersuite', data)).status).toBe(200);
            expect(capturedBody.generationConfig?.thinkingConfig?.thinkingLevel).toBeUndefined();
            nodeFetchMock.mockClear();
            process.env.SILLYTAVERN_GEMINI_APIVERSION = 'v1beta';
            expect((await request('makersuite', data)).status).toBe(400);
            expect(nodeFetchMock).not.toHaveBeenCalled();
        } finally {
            if (oldVersion === undefined) delete process.env.SILLYTAVERN_GEMINI_APIVERSION;
            else process.env.SILLYTAVERN_GEMINI_APIVERSION = oldVersion;
        }
    });

    test('NanoGPT honors a matching GPT OSS fingerprint while keeping seed explicit', async () => {
        expect((await request(CHAT_COMPLETION_SOURCES.NANOGPT, {
            model: 'openai/gpt-oss-20b',
            model_sampler_metadata: {
                source: 'nanogpt',
                model: 'openai/gpt-oss-20b',
                supported_parameters: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty'],
            },
        })).status).toBe(200);
        expect(capturedBody.typical_p).toBe(0.6);
        expect(capturedBody.top_k).toBe(40);
        expect(capturedBody.seed).toBeUndefined();
        expect(capturedBody.model_sampler_metadata).toBeUndefined();
    });

    test('NanoGPT proprietary models do not inherit open-weight extras', async () => {
        expect((await request(CHAT_COMPLETION_SOURCES.NANOGPT, {
            model: 'openai/gpt-4.1',
            model_sampler_metadata: {
                source: 'nanogpt',
                model: 'openai/gpt-4.1',
                open_weights: true,
                supported_parameters: ['temperature', 'top_p', 'top_k', 'typical_p', 'seed'],
            },
        })).status).toBe(200);
        expect(capturedBody).toEqual(expect.objectContaining({ temperature: 1.4, top_p: 0.8 }));
        expect(capturedBody.seed).toBe(9);
        for (const key of ['top_k', 'typical_p']) expect(capturedBody).not.toHaveProperty(key);
    });

    test.each(['custom', 'openrouter', 'nanogpt', 'linkapi'])('%s consumes exact metadata before stripping it from the upstream body', async source => {
        expect((await request(source, {
            custom_url: 'http://127.0.0.1:9/v1',
            model_sampler_metadata: { source, model: 'test-model', supported_parameters: ['top_k'] },
        })).status).toBe(200);
        expect(capturedBody.top_k).toBe(40);
        for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'min_p', 'typical_p', 'seed', 'model_sampler_metadata']) {
            expect(capturedBody).not.toHaveProperty(key);
        }
    });

    test('matching Custom Typical P and explicit NanoGPT seed reach the wire', async () => {
        expect((await request('custom', {
            custom_url: 'http://127.0.0.1:9/v1',
            model_sampler_metadata: { source: 'custom', model: 'test-model', supported_parameters: ['typical_p'] },
        })).status).toBe(200);
        expect(capturedBody.typical_p).toBe(0.6);
        expect((await request('nanogpt', {
            model_sampler_metadata: { source: 'nanogpt', model: 'test-model', supported_parameters: ['seed'] },
        })).status).toBe(200);
        expect(capturedBody.seed).toBe(9);
    });

    test('Custom YAML remains an explicit advanced escape hatch after UI-owned filtering', async () => {
        expect((await request(CHAT_COMPLETION_SOURCES.CUSTOM, {
            custom_url: 'http://127.0.0.1:9/v1',
            custom_include_body: 'typical_p: 0.35\nmin_p: 0.25',
        })).status).toBe(200);
        expect(capturedBody.typical_p).toBe(0.35);
        expect(capturedBody.min_p).toBe(0.25);
    });

    test('Responses removes Chat Completions-only penalties, seed, and extended samplers', async () => {
        expect((await request(CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES, { model: 'gpt-4o' })).status).toBe(200);
        expect(capturedBody).toEqual(expect.objectContaining({ temperature: 1.4, top_p: 0.8 }));
        for (const key of ['frequency_penalty', 'presence_penalty', 'top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty', 'seed']) {
            expect(capturedBody).not.toHaveProperty(key);
        }
    });

    test('Cohere clamps its outbound ranges without changing the request contract', async () => {
        expect((await request(CHAT_COMPLETION_SOURCES.COHERE, {
            top_p: 0,
            frequency_penalty: 4,
            presence_penalty: -2,
        })).status).toBe(200);
        expect(capturedBody.p).toBe(0.01);
        expect(capturedBody.frequency_penalty).toBe(1);
        expect(capturedBody.presence_penalty).toBe(0);
    });
});

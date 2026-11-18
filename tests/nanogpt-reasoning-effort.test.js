import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

const { default: actualNodeFetch, Response: FetchResponse } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

describe('outgoing chat completions', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    let capturedHeaders;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-effort-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { router: textCompletionsRouter } = await import('../src/endpoints/backends/text-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-effort-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.NANOGPT, 'nanogpt-test-key');
        secretManager.writeSecret(SECRET_KEYS.OPENROUTER, 'openrouter-test-key');
        secretManager.writeSecret(SECRET_KEYS.PERPLEXITY, 'perplexity-test-key');
        secretManager.writeSecret(SECRET_KEYS.POLLINATIONS, 'pollinations-test-key');
        secretManager.writeSecret(SECRET_KEYS.COMETAPI, 'cometapi-test-key');
        secretManager.writeSecret(SECRET_KEYS.OPENAI, 'openai-test-key');
        secretManager.writeSecret(SECRET_KEYS.MAKERSUITE, 'google-test-key');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
            next();
        });
        app.use('/api/backends/chat-completions', chatCompletionsRouter);
        app.use('/api/backends/text-completions', textCompletionsRouter);

        await new Promise((resolve) => {
            appServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = appServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(() => {
        capturedBody = undefined;
        capturedHeaders = undefined;
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            capturedHeaders = options?.headers;
            return new Response(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
    });

    afterAll(async () => {
        if (appServer) {
            await new Promise((resolve, reject) => {
                appServer.close((error) => error ? reject(error) : resolve());
            });
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

    function makeRequest(source, overrides = {}) {
        return fetch(`${baseUrl}/api/backends/${source === 'openrouter-text' ? 'text' : 'chat'}-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: source,
                model: 'test-model',
                stream: false,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Question' }],
                ...(source === 'openrouter-text' ? { api_type: 'openrouter', api_server: 'https://openrouter.ai/api', prompt: 'Question' } : {}),
                ...overrides,
            }),
        });
    }

    const invalidNoneRoutes = [
        ['OpenAI native', 'openai', { model: 'gpt-5' }],
        ['OpenAI Responses native', 'openai_responses', { model: 'gpt-5' }],
        ['Gemini 3 native', 'makersuite', { model: 'gemini-3.8-flash' }],
        ['Nano exact list', 'nanogpt', { model: 'vendor/plain', model_sampler_metadata: { source: 'nanogpt', model: 'vendor/plain', reasoning_efforts: ['high'] } }],
        ['Nano thinking without catalogue', 'nanogpt', { model: 'vendor/model:free:thinking' }],
        ['OpenRouter list', 'openrouter', { model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning: { supported_efforts: ['high'] } } }],
        ['OpenRouter mandatory unknown list', 'openrouter', { model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning: { mandatory: true, supported_efforts: [] } } }],
        ['OpenRouter no selector', 'openrouter', { model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning: {} } }],
    ];

    describe.each([false, true])('None wire suppression with stream=%s', stream => {
        test.each(invalidNoneRoutes)('%s equals the absent-effort provider body', async (_name, source, overrides) => {
            nodeFetchMock.mockImplementation(async (_url, options) => {
                capturedBody = JSON.parse(options.body);
                return stream
                    ? new FetchResponse('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
                    : new FetchResponse(JSON.stringify({ choices: [{ message: { content: 'ok' } }], output: [],
                        candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }] }),
                    { headers: { 'Content-Type': 'application/json' } });
            });
            const controls = { ...overrides, stream, include_reasoning: true, temperature: 0.7 };
            const absent = await makeRequest(source, controls);
            expect(absent.status).toBe(200);
            await absent.text();
            expect(nodeFetchMock).toHaveBeenCalledTimes(1);
            const absentBody = structuredClone(capturedBody);
            const inputField = source === 'makersuite' ? 'contents' : source === 'openai_responses' ? 'input' : 'messages';
            expect(Array.isArray(absentBody[inputField])).toBe(true);
            expect(absentBody[inputField].length).toBeGreaterThan(0);
            expect(absentBody.model).toBe(source === 'makersuite' ? undefined : overrides.model ?? 'test-model');
            const suppressed = await makeRequest(source, { ...controls, reasoning_effort: ' None ' });
            expect(suppressed.status).toBe(200);
            await suppressed.text();
            expect(nodeFetchMock).toHaveBeenCalledTimes(2);
            expect(capturedBody).toEqual(absentBody);
            expect(capturedBody).not.toHaveProperty('reasoning_effort');
            expect(capturedBody.reasoning ?? {}).not.toHaveProperty('effort');
            expect(capturedBody.reasoning ?? {}).not.toHaveProperty('enabled', false);
            expect(capturedBody.reasoning?.exclude).toBe(source === 'openrouter' ? false : undefined);
        });
    });

    test.each([
        ['openai', { model: 'gpt-5.1' }, ['reasoning_effort']],
        ['nanogpt', { model_sampler_metadata: { source: 'nanogpt', model: 'test-model', reasoning_efforts: ['none', 'high'] } }, ['reasoning', 'effort']],
        ['openrouter', { model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning: { supported_efforts: ['none', 'high'] } } }, ['reasoning', 'effort']],
    ])('%s still forwards None on an exact allowed contract', async (source, overrides, field) => {
        expect((await makeRequest(source, { ...overrides, reasoning_effort: 'none' })).status).toBe(200);
        expect(capturedBody).toHaveProperty(field, 'none');
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['nanogpt', {}, ['reasoning', 'effort']],
        ['nanogpt', { model_sampler_metadata: { source: 'nanogpt', model: 'test-model', reasoning_efforts: ['high', null] } }, ['reasoning', 'effort']],
        ['nanogpt', { model_sampler_metadata: { source: 'nanogpt', model: 'test-model:free', reasoning_efforts: ['high'] } }, ['reasoning', 'effort']],
        ['nanogpt', { model: 'vendor/model:thinkingish' }, ['reasoning', 'effort']],
        ['nanogpt', { model: 'vendor/model:Thinking' }, ['reasoning', 'effort']],
        ['openrouter', {}, ['reasoning', 'effort']],
        ['openrouter', { model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning: null } }, ['reasoning', 'effort']],
        ['custom', { model: 'gpt-5.2', custom_url: 'https://custom.test/v1' }, ['reasoning_effort']],
        ['openai', { model: 'future-neutral-model' }, ['reasoning_effort']],
    ])('%s keeps unknown raw-request None behaviour with %p', async (source, overrides, field) => {
        expect((await makeRequest(source, { ...overrides, reasoning_effort: 'none' })).status).toBe(200);
        expect(capturedBody).toHaveProperty(field, 'none');
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['openai', { model: 'gpt-5' }, 'max'],
        ['makersuite', { model: 'gemini-3.8-flash' }, 'max'],
        ['nanogpt', { model_sampler_metadata: { source: 'nanogpt', model: 'test-model', reasoning_efforts: ['high'] } }, 'low'],
        ['openrouter', { model_sampler_metadata: { source: 'openrouter', model: 'test-model', reasoning: { supported_efforts: ['high'] } } }, 'low'],
    ])('%s rejects other unsupported efforts before any provider call', async (source, overrides, effort) => {
        const response = await makeRequest(source, { ...overrides, reasoning_effort: effort });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_REASONING_EFFORT' } });
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    describe.each([CHAT_COMPLETION_SOURCES.NANOGPT, CHAT_COMPLETION_SOURCES.OPENROUTER, 'openrouter-text'])('%s service tiers', source => {
        test.each(['flex', 'priority', 'auto', 'default'])('forwards %s without altering provider or billing choices', async tier => {
            const response = await makeRequest(source, {
                service_tier: tier,
                provider: ['OpenAI'], allow_fallbacks: false, quantizations: ['bf16'],
                nanogpt_allowed_providers: ['unlisted-provider'], nanogpt_payg_override: false,
            });
            expect(response.status).toBe(200);
            expect(capturedBody.service_tier).toBe(tier);
            expect(capturedBody.provider).toEqual(source === CHAT_COMPLETION_SOURCES.NANOGPT
                ? { only: ['unlisted-provider'] }
                : { order: ['OpenAI'], allow_fallbacks: false, quantizations: ['bf16'] });
            expect(capturedBody.billing_mode).toBeUndefined();
            expect(capturedHeaders['X-Billing-Mode']).toBeUndefined();
            expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        });

        test('omits the tier by default', async () => {
            expect((await makeRequest(source)).status).toBe(200);
            expect(capturedBody).not.toHaveProperty('service_tier');
        });

        test.each(['', 'fast', 'unsupported', null, [], {}, true, 1])('rejects malformed tier %p before forwarding', async tier => {
            expect((await makeRequest(source, { service_tier: tier })).status).toBe(400);
            expect(nodeFetchMock).not.toHaveBeenCalled();
        });

        test('keeps the tier on streamed requests', async () => {
            nodeFetchMock.mockImplementationOnce(async (_url, options) => {
                capturedBody = JSON.parse(options.body);
                return new FetchResponse('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
            });
            const response = await makeRequest(source, { service_tier: 'flex', stream: true });
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('[DONE]');
            expect(capturedBody.service_tier).toBe('flex');
        });

        test('does not retry an upstream tier rejection', async () => {
            nodeFetchMock.mockResolvedValueOnce(new FetchResponse('{"error":{"message":"tier unavailable"}}', { status: 400 }));
            const response = await makeRequest(source, { service_tier: 'flex' });
            await response.text();
            expect(nodeFetchMock).toHaveBeenCalledTimes(1);
            expect(JSON.parse(nodeFetchMock.mock.calls[0][1].body).service_tier).toBe('flex');
        });
    });

    test.each([
        {},
        { nanogpt_provider: '' },
        { nanogpt_provider: ' \t ' },
        { nanogpt_payg_override: false },
        { nanogpt_allowed_providers: [] },
        { nanogpt_ignored_providers: [] },
        { nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] },
        { nanogpt_provider: 'legacy-provider', nanogpt_allowed_providers: [] },
        { nanogpt_provider: 'legacy-provider', nanogpt_ignored_providers: [] },
        { nanogpt_provider: 'legacy-provider', nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] },
    ])('NanoGPT omits provider and billing overrides for %p', async (overrides) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, overrides);

        expect(response.status).toBe(200);
        expect(capturedBody).not.toHaveProperty('provider');
        expect(capturedBody).not.toHaveProperty('billing_mode');
        expect(capturedHeaders).not.toHaveProperty('X-Provider');
        expect(capturedHeaders).not.toHaveProperty('X-Billing-Mode');
    });

    test.each([
        ['allowed only', { nanogpt_allowed_providers: ['Provider-A', 'unlisted/provider:V2'] }, { only: ['Provider-A', 'unlisted/provider:V2'] }],
        ['ignored only', { nanogpt_ignored_providers: ['Provider-B', 'unlisted/provider:V3'] }, { ignore: ['Provider-B', 'unlisted/provider:V3'] }],
        ['combined', { nanogpt_allowed_providers: ['Provider-A'], nanogpt_ignored_providers: ['Provider-B'] }, { only: ['Provider-A'], ignore: ['Provider-B'] }],
        ['empty ignored', { nanogpt_allowed_providers: [' Provider-A '], nanogpt_ignored_providers: [] }, { only: [' Provider-A '] }],
        ['empty allowed', { nanogpt_allowed_providers: [], nanogpt_ignored_providers: ['Provider-B'] }, { ignore: ['Provider-B'] }],
    ])('NanoGPT sends exact structured IDs with %s, without explicit billing overrides', async (_name, overrides, provider) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            nanogpt_provider: 'legacy-provider',
            nanogpt_payg_override: false,
            ...overrides,
        });

        expect(response.status).toBe(200);
        expect(capturedBody.provider).toEqual(provider);
        expect(capturedHeaders).not.toHaveProperty('X-Provider');
        expect(capturedHeaders).not.toHaveProperty('X-Billing-Mode');
        expect(capturedBody).not.toHaveProperty('billing_mode');
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        [{}, undefined],
        [{ nanogpt_allowed_providers: [], nanogpt_ignored_providers: [] }, undefined],
        [{ nanogpt_allowed_providers: ['Provider-A'], nanogpt_ignored_providers: ['Provider-B'] }, { only: ['Provider-A'], ignore: ['Provider-B'] }],
    ])('NanoGPT PAYG true sends both billing overrides with %p', async (overrides, provider) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            ...overrides,
            nanogpt_payg_override: true,
        });

        expect(response.status).toBe(200);
        expect(capturedHeaders['X-Billing-Mode']).toBe('paygo');
        expect(capturedBody.billing_mode).toBe('paygo');
        expect(capturedBody.provider).toEqual(provider);
        expect(capturedHeaders).not.toHaveProperty('X-Provider');
    });

    test('NanoGPT preserves the legacy provider header when neither list is supplied', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { nanogpt_provider: 'Legacy/provider:V2' });

        expect(response.status).toBe(200);
        expect(capturedHeaders['X-Provider']).toBe('Legacy/provider:V2');
        expect(capturedBody).not.toHaveProperty('provider');
        expect(capturedBody).not.toHaveProperty('billing_mode');
        expect(capturedHeaders).not.toHaveProperty('X-Billing-Mode');
    });

    test.each([
        ...['nanogpt_allowed_providers', 'nanogpt_ignored_providers'].flatMap(field => [
            null, '', 'Provider-A', false, 1, {},
            ['Provider-A', ''], ['Provider-A', ' \t '], ['Provider-A', null],
            ['Provider-A', false], ['Provider-A', 1], ['Provider-A', {}], ['Provider-A', []],
        ].map(value => [field, value])),
        ...[null, '', 'true', 'false', 0, 1, {}, []].map(value => ['nanogpt_payg_override', value]),
        ...[null, false, 1, {}, [], 'bad\r\nX-Injected: value', 'bad\u0000', 'bad\u0100'].map(value => ['nanogpt_provider', value]),
    ])('NanoGPT refuses malformed %s=%p before any outbound fetch', async (field, value) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            nanogpt_provider: 'legacy-provider',
            [field]: value,
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: true });
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test.each([
        [400, 400],
        [503, 502],
    ])('NanoGPT does not retry without restrictions after an upstream %s', async (status, expectedStatus) => {
        nodeFetchMock.mockResolvedValueOnce(new Response('{}', { status }));
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
            nanogpt_allowed_providers: ['unlisted/provider'],
            nanogpt_ignored_providers: ['Provider-B'],
        });

        expect(response.status).toBe(expectedStatus);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(nodeFetchMock.mock.calls[0][1].body).provider).toEqual({
            only: ['unlisted/provider'],
            ignore: ['Provider-B'],
        });
    });

    test.each([
        [CHAT_COMPLETION_SOURCES.CUSTOM, { custom_url: 'https://custom.test/v1' }],
        [CHAT_COMPLETION_SOURCES.PERPLEXITY, {}],
        [CHAT_COMPLETION_SOURCES.OPENROUTER, { provider: ['own-provider'], allow_fallbacks: false }],
    ])('%s is unaffected by valid or malformed NanoGPT fields', async (source, overrides) => {
        const baseline = await makeRequest(source, overrides);
        const originalBody = capturedBody;
        const originalHeaders = capturedHeaders;
        const response = await makeRequest(source, {
            ...overrides,
            nanogpt_allowed_providers: ['NanoGPT-only'],
            nanogpt_ignored_providers: ['NanoGPT-ignored'],
            nanogpt_payg_override: true,
            nanogpt_provider: 'legacy-provider',
        });

        expect(baseline.status).toBe(200);
        expect(response.status).toBe(200);
        expect(capturedBody).toEqual(originalBody);
        expect(capturedHeaders).toEqual(originalHeaders);

        const invalidResponse = await makeRequest(source, {
            ...overrides,
            nanogpt_allowed_providers: 'invalid',
            nanogpt_ignored_providers: null,
            nanogpt_payg_override: 'true',
            nanogpt_provider: 'bad\r\nheader',
        });

        expect(invalidResponse.status).toBe(200);
        expect(capturedBody).toEqual(originalBody);
        expect(capturedHeaders).toEqual(originalHeaders);
    });

    describe('NanoGPT declared reasoning levels', () => {
        const model = 'z-ai/glm-5.2:thinking';
        const metadata = { source: CHAT_COMPLETION_SOURCES.NANOGPT, model, reasoning_efforts: ['high', 'max'] };

        test('rejects unsupported Low before adding the web-search suffix or contacting the provider', async () => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model, reasoning_effort: 'low', model_sampler_metadata: metadata, enable_web_search: true,
            });
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: expect.stringContaining('High') } });
            expect(nodeFetchMock).not.toHaveBeenCalled();
        });

        test.each(['high', 'max'])('keeps declared %s and strips internal metadata from the native wire', async effort => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model, reasoning_effort: effort, model_sampler_metadata: metadata, enable_web_search: true,
            });
            expect(response.status).toBe(200);
            expect(capturedBody.model).toBe(`${model}:online`);
            expect(capturedBody.reasoning).toEqual({ effort });
            expect(capturedBody).not.toHaveProperty('model_sampler_metadata');
            expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        });

        test('requires the exact fingerprint of an explicitly selected online variant', async () => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model: `${model}:online`, reasoning_effort: 'low', model_sampler_metadata: metadata,
            });
            expect(response.status).toBe(200);
            expect(capturedBody.reasoning).toEqual({ effort: 'low' });
        });

        test.each([
            ['base variant', { ...metadata, model: 'z-ai/glm-5.2' }],
            ['online variant', { ...metadata, model: `${model}:online` }],
            ['another source', { ...metadata, source: CHAT_COMPLETION_SOURCES.OPENROUTER }],
            ['empty declaration', { ...metadata, reasoning_efforts: [] }],
            ['Auto and future only', { ...metadata, reasoning_efforts: ['auto', 'future-rung'] }],
            ['malformed array', { ...metadata, reasoning_efforts: ['high', null] }],
            ['missing metadata', undefined],
        ])('retains legacy forwarding for %s', async (_name, declaration) => {
            const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model, reasoning_effort: 'low', model_sampler_metadata: declaration,
            });
            expect(response.status).toBe(200);
            expect(capturedBody.reasoning).toEqual({ effort: 'low' });
            expect(capturedBody).not.toHaveProperty('model_sampler_metadata');
        });

        test.each([undefined, '', 'auto'])('preserves omitted/legacy Auto effort %p with a known declaration', async effort => {
            expect((await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model, reasoning_effort: effort, model_sampler_metadata: metadata,
            })).status).toBe(200);
            expect(capturedBody).not.toHaveProperty('reasoning');
        });

        test.each([['min', 'minimal'], ['FutureRung', 'FutureRung']])('admits explicitly declared %s without changing its wire semantics', async (effort, wire) => {
            expect((await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model, reasoning_effort: effort,
                model_sampler_metadata: { ...metadata, reasoning_efforts: ['high', 'minimal', 'none', 'FutureRung'] },
            })).status).toBe(200);
            expect(capturedBody.reasoning).toEqual({ effort: wire });
        });

        test('suppresses None for a thinking variant exactly as an absent effort', async () => {
            const overrides = { model, model_sampler_metadata: metadata };
            expect((await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, overrides)).status).toBe(200);
            const absentBody = capturedBody;
            expect((await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { ...overrides, reasoning_effort: 'none' })).status).toBe(200);
            expect(capturedBody).toEqual(absentBody);
            expect(nodeFetchMock).toHaveBeenCalledTimes(2);
        });

        test('forwards explicitly allowed None for a non-thinking variant', async () => {
            const plainModel = 'z-ai/glm-5.2';
            expect((await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, {
                model: plainModel, reasoning_effort: 'none',
                model_sampler_metadata: { ...metadata, model: plainModel, reasoning_efforts: ['none', 'high'] },
            })).status).toBe(200);
            expect(capturedBody.reasoning).toEqual({ effort: 'none' });
        });
    });

    test.each([false, true])('OpenRouter known-invalid None matches an absent effort, stream=%s', async stream => {
        const model = 'fixture/model';
        const overrides = { model, stream, model_sampler_metadata: { source: CHAT_COMPLETION_SOURCES.OPENROUTER, model, reasoning: { supported_efforts: ['high'], mandatory: true } } };
        if (stream) nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options.body);
            return new FetchResponse('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        });
        const absent = await makeRequest(CHAT_COMPLETION_SOURCES.OPENROUTER, overrides);
        expect(absent.status).toBe(200);
        await absent.text();
        const absentBody = capturedBody;
        const suppressed = await makeRequest(CHAT_COMPLETION_SOURCES.OPENROUTER, { ...overrides, reasoning_effort: 'none' });
        expect(suppressed.status).toBe(200);
        await suppressed.text();
        expect(capturedBody).toEqual(absentBody);
        expect(nodeFetchMock).toHaveBeenCalledTimes(2);
    });

    // NanoGPT documents none < minimal < low < medium < high < xhigh, and some models accept
    // max. Everything but min is spelled the same here, so it goes out untouched instead of
    // being shifted a rung down. min is the only name NanoGPT does not have, so it takes the
    // nearest rung. none goes out too: omitting it would let the model pick its own depth.
    test.each([
        ['none', 'none'],
        ['min', 'minimal'],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
        ['max', 'max'],
    ])('NanoGPT sends %s as %s', async (effort, expected) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: expected });
    });

    test.each(['auto', '   '])('NanoGPT omits the reasoning key entirely for %p', async (effort) => {
        // Upstream emitted a bare `"reasoning": {}` for both, because the value is truthy but
        // means "unset". hasOwn, not toBeUndefined: an empty object would also read as
        // undefined on the nested effort.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test('NanoGPT forwards a value it does not recognize instead of dropping it', async () => {
        // A rung NanoGPT rejects earns an error the user can read, rather than a silent
        // downgrade to whatever the model felt like doing.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: 'banana' });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: 'banana' });
    });

    test('NanoGPT omits the reasoning key when no effort is supplied', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT);

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning')).toBe(false);
    });

    test.each([
        ['XHigh', 'xhigh'],
        [' xhigh ', 'xhigh'],
        [' Max ', 'max'],
        ['MAX', 'max'],
        [' None ', 'none'],
    ])('NanoGPT normalizes %p before the table lookup and sends %s', async (effort, expected) => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.NANOGPT, { reasoning_effort: effort });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning).toEqual({ effort: expected });
    });

    test('OpenRouter receives a lowercased effort instead of the raw value', async () => {
        // OpenRouter forwards whatever it is given, so a hand-edited profile containing
        // "Medium" produced `invalid value for reasoning.effort "Medium"` from the provider.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.OPENROUTER, { reasoning_effort: 'Medium' });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning.effort).toBe('medium');
    });

    test('Perplexity receives a lowercased effort', async () => {
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.PERPLEXITY, { reasoning_effort: 'HIGH' });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('high');
    });

    test('an unrecognized value reaches an OpenAI-compatible endpoint with its casing intact', async () => {
        // Several proxies take vocabulary of their own. Dropping unknowns would regress them, and
        // case-folding one would too, since JSON enum values are case-sensitive.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            reasoning_effort: 'UltraFast',
            custom_url: 'https://custom.test/v1',
            model: 'gpt-5',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('UltraFast');
    });

    test('\'none\' reaches an OpenAI-compatible endpoint verbatim for a GPT-5.1+ model', async () => {
        // The client only resolves 'none' for models that document it (GPT-5.1 and newer);
        // the server's job is to pass it through untouched rather than dropping it.
        const response = await makeRequest(CHAT_COMPLETION_SOURCES.CUSTOM, {
            reasoning_effort: 'none',
            custom_url: 'https://custom.test/v1',
            model: 'gpt-5.2',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.reasoning_effort).toBe('none');
    });

    // Two representatives of the branches that assign this key unconditionally (CometAPI and
    // Chutes are the others). A value that trims to nothing has to be removed from the body
    // rather than blanked, or they ship `"reasoning_effort": ""`. The removal happens once at
    // the shared entry point, so these two cover the whole class.
    test.each([
        ['Perplexity', CHAT_COMPLETION_SOURCES.PERPLEXITY],
        ['Pollinations', CHAT_COMPLETION_SOURCES.POLLINATIONS],
    ])('%s omits the field entirely for a whitespace-only effort', async (_name, source) => {
        const response = await makeRequest(source, { reasoning_effort: '   ' });

        expect(response.status).toBe(200);
        expect(Object.hasOwn(capturedBody, 'reasoning_effort')).toBe(false);
    });
});

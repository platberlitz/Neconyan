import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

const { default: actualNodeFetch } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({ default: nodeFetchMock }));

describe('Chat Completion sampler wire filtering', () => {
    let server;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sampler-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sampler-user-'));
        tempDirs.push(userRoot);
        const secrets = new SecretManager({ root: userRoot, backups: userRoot });
        for (const key of [SECRET_KEYS.OPENAI, SECRET_KEYS.OPENROUTER, SECRET_KEYS.NANOGPT, SECRET_KEYS.COHERE, SECRET_KEYS.WORKERS_AI, SECRET_KEYS.LINKAPI]) {
            secrets.writeSecret(key, `${key}-test-key`);
        }

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
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
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

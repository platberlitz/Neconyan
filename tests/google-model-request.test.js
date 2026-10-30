import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

const actualNodeFetch = (await import('node-fetch')).default;
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

describe('Google model request compatibility', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;
    let capturedBody;
    const tempDirs = [];

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-google-model-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-google-model-user-'));
        tempDirs.push(userRoot);
        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.MAKERSUITE, 'google-test-key');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
            next();
        });
        app.use('/api/backends/chat-completions', chatCompletionsRouter);

        await new Promise((resolve) => {
            appServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = appServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(() => {
        capturedBody = undefined;
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (_url, options) => {
            capturedBody = JSON.parse(options?.body ?? '{}');
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'ok' }] } }],
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

    function makeRequest(model, extra = {}) {
        return fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
                model,
                stream: false,
                max_tokens: 128,
                temperature: 1,
                top_p: 0.9,
                top_k: 40,
                messages: [{ role: 'user', content: 'Question' }],
                ...extra,
            }),
        });
    }

    test.each(['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'])(
        'omits unsupported sampling parameters for %s',
        async (model) => {
            const response = await makeRequest(model);

            expect(response.status).toBe(200);
            expect(capturedBody.generationConfig).not.toHaveProperty('temperature');
            expect(capturedBody.generationConfig).not.toHaveProperty('topP');
            expect(capturedBody.generationConfig).not.toHaveProperty('topK');
            expect(capturedBody.generationConfig).not.toHaveProperty('candidateCount');
        },
    );

    test('keeps sampling parameters for older Gemini models', async () => {
        const response = await makeRequest('gemini-2.5-flash');

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig).toMatchObject({
            temperature: 1,
            topP: 0.9,
            topK: 40,
            candidateCount: 1,
        });
    });

    test('omits the thinking level when no reasoning effort is sent', async () => {
        const response = await makeRequest('gemini-3.8-flash');

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig).not.toHaveProperty('thinkingConfig');
    });

    test('forwards a chosen reasoning effort as the thinking level', async () => {
        const response = await makeRequest('gemini-3.8-flash', { reasoning_effort: 'medium' });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    });

    test('keeps the 2.5 thinking budget when no reasoning effort is sent', async () => {
        const response = await makeRequest('gemini-2.5-flash');

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test.each(['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'])(
        'sends no image configuration for %s when no image settings are sent',
        async (model) => {
            const response = await makeRequest(model, { request_images: true });

            expect(response.status).toBe(200);
            expect(capturedBody.generationConfig.responseModalities).toEqual(['text', 'image']);
            expect(capturedBody.generationConfig).not.toHaveProperty('imageConfig');
            expect(JSON.stringify(capturedBody)).not.toContain('undefined');
        },
    );

    test('forwards a chosen aspect ratio and resolution to a Gemini 3 image model', async () => {
        const response = await makeRequest('gemini-3-pro-image-preview', {
            request_images: true,
            request_image_aspect_ratio: '16:9',
            request_image_resolution: '2K',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '16:9' });
    });

    test('forwards only the aspect ratio when no resolution is sent', async () => {
        const response = await makeRequest('gemini-2.5-flash-image', {
            request_images: true,
            request_image_aspect_ratio: '16:9',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
    });

    test('forwards only the resolution when no aspect ratio is sent', async () => {
        const response = await makeRequest('gemini-3-pro-image-preview', {
            request_images: true,
            request_image_resolution: '2K',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ imageSize: '2K' });
    });

    test.each(['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'])(
        'sends no image configuration for %s when only a resolution is sent',
        async (model) => {
            const response = await makeRequest(model, {
                request_images: true,
                request_image_resolution: '2K',
            });

            expect(response.status).toBe(200);
            expect(capturedBody.generationConfig.responseModalities).toEqual(['text', 'image']);
            expect(capturedBody.generationConfig).not.toHaveProperty('imageConfig');
        },
    );

    test('drops the resolution but keeps the aspect ratio for a non-Gemini 3 image model', async () => {
        const response = await makeRequest('gemini-2.5-flash-image', {
            request_images: true,
            request_image_aspect_ratio: '16:9',
            request_image_resolution: '2K',
        });

        expect(response.status).toBe(200);
        expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
    });
});

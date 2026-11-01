import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { CHAT_COMPLETION_SOURCES, TEXTGEN_TYPES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import {
    assertSameOriginHttpUrl,
    buildAzureSpeechUrl,
    buildChutesEmbeddingBaseUrl,
    buildChutesTranscribeUrl,
    isAllowedTextGenSecretTarget,
    parseHttpBaseUrl,
    resolveAzureSpeechOrigin,
    resolveVertexAiBaseUrl,
    validateGoogleModelPath,
    validateMiniMaxApiHost,
    validateSafePathSegment,
    validateTextGenServerUrl,
    validateVertexRegion,
    validateVolcengineTtsEndpoint,
} from '../src/endpoints/provider-url-validation.js';

const { default: actualNodeFetch } = await import('node-fetch');
const nodeFetchMock = jest.fn((url, options) => actualNodeFetch(url, options));
await jest.unstable_mockModule('node-fetch', () => ({ default: nodeFetchMock }));

describe('Provider URL and hostname validation', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let userRoot;
    let audioFilePath;
    /** @type {Array<{ url: string, options: any }>} */
    let capturedFetches = [];
    const tempDirs = [];

    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const syntheticServiceAccount = {
        type: 'service_account',
        project_id: 'synthetic-project-123',
        private_key_id: 'synthetic-key-id',
        private_key: privateKey,
        client_email: 'synthetic@synthetic-project-123.iam.gserviceaccount.com',
    };

    let SecretManager;
    let SECRET_KEYS;
    let getGoogleApiConfigForSettings;
    let requestOpenAIBatchVector;
    let validateMiniMaxAudioOutputUrl;
    let handleTextGenerationEncode;
    let setAdditionalHeadersByType;

    beforeAll(async () => {
        const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-provider-url-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        const defaultConfig = fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        fs.writeFileSync(configPath, defaultConfig);
        tempDirs.push(configRoot);
        setConfigFilePath(configPath);

        const { router: azureRouter } = await import('../src/endpoints/azure.js');
        const { router: openaiRouter } = await import('../src/endpoints/openai.js');
        const googleModule = await import('../src/endpoints/google.js');
        const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
        const { router: textCompletionsRouter } = await import('../src/endpoints/backends/text-completions.js');
        const minimaxModule = await import('../src/endpoints/minimax.js');
        const { router: volcengineRouter } = await import('../src/endpoints/volcengine.js');
        const tokenizersModule = await import('../src/endpoints/tokenizers.js');
        const additionalHeadersModule = await import('../src/additional-headers.js');
        const secretsModule = await import('../src/endpoints/secrets.js');
        const openaiVectorsModule = await import('../src/vectors/openai-vectors.js');

        SecretManager = secretsModule.SecretManager;
        SECRET_KEYS = secretsModule.SECRET_KEYS;
        getGoogleApiConfigForSettings = googleModule.getGoogleApiConfigForSettings;
        requestOpenAIBatchVector = openaiVectorsModule.requestOpenAIBatchVector;
        validateMiniMaxAudioOutputUrl = minimaxModule.validateMiniMaxAudioOutputUrl;
        handleTextGenerationEncode = tokenizersModule.handleTextGenerationEncode;
        setAdditionalHeadersByType = additionalHeadersModule.setAdditionalHeadersByType;

        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-provider-url-user-'));
        tempDirs.push(userRoot);
        audioFilePath = path.join(userRoot, 'synthetic-audio.wav');

        const secretManager = new SecretManager({ root: userRoot, backups: userRoot });
        secretManager.writeSecret(SECRET_KEYS.AZURE_TTS, 'SYNTHETIC_AZURE_TTS_KEY');
        secretManager.writeSecret(SECRET_KEYS.AZURE_OPENAI, 'SYNTHETIC_AZURE_OPENAI_KEY');
        secretManager.writeSecret(SECRET_KEYS.CHUTES, 'SYNTHETIC_CHUTES_KEY');
        secretManager.writeSecret(SECRET_KEYS.OPENROUTER, 'SYNTHETIC_OPENROUTER_KEY');
        secretManager.writeSecret(SECRET_KEYS.OPENAI, 'SYNTHETIC_OPENAI_KEY');
        secretManager.writeSecret(SECRET_KEYS.GROQ, 'SYNTHETIC_GROQ_KEY');
        secretManager.writeSecret(SECRET_KEYS.CUSTOM, 'SYNTHETIC_CUSTOM_KEY');
        secretManager.writeSecret(SECRET_KEYS.CUSTOM_OPENAI_TTS, 'SYNTHETIC_CUSTOM_TTS_KEY');
        secretManager.writeSecret(SECRET_KEYS.MAKERSUITE, 'SYNTHETIC_MAKERSUITE_KEY');
        secretManager.writeSecret(SECRET_KEYS.VERTEXAI, 'SYNTHETIC_VERTEXAI_EXPRESS_KEY');
        secretManager.writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, JSON.stringify(syntheticServiceAccount));
        secretManager.writeSecret(SECRET_KEYS.WORKERS_AI, 'SYNTHETIC_WORKERS_AI_KEY');
        secretManager.writeSecret(SECRET_KEYS.VLLM, 'SYNTHETIC_VLLM_KEY');
        secretManager.writeSecret(SECRET_KEYS.TOGETHERAI, 'SYNTHETIC_TOGETHERAI_KEY');
        secretManager.writeSecret(SECRET_KEYS.FEATHERLESS, 'SYNTHETIC_FEATHERLESS_KEY');
        secretManager.writeSecret(SECRET_KEYS.MANCER, 'SYNTHETIC_MANCER_KEY');
        secretManager.writeSecret(SECRET_KEYS.INFERMATICAI, 'SYNTHETIC_INFERMATICAI_KEY');
        secretManager.writeSecret(SECRET_KEYS.DREAMGEN, 'SYNTHETIC_DREAMGEN_KEY');
        secretManager.writeSecret(SECRET_KEYS.HUGGINGFACE, 'SYNTHETIC_HUGGINGFACE_KEY');
        secretManager.writeSecret(SECRET_KEYS.OOBA, 'SYNTHETIC_OOBA_KEY');
        secretManager.writeSecret(SECRET_KEYS.TABBY, 'SYNTHETIC_TABBY_KEY');
        secretManager.writeSecret(SECRET_KEYS.MINIMAX, 'SYNTHETIC_MINIMAX_KEY');
        secretManager.writeSecret(SECRET_KEYS.MINIMAX_GROUP_ID, 'SYNTHETIC_MINIMAX_GROUP');
        secretManager.writeSecret(SECRET_KEYS.VOLCENGINE_APP_ID, 'SYNTHETIC_VOLC_APP_ID');
        secretManager.writeSecret(SECRET_KEYS.VOLCENGINE_ACCESS_KEY, 'SYNTHETIC_VOLC_ACCESS_KEY');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
            if (req.headers['x-test-audio-file'] === '1') {
                fs.writeFileSync(audioFilePath, Buffer.from('RIFF0000WAVEfmt '));
                req.file = /** @type {any} */ ({ path: audioFilePath });
            }
            if (req.headers['x-test-dns-ip']) {
                const resolvedIp = String(req.headers['x-test-dns-ip']);
                req.lookupAddresses = async () => [resolvedIp];
            } else {
                req.lookupAddresses = async () => ['93.184.216.34'];
            }
            next();
        });
        app.use('/api/azure', azureRouter);
        app.use('/api/openai', openaiRouter);
        app.use('/api/google', googleModule.router);
        app.use('/api/backends/chat-completions', chatCompletionsRouter);
        app.use('/api/backends/text-completions', textCompletionsRouter);
        app.use('/api/minimax', minimaxModule.router);
        app.use('/api/volcengine', volcengineRouter);
        app.post('/api/tokenizers/remote/textgenerationwebui/encode', handleTextGenerationEncode);

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    beforeEach(() => {
        capturedFetches = [];
        nodeFetchMock.mockClear();
        nodeFetchMock.mockImplementation(async (url, options = {}) => {
            const urlString = String(url);
            capturedFetches.push({ url: urlString, options });

            if (urlString === 'https://oauth2.googleapis.com/token') {
                return new Response(JSON.stringify({ access_token: 'SYNTHETIC_GCP_ACCESS_TOKEN' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            if (urlString.includes('.tts.speech.microsoft.com/cognitiveservices/voices/list')) {
                return new Response(JSON.stringify([{ ShortName: 'en-US-JennyNeural', Locale: 'en-US' }]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            if (urlString.includes('.tts.speech.microsoft.com/cognitiveservices/v1')) {
                return new Response(Buffer.from('ogg-audio-bytes'), {
                    status: 200,
                    headers: { 'Content-Type': 'audio/ogg' },
                });
            }

            if (urlString.endsWith('.chutes.ai/transcribe')) {
                return new Response(JSON.stringify([{ text: 'hello ' }, { text: 'world' }]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            if (urlString.includes('/audio/speech') || urlString.endsWith('/tts')) {
                return new Response(Buffer.from('wav-audio-bytes'), {
                    status: 200,
                    headers: { 'Content-Type': 'audio/wav' },
                });
            }

            return new Response(JSON.stringify({
                model: 'test-model',
                choices: [{ message: { content: 'synthetic caption or reply' }, finish_reason: 'stop' }],
                candidates: [{
                    content: {
                        parts: [{
                            text: 'synthetic gemini reply',
                            inlineData: { mimeType: 'audio/mp3', data: Buffer.from('mp3').toString('base64') },
                        }],
                    },
                    finishReason: 'STOP',
                }],
                predictions: [{ bytesBase64Encoded: Buffer.from('jpg').toString('base64') }],
                publisherModels: [{ name: 'publishers/google/models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
                models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
                data: [{ id: 'test-model' }],
                result: [{ name: '@cf/meta/llama-3.2-11b-vision-instruct', properties: [{ property_id: 'vision', value: 'true' }] }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        nodeFetchMock.mockImplementation((url, options) => actualNodeFetch(url, options));
    });

    describe('Direct validator unit checks', () => {
        test('accepts normal Azure regions and rejects authority injection', () => {
            expect(resolveAzureSpeechOrigin('westus')).toEqual({
                region: 'westus',
                origin: 'https://westus.tts.speech.microsoft.com',
            });
            expect(buildAzureSpeechUrl('eastus2', '/cognitiveservices/v1'))
                .toBe('https://eastus2.tts.speech.microsoft.com/cognitiveservices/v1');

            for (const bad of ['attacker.example/exfil#', 'westus.attacker.example#', 'westus@attacker.example', '-westus', 'westus/../../x', '']) {
                expect(() => buildAzureSpeechUrl(bad, '/cognitiveservices/v1')).toThrow();
            }
        });

        test('accepts expected Chutes DNS labels and rejects authority injection', () => {
            expect(buildChutesTranscribeUrl('chutes-whisper-large-v3'))
                .toBe('https://chutes-whisper-large-v3.chutes.ai/transcribe');
            expect(buildChutesEmbeddingBaseUrl('chutes-qwen-qwen3-embedding-8b'))
                .toBe('https://chutes-qwen-qwen3-embedding-8b.chutes.ai/v1');

            for (const bad of ['attacker.example/exfil#', 'sub.domain', 'model?x=1#', 'model@attacker.com', '-bad', 'bad-', '']) {
                expect(() => buildChutesTranscribeUrl(bad)).toThrow();
                expect(() => buildChutesEmbeddingBaseUrl(bad)).toThrow();
            }
        });

        test('accepts global and regional Vertex AI regions and rejects authority injection', () => {
            expect(validateVertexRegion(undefined)).toBe('us-central1');
            expect(validateVertexRegion('global')).toBe('global');
            expect(validateVertexRegion('europe-west4')).toBe('europe-west4');
            expect(resolveVertexAiBaseUrl('global', { includeVersion: true }).baseUrl)
                .toBe('https://aiplatform.googleapis.com/v1');
            expect(resolveVertexAiBaseUrl('asia-northeast1', { includeVersion: false }).baseUrl)
                .toBe('https://asia-northeast1-aiplatform.googleapis.com');

            for (const bad of ['attacker.example/exfil#', 'us-central1.attacker.example#', 'us-central1/../../x', 'global@evil.com']) {
                expect(() => resolveVertexAiBaseUrl(bad)).toThrow();
            }
        });

        test('validates path segments, model paths, and same-origin URLs', () => {
            expect(validateSafePathSegment('my-project-123', 'project')).toBe('my-project-123');
            expect(validateGoogleModelPath('gemini-2.5-flash')).toBe('gemini-2.5-flash');
            expect(() => validateSafePathSegment('../escape', 'project')).toThrow();
            expect(() => validateSafePathSegment('proj/../../evil', 'project')).toThrow();
            expect(() => validateGoogleModelPath('gemini-2.5-flash?key=leak#')).toThrow();

            const base = parseHttpBaseUrl('http://127.0.0.1:8080/v1');
            expect(assertSameOriginHttpUrl('http://127.0.0.1:8080/v1/chat/completions', base).toString())
                .toBe('http://127.0.0.1:8080/v1/chat/completions');
            expect(() => assertSameOriginHttpUrl('https://attacker.example/v1/chat/completions', base)).toThrow();
            expect(() => parseHttpBaseUrl('https://user:pass@attacker.example/v1')).toThrow();
            expect(() => parseHttpBaseUrl('https://proxy.example/v1?foo=bar')).toThrow();
        });
    });

    describe('Azure TTS endpoints (/api/azure/list and /api/azure/generate)', () => {
        test('rejects authority injection in region with 400 and never calls fetch', async () => {
            const listRes = await fetch(`${baseUrl}/api/azure/list`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region: 'attacker.example/exfil#' }),
            });
            expect(listRes.status).toBe(400);

            const genRes = await fetch(`${baseUrl}/api/azure/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    region: 'attacker.example/exfil#',
                    text: 'Hello there',
                    voice: 'en-US-JennyNeural',
                }),
            });
            expect(genRes.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);
        });

        test('allows valid Azure region requests', async () => {
            const listRes = await fetch(`${baseUrl}/api/azure/list`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region: 'westus' }),
            });
            expect(listRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://westus.tts.speech.microsoft.com/cognitiveservices/voices/list');
            expect(capturedFetches[0].options.headers['Ocp-Apim-Subscription-Key']).toBe('SYNTHETIC_AZURE_TTS_KEY');

            const genRes = await fetch(`${baseUrl}/api/azure/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    region: 'westus',
                    text: 'Hello there',
                    voice: 'en-US-JennyNeural',
                }),
            });
            expect(genRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[1].url).toBe('https://westus.tts.speech.microsoft.com/cognitiveservices/v1');
        });
    });

    describe('Chutes transcription and vector embeddings endpoints', () => {
        test('rejects authority injection in transcription model with 400 and never calls fetch', async () => {
            const res = await fetch(`${baseUrl}/api/openai/chutes/transcribe-audio`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-test-audio-file': '1',
                },
                body: JSON.stringify({ model: 'attacker.example/exfil#' }),
            });
            expect(res.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);
        });

        test('allows valid Chutes DNS label transcription model', async () => {
            const res = await fetch(`${baseUrl}/api/openai/chutes/transcribe-audio`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-test-audio-file': '1',
                },
                body: JSON.stringify({ model: 'chutes-whisper-large-v3' }),
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ text: 'hello world' });
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://chutes-whisper-large-v3.chutes.ai/transcribe');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_CHUTES_KEY');
        });

        test('rejects authority injection in Chutes vector embedding model before fetch and allows valid Chutes embedding model', async () => {
            const directories = { root: userRoot, backups: userRoot };
            const vectorFetchCalls = [];
            const mockVectorFetch = jest.fn(async (url, options) => {
                vectorFetchCalls.push({ url: String(url), options });
                return new Response(JSON.stringify({
                    data: [{ index: 0, embedding: [0.25, 0.75] }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            for (const badModel of ['attacker.example/exfil#', 'sub.domain', 'model?x=1#', 'model@attacker.com', '-bad']) {
                await expect(
                    requestOpenAIBatchVector(['hello'], 'chutes', directories, badModel, null, { fetchImpl: mockVectorFetch }),
                ).rejects.toThrow(/Invalid Chutes embedding model/);
            }
            expect(vectorFetchCalls).toHaveLength(0);

            const embeddings = await requestOpenAIBatchVector(
                ['hello'],
                'chutes',
                directories,
                'chutes-qwen-qwen3-embedding-8b',
                null,
                { fetchImpl: mockVectorFetch },
            );
            expect(embeddings).toEqual([[0.25, 0.75]]);
            expect(vectorFetchCalls).toHaveLength(1);
            expect(vectorFetchCalls[0].url).toBe('https://chutes-qwen-qwen3-embedding-8b.chutes.ai/v1/embeddings');
            expect(vectorFetchCalls[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_CHUTES_KEY');
        });
    });

    describe('OpenAI multimodal captioning (/api/openai/caption-image)', () => {
        test('does not send stored OpenRouter or other provider keys when reverse_proxy is set', async () => {
            const res = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'openrouter',
                    model: 'openai/gpt-4o',
                    prompt: 'Describe image',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    reverse_proxy: 'https://proxy.example/v1',
                }),
            });
            expect(res.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://proxy.example/v1/chat/completions');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer ');
            expect(JSON.stringify(capturedFetches[0].options.headers)).not.toContain('SYNTHETIC_OPENROUTER_KEY');
        });

        test('uses explicitly provided proxy_password when reverse_proxy is set', async () => {
            const res = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'openrouter',
                    model: 'openai/gpt-4o',
                    prompt: 'Describe image',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    reverse_proxy: 'https://proxy.example/v1',
                    proxy_password: 'EXPLICIT_PROXY_PASSWORD',
                }),
            });
            expect(res.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://proxy.example/v1/chat/completions');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer EXPLICIT_PROXY_PASSWORD');
        });

        test('does not allow api_type spoofing to attach unrelated textgen secrets on cloud or local captioning', async () => {
            const cloudRes = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'openai',
                    api_type: 'openrouter',
                    model: 'gpt-4o',
                    prompt: 'Describe image',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    reverse_proxy: 'https://proxy.example/v1',
                    proxy_password: 'EXPLICIT_PROXY_PASSWORD',
                }),
            });
            expect(cloudRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer EXPLICIT_PROXY_PASSWORD');
            expect(JSON.stringify(capturedFetches[0].options.headers)).not.toContain('SYNTHETIC_OPENROUTER_KEY');

            // Local backend (vllm/ooba/koboldcpp/llamacpp) with spoofed api_type: 'openrouter' or 'togetherai'
            // must only use the local backend's own secret (VLLM), never the spoofed cloud secret.
            const localRes = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'vllm',
                    api_type: 'openrouter',
                    server_url: 'http://127.0.0.1:8000/v1',
                    model: 'llava-v1.6',
                    prompt: 'Describe image',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                }),
            });
            expect(localRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[1].url).toBe('http://127.0.0.1:8000/v1/chat/completions');
            expect(capturedFetches[1].options.headers.Authorization).toBe('Bearer SYNTHETIC_VLLM_KEY');
            expect(JSON.stringify(capturedFetches[1].options.headers)).not.toContain('SYNTHETIC_OPENROUTER_KEY');
            expect(JSON.stringify(capturedFetches[1].options.headers)).not.toContain('SYNTHETIC_TOGETHERAI_KEY');
            expect(capturedFetches[1].options.headers['HTTP-Referer']).toBeUndefined();
        });

        test('preserves normal OpenRouter captioning and local/custom captioning', async () => {
            const orRes = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'openrouter',
                    model: 'openai/gpt-4o',
                    prompt: 'Describe image',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                }),
            });
            expect(orRes.status).toBe(200);
            expect(capturedFetches[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_OPENROUTER_KEY');

            const customRes = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'custom',
                    server_url: 'http://127.0.0.1:11434/v1',
                    model: 'llava',
                    prompt: 'Describe image',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                }),
            });
            expect(customRes.status).toBe(200);
            expect(capturedFetches[1].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
            expect(capturedFetches[1].options.headers.Authorization).toBe('Bearer SYNTHETIC_CUSTOM_KEY');
        });
    });

    describe('All Vertex AI URL constructors (google.js + chat-completions.js status & generate)', () => {
        test('rejects authority injection in vertexai_region before minting service account token or calling fetch', async () => {
            const directories = { root: userRoot, backups: userRoot };

            // 1. Direct getGoogleApiConfigForSettings (used by vectors / operations / google endpoints)
            for (const authMode of ['express', 'full']) {
                await expect(getGoogleApiConfigForSettings(directories, {
                    api: 'vertexai',
                    vertexai_auth_mode: authMode,
                    vertexai_region: 'attacker.example/exfil#',
                }, 'gemini-2.5-flash')).rejects.toThrow(/Invalid Vertex AI region/);
            }
            expect(capturedFetches).toHaveLength(0);

            // 2. Google endpoints (/caption-image, /generate-native-tts, /generate-image, /generate-video)
            for (const endpoint of ['/api/google/caption-image', '/api/google/generate-native-tts', '/api/google/generate-image', '/api/google/generate-video']) {
                const res = await fetch(`${baseUrl}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api: 'vertexai',
                        vertexai_auth_mode: 'full',
                        vertexai_region: 'attacker.example/exfil#',
                        model: 'gemini-2.5-flash',
                        prompt: 'test',
                        text: 'test',
                        voice: 'Zephyr',
                        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    }),
                });
                expect(res.status).toBe(400);
            }
            expect(capturedFetches).toHaveLength(0);

            // 3. Chat Completions status check (/api/backends/chat-completions/status) in express & full modes
            for (const authMode of ['express', 'full']) {
                const statusRes = await fetch(`${baseUrl}/api/backends/chat-completions/status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                        vertexai_auth_mode: authMode,
                        vertexai_region: 'attacker.example/exfil#',
                    }),
                });
                expect(statusRes.status).toBe(400);
            }
            expect(capturedFetches).toHaveLength(0);

            // 4. Chat Completions generate (/api/backends/chat-completions/generate) in express & full modes
            for (const authMode of ['express', 'full']) {
                const genRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                        vertexai_auth_mode: authMode,
                        vertexai_region: 'attacker.example/exfil#',
                        model: 'gemini-2.5-flash',
                        messages: [{ role: 'user', content: 'Hello' }],
                    }),
                });
                expect(genRes.status).toBe(400);
            }
            expect(capturedFetches).toHaveLength(0);
        });

        test('rejects malicious vertexai_express_project_id and model path traversal with 400', async () => {
            const statusRes = await fetch(`${baseUrl}/api/backends/chat-completions/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                    vertexai_auth_mode: 'express',
                    vertexai_region: 'us-central1',
                    vertexai_express_project_id: 'proj/../../../../attacker',
                }),
            });
            expect(statusRes.status).toBe(400);

            const genRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                    vertexai_auth_mode: 'express',
                    vertexai_region: 'us-central1',
                    model: 'gemini-2.5-flash?key=override#',
                    messages: [{ role: 'user', content: 'Hello' }],
                }),
            });
            expect(genRes.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);
        });

        test('allows valid Vertex AI regional, global, and reverse_proxy requests across google.js and chat-completions.js', async () => {
            // 1. google.js caption-image with global region + full service account mode
            const capRes = await fetch(`${baseUrl}/api/google/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'vertexai',
                    vertexai_auth_mode: 'full',
                    vertexai_region: 'global',
                    model: 'gemini-2.5-flash',
                    prompt: 'Describe',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                }),
            });
            expect(capRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[0].url).toBe('https://oauth2.googleapis.com/token');
            expect(capturedFetches[1].url).toBe(
                'https://aiplatform.googleapis.com/v1/projects/synthetic-project-123/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
            );
            expect(capturedFetches[1].options.headers.Authorization).toBe('Bearer SYNTHETIC_GCP_ACCESS_TOKEN');

            // 2. chat-completions status check in express mode with regional endpoint
            capturedFetches = [];
            const statusRes = await fetch(`${baseUrl}/api/backends/chat-completions/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                    vertexai_auth_mode: 'express',
                    vertexai_region: 'europe-west4',
                    vertexai_express_project_id: 'my-express-proj',
                }),
            });
            expect(statusRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe(
                'https://europe-west4-aiplatform.googleapis.com/v1/projects/my-express-proj/locations/europe-west4/publishers/google/models?pageSize=1000',
            );
            expect(capturedFetches[0].options.headers['x-goog-api-key']).toBe('SYNTHETIC_VERTEXAI_EXPRESS_KEY');

            // 3. chat-completions generate in express mode and proxy mode
            capturedFetches = [];
            const genRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                    vertexai_auth_mode: 'express',
                    vertexai_region: 'us-central1',
                    model: 'gemini-2.5-flash',
                    stream: false,
                    messages: [{ role: 'user', content: 'Hello' }],
                }),
            });
            expect(genRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe(
                'https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=SYNTHETIC_VERTEXAI_EXPRESS_KEY',
            );

            capturedFetches = [];
            const proxyGenRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.VERTEXAI,
                    reverse_proxy: 'https://vertex-proxy.example/custom-prefix',
                    proxy_password: 'PROXY_SECRET',
                    model: 'gemini-2.5-flash',
                    stream: false,
                    messages: [{ role: 'user', content: 'Hello' }],
                }),
            });
            expect(proxyGenRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe(
                'https://vertex-proxy.example/custom-prefix/v1/publishers/google/models/gemini-2.5-flash:generateContent',
            );
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer PROXY_SECRET');
        });
    });

    describe('Azure OpenAI URL & deployment validation in chat-completions.js', () => {
        test('rejects same-origin path traversal and query/fragment injection in azure_deployment_name with 400', async () => {
            const statusRes = await fetch(`${baseUrl}/api/backends/chat-completions/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
                    azure_base_url: 'https://my-resource.openai.azure.com',
                    azure_deployment_name: '../../../../../other-path/exfil',
                    azure_api_version: '2024-02-01',
                }),
            });
            expect(statusRes.status).toBe(400);

            const genRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
                    azure_base_url: 'https://my-resource.openai.azure.com',
                    azure_deployment_name: 'deploy?api-version=override#',
                    azure_api_version: '2024-02-01',
                    messages: [{ role: 'user', content: 'Hi' }],
                }),
            });
            expect(genRes.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);
        });

        test('allows valid Azure OpenAI status and generate calls', async () => {
            const statusRes = await fetch(`${baseUrl}/api/backends/chat-completions/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
                    azure_base_url: 'https://my-resource.openai.azure.com',
                    azure_deployment_name: 'gpt-4o-deploy',
                    azure_api_version: '2024-02-01',
                }),
            });
            expect(statusRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[0].url).toBe('https://my-resource.openai.azure.com/openai/models?api-version=2024-02-01');
            expect(capturedFetches[1].url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-02-01');
        });
    });

    describe('Configurable custom endpoints and invalid reverse_proxy handling', () => {
        test('returns 400 (not 500) when reverse_proxy or server_url is malformed, has non-HTTP scheme, or includes query string', async () => {
            const genRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
                    reverse_proxy: 'ftp://invalid-scheme.example/v1',
                    proxy_password: 'test',
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hi' }],
                }),
            });
            expect(genRes.status).toBe(400);

            const queryProxyRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
                    reverse_proxy: 'https://proxy.example/v1?foo=bar',
                    proxy_password: 'test',
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hi' }],
                }),
            });
            expect(queryProxyRes.status).toBe(400);

            const queryCaptionRes = await fetch(`${baseUrl}/api/openai/caption-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'vllm',
                    server_url: 'http://127.0.0.1:8000/v1?foo=bar',
                    model: 'llava',
                    prompt: 'Describe',
                    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                }),
            });
            expect(queryCaptionRes.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);
        });

        test('preserves local/private custom_url for Custom chat completion and Custom OpenAI TTS', async () => {
            const customChatRes = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                    custom_url: 'http://127.0.0.1:8080/v1',
                    model: 'local-model',
                    stream: false,
                    messages: [{ role: 'user', content: 'Hi' }],
                }),
            });
            expect(customChatRes.status).toBe(200);
            expect(capturedFetches[0].url).toBe('http://127.0.0.1:8080/v1/chat/completions');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_CUSTOM_KEY');

            const customTtsRes = await fetch(`${baseUrl}/api/openai/custom/generate-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider_endpoint: 'http://127.0.0.1:8880/v1/audio/speech',
                    input: 'Hello local world',
                    voice: 'alloy',
                }),
            });
            expect(customTtsRes.status).toBe(200);
            expect(capturedFetches[1].url).toBe('http://127.0.0.1:8880/v1/audio/speech');
            expect(capturedFetches[1].options.headers.Authorization).toBe('Bearer SYNTHETIC_CUSTOM_TTS_KEY');
        });
    });

    describe('FN-MEDIUM-1: Text-completions, remote tokenizers, MiniMax TTS, and Volcengine TTS secret isolation', () => {
        test('setAdditionalHeadersByType only attaches fixed cloud textgen secrets to canonical provider origins', () => {
            const directories = { root: userRoot, backups: userRoot };
            const canonicalCases = [
                [TEXTGEN_TYPES.OPENROUTER, 'https://openrouter.ai/api', 'SYNTHETIC_OPENROUTER_KEY'],
                [TEXTGEN_TYPES.TOGETHERAI, 'https://api.together.xyz', 'SYNTHETIC_TOGETHERAI_KEY'],
                [TEXTGEN_TYPES.FEATHERLESS, 'https://api.featherless.ai/v1', 'SYNTHETIC_FEATHERLESS_KEY'],
                [TEXTGEN_TYPES.MANCER, 'https://neuro.mancer.tech', 'SYNTHETIC_MANCER_KEY'],
                [TEXTGEN_TYPES.INFERMATICAI, 'https://api.totalgpt.ai', 'SYNTHETIC_INFERMATICAI_KEY'],
                [TEXTGEN_TYPES.DREAMGEN, 'https://dreamgen.com', 'SYNTHETIC_DREAMGEN_KEY'],
                [TEXTGEN_TYPES.HUGGINGFACE, 'https://my-endpoint.endpoints.huggingface.cloud', 'SYNTHETIC_HUGGINGFACE_KEY'],
            ];

            for (const [type, validUrl, expectedSecret] of canonicalCases) {
                expect(isAllowedTextGenSecretTarget(type, validUrl)).toBe(true);
                expect(isAllowedTextGenSecretTarget(type, 'https://attacker.example/v1')).toBe(false);
                expect(isAllowedTextGenSecretTarget(type, 'http://127.0.0.1:8000')).toBe(false);

                const allowedHeaders = {};
                setAdditionalHeadersByType(allowedHeaders, type, validUrl, directories);
                expect(JSON.stringify(allowedHeaders)).toContain(expectedSecret);

                const blockedHeaders = {};
                setAdditionalHeadersByType(blockedHeaders, type, 'https://attacker.example/v1', directories);
                expect(blockedHeaders).toEqual({});
                expect(() => validateTextGenServerUrl(type, 'https://attacker.example/v1')).toThrow();
            }

            // Local/custom backends continue to attach their own secret to arbitrary user-configured servers
            const vllmHeaders = {};
            setAdditionalHeadersByType(vllmHeaders, TEXTGEN_TYPES.VLLM, 'http://127.0.0.1:8000', directories);
            expect(vllmHeaders.Authorization).toBe('Bearer SYNTHETIC_VLLM_KEY');
        });

        test('text-completions status, props, generate, and tabby/download reject non-canonical cloud server URLs and preserve canonical/local requests', async () => {
            for (const route of ['/api/backends/text-completions/status', '/api/backends/text-completions/props', '/api/backends/text-completions/generate']) {
                const badRes = await fetch(`${baseUrl}${route}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_type: TEXTGEN_TYPES.OPENROUTER,
                        api_server: 'https://attacker.example/api',
                        model: 'openai/gpt-4o',
                        prompt: 'Hello',
                    }),
                });
                expect(badRes.status).toBeGreaterThanOrEqual(400);
                expect(badRes.status).toBeLessThan(500);
            }
            expect(capturedFetches).toHaveLength(0);

            // Canonical OpenRouter text-completions generate succeeds and attaches SYNTHETIC_OPENROUTER_KEY
            const okCloudRes = await fetch(`${baseUrl}/api/backends/text-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_type: TEXTGEN_TYPES.OPENROUTER,
                    api_server: 'https://openrouter.ai/api',
                    model: 'openai/gpt-4o',
                    prompt: 'Hello',
                    stream: false,
                }),
            });
            expect(okCloudRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_OPENROUTER_KEY');

            // Local vLLM text-completions generate succeeds with local URL and attaches SYNTHETIC_VLLM_KEY
            const okLocalRes = await fetch(`${baseUrl}/api/backends/text-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_type: TEXTGEN_TYPES.VLLM,
                    api_server: 'http://127.0.0.1:8000/v1',
                    model: 'local-model',
                    prompt: 'Hello',
                    stream: false,
                }),
            });
            expect(okLocalRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[1].url).toBe('http://127.0.0.1:8000/v1/completions');
            expect(capturedFetches[1].options.headers.Authorization).toBe('Bearer SYNTHETIC_VLLM_KEY');

            // Tabby download binds strictly to TABBY secret, never spoofed api_type: 'openrouter'
            capturedFetches = [];
            nodeFetchMock.mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(JSON.stringify({ permission: 'admin' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }).mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const tabbyRes = await fetch(`${baseUrl}/api/backends/text-completions/tabby/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_type: TEXTGEN_TYPES.OPENROUTER,
                    api_server: 'http://127.0.0.1:5000',
                    repo_id: 'org/model',
                }),
            });
            expect(tabbyRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_TABBY_KEY');
            expect(JSON.stringify(capturedFetches[0].options.headers)).not.toContain('SYNTHETIC_OPENROUTER_KEY');
        });

        test('remote tokenizer encode never forwards cloud textgen secrets on spoofed api_type', async () => {
            nodeFetchMock.mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(JSON.stringify({ tokens: [1, 2, 3], count: 3 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const encodeRes = await fetch(`${baseUrl}/api/tokenizers/remote/textgenerationwebui/encode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'http://127.0.0.1:5000/v1',
                    api_type: TEXTGEN_TYPES.OPENROUTER,
                    text: 'Tokenize this',
                    model: 'local',
                }),
            });
            expect(encodeRes.status).toBe(200);
            expect(await encodeRes.json()).toEqual({ count: 3, ids: [1, 2, 3] });
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('http://127.0.0.1:5000/v1/internal/encode');
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_OOBA_KEY');
            expect(JSON.stringify(capturedFetches[0].options.headers)).not.toContain('SYNTHETIC_OPENROUTER_KEY');
        });

        test('MiniMax TTS validates apiHost against official MiniMax origins and validates returned audio URLs', async () => {
            expect(validateMiniMaxApiHost('https://api.minimax.io')).toBe('https://api.minimax.io');
            expect(validateMiniMaxApiHost('https://api.minimaxi.chat')).toBe('https://api.minimaxi.chat');
            expect(validateMiniMaxApiHost('https://api.minimax.chat')).toBe('https://api.minimax.chat');
            expect(() => validateMiniMaxApiHost('https://attacker.example')).toThrow();
            expect(() => validateMiniMaxApiHost('http://api.minimax.io')).toThrow();

            expect(validateMiniMaxAudioOutputUrl(
                'https://cdn.minimax.io/audio/output.mp3?token=signed',
                'https://api.minimax.io',
                ['SYNTHETIC_MINIMAX_KEY'],
            )).toBe('https://cdn.minimax.io/audio/output.mp3?token=signed');
            expect(() => validateMiniMaxAudioOutputUrl('http://127.0.0.1:8080/internal', 'https://api.minimax.io')).toThrow();
            expect(() => validateMiniMaxAudioOutputUrl('https://169.254.169.254/latest/meta-data', 'https://api.minimax.io')).toThrow();
            expect(() => validateMiniMaxAudioOutputUrl('http://cdn.minimax.io/audio/output.mp3', 'https://api.minimax.io')).toThrow();

            // 1. Rejects untrusted apiHost with 400 and 0 fetches
            const badHostRes = await fetch(`${baseUrl}/api/minimax/generate-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiHost: 'https://attacker.example',
                    text: 'Hello',
                    voiceId: 'voice-1',
                }),
            });
            expect(badHostRes.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);

            // 2. Rejects private/loopback responseData.data.url without fetching it
            nodeFetchMock.mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(JSON.stringify({
                    base_resp: { status_code: 0, status_msg: 'ok' },
                    data: { url: 'http://127.0.0.1:9000/secret-ssrf' },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const badAudioUrlRes = await fetch(`${baseUrl}/api/minimax/generate-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiHost: 'https://api.minimax.io',
                    text: 'Hello',
                    voiceId: 'voice-1',
                }),
            });
            expect(badAudioUrlRes.status).toBe(500);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://api.minimax.io/v1/t2a_v2?GroupId=SYNTHETIC_MINIMAX_GROUP');

            // 3. Rejects DNS-to-private/loopback rebinding on returned audio URL via safeFetchFollowRedirects
            capturedFetches = [];
            nodeFetchMock.mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(JSON.stringify({
                    base_resp: { status_code: 0, status_msg: 'ok' },
                    data: { url: 'https://rebind.minimax-cdn.example/audio/sample.mp3' },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const rebindAudioRes = await fetch(`${baseUrl}/api/minimax/generate-voice`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-test-dns-ip': '127.0.0.1',
                },
                body: JSON.stringify({
                    apiHost: 'https://api.minimax.io',
                    text: 'Hello',
                    voiceId: 'voice-1',
                }),
            });
            expect(rebindAudioRes.status).toBe(500);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://api.minimax.io/v1/t2a_v2?GroupId=SYNTHETIC_MINIMAX_GROUP');

            // 4. Allows valid official apiHost + public HTTPS CDN audio URL via safeFetchFollowRedirects (maxRedirects: 0 -> redirect: 'manual')
            capturedFetches = [];
            nodeFetchMock.mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(JSON.stringify({
                    base_resp: { status_code: 0, status_msg: 'ok' },
                    data: { url: 'https://cdn.minimax.io/audio/sample.mp3' },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }).mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                return new Response(Buffer.from('ID3-synthetic-mp3'), {
                    status: 200,
                    headers: { 'Content-Type': 'audio/mpeg' },
                });
            });

            const okRes = await fetch(`${baseUrl}/api/minimax/generate-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiHost: 'https://api.minimax.io',
                    text: 'Hello',
                    voiceId: 'voice-1',
                }),
            });
            expect(okRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(2);
            expect(capturedFetches[0].options.headers.Authorization).toBe('Bearer SYNTHETIC_MINIMAX_KEY');
            expect(capturedFetches[1].url).toBe('https://cdn.minimax.io/audio/sample.mp3');
            expect(capturedFetches[1].options.redirect).toBe('manual');
            expect(capturedFetches[1].options.agent).toBeDefined();
        });

        test('Volcengine TTS validates provider_endpoint against openspeech.bytedance.com before reading secrets', async () => {
            expect(validateVolcengineTtsEndpoint(undefined)).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
            expect(() => validateVolcengineTtsEndpoint('https://attacker.example/api/v3/tts/unidirectional')).toThrow();
            expect(() => validateVolcengineTtsEndpoint('http://openspeech.bytedance.com/api/v3/tts/unidirectional')).toThrow();

            const badRes = await fetch(`${baseUrl}/api/volcengine/generate-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider_endpoint: 'https://attacker.example/api/v3/tts/unidirectional',
                    resource_id: 'volc.service_type.10029',
                    text: 'Hello',
                    voice_speaker: 'zh_female_xiaohe_uranus_bigtts',
                }),
            });
            expect(badRes.status).toBe(400);
            expect(capturedFetches).toHaveLength(0);

            nodeFetchMock.mockImplementationOnce(async (url, options = {}) => {
                capturedFetches.push({ url: String(url), options });
                const line1 = JSON.stringify({ code: 0, data: Buffer.from('mp3-part').toString('base64') });
                const line2 = JSON.stringify({ code: 20000000 });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'Content-Type': 'application/json' }),
                    body: Readable.from([Buffer.from(`${line1}\n${line2}\n`)]),
                };
            });

            const okRes = await fetch(`${baseUrl}/api/volcengine/generate-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider_endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
                    resource_id: 'volc.service_type.10029',
                    text: 'Hello',
                    voice_speaker: 'zh_female_xiaohe_uranus_bigtts',
                }),
            });
            expect(okRes.status).toBe(200);
            expect(capturedFetches).toHaveLength(1);
            expect(capturedFetches[0].url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
            expect(capturedFetches[0].options.headers['X-Api-App-Id']).toBe('SYNTHETIC_VOLC_APP_ID');
            expect(capturedFetches[0].options.headers['X-Api-Access-Key']).toBe('SYNTHETIC_VOLC_ACCESS_KEY');
        });
    });
});

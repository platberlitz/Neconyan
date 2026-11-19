import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
    buildPixaiImageRequest,
    buildPixaiImageRequestFromSettings,
    createPixaiTask,
    getPixaiModes,
    getPixaiSize,
    normalizePixaiMode,
    PIXAI_CREATE_URL,
    PIXAI_DEFAULT_MODEL,
    PIXAI_MODELS,
    pollPixaiTask,
} from '../public/scripts/extensions/quick-image-gen/lib/pixai.js';
import { HOSTED_PROVIDER_IDS, PROVIDER_OUTPUT_HOST_SUFFIXES } from '../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { getProviderGenerationCapabilities } from '../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';
import { createEffectiveRequest, sanitizeReproducibleSettings } from '../public/scripts/extensions/quick-image-gen/lib/provider-contract.js';
import { materializeProviderImageSource } from '../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import { createSettingsExport, parseSettingsImport } from '../public/scripts/extensions/quick-image-gen/lib/settings-transfer.js';

const TSUBAKI_3 = '2024383379556065549';
const TSUBAKI_2 = '1983308862240288769';
const HARUKA = '1861558740588989558';
const HOSHINO = '1954632828118619567';
const LORA = '1234567890123456789';
const LORA_VERSION_LINK = 'https://pixai.art/model/9876543210987654321/1234567890123456788';
const IMAGE_URL = 'https://images-ng.pixai.art/images/orig/0f6a0d1c-2a39-4f10-9b9e-4c3f1d2e5a7b';
const OFFSITE_URL = 'https://storage.example/cat.png';
const CLOUDFRONT_URL = 'https://d2doj8oszwtcqy.cloudfront.net/images/temp/6a1f0c2e-8d4b-4e7a-9c3f-2b5d7e9a1c4f'
    + '?Expires=1795000000&Key-Pair-Id=K1QNL3S474VQ35&Signature=abc~def_ghi';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function scriptedFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected request to ${url}`);
        return typeof next === 'function' ? next(url, init) : next;
    };
    return { calls, fetchImpl };
}

describe('PixAI request body', () => {
    test('lists Tsubaki.3 first and uses it by default', () => {
        expect(PIXAI_DEFAULT_MODEL).toBe(TSUBAKI_3);
        expect(PIXAI_MODELS.map(model => [model.name, model.id])).toEqual([
            ['Tsubaki.3', TSUBAKI_3], ['Tsubaki.2', TSUBAKI_2], ['Haruka v2', HARUKA], ['Hoshino v2', HOSHINO],
        ]);
        expect(buildPixaiImageRequest({ prompt: 'cat' }).body.modelVersionId).toBe(TSUBAKI_3);
        expect(buildPixaiImageRequest({ model: '   ', prompt: 'cat' }).body.modelVersionId).toBe(TSUBAKI_3);
    });

    test.each([
        [1024, 1024, '1:1', '1k', 1024, 1024],
        [832, 1216, '2:3', '1k', 848, 1280],
        [1216, 832, '3:2', '1k', 1280, 848],
        [896, 1152, '3:4', '1k', 864, 1152],
        [768, 1280, '3:5', '1k', 768, 1280],
        [720, 1280, '9:16', '1k', 720, 1280],
        [1280, 720, '16:9', '1k', 1280, 720],
        [1920, 1088, '16:9', '1.5k', 1536, 864],
        [1536, 1536, '1:1', '1.5k', 1536, 1536],
        [512, 1536, '1:3', '1.5k', 512, 1536],
        [2048, 640, '3:1', '1.5k', 1536, 512],
        [1280, 1280, '1:1', '1k', 1024, 1024],
    ])('%i x %i maps to %s at %s', (width, height, aspectRatio, size, outWidth, outHeight) => {
        expect(getPixaiSize(width, height)).toEqual({ aspectRatio, size, width: outWidth, height: outHeight });
        const { body } = buildPixaiImageRequest({ prompt: 'cat', width, height });
        expect(body).toMatchObject({ aspectRatio, size });
        expect(body).not.toHaveProperty('width');
        expect(body).not.toHaveProperty('height');
    });

    test('Tsubaki models get mode and never sampling', () => {
        for (const model of [TSUBAKI_3, TSUBAKI_2]) {
            const { body, effectiveParameters } = buildPixaiImageRequest({
                model, prompt: 'cat', negative: 'blurry', width: 832, height: 1216, mode: 'pro',
                steps: 30, cfgScale: 6, sampler: 'euler_a', seed: 42,
            });
            expect(body).toEqual({
                modelVersionId: model, prompt: 'cat', negativePrompt: 'blurry', aspectRatio: '2:3', size: '1k',
                mode: 'pro', promptHelper: 'disable', batchSize: 1, seed: 42,
            });
            expect(effectiveParameters).toMatchObject({ model, width: 848, height: 1280, aspectRatio: '2:3', imageSize: '1k', seed: 42 });
            expect(effectiveParameters.steps).toBeUndefined();
            expect(effectiveParameters.sampler).toBeUndefined();
        }
    });

    test('sends only a mode the Tsubaki model offers', () => {
        const mode = (model, value) => buildPixaiImageRequest({ model, prompt: 'cat', mode: value }).body.mode;
        expect(getPixaiModes(TSUBAKI_3)).toEqual(['pro', 'ultra']);
        expect(getPixaiModes(TSUBAKI_2)).toEqual(['lite', 'standard', 'pro', 'ultra']);
        expect(getPixaiModes(HARUKA)).toEqual([]);
        expect(getPixaiModes('1234567890')).toEqual([]);
        for (const value of ['lite', 'standard', 'turbo', undefined]) expect(mode(TSUBAKI_3, value)).toBe('pro');
        expect(mode(TSUBAKI_3, 'ultra')).toBe('ultra');
        for (const value of ['lite', 'standard', 'pro', 'ultra']) expect(mode(TSUBAKI_2, value)).toBe(value);
        expect(mode(TSUBAKI_2, 'turbo')).toBe('standard');
        expect(buildPixaiImageRequest({ prompt: 'cat', mode: 'standard' }).body.mode).toBe('pro');
        expect(normalizePixaiMode('standard', TSUBAKI_3)).toBe('pro');
        expect(normalizePixaiMode('lite', TSUBAKI_2)).toBe('lite');
    });

    test('SDXL models get sampling and never mode', () => {
        const { body, effectiveParameters } = buildPixaiImageRequest({
            model: HARUKA, prompt: 'cat', mode: 'ultra', steps: 28, cfgScale: 6.5, sampler: 'dpm++_2m', seed: 7,
        });
        expect(body).not.toHaveProperty('mode');
        expect(body.sampling).toEqual({ method: 'DPM++ 2M Karras', steps: 28, cfgScale: 6.5 });
        expect(effectiveParameters).toMatchObject({ steps: 28, cfgScale: 6.5, sampler: 'DPM++ 2M Karras' });
        const unmapped = buildPixaiImageRequest({ model: HOSHINO, prompt: 'cat', steps: 500, cfgScale: 7, sampler: 'uni_pc' });
        expect(unmapped.body.sampling).toEqual({ steps: 100, cfgScale: 7 });
        expect(unmapped.effectiveParameters.sampler).toBeUndefined();
        expect(buildPixaiImageRequest({ model: HARUKA, prompt: 'c', steps: 0, sampler: 'restart' }).body.sampling)
            .toEqual({ method: 'Restart', steps: 1 });
    });

    test('a custom model version ID gets neither mode nor sampling', () => {
        const { body, family } = buildPixaiImageRequest({
            model: ' 1234567890 ', prompt: 'cat', mode: 'pro', steps: 20, cfgScale: 5, sampler: 'euler',
        });
        expect(family).toBe('');
        expect(body.modelVersionId).toBe('1234567890');
        expect(body).not.toHaveProperty('mode');
        expect(body).not.toHaveProperty('sampling');
    });

    test('always sends the prompt helper setting, defaulting to off', () => {
        expect(buildPixaiImageRequest({ prompt: 'cat' }).body.promptHelper).toBe('disable');
        expect(buildPixaiImageRequest({ prompt: 'cat', promptHelper: 'medium' }).body.promptHelper).toBe('medium');
        expect(buildPixaiImageRequest({ prompt: 'cat', promptHelper: 'yes please' }).body.promptHelper).toBe('disable');
    });

    test('shortens prompts to the model limit without splitting a character', () => {
        const long = 'a'.repeat(12_000);
        expect(buildPixaiImageRequest({ model: TSUBAKI_3, prompt: long }).body.prompt).toHaveLength(10_000);
        expect(buildPixaiImageRequest({ model: HARUKA, prompt: long }).body.prompt).toHaveLength(4096);
        expect(buildPixaiImageRequest({ model: '42', prompt: long }).body.prompt).toHaveLength(4096);
        expect(buildPixaiImageRequest({ prompt: 'cat', negative: long }).body.negativePrompt).toHaveLength(4096);
        const emoji = `${'b'.repeat(4095)}🐱`;
        expect(buildPixaiImageRequest({ model: HARUKA, prompt: emoji }).body.prompt).toBe('b'.repeat(4095));
        expect(buildPixaiImageRequest({ prompt: 'cat', negative: '  ' }).body).not.toHaveProperty('negativePrompt');
        expect(() => buildPixaiImageRequest({ prompt: '   ' })).toThrow('PixAI needs a prompt');
    });

    test('sends only whole, non-negative seeds', () => {
        expect(buildPixaiImageRequest({ prompt: 'cat', seed: 0 }).body.seed).toBe(0);
        for (const seed of [-1, 1.5, Number.NaN, undefined, 2 ** 60]) {
            expect(buildPixaiImageRequest({ prompt: 'cat', seed }).body).not.toHaveProperty('seed');
        }
    });

    test('reads Quick Image Gen settings', () => {
        const { body } = buildPixaiImageRequestFromSettings({
            pixaiModel: HARUKA, pixaiMode: 'pro', pixaiPromptHelper: 'enable',
            pixaiLoras: ` ${LORA}: 0.8 , ${LORA_VERSION_LINK}, 1234567890123456787:0 `,
            width: 1024, height: 1024, steps: 25, cfgScale: 7, sampler: 'euler_a',
        }, 'cat', 'dog', 9);
        expect(body).toEqual({
            modelVersionId: HARUKA, prompt: 'cat', negativePrompt: 'dog', aspectRatio: '1:1', size: '1k',
            promptHelper: 'enable', batchSize: 1, seed: 9, sampling: { method: 'Euler a', steps: 25, cfgScale: 7 },
            loras: [{ modelId: LORA, weight: 0.8 }, { modelId: '1234567890123456788', weight: 1 }, { modelId: '1234567890123456787', weight: 0 }],
        });
    });

    test('only sends LoRAs when set, alongside a separate negative prompt', () => {
        for (const pixaiLoras of [undefined, '', '  ']) {
            expect(buildPixaiImageRequestFromSettings({ pixaiLoras }, 'cat', 'dog', 9).body).not.toHaveProperty('loras');
        }
        const { body } = buildPixaiImageRequestFromSettings({ pixaiLoras: `${LORA_VERSION_LINK}/:.65` }, 'cat', 'dog', 9);
        expect(body).toMatchObject({ modelVersionId: TSUBAKI_3, mode: 'pro', prompt: 'cat', negativePrompt: 'dog',
            loras: [{ modelId: '1234567890123456788', weight: 0.65 }] });
    });

    test.each([
        ['some-name', 'enter the version ID or the PixAI version link'],
        ['https://pixai.art/model/9876543210987654321', 'enter the version ID or the PixAI version link'],
        [LORA_VERSION_LINK.replace('pixai.art', 'pixai.art.example'), 'enter the version ID or the PixAI version link'],
        [`${LORA}, `, 'LoRA 2: enter the version ID'],
        [`${LORA_VERSION_LINK}, 1234567890123456788`, 'LoRA 2: this version is already in the list'],
        [`${LORA}:`, 'use a weight between 0 and 1'],
        [`${LORA}:1.01`, 'use a weight between 0 and 1'],
        [`${LORA}:-0.1`, 'use a weight between 0 and 1'],
        [`${LORA}:0x1`, 'use a weight between 0 and 1'],
        [[LORA], 'comma-separated list'],
    ])('rejects an invalid LoRA list (%s)', (pixaiLoras, error) => {
        expect(() => buildPixaiImageRequestFromSettings({ pixaiLoras }, 'cat', '', 9)).toThrow(error);
    });

    test('enforces the PixAI API limit', () => {
        const ids = Array.from({ length: 16 }, (_, index) => `12345678901234567${10 + index}`);
        const request = values => buildPixaiImageRequestFromSettings({ pixaiLoras: values.join(',') }, 'cat', '', 9);
        expect(request(ids.slice(0, 15)).body.loras).toHaveLength(15);
        expect(() => request(ids)).toThrow('Use at most 15 PixAI LoRAs');
    });
});

describe('PixAI task polling', () => {
    const noWait = [];
    const wait = async (ms) => { noWait.push(ms); };

    test('submits once with the key and surfaces the provider error plainly', async () => {
        const ok = scriptedFetch([json({ id: '1943547603237249965', status: 'waiting' }, 201)]);
        await expect(createPixaiTask({ body: { prompt: 'cat' }, apiKey: ' secret ', fetchImpl: ok.fetchImpl }))
            .resolves.toBe('1943547603237249965');
        expect(ok.calls[0].url).toBe(PIXAI_CREATE_URL);
        expect(ok.calls[0].init.method).toBe('POST');
        expect(ok.calls[0].init.headers.Authorization).toBe('Bearer secret');
        expect(JSON.parse(ok.calls[0].init.body)).toEqual({ prompt: 'cat' });

        const broke = scriptedFetch([json({ code: 'INSUFFICIENT_BALANCE', status: 403, message: 'Not enough credits' }, 403)]);
        await expect(createPixaiTask({ body: {}, apiKey: 'k', fetchImpl: broke.fetchImpl }))
            .rejects.toThrow('PixAI image request failed (403 INSUFFICIENT_BALANCE): Not enough credits');
        const denied = scriptedFetch([json({ code: 'UNAUTHORIZED', status: 401, message: 'Invalid token' }, 401)]);
        await expect(createPixaiTask({ body: {}, apiKey: 'k', fetchImpl: denied.fetchImpl }))
            .rejects.toThrow('PixAI rejected the API key (401 UNAUTHORIZED): Invalid token');
        const noId = scriptedFetch([json({ status: 'waiting' }, 201)]);
        await expect(createPixaiTask({ body: {}, apiKey: 'k', fetchImpl: noId.fetchImpl })).rejects.toThrow('PixAI did not return a task ID');
    });

    test('keeps polling through an early 404 and a running task, then returns the image', async () => {
        noWait.length = 0;
        const { calls, fetchImpl } = scriptedFetch([
            json({ code: 'NOT_FOUND', status: 404, message: 'Task not found' }, 404),
            json({ id: 't1', status: 'waiting', outputs: { mediaIds: [], mediaUrls: [] } }),
            json({ id: 't1', status: 'running' }),
            json({ code: 'UNAVAILABLE', status: 503, message: 'busy' }, 503),
            json({ id: 't1', status: 'completed', outputs: { seed: '42', mediaIds: ['m1'], mediaUrls: [IMAGE_URL] } }),
        ]);
        await expect(pollPixaiTask({ taskId: 't1', apiKey: 'secret', fetchImpl, wait })).resolves.toBe(IMAGE_URL);
        expect(calls.map(call => call.url)).toEqual(Array(5).fill('https://api.pixai.art/v2/task/t1'));
        expect(calls.every(call => call.init.headers.Authorization === 'Bearer secret')).toBe(true);
        expect(noWait.every(ms => ms >= 1500)).toBe(true);
    });

    test('reports a failed task with its message', async () => {
        const { fetchImpl } = scriptedFetch([json({ id: 't2', status: 'failed',
            taskStatusMsgI18n: { key: 'nsfw', defaultMessage: 'The prompt was rejected by moderation' } })]);
        await expect(pollPixaiTask({ taskId: 't2', apiKey: 'k', fetchImpl, wait }))
            .rejects.toThrow('PixAI image failed: The prompt was rejected by moderation');
        const cancelled = scriptedFetch([json({ id: 't3', status: 'cancelled' })]);
        await expect(pollPixaiTask({ taskId: 't3', apiKey: 'k', fetchImpl: cancelled.fetchImpl, wait }))
            .rejects.toThrow('PixAI image cancelled');
    });

    test('looks up the image address when the task has no media URL yet', async () => {
        const { calls, fetchImpl } = scriptedFetch([
            json({ id: 't4', status: 'completed', outputs: { mediaIds: ['1943547603237249965'], mediaUrls: [null] } }),
            json([{ id: '1943547603237249965', type: 'IMAGE', urls: [
                { variant: 'THUMBNAIL', url: 'https://images-ng.pixai.art/images/thumb/x' },
                { variant: 'PUBLIC', url: IMAGE_URL },
            ] }]),
        ]);
        await expect(pollPixaiTask({ taskId: 't4', apiKey: 'k', fetchImpl, wait })).resolves.toBe(IMAGE_URL);
        expect(calls[1].url).toBe('https://api.pixai.art/v2/media/batch?ids=1943547603237249965');
        expect(new URL(calls[1].url).origin).toBe('https://api.pixai.art');
    });

    test('looks up the same media ID instead of using an off-domain task URL', async () => {
        const { calls, fetchImpl } = scriptedFetch([
            json({ status: 'completed', outputs: { mediaIds: ['m1'], mediaUrls: [OFFSITE_URL] } }),
            json([
                { id: 'other', urls: [{ variant: 'PUBLIC', url: 'https://images-ng.pixai.art/images/orig/other' }] },
                { id: 'm1', urls: [{ variant: 'PRIVATE', url: OFFSITE_URL }, { variant: 'PUBLIC', url: IMAGE_URL }] },
            ]),
        ]);
        const signal = new AbortController().signal;
        await expect(pollPixaiTask({ taskId: 't4', apiKey: 'k', fetchImpl, wait, signal })).resolves.toBe(IMAGE_URL);
        expect(calls.map(call => call.url)).toEqual([
            'https://api.pixai.art/v2/task/t4', 'https://api.pixai.art/v2/media/batch?ids=m1',
        ]);
        expect(calls[1].init).toEqual({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer k' }, signal });
    });

    test('uses the signed CloudFront address PixAI really returns, without a lookup', async () => {
        const { calls, fetchImpl } = scriptedFetch([
            json({ id: 't4', status: 'completed', outputs: { seed: '7', mediaIds: ['m1'], mediaUrls: [CLOUDFRONT_URL] } }),
        ]);
        await expect(pollPixaiTask({ taskId: 't4', apiKey: 'k', fetchImpl, wait })).resolves.toBe(CLOUDFRONT_URL);
        expect(calls).toHaveLength(1);
    });

    test('does not trust other CloudFront distributions', async () => {
        const other = 'https://dabc123example.cloudfront.net/images/temp/x';
        const { calls, fetchImpl } = scriptedFetch([
            json({ status: 'completed', outputs: { mediaIds: ['m1'], mediaUrls: [other] } }),
            json([{ id: 'm1', urls: [{ variant: 'PUBLIC', url: other }] }]),
        ]);
        await expect(pollPixaiTask({ taskId: 't5', apiKey: 'k', fetchImpl, wait }))
            .rejects.toThrow('PixAI returned an image address outside its own image hosts');
        expect(calls).toHaveLength(2);
    });

    test('refuses an off-domain task URL without a media ID', async () => {
        const offsite = scriptedFetch([json({ status: 'completed', outputs: { mediaUrls: [OFFSITE_URL] } })]);
        await expect(pollPixaiTask({ taskId: 't5', apiKey: 'k', fetchImpl: offsite.fetchImpl, wait }))
            .rejects.toThrow('PixAI returned an image address outside its own image hosts');
        expect(offsite.calls).toHaveLength(1);
    });

    test.each([
        ['an off-domain public URL', { id: 'm1', urls: [{ variant: 'PUBLIC', url: OFFSITE_URL }] },
            'PixAI returned an image address outside its own image hosts'],
        ['another media ID', { id: 'other', urls: [{ variant: 'PUBLIC', url: IMAGE_URL }] },
            'PixAI finished, but its image address is unavailable'],
    ])('refuses a lookup that only returns %s', async (_label, media, error) => {
        const { calls, fetchImpl } = scriptedFetch([
            json({ status: 'completed', outputs: { mediaIds: ['m1'], mediaUrls: [OFFSITE_URL] } }),
            json([media]),
        ]);
        await expect(pollPixaiTask({ taskId: 't5', apiKey: 'k', fetchImpl, wait })).rejects.toThrow(error);
        expect(calls.map(call => call.url)).toEqual([
            'https://api.pixai.art/v2/task/t5', 'https://api.pixai.art/v2/media/batch?ids=m1',
        ]);
    });

    test('stops after a lasting 404 and reports a task with no outputs', async () => {
        const gone = scriptedFetch(Array.from({ length: 11 }, () => json({ code: 'NOT_FOUND', status: 404, message: 'Task not found' }, 404)));
        await expect(pollPixaiTask({ taskId: 't6', apiKey: 'k', fetchImpl: gone.fetchImpl, wait }))
            .rejects.toThrow('PixAI status check failed (404 NOT_FOUND): Task not found');
        expect(gone.calls).toHaveLength(11);
        const lost = scriptedFetch([json({ status: 'running' }), json({ code: 'NOT_FOUND', status: 404, message: 'gone' }, 404)]);
        await expect(pollPixaiTask({ taskId: 't7', apiKey: 'k', fetchImpl: lost.fetchImpl, wait })).rejects.toThrow('404 NOT_FOUND');
        const empty = scriptedFetch([json({ status: 'completed', outputs: { mediaIds: [], mediaUrls: [] } })]);
        await expect(pollPixaiTask({ taskId: 't8', apiKey: 'k', fetchImpl: empty.fetchImpl, wait })).rejects.toThrow('PixAI finished without an image');
    });

    test('stops polling when cancelled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('Generation cancelled', 'AbortError'));
        await expect(pollPixaiTask({ taskId: 't9', apiKey: 'k', fetchImpl: () => { throw new Error('polled'); }, signal: controller.signal }))
            .rejects.toThrow('Generation cancelled');
    });
});

describe('PixAI in Quick Image Gen', () => {
    test('downloads the finished image without sending the key to the image host', async () => {
        const calls = [];
        const result = await materializeProviderImageSource(IMAGE_URL, {
            requestUrl: PIXAI_CREATE_URL,
            headers: { Authorization: 'Bearer secret' },
            fetchImpl: async (url, init) => {
                calls.push({ url, init });
                return new Response(PNG, { headers: { 'content-type': 'image/png' } });
            },
            allowBrowserFallback: false,
            forceFetch: true,
            allowedHostSuffixes: PROVIDER_OUTPUT_HOST_SUFFIXES.pixai,
            credentialHostSuffixes: [],
            credentialOrigins: [],
        });
        expect(result).toMatch(/^data:image\/png;base64,/);
        expect(calls).toHaveLength(1);
        expect(calls[0].init.headers).toEqual({});
        await expect(materializeProviderImageSource(CLOUDFRONT_URL, {
            requestUrl: PIXAI_CREATE_URL,
            headers: { Authorization: 'Bearer secret' },
            fetchImpl: async (url, init) => {
                calls.push({ url, init });
                return new Response(PNG, { headers: { 'content-type': 'image/webp' } });
            },
            allowBrowserFallback: false,
            forceFetch: true,
            allowedHostSuffixes: PROVIDER_OUTPUT_HOST_SUFFIXES.pixai,
            credentialHostSuffixes: [],
            credentialOrigins: [],
        })).resolves.toMatch(/^data:image\//);
        expect(calls[1].url).toBe(CLOUDFRONT_URL);
        expect(calls[1].init.headers).toEqual({});
        for (const url of ['https://dabc123example.cloudfront.net/x.png', 'https://evil-d2doj8oszwtcqy.cloudfront.net/x.png']) {
            await expect(materializeProviderImageSource(url, {
                requestUrl: PIXAI_CREATE_URL, forceFetch: true, allowedHostSuffixes: PROVIDER_OUTPUT_HOST_SUFFIXES.pixai,
                fetchImpl: () => { throw new Error('fetched'); },
            })).rejects.toThrow('untrusted host');
        }
        await expect(materializeProviderImageSource('https://pixai.art.evil.example/x.png', {
            requestUrl: PIXAI_CREATE_URL, forceFetch: true, allowedHostSuffixes: PROVIDER_OUTPUT_HOST_SUFFIXES.pixai,
            fetchImpl: () => { throw new Error('fetched'); },
        })).rejects.toThrow('untrusted host');
    });

    test('is a hosted provider whose sampling controls follow the model', () => {
        expect(HOSTED_PROVIDER_IDS.has('pixai')).toBe(true);
        const tsubaki = getProviderGenerationCapabilities('pixai', { pixaiModel: TSUBAKI_3 });
        expect(tsubaki).toMatchObject({ steps: false, cfgScale: false, sampler: false, seed: true, referenceImages: false });
        expect(getProviderGenerationCapabilities('pixai', { pixaiModel: '987' })).toEqual(tsubaki);
        expect(getProviderGenerationCapabilities('pixai', { pixaiModel: HOSHINO }))
            .toMatchObject({ steps: true, cfgScale: true, sampler: true, seed: true, referenceImages: false });
    });

    test('records the model, mode, prompt helper and LoRAs but never the key', () => {
        const settings = {
            provider: 'pixai', pixaiKey: 'secret-key', pixaiModel: TSUBAKI_3, pixaiMode: 'pro', pixaiPromptHelper: 'low',
            pixaiLoras: `${LORA}:0.8`,
            width: 832, height: 1216, steps: 30, cfgScale: 6, sampler: 'euler_a', seed: 5,
        };
        const snapshot = sanitizeReproducibleSettings(settings);
        expect(snapshot).toMatchObject({ provider: 'pixai', pixaiModel: TSUBAKI_3, pixaiMode: 'pro', pixaiPromptHelper: 'low', pixaiLoras: `${LORA}:0.8` });
        expect(sanitizeReproducibleSettings({ ...settings, provider: 'civitai' })).not.toHaveProperty('pixaiLoras');
        expect(JSON.stringify(snapshot)).not.toContain('secret-key');
        const request = createEffectiveRequest(settings, { model: TSUBAKI_3 });
        expect(request.parameters).toMatchObject({ model: TSUBAKI_3, width: 848, height: 1280, seed: 5 });
        expect(request.parameters).not.toHaveProperty('steps');
        expect(request.parameters).not.toHaveProperty('sampler');
    });

    test('transfers PixAI LoRAs without transferring the API key', () => {
        const exported = createSettingsExport({ activeSettings: {
            provider: 'pixai', pixaiKey: 'secret-key', pixaiModel: HARUKA, pixaiMode: 'lite', pixaiPromptHelper: 'disable',
            pixaiLoras: `${LORA_VERSION_LINK}, ${LORA}:0.8`,
        } });
        expect(exported.activeSettings).toMatchObject({ provider: 'pixai', pixaiModel: HARUKA, pixaiMode: 'lite', pixaiLoras: `${LORA_VERSION_LINK}, ${LORA}:0.8` });
        expect(exported.activeSettings).not.toHaveProperty('pixaiKey');
        const imported = parseSettingsImport(JSON.stringify({ version: 7, activeSettings: {
            provider: 'pixai', pixaiKey: 'smuggled', pixaiModel: TSUBAKI_2, pixaiMode: 'ultra', pixaiPromptHelper: 'medium',
            pixaiLoras: exported.activeSettings.pixaiLoras,
        } }));
        expect(imported.activeSettings).toMatchObject({ provider: 'pixai', pixaiModel: TSUBAKI_2, pixaiMode: 'ultra', pixaiPromptHelper: 'medium', pixaiLoras: `${LORA_VERSION_LINK}, ${LORA}:0.8` });
        expect(imported.activeSettings).not.toHaveProperty('pixaiKey');
    });

    test('wires PixAI into the provider list, generator and settings section', () => {
        const index = source('public/scripts/extensions/quick-image-gen/index.js');
        expect(index).toContain('pixai: { name: "PixAI", needsKey: true }');
        expect(index).toContain('pixai: genPixAI,');
        expect(index).toContain('pixai: "pixaiKey",');
        expect(index).toContain('<div id="qig-pixai-settings" class="qig-provider-section">');
        expect(index).toMatch(/case "pixai":\s*\/\/[^\n]*\n\s*return \{ requestUrl: PIXAI_CREATE_URL,/);
        expect(index).toContain('credentialOrigins: provider === "replicate" ? ["https://api.replicate.com"] : [],');
    });
});

import { describe, expect, test } from '@jest/globals';
import { buildGptImagePayload, buildImageResponsesPayload, extractProviderImageSource,
    getGptImageApiUrl, getOpenAICompatibleApiUrl, requestGptImageWithRouteRetry, usesImageResponsesApi } from '../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';

describe('Responses image proxy compatibility', () => {
    test.each(['sunburst', 'flare', 'sunburst-2026-09-10'])('routes %s through Responses with the proxy namespace intact', variant => {
        const model = `gpt-image-2.5-${variant}`;
        for (const suffix of ['', '/v1', '/images', '/images/generations', '/chat/completions', '/responses/']) {
            const base = `https://proxy.example.test/openai${suffix}?token=test`;
            const expected = `https://proxy.example.test/openai${suffix === '/v1' ? '/v1' : ''}/responses?token=test`;
            expect(getGptImageApiUrl(base, model)).toBe(expected);
            expect(getOpenAICompatibleApiUrl(base, 'responses')).toBe(expected);
        }
    });

    test('keeps ordinary GPT Image and chat proxy routing', () => {
        expect(usesImageResponsesApi('https://proxy.example.test/v1', 'gpt-image-2')).toBe(false);
        expect(usesImageResponsesApi('', 'gpt-image-2.5-flare')).toBe(false);
        expect(getGptImageApiUrl('https://proxy.example.test/v1', 'gpt-image-2')).toBe('https://proxy.example.test/v1/images/generations');
        expect(getGptImageApiUrl()).toBe('https://api.openai.com/v1/images/generations');
        expect(getOpenAICompatibleApiUrl('https://proxy.example.test/v1', 'chat_completions')).toBe('https://proxy.example.test/v1/chat/completions');
        expect(buildGptImagePayload({ model: 'gpt-image-2', prompt: 'cat', size: '1024x1024' })).toEqual({
            model: 'gpt-image-2', prompt: 'cat', size: '1024x1024', n: 1,
        });
    });

    test('puts the image model and options on a forced image tool, and actual references in input', () => {
        const reference = 'data:image/png;base64,reference-bytes';
        const body = buildImageResponsesPayload({ model: 'gpt-image-2.5-flare', prompt: 'portrait', negative: 'blur',
            size: '1024x1536', quality: 'high', outputFormat: 'webp', references: [reference], instructions: 'Keep the outfit.' });
        expect(body).toEqual({ model: 'gpt-5.5', instructions: 'Keep the outfit.',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'portrait\n\nAvoid in the image: blur' },
                { type: 'input_image', image_url: reference, detail: 'high' }] }],
            tools: [{ type: 'image_generation', model: 'gpt-image-2.5-flare', action: 'edit', size: '1024x1536', quality: 'high', output_format: 'webp' }],
            tool_choice: { type: 'image_generation' } });
        expect(buildImageResponsesPayload({ model: 'gpt-image-2.5-sunburst', prompt: 'cat' }).tools[0].action).toBe('generate');
    });

    test('never resubmits a rejected Responses request to an images endpoint', async () => {
        const calls = [];
        await expect(requestGptImageWithRouteRetry('https://proxy.example.test/v1/responses', async url => {
            calls.push(url);
            return { ok: false, status: 404, data: { error: { message: 'Proxy error (HTTP 404 Not Found): requested proxy endpoint does not exist' } } };
        })).rejects.toThrow('404');
        expect(calls).toEqual(['https://proxy.example.test/v1/responses']);
    });

    test('accepts only a completed image tool result, never a text link or partial image', () => {
        const image = { type: 'image_generation_call', status: 'completed', result: 'image-bytes' };
        const data = { object: 'response', status: 'completed', output: [
            { type: 'message', content: [{ type: 'output_text', text: 'https://example.test/not-the-image.png' }] }, image,
        ] };
        expect(extractProviderImageSource(data)).toBe('data:image/png;base64,image-bytes');
        expect(extractProviderImageSource({ output: [image] }, { defaultMime: 'image/webp' })).toBe('data:image/webp;base64,image-bytes');
        for (const status of ['failed', 'incomplete', 'in_progress', 'cancelled']) {
            expect(extractProviderImageSource({ ...data, status })).toBeNull();
            expect(extractProviderImageSource({ ...data, output: [{ ...image, status }] })).toBeNull();
        }
        expect(extractProviderImageSource({ ...data, output: [data.output[0]] })).toBeNull();
        expect(extractProviderImageSource({ ...data, error: { message: 'failed' } })).toBeNull();
    });
});

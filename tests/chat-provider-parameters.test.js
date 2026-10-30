import { describe, expect, test } from '@jest/globals';

import { createChatGenerationParameters } from '../public/scripts/chat-provider-parameters.js';

const baseSettings = {
    chat_completion_source: 'openai',
    temp_openai: 1,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    top_p_openai: 1,
    typical_p_openai: 1,
    n: 1,
};

const context = {
    appendReasoning: messages => messages,
    userName: 'User',
    characterName: 'Character',
    getGroupNames: () => [],
    getLogitBias: async () => ({}),
    getStoppingStrings: () => [],
    getIncludeReasoning: () => false,
    getReasoningEffort: () => undefined,
    getVerbosity: () => undefined,
    canPerformToolCalls: () => false,
    registerTools: async () => {},
    reverseProxySources: [],
    validateReverseProxy: () => {},
    getAssistantPrefill: () => '',
    getServiceTier: async () => undefined,
    getSamplerMetadata: () => undefined,
};

async function buildImageFields(imageSettings) {
    const { generate_data: data } = await createChatGenerationParameters(
        { ...baseSettings, ...imageSettings }, 'gpt-4o', 'normal', [{ role: 'user', content: 'Hello' }], context);
    return { resolution: data.request_image_resolution, aspectRatio: data.request_image_aspect_ratio };
}

describe('chat generation image request settings', () => {
    test.each([
        ['missing', {}],
        ['null', { request_image_resolution: null, request_image_aspect_ratio: null }],
    ])('sends empty strings when both image settings are %s', async (_label, imageSettings) => {
        expect(await buildImageFields(imageSettings)).toEqual({ resolution: '', aspectRatio: '' });
    });

    test('sends an empty aspect ratio when only the resolution is saved', async () => {
        expect(await buildImageFields({ request_image_resolution: '2K' })).toEqual({ resolution: '2K', aspectRatio: '' });
    });

    test('sends an empty resolution when only the aspect ratio is saved', async () => {
        expect(await buildImageFields({ request_image_aspect_ratio: '16:9' })).toEqual({ resolution: '', aspectRatio: '16:9' });
    });

    test('forwards chosen values unchanged', async () => {
        expect(await buildImageFields({ request_image_resolution: '2K', request_image_aspect_ratio: '16:9' })).toEqual({ resolution: '2K', aspectRatio: '16:9' });
    });

    test('keeps empty strings empty', async () => {
        expect(await buildImageFields({ request_image_resolution: '', request_image_aspect_ratio: '' })).toEqual({ resolution: '', aspectRatio: '' });
    });
});

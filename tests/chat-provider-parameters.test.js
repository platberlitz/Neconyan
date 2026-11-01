import { describe, expect, test } from '@jest/globals';

import { createChatGenerationParameters } from '../public/scripts/chat-provider-parameters.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

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

test('captures bound reasoning intent and metadata before an asynchronous bias lookup', async () => {
    const model = 'fixture/model';
    const metadata = { source: 'openrouter', model, reasoning: { mandatory: true, supported_efforts: ['future'] } };
    const settings = { ...baseSettings, chat_completion_source: 'openrouter', reasoning_effort: 'none',
        bias_preset_selected: 'selected', bias_presets: { selected: [{ text: 'test', value: -1 }] } };
    let resumeBias;
    let enterBias;
    const entered = new Promise(resolve => { enterBias = resolve; });
    const waiting = new Promise(resolve => { resumeBias = resolve; });
    const pending = createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
        ...context,
        getSamplerMetadata: () => metadata,
        getReasoningEffort: snapshot => resolveChatReasoningEffort(settings, model, undefined, snapshot),
        getLogitBias: async () => { enterBias(); await waiting; return {}; },
    });
    await entered;
    settings.chat_completion_source = 'custom';
    settings.reasoning_effort = 'high';
    metadata.reasoning.mandatory = false;
    resumeBias();
    const { generate_data: data } = await pending;
    expect(data.chat_completion_source).toBe('openrouter');
    expect(data.reasoning_effort).toBe('none');
    expect(data.model_sampler_metadata).toEqual({ source: 'openrouter', model, reasoning: { mandatory: true, supported_efforts: ['future'] } });
});

test.each(['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'anthropic/claude-fable-5'])(
    'retains declared OpenRouter effort for %s until the final guard', async model => {
        for (const effort of ['high', 'low', 'none']) {
            const metadata = { source: 'openrouter', model, reasoning: { supported_efforts: ['high', 'max'], mandatory: true } };
            const settings = { ...baseSettings, chat_completion_source: 'openrouter', reasoning_effort: effort };
            const { generate_data: data } = await createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
                ...context, getSamplerMetadata: () => metadata,
                getReasoningEffort: snapshot => resolveChatReasoningEffort(settings, model, undefined, snapshot),
            });
            expect(data.reasoning_effort).toBe(effort);
            expect(data.model_sampler_metadata).toEqual(metadata);
            expect(data.temperature).toBeUndefined();
            expect(data.top_p).toBeUndefined();
        }
    },
);

test('keeps existing Claude-family omission for unknown, stale and non-OpenRouter declarations', async () => {
    const model = 'anthropic/claude-sonnet-5';
    for (const [source, metadata] of [
        ['openrouter', undefined],
        ['openrouter', { source: 'openrouter', model: `${model}:free`, reasoning: { supported_efforts: ['high'] } }],
        ['custom', { source: 'openrouter', model, reasoning: { supported_efforts: ['high'] } }],
    ]) {
        const settings = { ...baseSettings, chat_completion_source: source, reasoning_effort: 'high' };
        const { generate_data: data } = await createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
            ...context, getSamplerMetadata: () => metadata,
            getReasoningEffort: snapshot => resolveChatReasoningEffort(settings, model, undefined, snapshot),
        });
        expect(data.reasoning_effort).toBeUndefined();
        expect(data.temperature).toBeUndefined();
    }
});

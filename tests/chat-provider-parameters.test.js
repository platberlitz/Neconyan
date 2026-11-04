import { describe, expect, jest, test } from '@jest/globals';

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

test.each(['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'anthropic/claude-fable-5'])(
    'retains declared NanoGPT effort for %s', async model => {
        for (const effort of ['high', 'low']) {
            const metadata = { source: 'nanogpt', model, reasoning_efforts: ['low', 'high'] };
            const settings = { ...baseSettings, chat_completion_source: 'nanogpt', reasoning_effort: effort };
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

const nanoClaudeModel = 'anthropic/claude-sonnet-5';
test.each([
    ['nanogpt', undefined],
    ['nanogpt', { source: 'nanogpt', model: `${nanoClaudeModel}:online`, reasoning_efforts: ['high'] }],
    ['nanogpt', { source: 'nanogpt', model: nanoClaudeModel, reasoning_efforts: [] }],
    ['nanogpt', { source: 'nanogpt', model: nanoClaudeModel, reasoning_efforts: ['auto'] }],
    ['custom', undefined],
    ['custom', { source: 'nanogpt', model: nanoClaudeModel, reasoning_efforts: ['low', 'high'] }],
])('keeps Claude-family omission for undeclared NanoGPT and for sources that do not preserve (%s, %j)', async (source, metadata) => {
    const model = nanoClaudeModel;
    const settings = { ...baseSettings, chat_completion_source: source, reasoning_effort: 'high' };
    const { generate_data: data } = await createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
        ...context, getSamplerMetadata: () => metadata,
        getReasoningEffort: snapshot => resolveChatReasoningEffort(settings, model, undefined, snapshot),
    });
    expect(data.reasoning_effort).toBeUndefined();
    expect(data.temperature).toBeUndefined();
});

test('captures future native route with reasoning intent before asynchronous bias', async () => {
    const model = 'anthropic/claude-sonnet-5-future';
    const settings = { ...baseSettings, chat_completion_source: 'openai', reasoning_effort: 'none',
        bias_preset_selected: 'selected', bias_presets: { selected: [{ text: 'test', value: -1 }] } };
    let release;
    let entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const pending = createChatGenerationParameters(settings, model, 'normal', [{ role: 'user', content: 'Hello' }], {
        ...context, getReasoningEffort: () => resolveChatReasoningEffort(settings, model),
        getLogitBias: async () => { entered(); await waiting; return {}; },
    });
    await ready;
    settings.chat_completion_source = 'custom';
    settings.reverse_proxy = 'https://fixture.invalid';
    settings.reasoning_effort = 'high';
    release();
    const { generate_data: data } = await pending;
    expect(data.chat_completion_source).toBe('openai');
    expect(data.reasoning_effort).toBe('none');
    expect(data.temperature).toBeUndefined();
});

test('builds one request from the settings as they were before the bias lookup', async () => {
    const settings = { ...baseSettings, chat_completion_source: 'openrouter', temp_openai: 0.7, top_p_openai: 0.9, openai_max_tokens: 400, seed: 5,
        show_thoughts: false, verbosity: 'low', tools_on: false, openrouter_providers: ['A'], openrouter_middleout: 'off',
        openrouter_service_tier: 'flex', openrouter_allow_fallbacks: true,
        bias_preset_selected: 's', bias_presets: { s: [{ text: 'a', value: 1 }] } };
    const registerSpy = jest.fn(async () => {});
    let release;
    let enter;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = createChatGenerationParameters(settings, 'gpt-4o', 'normal', [{ role: 'user', content: 'Hello' }], {
        ...context,
        getLogitBias: async () => { enter(); await gate; return { 1: 1 }; },
        getIncludeReasoning: () => settings.show_thoughts,
        getVerbosity: () => settings.verbosity,
        canPerformToolCalls: () => settings.tools_on,
        registerTools: registerSpy,
        reverseProxySources: ['openrouter'],
    });
    await entered;
    Object.assign(settings, { chat_completion_source: 'nanogpt', temp_openai: 1.5, top_p_openai: 0.1, openai_max_tokens: 9, seed: 99,
        show_thoughts: true, verbosity: 'high', tools_on: true, openrouter_middleout: 'on', openrouter_service_tier: 'priority',
        openrouter_allow_fallbacks: false, nanogpt_provider: 'P', reverse_proxy: 'https://later.invalid' });
    settings.openrouter_providers.push('B');
    release();
    const { generate_data: data } = await pending;
    expect(data.chat_completion_source).toBe('openrouter');
    expect(data.temperature).toBe(0.7);
    expect(data.top_p).toBe(0.9);
    expect(data.max_tokens).toBe(400);
    expect(data.seed).toBe(5);
    expect(data.include_reasoning).toBe(false);
    expect(data.verbosity).toBe('low');
    expect(data.provider).toEqual(['A']);
    expect(data.middleout).toBe('off');
    expect(data.service_tier).toBe('flex');
    expect(data.allow_fallbacks).toBe(true);
    expect(data.logit_bias).toEqual({ 1: 1 });
    expect(data).not.toHaveProperty('nanogpt_provider');
    expect(data).not.toHaveProperty('reverse_proxy');
    expect(registerSpy).not.toHaveBeenCalled();
    expect(settings.openrouter_providers).toEqual(['A', 'B']);
});

test('keeps NanoGPT fields and service tier from before a held tool registration', async () => {
    const settings = { ...baseSettings, chat_completion_source: 'nanogpt', temp_openai: 0.7, nanogpt_provider: 'P1',
        nanogpt_allowed_providers: ['A'], nanogpt_ignored_providers: [], nanogpt_payg_override: false, nanogpt_service_tier: 'priority' };
    let release;
    let enter;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = createChatGenerationParameters(settings, 'gpt-4o', 'normal', [{ role: 'user', content: 'Hello' }], {
        ...context,
        canPerformToolCalls: () => true,
        registerTools: async () => { enter(); await gate; },
        getServiceTier: async () => settings.nanogpt_service_tier,
    });
    await entered;
    Object.assign(settings, { chat_completion_source: 'openrouter', temp_openai: 1.5, nanogpt_provider: 'P2', nanogpt_service_tier: 'flex' });
    settings.nanogpt_allowed_providers.push('B');
    release();
    const { generate_data: data } = await pending;
    expect(data.chat_completion_source).toBe('nanogpt');
    expect(data.temperature).toBe(0.7);
    expect(data.nanogpt_provider).toBe('P1');
    expect(data.nanogpt_allowed_providers).toEqual(['A']);
    expect(data.nanogpt_payg_override).toBe(false);
    expect(data.service_tier).toBe('priority');
    expect(data).not.toHaveProperty('provider');
    expect(data).not.toHaveProperty('middleout');
});

test('does not throw on settings holding uncloneable nested values', async () => {
    const settings = { ...baseSettings, opaque: { callback() {} } };
    await expect(createChatGenerationParameters(settings, 'gpt-4o', 'normal', [{ role: 'user', content: 'Hello' }], context))
        .resolves.toMatchObject({ generate_data: { temperature: 1 } });
});

test.each(['https://b.invalid', ''])('validates the reverse proxy that the request sends when the setting changes to %j during a held bias lookup', async changed => {
    const settings = { ...baseSettings, chat_completion_source: 'openai', reverse_proxy: 'https://a.invalid', proxy_password: 'one',
        bias_preset_selected: 's', bias_presets: { s: [{ text: 'a', value: 1 }] } };
    const validate = jest.fn(async () => {});
    let release;
    let enter;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = createChatGenerationParameters(settings, 'gpt-4o', 'normal', [{ role: 'user', content: 'Hello' }], {
        ...context,
        reverseProxySources: ['openai'],
        validateReverseProxy: validate,
        getLogitBias: async () => { enter(); await gate; return { 1: 1 }; },
    });
    await entered;
    settings.reverse_proxy = changed;
    settings.proxy_password = 'two';
    release();
    const { generate_data: data } = await pending;
    expect(data.reverse_proxy).toBe('https://a.invalid');
    expect(data.proxy_password).toBe('one');
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0][0]).toBe(data.reverse_proxy);
});

describe('stopping strings and the assistant prefill come from the moment the request starts', () => {
    const bias = { bias_preset_selected: 's', bias_presets: { s: [{ text: 'a', value: 1 }] } };
    function liveContext(holdAt, overrides = {}) {
        const live = { stops: ['early'], prefill: 'early' };
        let release;
        let enter;
        const gate = new Promise(resolve => { release = resolve; });
        const entered = new Promise(resolve => { enter = resolve; });
        const hold = async () => { enter(); await gate; };
        const holds = {
            bias: { getLogitBias: async () => { await hold(); return { 1: 1 }; } },
            service: { getServiceTier: async () => { await hold(); return undefined; } },
            proxy: { reverseProxySources: ['claude'], validateReverseProxy: hold },
            tools: { canPerformToolCalls: () => true, registerTools: hold },
        };
        return {
            live, entered, release,
            context: {
                ...context,
                getStoppingStrings: limit => (limit > 0 ? live.stops.slice(0, limit) : [...live.stops]),
                getAssistantPrefill: () => live.prefill,
                ...holds[holdAt],
                ...overrides,
            },
        };
    }
    async function buildDuringChange(settings, model, type, holdAt) {
        const { live, entered, release, context: requestContext } = liveContext(holdAt);
        const pending = createChatGenerationParameters(settings, model, type, [{ role: 'user', content: 'Hello' }], requestContext);
        await entered;
        live.stops = ['later'];
        live.prefill = 'later';
        release();
        return (await pending).generate_data;
    }

    test.each([
        ['openai', 'a held bias lookup', { chat_completion_source: 'openai', ...bias }, 'gpt-4o', 'bias'],
        ['nanogpt', 'a held service tier lookup', { chat_completion_source: 'nanogpt' }, 'gpt-4o', 'service'],
        ['claude', 'a held proxy confirmation', { chat_completion_source: 'claude', reverse_proxy: 'https://a.invalid' }, 'claude-sonnet-4-5', 'proxy'],
        ['makersuite', 'a held tool registration', { chat_completion_source: 'makersuite' }, 'gemini-2.5-pro', 'tools'],
    ])('%s sends the stopping strings from before %s', async (_source, _wait, extra, model, holdAt) => {
        const data = await buildDuringChange({ ...baseSettings, ...extra }, model, 'normal', holdAt);
        expect(data.stop).toEqual(['early']);
    });

    test.each([
        ['claude', 'a held proxy confirmation', { chat_completion_source: 'claude', reverse_proxy: 'https://a.invalid' }, 'claude-sonnet-4-5', 'proxy'],
        ['linkapi (Anthropic format)', 'a held tool registration', { chat_completion_source: 'linkapi' }, 'claude-sonnet-4-5', 'tools'],
    ])('%s sends the assistant prefill from before %s', async (_source, _wait, extra, model, holdAt) => {
        const data = await buildDuringChange({ ...baseSettings, ...extra }, model, 'normal', holdAt);
        expect(data.assistant_prefill).toBe('early');
    });

    test('reads the stopping strings once per request', async () => {
        const getStoppingStrings = jest.fn(() => ['a']);
        await createChatGenerationParameters({ ...baseSettings, chat_completion_source: 'claude' }, 'claude-sonnet-4-5', 'normal',
            [{ role: 'user', content: 'Hello' }], { ...context, getStoppingStrings });
        expect(getStoppingStrings).toHaveBeenCalledTimes(1);
        expect(getStoppingStrings.mock.calls[0][0]).toBeUndefined();
    });

    test.each([
        ['openai', 'normal', {}, 'gpt-4o'],
        ['makersuite', 'normal', {}, 'gemini-2.5-pro'],
        ['linkapi', 'normal', {}, 'gpt-5'],
        ['claude', 'quiet', {}, 'claude-sonnet-4-5'],
        ['claude', 'continue', { continue_prefill: true }, 'claude-sonnet-4-5'],
    ])('does not build an assistant prefill for %s %s requests that send none (%j)', async (source, type, extra, model) => {
        const getAssistantPrefill = jest.fn(() => 'x');
        const { generate_data: data } = await createChatGenerationParameters({ ...baseSettings, chat_completion_source: source, ...extra }, model, type,
            [{ role: 'user', content: 'Hello' }], { ...context, getAssistantPrefill });
        expect(getAssistantPrefill).not.toHaveBeenCalled();
        expect(data).not.toHaveProperty('assistant_prefill');
    });

    test('builds the prefill once for a Claude continue without its own prefill', async () => {
        const getAssistantPrefill = jest.fn(() => 'x');
        const { generate_data: data } = await createChatGenerationParameters({ ...baseSettings, chat_completion_source: 'claude', continue_prefill: false },
            'claude-sonnet-4-5', 'continue', [{ role: 'user', content: 'Hello' }], { ...context, getAssistantPrefill });
        expect(getAssistantPrefill).toHaveBeenCalledTimes(1);
        expect(data.assistant_prefill).toBe('x');
    });

    test.each([
        ['openai', 'gpt-4o', ['a', 'x'.repeat(17), 'c', 'd']],
        ['claude', 'claude-sonnet-4-5', ['a', 'x'.repeat(17), 'c', 'd', 'e', 'f']],
        ['makersuite', 'gemini-2.5-pro', ['a', 'c', 'd', 'e']],
        ['zai', 'glm-4.6', ['a']],
    ])('applies the %s stop limit to the captured strings', async (source, model, expected) => {
        const stops = ['a', 'x'.repeat(17), 'c', 'd', 'e', 'f'];
        const { generate_data: data } = await createChatGenerationParameters({ ...baseSettings, chat_completion_source: source }, model, 'normal',
            [{ role: 'user', content: 'Hello' }], { ...context, getStoppingStrings: limit => (limit > 0 ? stops.slice(0, limit) : [...stops]) });
        expect(data.stop).toEqual(expected);
    });
});

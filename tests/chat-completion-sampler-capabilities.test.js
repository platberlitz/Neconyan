import { describe, expect, test } from '@jest/globals';
import { checkNanoGptReasoningEffort, getNanoGptReasoningCapabilities, resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

import {
    buildChatCompletionSamplerMetadata,
    filterChatCompletionSamplingParameters,
    getChatCompletionSamplerCapabilities,
} from '../public/scripts/openai-model-capabilities.js';

const allSamplers = {
    temperature: 1.4,
    top_p: 0.8,
    frequency_penalty: 0.2,
    presence_penalty: 0.3,
    top_k: 40,
    min_p: 0.2,
    top_a: 0.1,
    typical_p: 0.6,
    repetition_penalty: 1.2,
    seed: 7,
};

function supported(source, model, metadata) {
    return getChatCompletionSamplerCapabilities({ source, model, metadata }).supported;
}

describe('NanoGPT declared reasoning capabilities', () => {
    const model = 'z-ai/glm-5.2:thinking';
    const metadata = { source: 'nanogpt', model, reasoning_efforts: ['high', 'max'] };
    const check = (effort, declaration = metadata, identity = {}) => checkNanoGptReasoningEffort({ source: 'nanogpt', model, metadata: declaration, effort, ...identity });

    test('retains the bound raw declaration without changing sampler metadata policy', () => {
        const record = { reasoning_efforts: ['High', 'max'], supported_parameters: ['temperature'] };
        const built = buildChatCompletionSamplerMetadata('nanogpt', model, record);
        expect(built.reasoning_efforts).toEqual(['High', 'max']);
        expect(built.reasoning_efforts).not.toBe(record.reasoning_efforts);
        expect(supported('nanogpt', model, built)).toEqual(['temperature']);
        expect(buildChatCompletionSamplerMetadata('nanogpt', model, { reasoning_efforts: 'high' }).reasoning_efforts).toBe('high');
        expect(buildChatCompletionSamplerMetadata('openrouter', model, record)).not.toHaveProperty('reasoning_efforts');
    });

    test('marks known unsupported choices without changing the saved input or display resolver', () => {
        const settings = { chat_completion_source: 'nanogpt', reasoning_effort: 'low' };
        expect(check('low')).toMatchObject({ known: true, supported: false, supportedEfforts: ['high', 'max'] });
        expect(resolveChatReasoningEffort(settings, model, [{ id: model, reasoning_efforts: ['high', 'max'] }])).toBe('low');
        expect(settings.reasoning_effort).toBe('low');
        expect(check(' HIGH ').supported).toBe(true);
        expect(check('max').supported).toBe(true);
        expect(check('none').supported).toBe(false);
    });

    test.each([
        ['absent', undefined], ['null', null], ['array metadata', []],
        ['missing declaration', { source: 'nanogpt', model }],
        ['wrong source', { ...metadata, source: 'openrouter' }],
        ['base variant', { ...metadata, model: 'z-ai/glm-5.2' }],
        ['online variant', { ...metadata, model: `${model}:online` }],
        ['string declaration', { ...metadata, reasoning_efforts: 'high,max' }],
        ['mixed malformed array', { ...metadata, reasoning_efforts: ['high', null] }],
        ['empty declaration', { ...metadata, reasoning_efforts: [] }],
        ['blanks', { ...metadata, reasoning_efforts: [' ', ''] }],
        ['Auto only', { ...metadata, reasoning_efforts: ['auto'] }],
        ['future only', { ...metadata, reasoning_efforts: ['FutureRung', 'auto'] }],
    ])('keeps compatibility for %s', (_name, declaration) => {
        expect(checkNanoGptReasoningEffort({ source: 'nanogpt', model, metadata: declaration, effort: 'low' })).toMatchObject({ known: false, supported: true });
    });

    test('does not borrow a native declaration for another source or incomplete model identity', () => {
        expect(check('low', metadata, { source: 'custom' })).toMatchObject({ known: false, supported: true });
        expect(check('low', { source: 'nanogpt', reasoning_efforts: ['high'] }, { model: undefined }).known).toBe(false);
    });

    test.each([undefined, null, '', ' ', 'auto', ' AUTO '])('preserves legacy omission %p', effort => {
        expect(check(effort).supported).toBe(true);
    });

    test('recognises Minimum aliases, explicit None and exact opaque mixed values without mutation', () => {
        const declaration = Object.freeze({ source: 'nanogpt', model,
            reasoning_efforts: Object.freeze(['minimal', ' None ', 'HIGH', 'FutureRung', 'high']) });
        expect(getNanoGptReasoningCapabilities({ source: 'nanogpt', model, metadata: declaration })).toEqual({
            known: true, declaredEfforts: ['min', 'none', 'high', 'FutureRung'], supportedEfforts: ['none', 'min', 'high'],
        });
        for (const effort of ['min', 'MINIMAL', 'none', 'FutureRung']) expect(check(effort, declaration).supported).toBe(true);
        expect(check('futurerung', declaration).supported).toBe(false);
        expect(declaration.reasoning_efforts).toEqual(['minimal', ' None ', 'HIGH', 'FutureRung', 'high']);
    });

    test('preserves ElectronHub omission semantics independently of NanoGPT enforcement', () => {
        const settings = { chat_completion_source: 'electronhub', reasoning_effort: 'low' };
        expect(resolveChatReasoningEffort(settings, model, [{ id: model, metadata: { supported_reasoning_efforts: ['low'] } }])).toBe('low');
        expect(resolveChatReasoningEffort(settings, model, [{ id: model, metadata: { supported_reasoning_efforts: ['high'] } }])).toBeUndefined();
        expect(resolveChatReasoningEffort(settings, model, [{ id: model }])).toBeUndefined();
    });
});

describe('Chat Completion sampler capabilities', () => {
    test('uses conservative source defaults and independent Typical P support', () => {
        expect(supported('openai', 'gpt-4o')).toEqual(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed']);
        expect(supported('openrouter', 'qwen/qwen3')).not.toContain('typical_p');
        expect(supported('nanogpt', 'unknown-model')).toEqual(['temperature', 'top_p']);
        expect(supported('cometapi', 'anything')).toEqual([]);
    });

    test('requires an exact metadata fingerprint and fails closed when the match is malformed', () => {
        const metadata = buildChatCompletionSamplerMetadata('custom', 'local-model', {
            supported_parameters: ['temperature', 'top_k', 'typical_p'],
        });
        expect(supported('custom', 'local-model', metadata)).toEqual(['temperature', 'top_k', 'typical_p']);
        expect(supported('custom', 'other-model', metadata)).toEqual(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed']);
        expect(supported('custom', 'local-model', { source: 'custom', model: 'local-model', supported_parameters: 'top_k' })).toEqual([]);
        expect(supported('custom', 'local-model', { source: 'custom', model: 'local-model', supported_parameters: [] })).toEqual([]);
    });

    test('never enables OpenRouter Typical P through model metadata', () => {
        const metadata = { source: 'openrouter', model: 'vendor/model', supported_parameters: ['temperature', 'top_p', 'typical_p', 'top_k'] };
        expect(supported('openrouter', 'vendor/model', metadata)).toEqual(['temperature', 'top_p', 'top_k']);
    });

    test('applies NanoGPT model identity and explicit metadata conservatively', () => {
        expect(supported('nanogpt', 'openai/gpt-oss-20b')).toContain('typical_p');
        expect(supported('nanogpt', 'openai/gpt-oss-20b:tee')).toContain('top_a');
        expect(supported('nanogpt', 'openai/gpt-oss-20b')).not.toContain('seed');
        expect(supported('nanogpt', 'gpt-4.1')).toEqual(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']);
        expect(supported('nanogpt', 'claude-sonnet-5', {
            source: 'nanogpt',
            model: 'claude-sonnet-5',
            open_weights: true,
        })).toEqual([]);
        expect(supported('nanogpt', 'custom-open-model', {
            source: 'nanogpt',
            model: 'custom-open-model',
            open_weights: true,
            supported_parameters: ['temperature', 'top_p', 'seed'],
        })).toEqual(['temperature', 'top_p', 'seed']);
    });

    test('NanoGPT metadata narrows family limits and malformed records fail closed', () => {
        for (const [model, allowed] of [
            ['openai/gpt-4o', ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed']],
            ['anthropic/claude-sonnet-4', ['temperature', 'top_p', 'top_k', 'seed']],
            ['google/gemini-2.5-flash', ['temperature', 'top_p', 'top_k', 'seed']],
            ['moonshot/kimi-k3', ['seed']],
        ]) {
            expect([...supported('nanogpt', model, { source: 'nanogpt', model, open_weights: true, supported_parameters: Object.keys(allSamplers) })].sort()).toEqual(allowed.sort());
        }
        const model = 'openai/gpt-oss-20b';
        expect(supported('nanogpt', model, buildChatCompletionSamplerMetadata('nanogpt', model, { supported_parameters: 'invalid' }))).toEqual([]);
        expect(supported('nanogpt', model, { source: 'nanogpt', model, supported_parameters: [] })).toEqual([]);
        expect(supported('nanogpt', 'unknown', { source: 'nanogpt', model: 'unknown', supported_parameters: ['frequency_penalty', 'presence_penalty'] })).toEqual(['frequency_penalty', 'presence_penalty']);
    });

    test('applies model restrictions and provider ranges without changing saved settings', () => {
        expect(supported('openai', 'o4-mini')).toEqual(['seed']);
        expect(supported('moonshot', 'kimi-k2.5')).toEqual([]);
        expect(supported('custom', 'kimi-k2.5')).toContain('temperature');
        expect(supported('openai', 'gpt-5.1')).toEqual(['temperature', 'top_p', 'seed']);
        expect(supported('openai', 'gpt-5-chat-latest')).toContain('frequency_penalty');
        expect(supported('xai', 'grok-4')).not.toEqual(expect.arrayContaining(['frequency_penalty', 'presence_penalty']));

        const cohere = getChatCompletionSamplerCapabilities({ source: 'cohere', model: 'command-r' });
        expect(cohere.ranges.top_p).toEqual({ min: 0.01, max: 0.99, step: 0.01 });
        expect(cohere.ranges.frequency_penalty).toEqual({ min: 0, max: 1, step: 0.01 });
        expect(getChatCompletionSamplerCapabilities({ source: 'workers_ai', model: 'llama' }).ranges.top_k.max).toBe(50);
        const workersRequest = { chat_completion_source: 'workers_ai', model: 'llama', top_p: 0 };
        filterChatCompletionSamplingParameters(workersRequest);
        expect(workersRequest.top_p).toBe(0.001);

        const request = { chat_completion_source: 'cohere', model: 'command-r', ...allSamplers };
        filterChatCompletionSamplingParameters(request);
        expect(request.top_p).toBe(0.8);
        expect(request.frequency_penalty).toBe(0.2);
        expect(request.model_sampler_metadata).toBeUndefined();
    });

    test('uses LinkAPI wire format and keeps internal metadata off the wire', () => {
        expect(supported('linkapi', 'claude-sonnet-4')).toEqual(['temperature', 'top_p', 'top_k']);
        expect(supported('linkapi', 'gemini-2.5-flash')).toEqual(['temperature', 'top_p', 'top_k', 'seed']);
        expect(supported('linkapi', 'gemini-3.7-flash')).toEqual(['seed']);
        const request = {
            chat_completion_source: 'linkapi',
            model: 'claude-sonnet-4',
            ...allSamplers,
            model_sampler_metadata: { source: 'linkapi', model: 'claude-sonnet-4', supported_parameters: ['top_a'] },
        };
        filterChatCompletionSamplingParameters(request);
        expect(request).toEqual({ chat_completion_source: 'linkapi', model: 'claude-sonnet-4' });
        expect(request).not.toHaveProperty('top_a');
        expect(request).not.toHaveProperty('model_sampler_metadata');
    });
});

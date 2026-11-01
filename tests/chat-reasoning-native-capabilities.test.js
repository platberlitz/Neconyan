import { describe, expect, test } from '@jest/globals';
import { checkChatReasoningEffort, getChatReasoningCapabilities, getNativeReasoningRoute } from '../public/scripts/chat-reasoning-capabilities.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

const openai = [
    ['gpt-5', ['min', 'low', 'medium', 'high']], ['gpt-5-2025-08-07', ['min', 'low', 'medium', 'high']],
    ['gpt-5.1', ['none', 'low', 'medium', 'high']], ['gpt-5.1-2025-11-13', ['none', 'low', 'medium', 'high']],
    ['gpt-5.2', ['none', 'low', 'medium', 'high', 'xhigh']], ['gpt-5.2-2025-12-11', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh']], ['gpt-5.5-2026-04-23', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
];
const fixtures = [
    ...['openai', 'openai_responses'].flatMap(source => openai.map(([model, efforts]) => [source, model, efforts])),
    ...['gemini-3.8-flash', 'gemini-3.1-pro-preview'].map(model => ['makersuite', model, ['low', 'medium', 'high']]),
    ...['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'].map(model => ['makersuite', model, ['min', 'low', 'medium', 'high']]),
    ['vertexai', 'gemini-3.1-pro-preview', ['low', 'medium', 'high']], ['vertexai', 'gemini-3-flash-preview', ['min', 'low', 'medium', 'high']],
    ['deepseek', 'deepseek-v4-pro', ['none', 'low', 'high', 'max']], ['moonshot', 'kimi-k3', ['low', 'high', 'max']],
    ...['glm-5.3', 'glm-5.3-flash'].map(model => ['zai', model, ['low', 'high', 'max']]),
    ['minimax', 'MiniMax-M3.1-Flash', ['low', 'medium', 'high', 'xhigh', 'max']],
    ...['mistral-small-2603', 'mistral-medium-3-5'].map(model => ['mistralai', model, ['none', 'high']]),
    ['mistralai', 'mistral-large-4-0', ['low', 'medium', 'high']], ['mistralai', 'zai-glm-5-3', ['low', 'high', 'max']],
    ...['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].flatMap(model => ['groq', 'aimlapi'].map(source => [source, model, ['low', 'medium', 'high']])),
    ['groq', 'qwen/qwen3.8-27b', ['none', 'low', 'medium', 'high']], ['groq', 'meta-models/muse-spark-open', ['low', 'medium', 'high', 'xhigh']],
    ...['accounts/fireworks/models/gpt-oss-20b', 'accounts/fireworks/models/gpt-oss-120b'].map(model => ['fireworks', model, ['low', 'medium', 'high']]),
];
const route = source => getNativeReasoningRoute({ chat_completion_source: source }, { googleApiVersion: 'v1beta' });

describe('finite native reasoning contracts', () => {
    test.each(fixtures)('%s %s exposes the exact documented choices', (source, model, supportedEfforts) => {
        const identity = { source, model, route: route(source) };
        expect(getChatReasoningCapabilities(identity)).toMatchObject({ state: 'effort-list', supportedEfforts, provenance: `${source}-documentation` });
        for (const value of ['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']) {
            expect(checkChatReasoningEffort({ ...identity, effort: value }).supported).toBe(supportedEfforts.includes(value));
        }
        expect(checkChatReasoningEffort({ ...identity, effort: 'auto' }).supported).toBe(true);
        expect(checkChatReasoningEffort({ ...identity, model: `${model}:unlisted` }).state).toBe('unknown');
        expect(checkChatReasoningEffort({ ...identity, route: { ...identity.route, reverseProxy: 'https://proxy.invalid' } }).state).toBe('unknown');
    });

    test('treats Groq default as an exact explicit value, never an eighth UI option', () => {
        const identity = { source: 'groq', model: 'qwen/qwen3.8-27b', route: route('groq') };
        expect(checkChatReasoningEffort({ ...identity, effort: 'default' }).supported).toBe(true);
        expect(checkChatReasoningEffort({ ...identity, effort: 'Default' }).supported).toBe(false);
        expect(getChatReasoningCapabilities(identity).supportedEfforts).not.toContain('default');
    });

    test('requires matching Google version, Vertex native auth and provider endpoint', () => {
        const google = { source: 'makersuite', model: 'gemini-3.8-flash' };
        expect(getChatReasoningCapabilities({ ...google, route: getNativeReasoningRoute({ chat_completion_source: 'makersuite' }) }).state).toBe('unknown');
        expect(getChatReasoningCapabilities({ ...google, route: { ...route('makersuite'), googleApiVersion: 'v1' } }).state).toBe('unknown');
        const vertex = { source: 'vertexai', model: 'gemini-3-flash-preview' };
        expect(getChatReasoningCapabilities({ ...vertex, route: { ...route('vertexai'), vertexAuthMode: 'full' } }).state).toBe('effort-list');
        expect(getChatReasoningCapabilities({ ...vertex, route: { ...route('vertexai'), vertexAuthMode: 'proxy' } }).state).toBe('unknown');
        expect(getChatReasoningCapabilities({ source: 'minimax', model: 'MiniMax-M3.1-Flash', route: { ...route('minimax'), minimaxEndpoint: 'cn' } }).state).toBe('unknown');
        expect(getChatReasoningCapabilities({ source: 'zai', model: 'glm-5.3', route: { ...route('zai'), zaiEndpoint: 'coding' } }).state).toBe('unknown');
    });

    test('does not inherit native tables for aliases, deployments or other source names', () => {
        for (const [source, model] of [['openai', 'gpt-5.4'], ['openai', 'gpt-5.1-chat-latest'], ['vertexai', 'gemini-3.8-flash'],
            ['azure_openai', 'gpt-5.1'], ['custom', 'gpt-5.1'], ['linkapi', 'kimi-k3'], ['mistralai', 'mistral-large-4']]) {
            expect(getChatReasoningCapabilities({ source, model, route: route(source) }).state).toBe('unknown');
        }
    });

    test('preserves a native unsupported None until the final guard and leaves proxy compatibility alone', () => {
        const settings = { chat_completion_source: 'openai', reasoning_effort: 'none' };
        expect(resolveChatReasoningEffort(settings, 'gpt-5')).toBe('none');
        expect(checkChatReasoningEffort({ source: 'openai', model: 'gpt-5', route: route('openai'), effort: 'none' }).supported).toBe(false);
        expect(resolveChatReasoningEffort({ ...settings, reverse_proxy: 'https://proxy.invalid' }, 'gpt-5')).toBeUndefined();
        expect(resolveChatReasoningEffort({ chat_completion_source: 'makersuite', reasoning_effort: 'none' }, 'gemini-3.8-flash')).toBe('none');
    });
});

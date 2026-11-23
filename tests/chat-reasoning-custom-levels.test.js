import { describe, expect, test } from '@jest/globals';
import {
    CUSTOM_COMPATIBLE_EFFORTS,
    CUSTOM_EFFORT_ALIASES,
    REASONING_CONTROL_VALUES,
    checkChatReasoningEffort,
    customReasoningLevelsApplicable,
    getChatReasoningCapabilities,
    getNativeReasoningRoute,
    resolveCustomReasoningModel,
    resolveKnownInvalidNoneEffort,
} from '../public/scripts/chat-reasoning-capabilities.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

const customSettings = { chat_completion_source: 'custom', custom_reasoning_param_format: 'openai', custom_reasoning_param_name: 'reasoning_effort', custom_reasoning_documented_levels: true };
const customRoute = (overrides = {}) => getNativeReasoningRoute({ ...customSettings, ...overrides });
const lookup = id => resolveCustomReasoningModel(id)?.id ?? null;
const allRows = Object.entries(CUSTOM_COMPATIBLE_EFFORTS).flatMap(([maker, rows]) => Object.entries(rows).map(([id, efforts]) => ({ maker, id: id.toLowerCase(), efforts })));

describe('resolveCustomReasoningModel', () => {
    test.each([
        ['smol-openai/gpt-6.1-sol', 'gpt-6.1-sol'], ['[free]gpt-6.1-sol', 'gpt-6.1-sol'], ['gpt-5.5-2026-04-23', 'gpt-5.5-2026-04-23'],
        ['smol-openai/gpt-6.2-astra', 'gpt-6.2-astra'], ['smol-google/gemini-4-neon', 'gemini-4-neon'],
        ['smol-google/gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'], ['glm-5.3-flash-free', 'glm-5.3-flash'],
        ['[free]glm-5.3', 'glm-5.3'], ['smol-alibaba/glm-5.3', 'glm-5.3'], ['smol-glm/glm-5.3-flashx', 'glm-5.3-flashx'],
        ['smol-kimi/kimi-k3.1-pro-highspeed', 'kimi-k3.1-pro-highspeed'], ['[free][kimi]moonshotai/kimi-k3.1-pro-highspeed', 'kimi-k3.1-pro-highspeed'],
        ['[kimi] kimi-k3.1-pro', 'kimi-k3.1-pro'], ['[free]kimi-k3', 'kimi-k3'], ['smol-alibaba/kimi-k3', 'kimi-k3'],
        ['accounts/fireworks/models/kimi-k3', 'kimi-k3'], ['deepseek-v4-pro-0813', 'deepseek-v4-pro'],
        ['smol-alibaba/deepseek-v4-pro-0813', 'deepseek-v4-pro'], ['deepseek-v4-flash-0731', 'deepseek-v4-flash'],
        ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'], ['deepseek-v4.1-flash-free', 'deepseek-v4.1-flash'],
        ['smol-alibaba/qwen3.8-max-0902', 'qwen3.8-max-0902'], ['qwen3.8-27b', 'qwen3.8-27b'], ['qwen/qwen3.8-27b', 'qwen3.8-27b'],
        ['smol-alibaba/stepfun/step-3.7-flash', 'step-3.7-flash'], ['smol-xai/grok-4.3', 'grok-4.3'],
        ['mistral-small-2603', 'mistral-small-2603'], ['zai-glm-5-3-flash', 'zai-glm-5-3-flash'],
        ['MiniMax-M3.1-Flash', 'minimax-m3.1-flash'], ['claude-code/claude-opus-5-5', 'claude-opus-5-5'],
        ['smol-anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6'],
        ['glm-5.2', 'glm-5.2'], ['smol-glm/glm-5.2', 'glm-5.2'], ['smol-alibaba/glm-5.2', 'glm-5.2'],
    ])('%s resolves to %s', (input, expected) => {
        expect(lookup(input)).toBe(expected);
    });

    test.each([
        'smol-openai/gpt-image-2.5-flare-2026-09-08', 'gpt-5.4-mini-2026-03-17', 'smol-google/gemini-3.1-flash-lite-image',
        'smol-google/gemini-3.1-flash-lite-preview', 'smol-google/gemini-3.5-flash', 'smol-google/gemini-3.7-flash',
        'smol-google/gemma-4-31b-it', 'gemini-2.5-flash', 'smol-alibaba/glm-5.2-fast-preview',
        'smol-alibaba/kimi/kimi-k2.7-code-highspeed', 'smol-kimi/kimi-k2.6', 'smol-alibaba/siliconflow/deepseek-v3.2',
        'smol-alibaba/cmaas-qwen3.8-flash', 'smol-xai/grok-4.20-0309-reasoning', 'smol-xai/grok-4.20-multi-agent-0309',
        'smol-xai/grok-imagine-image', 'claude-code/claude-sonnet-4-5-20250929', 'claude-code/claude-opus-4-20250514',
        'claude-code/claude-opus-4-5-20251101', 'kilo/particle-ai/particle-1:free', 'gpt-6-sol:online', '', '   ', undefined, 42,
    ])('%p does not match', input => {
        expect(lookup(input)).toBeNull();
    });

    test('returns the documented efforts and aliases', () => {
        expect(resolveCustomReasoningModel('gemini-4-neon').efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
        expect(resolveCustomReasoningModel('gemini-4-carbon').efforts).toEqual(['low', 'medium', 'high']);
        expect(resolveCustomReasoningModel('smol-alibaba/qwen3.8-2.4t-a95b').efforts).toEqual(['low', 'medium', 'xhigh']);
        expect(resolveCustomReasoningModel('qwen3.8-flash').efforts).toEqual(['none', 'low', 'medium', 'xhigh']);
        expect(resolveCustomReasoningModel('smol-deepseek/deepseek-v4-pro').efforts).toEqual(['none', 'low', 'high', 'max']);
        expect(resolveCustomReasoningModel('deepseek-v4.1-flash-1017').efforts).toEqual(['none', 'low', 'high', 'max']);
        expect(resolveCustomReasoningModel('smol-alibaba/kimi-k3').efforts).toEqual(['low', 'high', 'max']);
        expect(resolveCustomReasoningModel('smol-openai/gpt-6.2-sol').efforts).toEqual(['min', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(resolveCustomReasoningModel('grok-4.3').efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
        expect(resolveCustomReasoningModel('grok-4.5').efforts).toEqual(['low', 'medium', 'high']);
        expect(resolveCustomReasoningModel('smol-glm/glm-5.2').efforts).toEqual(['none', 'high', 'max']);
        expect(resolveCustomReasoningModel('smol-glm/glm-5.2').aliases).toEqual({ min: 'none', low: 'high', medium: 'high', xhigh: 'max' });
        expect(resolveCustomReasoningModel('deepseek-v4-pro-0813').aliases).toEqual({ min: 'low', medium: 'high', xhigh: 'high' });
        expect(resolveCustomReasoningModel('qwen3.8-max').aliases).toEqual({ min: 'low', high: 'xhigh', max: 'xhigh' });
        expect(resolveCustomReasoningModel('grok-4.5-latest').aliases).toEqual({ xhigh: 'high' });
        expect(resolveCustomReasoningModel('smol-google/gemini-4-argon').aliases).toEqual({ min: 'low' });
        expect(resolveCustomReasoningModel('gpt-6-sol').aliases).toEqual({});
    });
});

describe('Custom table properties', () => {
    test.each(allRows.map(row => [row.id, row]))('%s resolves to its own row', (id, row) => {
        expect(resolveCustomReasoningModel(id)).toMatchObject({ id, maker: row.maker, efforts: row.efforts });
    });

    test.each(allRows.map(row => [row.id]))('%s is not reachable from a distinct variant', id => {
        for (const suffix of ['-highspeed', '-flashx', '-lite', '-image', '-fast-preview', '-mini', '-preview', '-pro', ':thinking']) {
            const hit = resolveCustomReasoningModel(id + suffix);
            expect(hit === null || hit.id === id + suffix).toBe(true);
        }
    });

    test('no lower-cased key sits in two groups', () => {
        const ids = allRows.map(row => row.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every alias id is a table key, every target is in its row, and no alias is', () => {
        const byId = new Map(allRows.map(row => [row.id, row.efforts]));
        for (const [id, aliases] of Object.entries(CUSTOM_EFFORT_ALIASES)) {
            const efforts = byId.get(id);
            expect(efforts).toBeDefined();
            for (const [alias, target] of Object.entries(aliases)) {
                expect(REASONING_CONTROL_VALUES).toContain(alias);
                expect(REASONING_CONTROL_VALUES).toContain(target);
                expect(efforts).toContain(target);
                expect(efforts).not.toContain(alias);
            }
        }
    });

    test('the Custom google rows match the native makersuite rows, and native zai has no glm-5.2', () => {
        const nativeGoogle = getNativeReasoningRoute({ chat_completion_source: 'makersuite' }, { googleApiVersion: 'v1beta' });
        for (const [id, efforts] of Object.entries(CUSTOM_COMPATIBLE_EFFORTS.google)) {
            expect(getChatReasoningCapabilities({ source: 'makersuite', model: id, route: nativeGoogle }).declaredEfforts).toEqual(efforts);
        }
        const nativeZai = getNativeReasoningRoute({ chat_completion_source: 'zai' });
        expect(getChatReasoningCapabilities({ source: 'zai', model: 'glm-5.2', route: nativeZai }).state).toBe('unknown');
        expect(getChatReasoningCapabilities({ source: 'zai', model: 'glm-5.3', route: nativeZai }).state).toBe('effort-list');
        expect(Object.hasOwn(CUSTOM_COMPATIBLE_EFFORTS.zai, 'glm-5.2')).toBe(true);
    });

    test('Auto is always supported, and None is either listed or omitted', () => {
        for (const row of allRows) {
            const identity = { source: 'custom', model: row.id, route: customRoute() };
            expect(checkChatReasoningEffort({ ...identity, effort: 'auto' }).supported).toBe(true);
            expect(resolveKnownInvalidNoneEffort({ ...identity, effort: 'none' })).toBe(row.efforts.includes('none') ? 'none' : undefined);
        }
    });
});

describe('Custom route gating', () => {
    test('with the switch on, the OpenAI format and a name, a matched model gets an effort list', () => {
        expect(getChatReasoningCapabilities({ source: 'custom', model: 'smol-kimi/kimi-k3', route: customRoute() })).toMatchObject({
            state: 'effort-list', supportedEfforts: ['low', 'high', 'max'], provenance: 'custom-moonshot-documentation',
            reason: 'documented-compatible-efforts', noneAlwaysOffered: true, effortAliases: {}, nativeFallback: false,
        });
        expect(getChatReasoningCapabilities({ source: 'custom', model: 'qwen3.8-max', route: customRoute() }).effortAliases)
            .toEqual({ min: 'low', high: 'xhigh', max: 'xhigh' });
    });

    test.each([
        ['switch off', { custom_reasoning_documented_levels: false }],
        ['boolean format', { custom_reasoning_param_format: 'boolean' }],
        ['string format', { custom_reasoning_param_format: 'string' }],
        ['thinking object format', { custom_reasoning_param_format: 'thinking_object' }],
        ['blank name', { custom_reasoning_param_name: '  ' }],
        ['openrouter source', { chat_completion_source: 'openrouter' }],
    ])('%s stays unknown', (name, overrides) => {
        const settings = { ...customSettings, ...overrides };
        const capabilities = getChatReasoningCapabilities({ source: settings.chat_completion_source, model: 'smol-kimi/kimi-k3', route: getNativeReasoningRoute(settings) });
        expect(capabilities).toMatchObject({ state: 'unknown', nativeFallback: false });
        expect(capabilities.noneAlwaysOffered).toBeUndefined();
    });

    test('an unmatched model stays unknown', () => {
        expect(getChatReasoningCapabilities({ source: 'custom', model: 'kilo/particle-ai/particle-1:free', route: customRoute() }).state).toBe('unknown');
    });

    test('a native match has no Custom fields', () => {
        const capabilities = getChatReasoningCapabilities({ source: 'openai', model: 'gpt-6-astra', route: getNativeReasoningRoute({ chat_completion_source: 'openai' }) });
        expect(capabilities.state).toBe('effort-list');
        expect(capabilities.noneAlwaysOffered).toBeUndefined();
        expect(capabilities.effortAliases).toBeUndefined();
    });

    test('customReasoningLevelsApplicable needs custom, the OpenAI format and a name', () => {
        expect(customReasoningLevelsApplicable(customSettings)).toBe(true);
        expect(customReasoningLevelsApplicable({ ...customSettings, chat_completion_source: 'openai' })).toBe(false);
        expect(customReasoningLevelsApplicable({ ...customSettings, custom_reasoning_param_format: 'boolean' })).toBe(false);
        expect(customReasoningLevelsApplicable({ ...customSettings, custom_reasoning_param_name: '' })).toBe(false);
        expect(customReasoningLevelsApplicable({ ...customSettings, custom_reasoning_param_name: undefined })).toBe(false);
    });

    test('a saved alias is unsupported and names the level it acts as', () => {
        const result = checkChatReasoningEffort({ source: 'custom', model: 'deepseek-v4-pro-0813', route: customRoute(), effort: 'medium' });
        expect(result.supported).toBe(false);
        expect(result.effortAliases.medium).toBe('high');
    });

    test('resolveChatReasoningEffort follows the switch', () => {
        const none = { ...customSettings, reasoning_effort: 'none' };
        expect(resolveChatReasoningEffort(none, 'deepseek-v4-pro-0813')).toBe('none');
        expect(resolveChatReasoningEffort({ ...none, custom_reasoning_documented_levels: false }, 'deepseek-v4-pro-0813')).toBeUndefined();
        expect(resolveChatReasoningEffort(none, 'smol-kimi/kimi-k3')).toBeUndefined();
        expect(resolveChatReasoningEffort({ ...customSettings, reasoning_effort: 'min' }, 'gpt-5')).toBe('min');
    });
});

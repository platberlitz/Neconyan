import { describe, expect, test } from '@jest/globals';
import { checkChatReasoningEffort, checkNanoGptReasoningEffort, getChatReasoningCapabilities, getNanoGptReasoningCapabilities, resolveKnownInvalidNoneEffort } from '../public/scripts/chat-reasoning-capabilities.js';
import { buildChatCompletionSamplerMetadata } from '../public/scripts/openai-model-capabilities.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

describe('OpenRouter model reasoning declarations', () => {
    const source = 'openrouter';
    const model = 'example/model:free';
    const metadata = reasoning => ({ source, model, reasoning });
    const capabilities = reasoning => getChatReasoningCapabilities({ source, model, metadata: metadata(reasoning) });
    const check = (reasoning, effort) => checkChatReasoningEffort({ source, model, metadata: metadata(reasoning), effort });

    test('projects only bound reasoning fields and preserves missing, null and malformed values', () => {
        const record = Object.freeze({ reasoning: Object.freeze({ supported_efforts: Object.freeze(['minimal', 'high']), mandatory: false, default_effort: 'high' }) });
        const built = buildChatCompletionSamplerMetadata(source, model, record);
        expect(built).toEqual({ source, model, reasoning: { supported_efforts: ['minimal', 'high'], mandatory: false } });
        expect(built.reasoning.supported_efforts).not.toBe(record.reasoning.supported_efforts);
        expect(buildChatCompletionSamplerMetadata(source, model, { reasoning: {} }).reasoning).toEqual({});
        expect(buildChatCompletionSamplerMetadata(source, model, { reasoning: { supported_efforts: null } }).reasoning.supported_efforts).toBeNull();
        expect(buildChatCompletionSamplerMetadata(source, model, { reasoning: 'bad' }).reasoning).toBe('bad');
        expect(buildChatCompletionSamplerMetadata('custom', model, record)).not.toHaveProperty('reasoning');
        expect(record.reasoning.supported_efforts).toEqual(['minimal', 'high']);
    });

    test('accepts only declared efforts, including known aliases and exact opaque values', () => {
        const declaration = { supported_efforts: ['minimal', 'High', 'FutureRung', 'high', 'none'] };
        expect(capabilities(declaration)).toMatchObject({ state: 'effort-list', supportedEfforts: ['none', 'min', 'high'] });
        for (const effort of ['min', 'MINIMAL', 'high', 'none', 'FutureRung', 'auto', undefined]) expect(check(declaration, effort).supported).toBe(true);
        for (const effort of ['medium', 'futurerung']) expect(check(declaration, effort).supported).toBe(false);
    });

    test('treats null as all gateway efforts and honours mandatory reasoning', () => {
        expect(capabilities({ supported_efforts: null }).supportedEfforts).toEqual(['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(capabilities({ supported_efforts: null, mandatory: true }).supportedEfforts).toEqual(['min', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(check({ supported_efforts: ['none', 'high'], mandatory: true }, 'none')).toMatchObject({ supported: false, forbidden: true });
    });

    test('distinguishes an omitted member from an absent or malformed reasoning object', () => {
        expect(check({}, 'low')).toMatchObject({ state: 'no-selector', supported: false, reason: 'selector-not-exposed', provenance: 'openrouter-catalogue' });
        expect(check({}, undefined)).toMatchObject({ state: 'no-selector', supported: true });
        for (const reasoning of [null, [], 'bad', { mandatory: 'true' }]) expect(check(reasoning, 'low')).toMatchObject({ state: 'unknown', supported: true });
        expect(getChatReasoningCapabilities({ source, model, metadata: { source, model } }).state).toBe('unknown');
    });

    test.each([[], [''], ['auto'], ['FutureOnly'], ['none'], ['high', null], 'high'])('retains mandatory None prohibition with unknown declaration %p', effortList => {
        const reasoning = { supported_efforts: effortList, mandatory: true };
        expect(check(reasoning, 'none')).toMatchObject({ state: 'unknown', supported: false, forbidden: true });
        expect(check(reasoning, 'high').supported).toBe(true);
        expect(check(reasoning, undefined).supported).toBe(true);
    });

    test('does not borrow a declaration across source, exact model or variant', () => {
        const bound = metadata({ supported_efforts: ['high'] });
        for (const identity of [{ source: 'custom', model }, { source, model: 'example/model' }, { source, model: `${model}:online` }]) {
            expect(checkChatReasoningEffort({ ...identity, metadata: bound, effort: 'low' })).toMatchObject({ state: 'unknown', supported: true });
        }
        expect(checkChatReasoningEffort({ source, model, metadata: { source, model, supported_parameters: ['reasoning'] }, effort: 'low' }).state).toBe('unknown');
    });

    test('preserves deliberate None and unsupported saved choices until the guard', () => {
        const settings = { chat_completion_source: source, reasoning_effort: 'none' };
        expect(resolveChatReasoningEffort(settings, model, undefined, metadata({ supported_efforts: ['none', 'high'] }))).toBe('none');
        expect(resolveChatReasoningEffort(settings, model, undefined, metadata({ supported_efforts: ['Future'], mandatory: true }))).toBeUndefined();
        expect(resolveChatReasoningEffort(settings, model, undefined, metadata({ supported_efforts: [] }))).toBeUndefined();
        expect(resolveChatReasoningEffort({ ...settings, reasoning_effort: 'low' }, model, undefined, metadata({ supported_efforts: ['high'] }))).toBe('low');
        expect(resolveChatReasoningEffort({ ...settings, reasoning_effort: 'low' }, model, undefined, metadata({}))).toBeUndefined();
        expect(settings.reasoning_effort).toBe('none');
    });
});

describe('known invalid None suppression', () => {
    test.each(['vendor/model:thinking', 'vendor/model:thinking:free', 'vendor/model:free:thinking'])('forbids exact Nano token %s even with contradictory metadata', model => {
        const identity = { source: 'nanogpt', model, metadata: { source: 'nanogpt', model, reasoning_efforts: ['none', 'high'] } };
        expect(resolveKnownInvalidNoneEffort({ ...identity, effort: ' None ' })).toBeUndefined();
        expect(checkChatReasoningEffort({ ...identity, effort: 'none' }).supported).toBe(false);
        expect(checkNanoGptReasoningEffort({ ...identity, effort: 'none' }).supported).toBe(false);
        expect(getNanoGptReasoningCapabilities(identity).supportedEfforts).toEqual(['high']);
        expect(resolveKnownInvalidNoneEffort({ ...identity, effort: 'high' })).toBe('high');
        for (const metadata of [undefined, { ...identity.metadata, reasoning_efforts: ['high', null] }, { ...identity.metadata, model: 'stale' }]) {
            expect(resolveKnownInvalidNoneEffort({ ...identity, metadata, effort: 'none' })).toBeUndefined();
            expect(checkNanoGptReasoningEffort({ ...identity, metadata, effort: 'none' }).supported).toBe(false);
        }
    });

    test('retains a known empty supported list when thinking metadata declares only None', () => {
        const identity = { source: 'nanogpt', model: 'vendor/model:thinking', metadata: { source: 'nanogpt', model: 'vendor/model:thinking', reasoning_efforts: ['none'] } };
        expect(getNanoGptReasoningCapabilities(identity)).toMatchObject({ known: true, supportedEfforts: [] });
        expect(getChatReasoningCapabilities(identity)).toMatchObject({ state: 'effort-list', supportedEfforts: [] });
        expect(checkNanoGptReasoningEffort({ ...identity, effort: 'auto' }).supported).toBe(true);
        for (const effort of ['low', 'high', 'max', 'FutureRung']) {
            expect(checkNanoGptReasoningEffort({ ...identity, effort }).supported).toBe(false);
            expect(checkChatReasoningEffort({ ...identity, effort }).supported).toBe(false);
        }
        expect(identity.metadata.reasoning_efforts).toEqual(['none']);
    });

    test.each(['vendor/thinking-model', 'vendor/thinking/model', 'vendor/model:thinkingish', 'vendor/model:Thinking'])('keeps unknown Nano identity %s', model => {
        expect(resolveKnownInvalidNoneEffort({ source: 'nanogpt', model, effort: 'none' })).toBe('none');
    });

    test('uses exact declarations and preserves unknown and valid inputs', () => {
        const source = 'openrouter';
        const model = 'vendor/model';
        const identity = reasoning => ({ source, model, metadata: { source, model, reasoning } });
        for (const reasoning of [{ supported_efforts: ['high'] }, { mandatory: true, supported_efforts: [] }, {}]) {
            expect(resolveKnownInvalidNoneEffort({ ...identity(reasoning), effort: 'none' })).toBeUndefined();
        }
        expect(resolveKnownInvalidNoneEffort({ ...identity({ supported_efforts: ['none', 'high'] }), effort: 'none' })).toBe('none');
        expect(resolveKnownInvalidNoneEffort({ ...identity({ supported_efforts: [] }), effort: 'none' })).toBe('none');
        expect(resolveKnownInvalidNoneEffort({ source: 'custom', model: 'vendor/model:thinking', effort: 'none' })).toBe('none');
    });

    test.each(['nanogpt', 'openrouter'])('%s leaves malformed, stale and missing declarations unknown', source => {
        const model = 'vendor/plain';
        const declaration = source === 'nanogpt' ? { reasoning_efforts: ['high'] } : { reasoning: { supported_efforts: ['high'] } };
        const bound = { source, model, ...declaration };
        const malformed = source === 'nanogpt' ? { reasoning_efforts: ['high', null] } : { reasoning: { supported_efforts: ['high', null] } };
        for (const metadata of [undefined, null, [], { ...bound, source: 'custom' }, { ...bound, model: `${model}:free` }, { source, model, ...malformed }]) {
            const input = { source, model, metadata, effort: ' None ' };
            const before = JSON.stringify(input);
            expect(resolveKnownInvalidNoneEffort(input)).toBe(' None ');
            expect(JSON.stringify(input)).toBe(before);
        }
        expect(resolveKnownInvalidNoneEffort({ source, model, metadata: bound, effort: 'none' })).toBeUndefined();
        for (const effort of ['auto', 'minimal', 'FutureRung', null, 3, {}]) {
            expect(resolveKnownInvalidNoneEffort({ source, model, metadata: bound, effort })).toBe(effort);
        }
    });
});

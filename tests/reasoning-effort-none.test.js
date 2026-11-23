import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkChatReasoningEffort, getNativeReasoningRoute } from '../public/scripts/chat-reasoning-capabilities.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');

describe('reasoning effort \'none\'', () => {
    test.each(['openai/gpt-5.4', 'smol-openai/gpt-5.4', '[openai]/gpt-5.4', '[free]gpt-5.4', 'openai:gpt-5.4', 'openai/gpt-5.10'])('keeps legacy Custom None for %s', model => {
        const settings = { chat_completion_source: 'custom', custom_reasoning_documented_levels: false, reasoning_effort: 'none' };
        expect(resolveChatReasoningEffort(settings, model)).toBe('none');
    });

    test.each(['[gpt-5.4]gpt-4o', 'openai/not-gpt-5.4', 'openai/gpt-5.4fake', 'openai/gpt-5', 'openai/gpt-5.0'])('does not mistake %s for GPT-5.1+ on Custom', model => {
        expect(resolveChatReasoningEffort({ chat_completion_source: 'custom', reasoning_effort: 'none' }, model)).toBeUndefined();
    });
    test('the client suppresses native invalid None and preserves legacy OpenAI-style behaviour', () => {
        // Unknown and proxy-style
        // routes keep their previous None handling. GPT-5.1 accepts the literal value.
        for (const source of ['openai', 'openai_responses', 'azure_openai', 'custom']) {
            const settings = { chat_completion_source: source, reasoning_effort: 'none' };
            expect(resolveChatReasoningEffort(settings, 'gpt-5.1')).toBe('none');
            expect(resolveChatReasoningEffort(settings, 'gpt-5.4')).toBe('none');
            expect(resolveChatReasoningEffort(settings, 'gpt-5')).toBeUndefined();
            expect(resolveChatReasoningEffort(settings, 'gpt-4o')).toBe(['openai', 'openai_responses'].includes(source) ? 'none' : undefined);
        }
        expect(resolveChatReasoningEffort({ chat_completion_source: 'openrouter', reasoning_effort: 'none' }, 'gpt-5.4')).toBeUndefined();
        for (const source of ['openai', 'openai_responses']) {
            expect(checkChatReasoningEffort({ source, model: 'gpt-5', effort: 'none',
                route: getNativeReasoningRoute({ chat_completion_source: source }) }).supported).toBe(false);
        }
    });

    test('OpenRouter preserves None for an exact declaration until validation, while unknown metadata keeps legacy omission', () => {
        const settings = { chat_completion_source: 'openrouter', reasoning_effort: 'none' };
        const metadata = { source: 'openrouter', model: 'test/model', reasoning: { supported_efforts: ['none', 'high'] } };
        expect(resolveChatReasoningEffort(settings, 'test/model', undefined, metadata)).toBe('none');
        expect(resolveChatReasoningEffort(settings, 'test/model:free', undefined, metadata)).toBeUndefined();
        expect(resolveChatReasoningEffort(settings, 'test/model', undefined, { ...metadata, reasoning: { mandatory: true, supported_efforts: [] } })).toBeUndefined();
        expect(settings.reasoning_effort).toBe('none');
    });

    test.each(['nanogpt', 'openrouter'])('%s preserves its existing unknown None resolution without mutating saved settings', source => {
        const settings = { chat_completion_source: source, reasoning_effort: 'none', include_reasoning: false };
        const before = JSON.stringify(settings);
        const model = 'vendor/plain';
        const declarations = [undefined, { source: 'custom', model, reasoning_efforts: ['high'], reasoning: { supported_efforts: ['high'] } },
            { source, model: `${model}:free`, reasoning_efforts: ['high'], reasoning: { supported_efforts: ['high'] } },
            { source, model, reasoning_efforts: ['high', null], reasoning: { supported_efforts: ['high', null] } }];
        for (const metadata of declarations) {
            expect(resolveChatReasoningEffort(settings, model, undefined, metadata)).toBe(source === 'nanogpt' ? 'none' : undefined);
        }
        expect(JSON.stringify(settings)).toBe(before);
    });

    test('the UI no longer promises that None is never sent', () => {
        expect(indexSource).not.toContain('None (don\'t send)');
        expect(indexSource).not.toContain('None does not send an effort level.');
        expect(indexSource).toContain('None is sent verbatim to GPT-5.1 and newer. Other models get no effort level.');
    });
});

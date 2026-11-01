import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkChatReasoningEffort, getNativeReasoningRoute } from '../public/scripts/chat-reasoning-capabilities.js';
import { resolveChatReasoningEffort } from '../public/scripts/chat-request-controls.js';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const chatCompletionsSource = readSource('../src/endpoints/backends/chat-completions.js');

describe('reasoning effort \'none\'', () => {
    test('the client preserves native invalid intent and legacy OpenAI-style None behaviour', () => {
        // Native GPT-5 retains invalid intent for the final guard; unknown and proxy-style
        // routes keep their previous None handling. GPT-5.1 accepts the literal value.
        for (const source of ['openai', 'openai_responses', 'azure_openai', 'custom']) {
            const settings = { chat_completion_source: source, reasoning_effort: 'none' };
            expect(resolveChatReasoningEffort(settings, 'gpt-5.1')).toBe('none');
            expect(resolveChatReasoningEffort(settings, 'gpt-5.4')).toBe('none');
            expect(resolveChatReasoningEffort(settings, 'gpt-5')).toBe(['openai', 'openai_responses'].includes(source) ? 'none' : undefined);
            expect(resolveChatReasoningEffort(settings, 'gpt-4o')).toBe(['openai', 'openai_responses'].includes(source) ? 'none' : undefined);
        }
        expect(resolveChatReasoningEffort({ chat_completion_source: 'openrouter', reasoning_effort: 'none' }, 'gpt-5.4')).toBeUndefined();
        for (const source of ['openai', 'openai_responses']) {
            expect(checkChatReasoningEffort({ source, model: 'gpt-5', effort: 'none',
                route: getNativeReasoningRoute({ chat_completion_source: source }) }).supported).toBe(false);
        }
    });

    test('the NanoGPT handler forwards \'none\' untouched', () => {
        // NanoGPT's documented ladder starts at none. Gating on a translation table made the
        // caller omit the reasoning key entirely, letting the model default to thinking.
        expect(chatCompletionsSource).toContain('if (request.body.reasoning_effort && request.body.reasoning_effort !== \'auto\') {');
        expect(chatCompletionsSource).toContain('bodyParams[\'reasoning\'] = { effort: toWireReasoningEffort(request.body.reasoning_effort) };');
    });

    test('OpenRouter preserves None for an exact declaration until validation, while unknown metadata keeps legacy omission', () => {
        const settings = { chat_completion_source: 'openrouter', reasoning_effort: 'none' };
        const metadata = { source: 'openrouter', model: 'test/model', reasoning: { supported_efforts: ['none', 'high'] } };
        expect(resolveChatReasoningEffort(settings, 'test/model', undefined, metadata)).toBe('none');
        expect(resolveChatReasoningEffort(settings, 'test/model:free', undefined, metadata)).toBeUndefined();
        expect(resolveChatReasoningEffort(settings, 'test/model', undefined, { ...metadata, reasoning: { mandatory: true, supported_efforts: [] } })).toBe('none');
        expect(settings.reasoning_effort).toBe('none');
    });

    test('the UI no longer promises that None is never sent', () => {
        expect(indexSource).not.toContain('None (don\'t send)');
        expect(indexSource).not.toContain('None does not send an effort level.');
        expect(indexSource).toContain('None is sent verbatim to GPT-5.1 and newer. Other models get no effort level.');
    });
});

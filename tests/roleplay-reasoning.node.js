import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractProviderReasoning, extractProviderReasoningSignature } from '../public/scripts/generation-format.js';

test('shared provider reasoning respects source settings and preserves encrypted signatures', () => {
    const chat = { mainApi: 'openai', chatCompletionSource: 'custom' };
    const custom = { choices: [{ message: { reasoning_content: 'Thinking<|sep|>done' } }] };
    assert.equal(extractProviderReasoning(custom, { ...chat, showThoughts: false }), '');
    assert.equal(extractProviderReasoning(custom, chat), 'Thinkingdone');
    assert.equal(extractProviderReasoning({ choices: [{ message: { content: [{ thinking: [{ text: 'Mistral thought' }] }] } }] },
        { mainApi: 'openai', chatCompletionSource: 'mistralai' }), 'Mistral thought');
    assert.equal(extractProviderReasoning({ choices: [{ reasoning: 'Router thought' }] },
        { mainApi: 'textgenerationwebui', textGenType: 'openrouter' }), 'Router thought');
    assert.equal(extractProviderReasoning({ thinking: 'Ollama thought' },
        { mainApi: 'textgenerationwebui', textGenType: 'ollama' }), 'Ollama thought');
    const router = { choices: [{ message: { reasoning_details: [
        { id: 'tool_hidden', type: 'reasoning.encrypted', data: 'not this' },
        { id: 'thought', type: 'reasoning.encrypted', data: 'router signature' },
    ] } }] };
    assert.equal(extractProviderReasoningSignature(router, { mainApi: 'openai', chatCompletionSource: 'openrouter' }), 'router signature');
    assert.equal(extractProviderReasoningSignature({ responseContent: { parts: [{ text: 'thought', thoughtSignature: 'gemini signature' }] } },
        { mainApi: 'openai', chatCompletionSource: 'makersuite' }), 'gemini signature');
    assert.equal(extractProviderReasoningSignature({ choices: [{ message: { reasoning_details: {} } }] },
        { mainApi: 'openai', chatCompletionSource: 'openrouter' }), null);
    assert.equal(extractProviderReasoningSignature({ responseContent: { parts: {} } },
        { mainApi: 'openai', chatCompletionSource: 'makersuite' }), null);
});

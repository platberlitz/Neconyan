import { describe, expect, jest, test } from '@jest/globals';
import { checkPostInterceptChatBudget, shouldCheckPostInterceptChatBudget } from '../public/scripts/openai-prompt-budget.js';

describe('OpenAI post-intercept prompt budget', () => {
    test('recounts chat payloads after pre-generation intercepts', async () => {
        const chat = [{ role: 'user', content: 'intercept-expanded prompt' }];
        const countTokens = jest.fn(async () => 120);

        const result = await checkPostInterceptChatBudget(chat, {
            openai_max_context: 150,
            openai_max_tokens: 40,
        }, countTokens);

        expect(countTokens).toHaveBeenCalledWith(chat);
        expect(result).toEqual({
            promptTokens: 120,
            promptTokenBudget: 110,
            exceeded: true,
        });
    });

    test('does not flag payloads that stay within the post-intercept budget', async () => {
        const result = await checkPostInterceptChatBudget([{ role: 'user', content: 'prompt' }], {
            openai_max_context: 150,
            openai_max_tokens: 40,
        }, async () => 110);

        expect(result.exceeded).toBe(false);
    });

    test('rejects non-array post-intercept payloads', async () => {
        await expect(checkPostInterceptChatBudget(null, {
            openai_max_context: 150,
            openai_max_tokens: 40,
        }, async () => 0)).rejects.toThrow('Post-intercept chat payload must be an array.');
    });

    test('counts clean memory text after an intercept while preserving the working slot for proof', async () => {
        const marker = { open: '[private begin]', close: '[private end]' };
        const working = marker.open + '\nprimary\n' + marker.close;
        const chat = [{ role: 'system', content: working }];
        const counter = jest.fn(async payload => payload[0].content.length);
        const result = await checkPostInterceptChatBudget(chat, { openai_max_context: 8, openai_max_tokens: 1 }, counter, marker);
        expect(result).toEqual({ promptTokens: 7, promptTokenBudget: 7, exceeded: false });
        expect(counter).toHaveBeenCalledWith([{ role: 'system', content: 'primary' }]);
        expect(chat[0].content).toBe(working);
    });

    test('checks budget only when the prompt-ready chat changed', () => {
        expect(shouldCheckPostInterceptChatBudget({ chatChanged: true })).toBe(true);
        expect(shouldCheckPostInterceptChatBudget({ chatChanged: false })).toBe(false);
        expect(shouldCheckPostInterceptChatBudget({})).toBe(false);
        expect(shouldCheckPostInterceptChatBudget(null)).toBe(false);
    });
});

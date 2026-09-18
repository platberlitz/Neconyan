/* eslint-disable playwright/no-standalone-expect -- Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { formatTokenCounterText, updateReasoningTokenAccounting } from '../public/scripts/reasoning-token-accounting.js';

describe('reasoning token accounting', () => {
    test('formats visible token counter text only for positive counts', () => {
        expect(formatTokenCounterText(42)).toBe('42t');
        expect(formatTokenCounterText('7')).toBe('7t');
        expect(formatTokenCounterText(0)).toBe('');
        expect(formatTokenCounterText(undefined)).toBe('');
        expect(formatTokenCounterText(Number.NaN)).toBe('');
    });

    test('counts output and locally parsed reasoning separately', async () => {
        const message = {
            mes: 'Final answer',
            extra: {
                reasoning: 'Hidden chain of thought',
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
        });

        expect(result).toEqual({ outputTokens: 2, reasoningTokens: 4 });
        expect(message.extra.token_count).toBe(2);
        expect(message.extra.reasoning_tokens).toBe(4);
        expect(countTokens).toHaveBeenNthCalledWith(1, 'Final answer');
        expect(countTokens).toHaveBeenNthCalledWith(2, 'Hidden chain of thought');
    });

    test('keeps provider-reported reasoning tokens when they exceed local count', async () => {
        const message = {
            mes: 'Visible output',
            extra: {
                reasoning: 'Provider thought text',
                reasoning_tokens: 17,
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
            reasoningTokens: message.extra.reasoning_tokens,
        });

        expect(result).toEqual({ outputTokens: 2, reasoningTokens: 17 });
        expect(message.extra.token_count).toBe(2);
        expect(message.extra.reasoning_tokens).toBe(17);
        expect(countTokens).toHaveBeenNthCalledWith(1, 'Visible output');
        expect(countTokens).toHaveBeenNthCalledWith(2, 'Provider thought text');
    });

    test('uses local reasoning count when provider count is lower', async () => {
        const message = {
            mes: 'Visible output',
            extra: {
                reasoning: 'Locally counted thought text',
                reasoning_tokens: 1,
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
            reasoningTokens: message.extra.reasoning_tokens,
        });

        expect(result).toEqual({ outputTokens: 2, reasoningTokens: 4 });
        expect(message.extra.token_count).toBe(2);
        expect(message.extra.reasoning_tokens).toBe(4);
        expect(countTokens).toHaveBeenNthCalledWith(1, 'Visible output');
        expect(countTokens).toHaveBeenNthCalledWith(2, 'Locally counted thought text');
    });

    test('can avoid local reasoning estimation when token counting is disabled', async () => {
        const message = {
            mes: 'Visible output',
            extra: {
                token_count: 9,
                reasoning: 'Uncounted thought text',
            },
        };
        const countTokens = jest.fn(async () => 99);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoning: message.extra.reasoning,
            countOutput: false,
            countReasoning: false,
        });

        expect(result).toEqual({ outputTokens: 9, reasoningTokens: 0 });
        expect(message.extra.token_count).toBe(9);
        expect(message.extra.reasoning_tokens).toBe(0);
        expect(countTokens).not.toHaveBeenCalled();
    });

    test('refreshes active swipe token metadata with edited message text', async () => {
        const message = {
            mes: 'Polished text has five words',
            swipe_id: 1,
            swipes: ['Original stale text', 'Polished text has five words'],
            swipe_info: [
                {
                    extra: {
                        token_count: 3,
                        reasoning_tokens: 2,
                    },
                },
                {
                    extra: {
                        token_count: 4,
                        reasoning_tokens: 7,
                    },
                },
            ],
            extra: {
                token_count: 4,
                reasoning_tokens: 7,
            },
        };
        const countTokens = jest.fn(async text => text.split(/\s+/).filter(Boolean).length);

        const result = await updateReasoningTokenAccounting(message, {
            countTokens,
            reasoningTokens: 0,
            countReasoning: false,
        });

        expect(result).toEqual({ outputTokens: 5, reasoningTokens: 0 });
        expect(message.extra.token_count).toBe(5);
        expect(message.extra.reasoning_tokens).toBe(0);
        expect(message.swipe_info[1].extra.token_count).toBe(5);
        expect(message.swipe_info[1].extra.reasoning_tokens).toBe(0);
        expect(message.swipe_info[0].extra.token_count).toBe(3);
        expect(message.swipe_info[0].extra.reasoning_tokens).toBe(2);
    });

    test.each(['edited', 'replaced'])('late counts never change a swipe that was %s during counting', async (change) => {
        const originalExtra = { token_count: 10 };
        const message = { mes: 'Original text', swipe_id: 0, swipes: ['Original text'], swipe_info: [{ extra: originalExtra }], extra: { token_count: 10 } };
        await updateReasoningTokenAccounting(message, {
            countTokens: async () => {
                message.mes = 'New text';
                message.swipes[0] = 'New text';
                if (change === 'replaced') message.swipe_info[0] = { extra: { token_count: 20 } };
                return 2;
            },
            reasoning: '',
        });
        expect(originalExtra.token_count).toBe(10);
        expect(message.extra.token_count).toBe(10);
        expect(message.swipe_info[0].extra.token_count).toBe(change === 'replaced' ? 20 : 10);
    });

    test('a swipe change during counting writes to the counted swipe, not the new one', async () => {
        const message = {
            mes: 'one two three',
            swipe_id: 0,
            swipes: ['one two three', 'four'],
            swipe_info: [{ extra: {} }, { extra: { token_count: 1, reasoning_tokens: 0 } }],
            extra: { token_count: 1, reasoning_tokens: 0 },
        };
        const countTokens = jest.fn(async (text) => {
            // Simulate the user swiping while the count is in flight.
            message.swipe_id = 1;
            message.mes = 'four';
            message.extra = { token_count: 1, reasoning_tokens: 0 };
            return text.split(/\s+/).filter(Boolean).length;
        });

        await updateReasoningTokenAccounting(message, { countTokens, reasoning: '' });

        expect(message.swipe_info[0].extra.token_count).toBe(3);
        expect(message.swipe_info[1].extra.token_count).toBe(1);
        expect(message.extra.token_count).toBe(1);
    });
});

import { describe, expect, test } from '@jest/globals';

import {
    appendHelperPrefillMessages,
    parseHelperPrefillMessages,
    serializeHelperPrefillForPrompt,
    prepareHelperPartialPrefill,
    joinHelperPartialPrefill,
} from '../public/scripts/extensions/helper-prefill.js';

describe('helper prefill role blocks', () => {
    test.each(['kimi-k3', 'moonshot/kimi-k3.1', 'kimi-k3.1-pro'])('keeps the partial continuation last for %s', model => {
        const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Task' }];
        const result = prepareHelperPartialPrefill(messages, '<think>Check carefully.</think>Answer: ', model);
        expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: '<think>Check carefully.</think>Answer: ', partial: true });
        expect(result.reply).toBe('Answer: ');
        expect(messages).toHaveLength(2);
        expect(joinHelperPartialPrefill('Yes', result.reply)).toBe('Answer: Yes');
        expect(joinHelperPartialPrefill('Answer: Yes', result.reply)).toBe('Answer: Yes');
    });

    test('does not seed another model or turn empty output into success', () => {
        const messages = [{ role: 'user', content: 'Task' }];
        expect(prepareHelperPartialPrefill(messages, 'Start', 'kimi-k2.5')).toEqual({ messages, reply: '', active: false });
        expect(prepareHelperPartialPrefill(messages, ' ', 'kimi-k3').active).toBe(false);
        expect(joinHelperPartialPrefill('  ', 'Start')).toBe('  ');
        expect(joinHelperPartialPrefill('', 'Start')).toBe('');
    });

    test('keeps unclosed seeded reasoning out of the visible response', () => {
        const result = prepareHelperPartialPrefill([], '<think>Work through the task', 'kimi-k3');
        expect(result.reply).toBe('');
        expect(joinHelperPartialPrefill('Visible answer', result.reply)).toBe('Visible answer');
    });
    test('parses role blocks in order with multiline content', () => {
        const input = `[system]
Follow the helper rules.

[user]
Current scene:
Rain on glass.

[assistant]
Let me`;

        expect(parseHelperPrefillMessages(input)).toEqual([
            { role: 'system', content: 'Follow the helper rules.' },
            { role: 'user', content: 'Current scene:\nRain on glass.' },
            { role: 'assistant', content: 'Let me' },
        ]);
    });

    test('treats unheaded text as assistant prefill and drops empty blocks', () => {
        const input = `Begin directly here.

[system]

[USER]
Keep this context.

[assistant]
`;

        expect(parseHelperPrefillMessages(input)).toEqual([
            { role: 'assistant', content: 'Begin directly here.' },
            { role: 'user', content: 'Keep this context.' },
        ]);
    });

    test('appends parsed prefill messages without mutating the base messages', () => {
        const baseMessages = [{ role: 'system', content: 'Base prompt.' }];
        const result = appendHelperPrefillMessages(baseMessages, '[assistant]\nStart');

        expect(result).toEqual([
            { role: 'system', content: 'Base prompt.' },
            { role: 'assistant', content: 'Start' },
        ]);
        expect(baseMessages).toEqual([{ role: 'system', content: 'Base prompt.' }]);
    });

    test('serializes role blocks for prompt-only helpers', () => {
        const messages = parseHelperPrefillMessages('[system]\nRules\n\n[user]\nContext\n\n[assistant]\nStart');

        expect(serializeHelperPrefillForPrompt(messages)).toBe(
            'SYSTEM:\nRules\n\nUSER:\nContext\n\nASSISTANT:\nStart',
        );
    });
});

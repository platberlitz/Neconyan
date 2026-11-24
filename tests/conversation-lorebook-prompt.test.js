import { describe, expect, test } from '@jest/globals';
import { composeConversationSystemPrompt } from '../public/scripts/neconyan-conversation/prompt-system.js';

describe('composeConversationSystemPrompt lorebook', () => {
    const base = { settings: { lorebook_override: 'Book' }, charName: 'Nova', userName: 'User', timeContext: 'T' };
    const focus = 'Conversation lorebook focus: Book. Prefer this lore/context over roleplay scene continuity.';

    test('without a scan result the prompt is unchanged', () => {
        const prompt = composeConversationSystemPrompt(base);
        expect(prompt).toContain(focus);
        expect(prompt).not.toContain('Lorebook entries');
        expect(composeConversationSystemPrompt({ ...base, lorebook: null })).toBe(prompt);
        expect(composeConversationSystemPrompt({ ...base, settings: {} })).not.toContain('lorebook');
    });

    test('found entries follow the focus sentence and precede user presence', () => {
        const prompt = composeConversationSystemPrompt({ ...base, availability: 'online', lorebook: { name: 'Book', found: true, text: 'ZEPHYR-LORE' } });
        const sentence = prompt.indexOf(focus);
        const block = prompt.indexOf('Lorebook entries from Book:\nZEPHYR-LORE');
        expect(sentence).toBeGreaterThan(-1);
        expect(block).toBe(sentence + focus.length + 2);
        expect(block).toBeLessThan(prompt.indexOf('User presence:'));
    });

    test('a found book with no activations keeps only the focus sentence', () => {
        const prompt = composeConversationSystemPrompt({ ...base, lorebook: { name: 'Book', found: true, text: '' } });
        expect(prompt).toContain(focus);
        expect(prompt).not.toContain('Lorebook entries');
    });

    test('a missing book adds nothing, not even the focus sentence', () => {
        const prompt = composeConversationSystemPrompt({ ...base, lorebook: { name: 'Book', found: false, text: '' } });
        expect(prompt).not.toContain('lorebook focus');
        expect(prompt).toBe(composeConversationSystemPrompt({ ...base, settings: {} }));
    });

    test('Character default adds the linked books\' entries without a focus sentence', () => {
        const plain = composeConversationSystemPrompt({ ...base, settings: {}, authorNote: 'NOTE', availability: 'online' });
        const lorebook = { name: 'Main, Extra', books: ['Main', 'Extra'], found: true, text: 'MAIN-LORE\nEXTRA-LORE', characterDefault: true };
        const prompt = composeConversationSystemPrompt({ ...base, settings: {}, authorNote: 'NOTE', availability: 'online', lorebook });
        expect(prompt).not.toContain('lorebook focus');
        const block = prompt.indexOf('Lorebook entries from Main, Extra:\nMAIN-LORE\nEXTRA-LORE');
        expect(block).toBeGreaterThan(prompt.indexOf('NOTE'));
        expect(block).toBeLessThan(prompt.indexOf('User presence:'));
        expect(prompt.replace('Lorebook entries from Main, Extra:\nMAIN-LORE\nEXTRA-LORE\n\n', '')).toBe(plain);
    });

    test('Character default with no entries or no linked books leaves the prompt unchanged', () => {
        const plain = composeConversationSystemPrompt({ ...base, settings: {} });
        expect(composeConversationSystemPrompt({ ...base, settings: {}, lorebook: null })).toBe(plain);
        expect(composeConversationSystemPrompt({ ...base, settings: {}, lorebook: { name: '', books: ['Main'], found: true, text: '', characterDefault: true } })).toBe(plain);
        expect(composeConversationSystemPrompt({ ...base, settings: {}, lorebook: { name: '', books: [], found: false, text: '', characterDefault: true } })).toBe(plain);
        expect(plain).not.toContain('orebook');
    });

    test('an override that is missing never falls back to card entries', () => {
        const prompt = composeConversationSystemPrompt({ ...base, lorebook: { name: 'Book', found: false, text: '' } });
        expect(prompt).not.toContain('Lorebook entries');
    });
});

import { describe, expect, test } from '@jest/globals';

const { limitGenerationProse } = await import('../public/scripts/generation-request-controls.js');
const {
    isStreamCompleted,
    markStreamCompleted,
    setFreshReasoningMarker,
    setGenerationToolTurnMarker,
    unmarkStreamCompleted,
} = await import('../public/scripts/stream-completion.js');

describe('nonstream limiter reports an unclosed inline block', () => {
    test('an unclosed opening tag moves its thinking out of prose and reports it unclosed', () => {
        const limited = limitGenerationProse('<think>She opens the door', 100, {}, '');
        expect(limited.text).toBe('');
        expect(limited.reasoning).toBe('She opens the door');
        expect(limited.unclosed).toBe(true);
    });

    test('a closed inline block is not reported unclosed', () => {
        const limited = limitGenerationProse('<think>Plan.</think> She opens the door.', 100, {}, '');
        expect(limited.text).toBe(' She opens the door.');
        expect(limited.unclosed).toBe(false);
    });
});

describe('completion producer helpers', () => {
    test('the tool-turn marker is set for a tool turn and cleared for an ordinary turn', () => {
        const extra = {};
        setGenerationToolTurnMarker(extra, true);
        expect(extra.generation_tool_turn).toBe(true);
        setGenerationToolTurnMarker(extra, false);
        expect(extra).not.toHaveProperty('generation_tool_turn');
    });

    test('fresh continuation reasoning is kept apart and cleared when empty', () => {
        const extra = {};
        setFreshReasoningMarker(extra, 'She closes the door.');
        expect(extra.reasoning_current).toBe('She closes the door.');
        setFreshReasoningMarker(extra, '   ');
        expect(extra).not.toHaveProperty('reasoning_current');
    });

    test('a message is completed only after it is explicitly marked', () => {
        const message = { mes: '' };
        expect(isStreamCompleted(message)).toBe(false);
        markStreamCompleted(message);
        expect(isStreamCompleted(message)).toBe(true);
        unmarkStreamCompleted(message);
        expect(isStreamCompleted(message)).toBe(false);
    });
});

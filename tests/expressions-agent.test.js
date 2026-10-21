import { normalizeAgentExpressionLabel, parseAgentExpressionAnswer } from '../public/scripts/extensions/expressions/expressions-agent-utils.js';

describe('expressions agent bridge', () => {
    describe('normalizeAgentExpressionLabel', () => {
        test('returns exact labels from the allowed list', () => {
            expect(normalizeAgentExpressionLabel('joy', ['joy', 'anger'])).toBe('joy');
            expect(normalizeAgentExpressionLabel('ANGER', ['joy', 'anger'])).toBe('anger');
        });

        test('strips markdown, quotes and punctuation', () => {
            expect(normalizeAgentExpressionLabel('**joy**', ['joy', 'anger'])).toBe('joy');
            expect(normalizeAgentExpressionLabel('"surprise"', ['joy', 'surprise'])).toBe('surprise');
            expect(normalizeAgentExpressionLabel('joy.', ['joy', 'anger'])).toBe('joy');
        });

        test('only uses complete labels, not unrelated words sharing a prefix', () => {
            expect(normalizeAgentExpressionLabel('joyless expression', ['joy', 'anger'])).toBeNull();
            expect(normalizeAgentExpressionLabel('joy expression', ['joy', 'anger'])).toBe('joy');
            expect(normalizeAgentExpressionLabel('{"emotion":"joy-soft"}', ['joy', 'joy-soft'])).toBe('joy-soft');
            expect(normalizeAgentExpressionLabel('surprised_2', ['surprised_2'])).toBe('surprised_2');
        });

        test('returns null for unknown labels', () => {
            expect(normalizeAgentExpressionLabel('furious', ['joy', 'anger'])).toBeNull();
        });

        test('allows prefix matches for numbered variants', () => {
            expect(normalizeAgentExpressionLabel('desire1', ['joy', 'desire'])).toBe('desire');
        });

        test('returns null for empty or whitespace input', () => {
            expect(normalizeAgentExpressionLabel('', ['joy'])).toBeNull();
            expect(normalizeAgentExpressionLabel('   ', ['joy'])).toBeNull();
        });
    });

    describe('parseAgentExpressionAnswer', () => {
        test('reads the named character on a shared card', () => {
            expect(parseAgentExpressionAnswer('Sol: anger', ['joy', 'anger'])).toEqual({ label: 'anger', speaker: 'Sol' });
            expect(parseAgentExpressionAnswer('**Mira**: joy.', ['joy', 'anger'])).toEqual({ label: 'joy', speaker: 'Mira' });
            expect(parseAgentExpressionAnswer('Mira Vale: desire2', ['joy', 'desire'])).toEqual({ label: 'desire', speaker: 'Mira Vale' });
            expect(parseAgentExpressionAnswer('{"character":"Sol","emotion":"joy"}', ['joy'])).toEqual({ label: 'joy', speaker: 'Sol' });
            expect(normalizeAgentExpressionLabel('Sol: anger', ['joy', 'anger'])).toBe('anger');
        });

        test('keeps plain labels and rejects unknown labels after a name', () => {
            expect(parseAgentExpressionAnswer('joy: she beams', ['joy'])).toEqual({ label: 'joy', speaker: '' });
            expect(parseAgentExpressionAnswer('Sol: furious', ['joy', 'anger'])).toEqual({ label: null, speaker: '' });
            expect(parseAgentExpressionAnswer('', ['joy'])).toEqual({ label: null, speaker: '' });
        });
    });
});

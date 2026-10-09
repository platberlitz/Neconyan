import { normalizeAgentExpressionLabel } from '../public/scripts/extensions/expressions/expressions-agent-utils.js';

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
});

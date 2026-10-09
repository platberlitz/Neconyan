import { expressionLabelFromFilename, isExpressionLabel, isExpressionSpriteName, parseExpressionLabels } from '../public/scripts/extensions/expressions/expression-labels.js';

describe('custom expression labels', () => {
    test('bulk entry normalises duplicates and rejects invalid or reserved names', () => {
        expect(parseExpressionLabels('Sleepy, joy-soft\nsleepy, surprised_2, bad name, constructor', ['sleepy']))
            .toEqual({ added: ['joy-soft', 'surprised_2'], invalid: ['bad name', 'constructor'] });
        expect(isExpressionLabel('a'.repeat(81))).toBe(false);
    });
    test('configured hyphenated labels survive variants, uploads and legacy filenames', () => {
        expect(expressionLabelFromFilename('joy-soft-2.png', ['joy', 'joy-soft'])).toBe('joy-soft');
        expect(expressionLabelFromFilename('joy.expressive.png')).toBe('joy');
        expect(expressionLabelFromFilename('surprised_2.webp')).toBe('surprised_2');
        expect(isExpressionSpriteName('joy-soft', 'joy-soft-2')).toBe(true);
        expect(isExpressionSpriteName('joy', 'joy/../../other')).toBe(false);
    });
});

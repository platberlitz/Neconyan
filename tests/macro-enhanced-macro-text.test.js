import { describe, expect, test } from '@jest/globals';
import { splitMacroArgs, tokenizeMacroText } from '../public/scripts/extensions/third-party/MacroEnhanced/src/ui/macro-text.js';

function roundTrip(input) {
    return tokenizeMacroText(input).map(token => token.text).join('');
}

describe('Macro Enhanced display tokenizer', () => {
    test('keeps every character so the text stays copyable', () => {
        const samples = [
            'plain text',
            '{{upper::{{char}}}} rolled {{roll::d20}}',
            '{{greet::Alice::[mood]}}',
            'before {{a::{{b::c}}}} after',
            '{{// a comment with | and {{user}}}}',
            '{{foreachChatVar::satiety_::p}}{{.p}}: {{.p_value}}{{/foreachChatVar}}',
        ];
        for (const sample of samples) {
            expect(roundTrip(sample)).toBe(sample);
        }
    });

    test('marks names, nested names and argument punctuation separately', () => {
        const tokens = tokenizeMacroText('{{upper::{{char}}}}');
        expect(tokens.filter(token => token.kind === 'name').map(token => token.text)).toEqual(['upper', 'char']);
        expect(tokens.filter(token => token.kind === 'punct').map(token => token.text)).toEqual(['{{', '::', '{{', '}}', '}}']);
    });

    test('keeps optional argument brackets as punctuation around the argument', () => {
        const tokens = tokenizeMacroText('{{greet::Alice::[mood]}}');
        expect(tokens).toContainEqual({ kind: 'opt', text: 'mood' });
        expect(tokens.map(token => token.text).filter(text => text === '[' || text === ']')).toEqual(['[', ']']);
    });

    test('handles the list marker and block closers', () => {
        const list = tokenizeMacroText('{{listpick::weather::…}}');
        expect(list).toContainEqual({ kind: 'arg', text: '…' });

        const close = tokenizeMacroText('{{/if}}');
        expect(close.filter(token => token.kind === 'name').map(token => token.text)).toEqual(['if']);
        expect(close[0]).toEqual({ kind: 'punct', text: '{{' });
    });

    test('splits top-level arguments but not separators inside nested macros', () => {
        expect(splitMacroArgs('one::two::{{nested::three}}')).toEqual(['one', 'two', '{{nested::three}}']);
    });
});

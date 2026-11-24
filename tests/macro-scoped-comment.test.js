import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import * as chevrotain from 'chevrotain';
import { SCOPED_COMMENT_CASES, UNCLOSED_SCOPE_CASES } from './fixtures/macro-scoped-comment-cases.js';
import { evaluateEveryExample, installFixedClock, readExampleUsageBaseline } from './fixtures/macro-example-usage.js';

await jest.unstable_mockModule('../public/lib.js', () => ({ chevrotain }));

const { MacroLexer } = await import('../public/scripts/macros/engine/MacroLexer.js');
const { MacroParser } = await import('../public/scripts/macros/engine/MacroParser.js');
const { MacroCstWalker } = await import('../public/scripts/macros/engine/MacroCstWalker.js');
const { createMacroEnvironment, MacroRegistry } = await import('../src/macros/index.js');
const { isCommentOnlyPromptContent } = await import('../public/scripts/prompt-token-counts.js');

const tokenNames = input => MacroLexer.test(input).tokens.map(token => token.type);

function evaluate(input) {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        return createMacroEnvironment({}).evaluate(input);
    } finally {
        warn.mockRestore();
    }
}

describe('scoped comment macro, browser-side registry', () => {
    test.each(SCOPED_COMMENT_CASES)('$name', ({ input, after }) => {
        expect(evaluate(input)).toBe(after);
    });

    test('rows that did not change keep their output from origin/staging', () => {
        const unchanged = SCOPED_COMMENT_CASES.filter(entry => !entry.changed);
        expect(unchanged.length).toBeGreaterThan(10);
        for (const { input, before } of unchanged) {
            expect(evaluate(input)).toBe(before);
        }
    });

    test('a scoped comment runs nested macros exactly as the inline comment does', () => {
        expect(evaluate('{{//}}{{setvar::x::1}}{{///}}[{{getvar::x}}]')).toBe('[1]');
        expect(evaluate('{{// {{setvar::x::1}}}}[{{getvar::x}}]')).toBe('[1]');
    });

    test('a lone opener keeps its arity warning and a stray closer stays silent', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(createMacroEnvironment({}).evaluate('A{{//}}B')).toBe('AB');
            expect(warn).toHaveBeenCalledTimes(1);
            warn.mockClear();
            expect(createMacroEnvironment({}).evaluate('A{{///}}B')).toBe('AB');
            expect(warn).not.toHaveBeenCalled();
            expect(createMacroEnvironment({}).evaluate('A{{//}}hidden{{///}}B')).toBe('AB');
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('lexing of the closing comment tag', () => {
    test('{{///}} is a closing flag followed by the comment name', () => {
        for (const input of ['{{///}}', '{{ /// }}', '{{ ///\n}}']) {
            expect(tokenNames(input)).toEqual(['Macro.Start', 'Macro.Flag', 'Macro.DoubleSlash', 'Macro.End']);
            expect(MacroParser.parseDocument(input).errors).toEqual([]);
        }
    });

    test('other comment spellings lex as before', () => {
        expect(tokenNames('{{//}}')).toEqual(['Macro.Start', 'Macro.DoubleSlash', 'Macro.End']);
        expect(tokenNames('{{ // }}')).toEqual(['Macro.Start', 'Macro.DoubleSlash', 'Macro.End']);
        expect(tokenNames('{{// a}}')[1]).toBe('Macro.DoubleSlash');
        expect(tokenNames('{{///x}}').slice(0, 3)).toEqual(['Macro.Start', 'Macro.DoubleSlash', 'Unknown']);
        expect(tokenNames('{{////}}').slice(0, 3)).toEqual(['Macro.Start', 'Macro.DoubleSlash', 'Unknown']);
        expect(tokenNames('{{/comment}}')).toEqual(['Macro.Start', 'Macro.Flag', 'Macro.Identifier', 'Macro.End']);
        expect(tokenNames('{{#///}}')).toEqual(['Macro.Start', 'Macro.Flag', 'Macro.Flag', 'Macro.DoubleSlash', 'Macro.End']);
    });
});

describe('unclosed scope reporting', () => {
    test.each(UNCLOSED_SCOPE_CASES)('$input', ({ input, after }) => {
        createMacroEnvironment({});
        const { cst } = MacroParser.parseDocument(input);
        const names = MacroCstWalker.findUnclosedScopes({ text: input, cst }).map(scope => scope.name);
        expect(names).toEqual(after);
    });

    test('the closing tag suggested for a scoped comment closes it', () => {
        createMacroEnvironment({});
        const input = '{{//}}a';
        const { cst } = MacroParser.parseDocument(input);
        const [scope] = MacroCstWalker.findUnclosedScopes({ text: input, cst });
        const closer = `{{${scope.paddingBefore}/${scope.name}${scope.paddingAfter}}}`;
        expect(closer).toBe('{{///}}');
        expect(evaluate(input + closer)).toBe('');
    });
});

describe('token counter agrees with the evaluator', () => {
    test('a prompt is comment-only exactly when it evaluates to nothing visible', () => {
        const inputs = [
            '{{//}}First line\nSecond line{{///}}',
            '{{ // }}x{{ /// }}',
            '{{COMMENT}}x{{/Comment}}',
            '{{comment}}x{{/comment}}',
            '{{//}}a{{//}}b{{///}}c{{///}}',
            '{{//}}a{{///}}{{//}}b{{///}}',
            '{{// inline}}',
            '{{//}}a{{///}}b',
            '{{//}}a',
            '{{//}}x{{/comment}}',
            '{{comment}}x{{///}}',
            '{{//}}a{{///}}{{///}}',
            '{{comment x}}{{/comment}}',
            '{{comment x}}{{comment}}y{{/comment}}',
        ];
        for (const input of inputs) {
            const visible = evaluate(input).trim() !== '';
            expect({ input, commentOnly: isCommentOnlyPromptContent(input) }).toEqual({ input, commentOnly: !visible });
        }
    });
});

describe('every registered exampleUsage', () => {
    // Jest gives the test its own process.env and the dice and random macros read real entropy, so the
    // time zone and these macros cannot be pinned here; tests/macro-scoped-comment.node.js compares all of them.
    let restoreClock;
    beforeAll(() => {
        restoreClock = installFixedClock();
    });
    afterAll(() => {
        restoreClock();
    });

    const CLOCK_OR_RANDOM = new Set([
        '{{random::blonde::brown::red::black::blue}}',
        '{{roll::3d6+4}}',
        '{{time}}',
        '{{datetimeformat::YYYY-MM-DD HH:mm:ss}}',
        '{{datetimeformat::LLLL}}',
    ]);

    test('evaluates exactly as it did on origin/staging', () => {
        const actual = evaluateEveryExample({ createMacroEnvironment, MacroRegistry });
        const baseline = readExampleUsageBaseline();
        expect(Object.keys(baseline)).toHaveLength(58);
        expect(Object.keys(actual).sort()).toEqual(Object.keys(baseline).sort());
        const differing = Object.keys(baseline)
            .filter(example => !CLOCK_OR_RANDOM.has(example))
            .filter(example => actual[example] !== baseline[example]);
        expect(differing).toEqual([]);
        for (const example of CLOCK_OR_RANDOM) {
            expect(actual[example]).toEqual(expect.any(String));
            expect(actual[example]).not.toBe('');
            expect(actual[example]).not.toContain('{{');
        }
    });
});

import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Use the real host parser, not a friendlier stand-in, so parsing regressions show up here. */
const utilsSource = readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');
const start = utilsSource.indexOf('export function regexFromString');
const end = utilsSource.indexOf('\n}\n', start) + 3;
const regexFromString = vm.runInNewContext(`(${utilsSource.slice(start, end).replace('export ', '')})`);

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    regexFromString,
    uuidv4: jest.fn(() => 'test-uuid'),
}));

const {
    AGENT_REGEX_PLACEMENT,
    AGENT_REGEX_SUBSTITUTE,
    applyRegexScript,
    applyRegexScriptList,
    normalizeRegexScript,
} = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');

function script(overrides) {
    return normalizeRegexScript({ id: 's1', scriptName: 'test', markdownOnly: false, ...overrides });
}

describe('regexFromString parses the whole input', () => {
    test('a multi-line pattern compiles as one pattern', () => {
        const compiled = regexFromString('a\nb');
        expect(compiled.test('a\nb')).toBe(true);
        expect(compiled.test('xa')).toBe(false);
    });

    test('literals with modern flags keep their flags', () => {
        const sticky = regexFromString('/x/y');
        expect(sticky.sticky).toBe(true);
        const dotAll = regexFromString('/a.b/s');
        expect(dotAll.test('a\nb')).toBe(true);
    });

    test('invalid flags fall back to a plain pattern instead of being dropped silently', () => {
        expect(regexFromString('/a/gg').test('/a/gg')).toBe(true);
    });
});

describe('agent regex replacement is bounded to real captures', () => {
    test('a capture index past the last group yields nothing, not the match offset or source', () => {
        const output = applyRegexScript(script({ findRegex: '/(foo)/', replaceString: '[$1|$2|$3]' }), 'xx foo');
        expect(output).toBe('xx [foo||]');
    });

    test('named groups resolve', () => {
        const output = applyRegexScript(script({ findRegex: '/(?<word>bar)/', replaceString: '<$<word>>' }), 'a bar');
        expect(output).toBe('a <bar>');
    });

    test('a null legacy script does not abort the list', () => {
        expect(() => normalizeRegexScript(null)).not.toThrow();
        const output = applyRegexScriptList('hello', [null, { findRegex: '/hello/', replaceString: 'bye', markdownOnly: false }], AGENT_REGEX_PLACEMENT.AI_OUTPUT);
        expect(output).toBe('bye');
    });
});

describe('the message speaker overrides the selected character in every macro pass', () => {
    test('find, replace and trim macros all receive the character override', () => {
        const substituteParamsFn = jest.fn((value, options = {}) => value.replaceAll('{{char}}', options.name2Override ?? 'Bob'));
        const output = applyRegexScript(
            script({
                findRegex: '/{{char}}: (.*)/',
                replaceString: '$1 said by {{char}}',
                trimStrings: ['{{char}}!'],
                substituteRegex: AGENT_REGEX_SUBSTITUTE.RAW,
            }),
            'Alice: hi Alice! there',
            { characterOverride: 'Alice', substituteParamsFn, substituteParamsExtendedFn: jest.fn(value => value) },
        );
        expect(output).toBe('hi  there said by Alice');
        for (const [, options] of substituteParamsFn.mock.calls) {
            expect(options?.name2Override).toBe('Alice');
        }
    });
});

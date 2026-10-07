import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { regexFromString } from '../public/scripts/regex-utils.js';
import { SAMPLES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js';

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandRuntimeUtils.js', () => ({
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

describe('bundled Relationship Tracker Unsaid quotes', () => {
    const bundles = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));
    const scripts = bundles['tpl-relationship-tracker'];
    const render = (value, replacements = scripts) => applyRegexScriptList(
        SAMPLES['relationship-bond'].full.replace('I hoped you would stay', value),
        replacements, AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true },
    ).match(/Unsaid[\s\S]*?<\/summary><div[^>]*>([\s\S]*?)<\/div>/)?.[1];

    test.each([
        ['I hoped you would stay', '“I hoped you would stay”'],
        ['<font color="#aaffaa">Stay</font>', '“<font color="#aaffaa">Stay</font>”'],
        ['"Stay"', '"Stay"'],
        ['“Stay”', '“Stay”'],
        ['<font color="#aaffaa">"Stay"</font>', '<font color="#aaffaa">"Stay"</font>'],
        ['<font color="#aaffaa"><em>“Stay”</em></font>', '<font color="#aaffaa"><em>“Stay”</em></font>'],
        ['<font color="#aaffaa">&quot;Stay&quot;</font>', '<font color="#aaffaa">&quot;Stay&quot;</font>'],
        ['He said "stay" quietly', '“He said "stay" quietly”'],
        ['"Stay', '“"Stay”'],
    ])('preserves one surrounding pair and original markup for %s', (value, expected) => {
        expect(render(value)).toBe(expected);
    });

    test('saved copies with new identities receive the same display repair', () => {
        expect(render('"Stay"', scripts.map(item => ({ ...item, id: 'saved-copy', scriptName: 'My tracker' })))).toBe('"Stay"');
    });

    test('custom replacement punctuation is preserved', () => {
        const customised = scripts.map(item => ({ ...item, replaceString: item.replaceString.replace('“$17”', 'Thought: “$17”') }));
        expect(render('"Stay"', customised)).toBe('Thought: “"Stay"”');
    });
});

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

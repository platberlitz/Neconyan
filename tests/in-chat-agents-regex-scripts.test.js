import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { regexFromString, replaceWithRegex } from '../public/scripts/regex-utils.js';
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

describe('replaceWithRegex matches native String.prototype.replace for leading prefix lookbehinds', () => {
    const plotCompassTemplate = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/plot-compass-companion.json', import.meta.url), 'utf8'));
    const compare = (input, regex, replacer) => {
        const nativeCalls = [];
        const fastCalls = [];
        const nativeOut = input.replace(new RegExp(regex.source, regex.flags), (...args) => {
            nativeCalls.push(args);
            return replacer(...args);
        });
        const fastOut = replaceWithRegex(input, regex, (...args) => {
            fastCalls.push(args);
            return replacer(...args);
        });
        return { fastOut, nativeOut, fastCalls, nativeCalls };
    };

    test.each([
        ['global multiline after HTML marker', '<style>body{a:1}</style><div data-pc-card="1">\nfoo\nbar\nfoo', /(?<=data-pc-card="1"[\s\S]*)^foo$/gm, m => `[${m}]`],
        ['non-global stops after first match', 'xx data-pc-card="1" aa aa', /(?<=data-pc-card="1"[\s\S]*)aa/, m => m.toUpperCase()],
        ['case-insensitive marker', 'prefix DATA-PC-CARD="1" **bold** and *italic*', /(?<=data-pc-card="1"[\s\S]*)\*\*([^*\n]+)\*\*/gi, (_, inner) => `<strong>${inner}</strong>`],
        ['named capture groups preserve groups argument shape', 'pre data-pc-card="1" hello world', /(?<=data-pc-card="1"[\s\S]*)(?<w>\w+)/g, (m, _g1, _off, _src, groups) => `<${groups.w}>`],
        ['inner lookbehind and word boundaries see the full string', 'pre data-pc-card="1"word *ok* **bold**', /(?<=data-pc-card="1"[\s\S]*)(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, inner) => `<em>${inner}</em>`],
        ['dotAll leading .* prefix', 'head\nMARK\nline1\nline2', /(?<=MARK.*)line\d/gs, m => m.toUpperCase()],
        ['lazy [\\s\\S]*? prefix', 'MARK a b', /(?<=MARK[\s\S]*?)[ab]/g, m => m.toUpperCase()],
        ['zero-length matches advance identically', 'MARK ab', /(?<=MARK[\s\S]*)(?=[ab]|$)/g, () => '|'],
        ['surrogate pairs with unicode flag advance by code point', '😀MARK😀x', /(?<=😀MARK[\s\S]*)(?:)/gu, () => '.'],
        ['escaped literal characters in marker', 'a/b.c(1)+2 tail foo', /(?<=a\/b\.c\(1\)\+2[\s\S]*)foo/g, () => 'BAR'],
        ['marker absent skips all matches', 'no marker here foo bar', /(?<=data-pc-card="1"[\s\S]*)foo/g, () => 'BAR'],
        ['repeated marker still anchors at earliest occurrence', 'MARK one MARK two', /(?<=MARK[\s\S]*)\b\w+\b/g, m => `(${m})`],
    ])('%s', (_name, input, regex, replacer) => {
        const { fastOut, nativeOut, fastCalls, nativeCalls } = compare(input, regex, replacer);
        expect(fastOut).toBe(nativeOut);
        expect(fastCalls).toEqual(nativeCalls);
    });

    test.each([
        ['top-level alternation must still match outside the marker', 'foo MARK bar', /(?<=MARK[\s\S]*)bar|foo/g],
        ['dot without dotAll flag does not cross newlines', 'MARK\nfoo', /(?<=MARK.*)foo/g],
        ['quantified atom in marker falls back cleanly', 'MRK foo', /(?<=MA?RK[\s\S]*)foo/g],
        ['character class in marker falls back cleanly', 'X foo', /(?<=[A-Z][\s\S]*)foo/g],
        ['character class escape in marker falls back cleanly', '9 foo', /(?<=\d[\s\S]*)foo/g],
        ['sticky regex obeys lastIndex without rewriting', 'MARK foo', /(?<=MARK[\s\S]*)foo/y],
    ])('falls back safely when pattern is not a pure literal prefix: %s', (_name, input, regex) => {
        const { fastOut, nativeOut, fastCalls, nativeCalls } = compare(input, regex, m => `[${m}]`);
        expect(fastOut).toBe(nativeOut);
        expect(fastCalls).toEqual(nativeCalls);
    });

    test('re-entrant replacer using the same RegExp does not corrupt outer iteration', () => {
        const re = /(?<=MARK[\s\S]*)\w+/g;
        const input = 'MARK one two';
        const out = replaceWithRegex(input, re, match => {
            if (match === 'one') {
                return replaceWithRegex('MARK inner', re, inner => inner.toUpperCase());
            }
            return match.toUpperCase();
        });
        expect(out).toBe('MARK MARK INNER TWO');
        expect(re.lastIndex).toBe(0);
    });

    test('bundled Plot Compass regex scripts produce identical HTML to native replace', () => {
        const sample = SAMPLES['plot-compass'].full;
        const fast = applyRegexScriptList(sample, plotCompassTemplate.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true });
        let nativeOut = sample;
        for (const item of plotCompassTemplate.regexScripts) {
            const compiled = regexFromString(item.findRegex);
            nativeOut = nativeOut.replace(compiled, item.replaceString);
        }
        expect(fast).toBe(nativeOut);
        expect(fast).toContain('data-pc-card="1"');
        expect(fast).toContain('<strong>brass token</strong>');
        expect(fast).toContain('<em>limping courier</em>');
    });
});

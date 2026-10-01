import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

let helpers;

beforeAll(async () => {
    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => Array.isArray(strings) && !strings.raw
            ? strings[0]
            : strings.reduce((joined, part, index) => joined + part + (index < values.length ? values[index] : ''), ''),
    }));
    helpers = await import('../public/scripts/extensions/regex/helpers.js');
});

describe('regex editor helpers', () => {
    test('reads plain and slash-wrapped patterns', () => {
        expect(helpers.parseRegexInput('/abc/gi')).toEqual({ source: 'abc', flags: 'gi', literal: true });
        expect(helpers.parseRegexInput('abc')).toEqual({ source: 'abc', flags: '', literal: false });
        expect(helpers.parseRegexInput('')).toEqual({ source: '', flags: '', literal: false });
    });

    test('flag options switch flags on and off in a stable order', () => {
        expect(helpers.setRegexFlag('/abc/g', 'i', true)).toBe('/abc/gi');
        expect(helpers.setRegexFlag('/abc/gi', 'i', false)).toBe('/abc/g');
        expect(helpers.setRegexFlag('abc', 'g', true)).toBe('/abc/g');
        expect(helpers.setRegexFlag('/abc/s', 'g', true)).toBe('/abc/gs');
        expect(helpers.setRegexFlag('', 'g', true)).toBe('');
    });

    test('pieces insert at the cursor and stay inside the slashes', () => {
        const digits = helpers.REGEX_SNIPPETS.find(snippet => snippet.id === 'digits');
        expect(helpers.insertRegexSnippet('', 0, 0, digits).value).toBe(`/${digits.pattern}/g`);
        const inserted = helpers.insertRegexSnippet('/ab/g', 2, 2, digits);
        expect(inserted.value).toBe(`/a${digits.pattern}b/g`);
        const atEnd = helpers.insertRegexSnippet('/ab/g', 5, 5, digits);
        expect(atEnd.value).toBe(`/ab${digits.pattern}/g`);
        const group = helpers.REGEX_SNIPPETS.find(snippet => snippet.id === 'group');
        expect(helpers.insertRegexSnippet('/abc/g', 1, 4, group).value).toBe('/(abc)/g');
    });

    test('explains patterns in plain words', () => {
        const rows = helpers.describeRegex('/"([^"\\n]+)"/g');
        expect(rows.map(row => row.token)).toEqual(['"', '(', '[^"\\n]', '+', ')', '"']);
        expect(rows[0].text).toBe('the exact text \'"\'');
        expect(rows[1].text).toContain('$1');
        expect(rows[2].text).toBe('one character that is not any of: \'"\', a line break');
        expect(rows[3].text).toBe('the piece before, repeated one or more times');
        expect(helpers.describeRegex('/[a-z0-9]{2,4}?/')[0].text).toBe('one character from: \'a\' to \'z\', \'0\' to \'9\'');
        expect(helpers.describeRegex('/[a-z0-9]{2,4}?/')[1].text).toBe('the piece before, between 2 and 4 times, as few as possible');
        expect(helpers.describeRegex('/hello/')).toEqual([{ token: 'hello', text: 'the exact text \'hello\'' }]);
        expect(helpers.describeRegex('')).toEqual([]);
    });

    test('counts matches in the sample and reports mistakes', () => {
        expect(helpers.countRegexMatches('/"[^"]+"/g', 'He said "hi" and "bye".')).toBe(2);
        expect(helpers.countRegexMatches('/a/', 'aaa')).toBe(1);
        expect(helpers.countRegexMatches('/(/g', 'abc')).toBe(-1);
    });

    test('every recipe is a working pattern', () => {
        expect(helpers.REGEX_RECIPES.length).toBeGreaterThanOrEqual(5);
        for (const recipe of helpers.REGEX_RECIPES) {
            expect(helpers.countRegexMatches(recipe.find, '')).toBeGreaterThanOrEqual(0);
            expect(recipe.label).toBeTruthy();
            expect(recipe.name).toBeTruthy();
        }
        const think = helpers.REGEX_RECIPES.find(recipe => recipe.id === 'think');
        expect(helpers.countRegexMatches(think.find, 'a <think>x\ny</think> b')).toBe(1);
    });
});

describe('script search', () => {
    const makeRow = name => {
        const classes = new Set();
        return {
            classes,
            classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
            querySelector: () => ({ textContent: name }),
        };
    };

    test('hides rows whose names do not match, ignoring case', () => {
        const rows = [makeRow('Trim Color Blocks'), makeRow('Bold dialogue'), makeRow('Remove HTML tags')];
        const root = { querySelectorAll: () => rows };
        expect(helpers.filterRegexScriptRows(root, 'COLOR')).toBe(1);
        expect(rows.map(row => row.classes.has('regex_filtered_out'))).toEqual([false, true, true]);
        expect(helpers.filterRegexScriptRows(root, '  ')).toBe(3);
        expect(rows.some(row => row.classes.has('regex_filtered_out'))).toBe(false);
    });

    test('the list keeps the search after it is redrawn', () => {
        const index = read('../public/scripts/extensions/regex/index.js');
        expect(index).toMatch(/setMoveButtonsVisibility\(\);\s*applyRegexScriptFilter\(\);/);
        expect(index).toContain('$(\'#regex_script_filter\').on(\'input\', applyRegexScriptFilter);');
    });
});

describe('regex editor wiring', () => {
    test('the editor template has the helper slots', () => {
        const editor = read('../public/scripts/extensions/regex/editor.html');
        for (const hook of ['regex_recipe_select', 'regex_flag_chips', 'regex_snippet_chips', 'regex_explain_list', 'regex_test_use_last', 'regex_test_matches']) {
            expect(editor).toContain(hook);
        }
    });

    test('the editor popup sets the helpers up', () => {
        const index = read('../public/scripts/extensions/regex/index.js');
        expect(index).toContain('import { filterRegexScriptRows, setupRegexEditorHelpers } from \'./helpers.js\';');
        expect(index).toContain('setupRegexEditorHelpers(editorHtml.get(0)');
    });

    test('flag boxes do not undo themselves on the input event', () => {
        const source = read('../public/scripts/extensions/regex/helpers.js');
        expect(source).toMatch(/dataset\?\.regexFlag\) return;/);
    });
});

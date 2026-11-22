import { describe, expect, test } from '@jest/globals';
import { CHECK_TARGETS, findShortcuts, parseShortcut, replaceShortcut } from '../public/scripts/scratchpad/check-shortcuts.js';
import { commandLines, expandTypedTools } from '../public/scripts/scratchpad/typed-tools.js';

const parse = text => {
    const { shortcuts } = findShortcuts(text);
    return shortcuts.map(parseShortcut);
};

describe('Scratchpad check shortcuts', () => {
    test('a message without a shortcut has none', () => {
        for (const text of ['', 'Please check my card', 'Why did it not trigger?', 'text /check card', '/checkcard', '/check-card', '//check card', '/roll 2d6\n/now', '/tools']) {
            expect(findShortcuts(text).shortcuts).toEqual([]);
        }
    });

    test('each target is read whatever its case, with the words after it kept', () => {
        expect(CHECK_TARGETS).toEqual(['card', 'preset', 'lorebook', 'app']);
        expect(parse('/check card')).toEqual([{ kind: 'check', word: 'card', target: 'card', rest: '' }]);
        expect(parse('/CHECK Preset')).toEqual([{ kind: 'check', word: 'Preset', target: 'preset', rest: '' }]);
        expect(parse('/check lorebook   the second book  ')).toEqual([{ kind: 'check', word: 'lorebook', target: 'lorebook', rest: 'the second book' }]);
        expect(parse('/check\tapp')).toEqual([{ kind: 'check', word: 'app', target: 'app', rest: '' }]);
        expect(parse('/check card focus on the greeting')[0].rest).toBe('focus on the greeting');
    });

    test('a bare /check and an unknown word are told apart', () => {
        expect(parse('/check')).toEqual([{ kind: 'check', word: '', target: '', rest: '' }]);
        expect(parse('/check   ')).toEqual([{ kind: 'check', word: '', target: '', rest: '' }]);
        expect(parse('/check carrd')).toEqual([{ kind: 'check', word: 'carrd', target: '', rest: '' }]);
        expect(parse('/check cards please')).toEqual([{ kind: 'check', word: 'cards', target: '', rest: 'please' }]);
    });

    test('/why carries the typed name, without quotes around it', () => {
        expect(parse('/why Dragon Lair')).toEqual([{ kind: 'why', name: 'Dragon Lair' }]);
        expect(parse('/why   "Dragon Lair" ')).toEqual([{ kind: 'why', name: 'Dragon Lair' }]);
        expect(parse('/why \'Mage\'s Tower\'')).toEqual([{ kind: 'why', name: 'Mage\'s Tower' }]);
        expect(parse('/why')).toEqual([{ kind: 'why', name: '' }]);
        expect(parse('/why \'')).toEqual([{ kind: 'why', name: '\'' }]);
    });

    test('lines inside a code block are left alone, and a block that closes frees the next line', () => {
        expect(findShortcuts('```\n/check card\n```').shortcuts).toEqual([]);
        expect(findShortcuts('~~~\n/why Dragon\n~~~').shortcuts).toEqual([]);
        expect(findShortcuts('```\n/check card\n```\n/check app').shortcuts.map(item => item.index)).toEqual([3]);
        expect(findShortcuts('  ```\n/check card').shortcuts).toEqual([]);
    });

    test('every shortcut line in a message is found, so the caller can refuse more than one', () => {
        expect(findShortcuts('/check card\nhello\n/why Dragon').shortcuts.map(item => [item.index, item.command])).toEqual([[0, 'check'], [2, 'why']]);
    });

    test('the request takes the place of the line, and the rest follows it in its own paragraph', () => {
        const { lines } = findShortcuts('Before\n/check card focus on the greeting\nAfter');
        expect(replaceShortcut(lines, 1, 'Check the card.', 'focus on the greeting')).toBe('Before\nCheck the card.\n\nfocus on the greeting\nAfter');
        expect(replaceShortcut(lines, 1, 'Check the card.')).toBe('Before\nCheck the card.\nAfter');
        expect(replaceShortcut(['/check app'], 0, 'Use the diagnostics.', '')).toBe('Use the diagnostics.');
    });

    test('typed tools and shortcuts read the same lines', () => {
        const text = '/roll 2d6\n```\n/check card\n```\n/check app\n/now';
        expect(commandLines(text).map(item => item.name)).toEqual(['roll', undefined, undefined, undefined, 'check', 'now']);
        const expanded = expandTypedTools(text, { randomInt: () => 0 });
        expect(findShortcuts(expanded.text).shortcuts.map(item => item.index)).toEqual([4]);
        expect(expandTypedTools('/check card focus on the greeting')).toEqual({ text: '/check card focus on the greeting', used: [], help: false });
    });
});

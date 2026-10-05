import { describe, expect, test } from '@jest/globals';
import {
    describeChange,
    formatEntry,
    formatField,
    normaliseChange,
    parseEntry,
    parseField,
    splitReply,
} from '../public/scripts/scratchpad/proposals.js';

const fence = value => `\`\`\`scratchpad-change\n${JSON.stringify(value)}\n\`\`\``;

describe('Scratchpad reply parsing', () => {
    test('keeps text and changes in reply order', () => {
        const reply = [
            'Here is an idea.',
            fence({ type: 'lorebook', action: 'add', book: 'Harbour', title: 'Old lighthouse', keys: ['lighthouse'], content: 'It still turns at night.', reason: 'Mentioned twice' }),
            'And one more thing.',
            fence({ type: 'chat', action: 'hide', message: '#4' }),
        ].join('\n');
        const parts = splitReply(reply);
        expect(parts.map(part => part.type)).toEqual(['text', 'change', 'text', 'change']);
        expect(parts[1]).toMatchObject({ index: 0, error: '', change: { type: 'lorebook', action: 'add', book: 'Harbour', keys: ['lighthouse'], constant: false } });
        expect(parts[3]).toMatchObject({ index: 1, change: { type: 'chat', action: 'hide', message: 4 } });
    });

    test('reports broken changes without hiding the rest of the reply', () => {
        const parts = splitReply('Before\n```scratchpad-change\n{not json\n```\nAfter\n' + fence({ type: 'chat', action: 'edit', message: 2 }));
        expect(parts[1]).toMatchObject({ type: 'change', change: null, error: 'This change could not be read.' });
        expect(parts[3]).toMatchObject({ type: 'change', change: null, error: 'This message rewrite has no text.' });
        expect(parts[0].text).toContain('Before');
        expect(parts[2].text).toContain('After');
    });

    test('a reply without changes stays one text part', () => {
        expect(splitReply('Just talk.')).toEqual([{ type: 'text', text: 'Just talk.' }]);
        expect(splitReply('')).toEqual([]);
    });

    test('accepts every supported change shape', () => {
        expect(normaliseChange({ type: 'lorebook', action: 'edit', book: 'B', uid: '7', keys: 'a, b' })).toEqual({ type: 'lorebook', action: 'edit', book: 'B', uid: 7, keys: ['a', 'b'], reason: '' });
        expect(normaliseChange({ type: 'lorebook', action: 'delete', book: 'B', uid: 0 })).toMatchObject({ action: 'delete', uid: 0 });
        expect(normaliseChange({ type: 'character', character: 'Ayla', field: 'alternate_greetings', value: ['Hi', ' ', 'Hello'] })).toMatchObject({ value: ['Hi', 'Hello'] });
        expect(normaliseChange({ type: 'character', character: 'Ayla', field: 'tags', value: 'sea, storm' })).toMatchObject({ value: ['sea', 'storm'] });
        expect(normaliseChange({ type: 'character', character: 'Ayla', field: 'first_mes', value: 'Hello.' })).toMatchObject({ field: 'first_mes', value: 'Hello.' });
        expect(normaliseChange({ type: 'chat', action: 'insert', after: 3, speaker: 'user', text: 'Wait.' })).toMatchObject({ after: 3, speaker: 'user', name: '' });
        expect(normaliseChange({ type: 'chat', action: 'insert', after: 3, speaker: 'narrator', text: 'Rain.' })).toMatchObject({ speaker: 'character' });
    });

    test('rejects changes that cannot be applied safely', () => {
        expect(() => normaliseChange([])).toThrow('not a JSON object');
        expect(() => normaliseChange({ type: 'lorebook', action: 'add', content: 'x' })).toThrow('which lorebook');
        expect(() => normaliseChange({ type: 'lorebook', action: 'add', book: 'B', content: ' ' })).toThrow('no content');
        expect(() => normaliseChange({ type: 'lorebook', action: 'edit', book: 'B', uid: 1 })).toThrow('does not change anything');
        expect(() => normaliseChange({ type: 'lorebook', action: 'edit', book: 'B', uid: -1, content: 'x' })).toThrow('which entry');
        expect(() => normaliseChange({ type: 'character', character: 'Ayla', field: 'avatar', value: 'x' })).toThrow('cannot change that character field');
        expect(() => normaliseChange({ type: 'character', field: 'description', value: 'x' })).toThrow('which character');
        expect(() => normaliseChange({ type: 'chat', action: 'delete', message: 'last' })).toThrow('which message');
        expect(() => normaliseChange({ type: 'chat', action: 'wipe', message: 1 })).toThrow('unknown action');
        expect(() => normaliseChange({ type: 'settings' })).toThrow('unknown type');
    });

    test('describes changes in plain words', () => {
        expect(describeChange({ type: 'lorebook', action: 'add', book: 'Harbour', title: 'Old lighthouse' })).toBe('New lorebook entry \'Old lighthouse\' in Harbour');
        expect(describeChange({ type: 'character', character: 'Ayla', field: 'mes_example' })).toBe('Change Ayla\'s example messages');
        expect(describeChange({ type: 'chat', action: 'unhide', message: 5 })).toBe('Show message #5 again');
        expect(describeChange({ type: 'chat', action: 'insert', after: 2 })).toBe('Add a message after #2');
    });

    test.each([undefined, null, '', ' ', '#', '# ', [], [0], false, {}, -1, 1.5, '1e2', Number.MAX_SAFE_INTEGER + 1])('rejects missing or malformed targets: %p', target => {
        expect(() => normaliseChange({ type: 'chat', action: 'delete', message: target })).toThrow('which message');
        expect(() => normaliseChange({ type: 'chat', action: 'insert', after: target, text: 'Hello.' })).toThrow('where it goes');
        expect(() => normaliseChange({ type: 'lorebook', action: 'delete', book: 'B', uid: target })).toThrow('which entry');
    });

    test.each([0, '0', '#0', ' #12 '])('accepts explicit numbered targets: %p', target => {
        expect(normaliseChange({ type: 'chat', action: 'hide', message: target }).message).toBe(Number(String(target).trim().replace('#', '')));
    });

    test.each(['constructor', '__proto__', 'toString'])('rejects inherited character fields: %s', field => {
        expect(() => normaliseChange({ type: 'character', character: 'Ayla', field, value: 'x' })).toThrow('cannot change that character field');
    });

    test('review text round-trips for entries and list fields', () => {
        const entry = { title: 'Old lighthouse', keys: ['lighthouse', 'beacon'], constant: true, content: 'Line one\n\nLine two' };
        expect(parseEntry(formatEntry(entry), {})).toEqual(entry);
        expect(parseEntry('Only content', { title: 'Kept', keys: ['k'], constant: false })).toEqual({ title: 'Kept', keys: ['k'], constant: false, content: 'Only content' });
        const greetings = ['Hello there.', 'Morning!'];
        expect(parseField('alternate_greetings', formatField('alternate_greetings', greetings))).toEqual(greetings);
        expect(parseField('tags', formatField('tags', ['a', 'b']))).toEqual(['a', 'b']);
        expect(parseField('description', 'Text')).toBe('Text');
    });
});

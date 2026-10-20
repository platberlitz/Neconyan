import { describe, expect, test } from '@jest/globals';
import { normaliseCharacterDraft } from '../public/scripts/neconyan-character-draft.js';

const note = '  [Nova\'s persona: curious;]\n';
const greetings = ['  Hello, {{user}}.\n', '', 'Hello again.', 'Hello again.'];
const locations = [
    ['top-level canonical', draft => draft, 'alternateGreetings'],
    ['top-level alias', draft => draft, 'alternate_greetings'],
    ['nested canonical', draft => draft.character, 'alternateGreetings'],
    ['nested alias', draft => draft.character, 'alternate_greetings'],
];
const draft = () => ({ character: { name: '  Nova  ', description: 'Original description.' } });

describe('new-character draft compatibility', () => {
    test.each(locations)('canonicalises %s greetings and nested notes without changing authored text', (_label, target, key) => {
        const input = draft();
        input.character.characterNote = note;
        target(input)[key] = greetings;
        const original = structuredClone(input);
        Object.freeze(greetings);
        Object.freeze(input.character);
        Object.freeze(input);
        const result = normaliseCharacterDraft(input);
        expect(result).toEqual({ character: { name: 'Nova', description: 'Original description.' }, characterNote: note,
            alternateGreetings: greetings, avatarPrompt: '' });
        expect(input).toEqual(original);
        expect(result.character).not.toBe(input.character);
        expect(result.alternateGreetings).not.toBe(greetings);
        expect(normaliseCharacterDraft(result)).toEqual(result);
        result.alternateGreetings.push('Independent copy.');
        expect(greetings).toHaveLength(4);
    });

    test('preserves canonical input, defaults and the existing top-level avatar prompt', () => {
        expect(normaliseCharacterDraft({ ...draft(), characterNote: note, alternateGreetings: greetings, avatarPrompt: ' Portrait. ' }))
            .toMatchObject({ characterNote: note, alternateGreetings: greetings, avatarPrompt: 'Portrait.' });
        expect(normaliseCharacterDraft(draft())).toMatchObject({ characterNote: '', alternateGreetings: [], avatarPrompt: '' });
    });

    test('accepts identical duplicates in every supported location', () => {
        const input = { ...draft(), characterNote: note, alternateGreetings: [...greetings], alternate_greetings: [...greetings] };
        Object.assign(input.character, { characterNote: note, alternateGreetings: [...greetings], alternate_greetings: [...greetings] });
        expect(normaliseCharacterDraft(input)).toMatchObject({ characterNote: note, alternateGreetings: greetings });
    });

    test.each(['', 'Different.', note.trim()])('rejects a conflicting note including explicit empty or whitespace differences: %j', other => {
        expect(() => normaliseCharacterDraft({ character: { name: 'Nova', characterNote: other }, characterNote: note })).toThrow('Conflicting values for characterNote');
    });

    test.each(locations)('rejects conflicting %s greetings including order and explicit emptiness', (_label, target, key) => {
        for (const other of [[], [...greetings].reverse(), [greetings[0].trim(), ...greetings.slice(1)], [...greetings, 'Extra.']]) {
            const input = { ...draft(), alternateGreetings: [...greetings] };
            if (key === 'alternateGreetings' && target(input) === input) {
                input.character.alternateGreetings = other;
            } else target(input)[key] = other;
            expect(() => normaliseCharacterDraft(input)).toThrow('Conflicting values for alternateGreetings');
        }
    });

    test.each([null, undefined])('treats %s as absent while retaining explicit empty values', absent => {
        const input = { character: { name: 'Nova', characterNote: note, alternateGreetings: greetings, alternate_greetings: absent },
            characterNote: absent, alternateGreetings: absent, alternate_greetings: absent, avatarPrompt: absent };
        expect(normaliseCharacterDraft(input)).toMatchObject({ characterNote: note, alternateGreetings: greetings, avatarPrompt: '' });
        input.character.characterNote = '';
        input.character.alternateGreetings = [];
        expect(normaliseCharacterDraft(input)).toMatchObject({ characterNote: '', alternateGreetings: [] });
        input.character.characterNote = absent;
        input.character.alternateGreetings = absent;
        expect(normaliseCharacterDraft(input)).toMatchObject({ characterNote: '', alternateGreetings: [] });
    });

    test.each([7, false, [], {}, 'N'.repeat(100001)].map((value, index) => ({ value, index })))('does not hide invalid nested note $index behind a valid canonical one', ({ value }) => {
        expect(() => normaliseCharacterDraft({ character: { name: 'Nova', characterNote: value }, characterNote: note }))
            .toThrow('The character note must be text');
    });

    test.each(locations)('validates every %s greeting candidate before resolving duplicates', (_label, target, key) => {
        for (const invalid of ['Hello.', {}, false, [7], [null], Array(21).fill('Hello.'), ['G'.repeat(100001)]]) {
            const input = { character: { name: 'Nova', alternateGreetings: ['Conflicting but valid.'] }, alternateGreetings: greetings };
            target(input)[key] = invalid;
            expect(() => normaliseCharacterDraft(input)).toThrow('alternateGreetings must be a list');
        }
    });

    test('retains inclusive text and greeting limits', () => {
        const input = { character: { name: 'N'.repeat(200), description: 'D'.repeat(100000), characterNote: 'N'.repeat(100000),
            alternate_greetings: Array(20).fill('G'.repeat(100000)) }, avatarPrompt: 'A'.repeat(10000) };
        expect(normaliseCharacterDraft(input).alternateGreetings).toHaveLength(20);
        expect(() => normaliseCharacterDraft({ character: { name: 'N'.repeat(201) } })).toThrow('character name');
        expect(() => normaliseCharacterDraft({ character: { name: '../Nova' } })).toThrow('path separators');
        expect(() => normaliseCharacterDraft({ character: { name: 'Nova', description: 'D'.repeat(100001) } })).toThrow('Invalid character field');
        expect(() => normaliseCharacterDraft({ ...draft(), avatarPrompt: 'A'.repeat(10001) })).toThrow('avatar prompt');
    });

    test.each(['avatarPrompt', 'extensions', 'depth_prompt', 'character_note', 'firstMessage', '__proto__', 'constructor', 'prototype'])(
        'still rejects unsupported nested field %s', key => {
            const input = JSON.parse(`{"character":{"name":"Nova","${key}":"Unapproved."}}`);
            expect(() => normaliseCharacterDraft(input)).toThrow(`Invalid character field: ${key}`);
        });

    test('ignores inherited compatibility fields', () => {
        const inherited = { characterNote: note, alternateGreetings: greetings, alternate_greetings: greetings };
        const input = Object.assign(Object.create(inherited), {
            character: Object.assign(Object.create(inherited), { name: 'Nova' }),
        });
        expect(normaliseCharacterDraft(input)).toEqual({ character: { name: 'Nova' }, characterNote: '', alternateGreetings: [], avatarPrompt: '' });
    });
});

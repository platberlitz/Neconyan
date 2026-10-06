import { describe, expect, test } from '@jest/globals';
import { blankPropertyRow, createPropertyDraft, propertyChanges } from '../public/scripts/notebooks/property-fields.js';

describe('Notebook property rows', () => {
    test('unchanged values, types and nested fields are not rewritten', () => {
        const base = { title: 'Place', tags: ['harbour'], count: 3, active: true, names: ['one', 'two'], nested: { untouched: true } };
        const draft = createPropertyDraft(base, ['nested']);
        expect(propertyChanges(draft)).toEqual({});
        expect(draft.rows.map(row => row.key)).toEqual(['count', 'active', 'names']);
        expect(base.nested).toEqual({ untouched: true });
    });

    test('several rows can be prepared without saving or changing existing fields', () => {
        const draft = createPropertyDraft({ existing: 'kept', tags: ['first'] });
        draft.rows.push({ ...blankPropertyRow(), key: 'place', value: 'Harbour' }, { ...blankPropertyRow(), key: 'season', value: 'Winter' }, blankPropertyRow());
        expect(propertyChanges(draft)).toEqual({ place: 'Harbour', season: 'Winter' });
        expect(draft.base).toEqual({ existing: 'kept', tags: ['first'] });
    });

    test('number, boolean and list edits retain their original types', () => {
        const draft = createPropertyDraft({ count: 3, active: true, names: ['one'] });
        for (const row of draft.rows) row.value = { count: '4.5', active: 'false', names: '["two", "three"]' }[row.key];
        expect(propertyChanges(draft)).toEqual({ count: 4.5, active: false, names: ['two', 'three'] });
    });

    test('renaming or removing a row explicitly removes its original key', () => {
        const draft = createPropertyDraft({ old: 'value', remove: 'unneeded', keep: 'same' });
        draft.rows[0].key = 'new';
        draft.rows[1].removed = true;
        expect(propertyChanges(draft)).toEqual({ new: 'value', old: null, remove: null });
    });

    test.each(['title', 'Tags', '__proto__', 'constructor', 'prototype', 'bad:key', '#heading', 'line\nbreak'])('refuses reserved or invalid field %s', key => {
        const draft = createPropertyDraft({});
        draft.rows.push({ ...blankPropertyRow(), key, value: 'bad' });
        expect(() => propertyChanges(draft)).toThrow();
    });

    test('refuses duplicate names, unnamed values and overwriting nested properties', () => {
        const draft = createPropertyDraft({ keep: 'value', nested: { secret: true } }, ['nested']);
        draft.rows.push({ ...blankPropertyRow(), key: 'keep', value: 'second' });
        expect(() => propertyChanges(draft)).toThrow(/twice/);
        draft.rows.at(-1).key = '';
        expect(() => propertyChanges(draft)).toThrow(/field name/);
        draft.rows.at(-1).key = 'nested';
        expect(() => propertyChanges(draft)).toThrow(/nested/);
    });

    test('rechecks only the edited fields, preserving unrelated newer changes', () => {
        const draft = createPropertyDraft({ edit: 'before', unrelated: 'before' });
        draft.rows[0].value = 'after';
        expect(propertyChanges(draft, { edit: 'before', unrelated: 'newer' })).toEqual({ edit: 'after' });
        expect(() => propertyChanges(draft, { edit: 'changed elsewhere', unrelated: 'newer' })).toThrow(/changed in the note/);
        expect(propertyChanges(draft, { edit: 'after', unrelated: 'newer' })).toEqual({});
    });

    test('does not erase an unchanged long field or rewrite legacy tag aliases', () => {
        const draft = createPropertyDraft({ tag: ['kept'], alias: ['Name'], long: 'x'.repeat(10_000) });
        expect(propertyChanges(draft)).toEqual({});
        draft.fields.tags = 'kept, another';
        expect(propertyChanges(draft)).toEqual({ tags: ['kept', 'another'] });
    });

    test('untouched imported field names are never normalised or made to block other edits', () => {
        const base = { 'legacy:key': 'kept', ' spaced ': 'kept', ['x'.repeat(80)]: 'kept' };
        const draft = createPropertyDraft(base);
        expect(propertyChanges(draft)).toEqual({});
        draft.rows.push({ ...blankPropertyRow(), key: 'season', value: 'Winter' });
        expect(propertyChanges(draft)).toEqual({ season: 'Winter' });
        expect(draft.rows.slice(0, 3).map(row => row.key)).toEqual(Object.keys(base));
    });
});

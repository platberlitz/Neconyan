import { describe, expect, test } from '@jest/globals';
import { CHARACTER_FIELDS, characterFieldPatch, readCharacterField } from '../public/scripts/scratchpad/character-fields.js';
import { normaliseChange, parseField, formatField } from '../public/scripts/scratchpad/proposals.js';

describe('Scratchpad character field contract', () => {
    test.each(Object.entries(CHARACTER_FIELDS))('round-trips %s through a proposal and a nested card patch', (field, definition) => {
        const value = definition.type === 'number' ? definition.max : definition.type === 'boolean' ? true
            : definition.type === 'role' ? 'assistant' : ['greetings', 'tags'].includes(definition.type) ? ['One', 'Two'] : 'New {{char}}';
        const proposal = normaliseChange({ type: 'character', character: 'Nova', field, value });
        expect(parseField(field, formatField(field, proposal.value))).toEqual(value);
        const patch = characterFieldPatch(field, proposal.value);
        expect(readCharacterField(patch, field)).toEqual(value);
        expect(patch).toMatchObject(definition.top ? { [definition.top]: value } : {});
    });
    test.each([
        ['extensions.depth_prompt.depth', -1], ['extensions.depth_prompt.depth', 1.5], ['extensions.depth_prompt.depth', 10000],
        ['extensions.talkativeness', 1.1], ['extensions.talkativeness', '0.5'], ['extensions.talkativeness', null],
        ['extensions.fav', 'false'], ['extensions.depth_prompt.role', 'tool'], ['name', '   '],
        ['extensions.__proto__.polluted', 'yes'], ['constructor', 'yes'], ['avatar', 'other.png'],
    ])('rejects invalid %s value %j', (field, value) => {
        expect(() => normaliseChange({ type: 'character', character: 'Nova', field, value })).toThrow();
    });
    test('validates edited settings and keeps false and zero', () => {
        expect(parseField('fav', 'false')).toBe(false);
        expect(parseField('talkativeness', '0')).toBe(0);
        expect(() => parseField('talkativeness', '')).toThrow();
        expect(() => parseField('depth_prompt_depth', '4.5')).toThrow();
        expect(() => parseField('fav', 'maybe')).toThrow();
        expect(readCharacterField({ data: { extensions: { fav: false, talkativeness: 0 } } }, 'fav')).toBe(false);
        expect(readCharacterField({ data: { extensions: { talkativeness: 0 } } }, 'talkativeness')).toBe(0);
    });
    test('a note text patch does not replace its depth, role or other extensions', () => {
        expect(characterFieldPatch('depth_prompt_prompt', 'Keep {{user}} literal')).toEqual({ data: { extensions: { depth_prompt: { prompt: 'Keep {{user}} literal' } } } });
        expect(() => characterFieldPatch('__proto__.polluted', true)).toThrow();
    });
});

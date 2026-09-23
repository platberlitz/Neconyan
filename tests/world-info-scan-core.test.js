import { describe, expect, jest, test } from '@jest/globals';
import { getStringHash } from '../public/scripts/macro-primitives.js';

import {
    applyWorldInfoTimedEffects,
    getTimedEffectWindow,
    filterWorldInfoInclusionGroups,
    getWorldInfoGroupNames,
    matchesWorldInfoEntry,
    normalizeWorldInfoKey,
    normalizeWorldInfoProbability,
    parseWorldInfoKeyRegex,
    passesWorldInfoProbability,
    prepareWorldInfoEntries,
    resolveWorldInfoTimedEffects,
} from '../public/scripts/world-info-scan-core.js';

describe('World Info scan probability', () => {
    test('normalizes CharacterBook extension fields', () => {
        expect(normalizeWorldInfoProbability({ extensions: { probability: 25, useProbability: false } })).toMatchObject({
            probability: 25,
            useProbability: false,
        });
    });

    test('preserves explicit top-level zero and false values', () => {
        expect(normalizeWorldInfoProbability({
            probability: 0,
            useProbability: false,
            extensions: { probability: 75, useProbability: true },
        })).toMatchObject({
            probability: 0,
            useProbability: false,
        });
    });

    test('never activates zero percent, including a zero roll', () => {
        expect(passesWorldInfoProbability({ probability: 0, useProbability: true }, () => 0)).toBe(false);
    });

    test('uses a strict percentage boundary', () => {
        expect(passesWorldInfoProbability({ probability: 50, useProbability: true }, () => 0.499)).toBe(true);
        expect(passesWorldInfoProbability({ probability: 50, useProbability: true }, () => 0.5)).toBe(false);
    });

    test('always activates disabled, sticky, and 100 percent checks without rolling', () => {
        const random = jest.fn(() => 0.99);
        expect(passesWorldInfoProbability({ probability: 1, useProbability: false }, random)).toBe(true);
        expect(passesWorldInfoProbability({ probability: 1, useProbability: true }, random, true)).toBe(true);
        expect(passesWorldInfoProbability({ probability: 100, useProbability: true }, random)).toBe(true);
        expect(random).not.toHaveBeenCalled();
    });
});

describe('World Info inclusion groups shared with the server', () => {
    const select = (entries, options = {}) => filterWorldInfoInclusionGroups(entries, new Set(options.activated || []), {
        score: entry => entry.score || 0,
        isEffectActive: (type, entry) => entry.effect === type,
        scanState: 1, random: () => options.roll ?? 0.5,
        groupScoring: options.scoring || false,
    });

    test('weights and overrides choose the same candidate the browser will use', () => {
        const first = { uid: 1, group: 'a', groupWeight: 1 };
        const second = { uid: 2, group: 'a', groupWeight: 3 };
        expect(select([first, second])).toEqual([second]);
        expect(select([first, { ...second, groupOverride: true }], { roll: 0 })).toEqual([{ ...second, groupOverride: true }]);
    });

    test('a sticky group keeps every sticky winner and removes cooldown losers', () => {
        const sticky = { uid: 1, group: 'a', effect: 'sticky' };
        const otherSticky = { uid: 2, group: 'a', effect: 'sticky' };
        expect(select([sticky, { uid: 3, group: 'a' }, otherSticky])).toEqual([sticky, otherSticky]);
        expect(select([{ uid: 3, group: 'a', effect: 'cooldown' }, { uid: 4, group: 'a' }])).toEqual([{ uid: 4, group: 'a' }]);
    });

    test('scoring and previously activated overlapping groups remove all losers', () => {
        const low = { uid: 1, group: 'a, b', score: 1 };
        const high = { uid: 2, group: 'a', score: 2 };
        const elsewhere = { uid: 3, group: 'b', score: 3 };
        expect(select([low, high, elsewhere], { scoring: true })).toEqual([high, elsewhere]);
        expect(select([low, high], { activated: [{ group: 'a' }] })).toEqual([]);
    });

    test('reserved group names remain selectable without inherited object keys', () => {
        const first = { uid: 1, group: 'constructor', groupWeight: 1 };
        const second = { uid: 2, group: 'constructor', groupWeight: 3 };
        expect(select([first, second])).toEqual([second]);
        expect(select([{ uid: 3, group: '__proto__' }])).toEqual([{ uid: 3, group: '__proto__' }]);
    });
});

describe('World Info scan normalization', () => {
    test('orders chat and persona books before character/global entries and retains pre-normalised hash', () => {
        const lore = { globalLore: [{ uid: 1, world: 'Global', order: 2, content: 'Global', position: 0 }],
            characterLore: [{ uid: 2, world: 'Character', order: 1, content: '@@activate\nCharacter', position: 'before_char' }],
            chatLore: [{ uid: 3, world: 'Chat', order: 0, content: 'Chat' }],
            personaLore: [{ uid: 4, world: 'Persona', order: 0, content: 'Persona' }] };
        const first = prepareWorldInfoEntries(lore, 1);
        expect(first.map(entry => entry.world)).toEqual(['Chat', 'Persona', 'Character', 'Global']);
        expect(first[2]).toMatchObject({ content: 'Character', decorators: ['@@activate'], position: 0 });
        expect(first[2].hash).toBe(getStringHash(JSON.stringify({ ...lore.characterLore[0], decorators: ['@@activate'], content: 'Character' })));
        expect(prepareWorldInfoEntries(lore, 2).map(entry => entry.world)).toEqual(['Chat', 'Persona', 'Global', 'Character']);
        expect(first[2].hash).toBe(prepareWorldInfoEntries(lore, 1)[2].hash);
    });

    test('rejects keys that are empty after substitution and trimming', () => {
        expect(normalizeWorldInfoKey('   ', value => value)).toBeNull();
        expect(normalizeWorldInfoKey('{{empty}}', () => '')).toBeNull();
        expect(normalizeWorldInfoKey('  {{user}}  ', () => ' Alice ')).toBe('Alice');
    });

    test('parses unique nonempty inclusion-group names', () => {
        expect(getWorldInfoGroupNames(' alpha, beta, alpha, , gamma ')).toEqual(['alpha', 'beta', 'gamma']);
        expect(getWorldInfoGroupNames(null)).toEqual([]);
    });

    test('matches primary and selective keys with the browser logic', () => {
        const entry = { key: ['{{character}}'], keysecondary: ['sea', 'moon'], selective: true, selectiveLogic: 3 };
        const options = { substitute: key => key === '{{character}}' ? 'Alice' : key };
        expect(matchesWorldInfoEntry(entry, 'Alice at sea beneath the moon', options)).toBe(true);
        expect(matchesWorldInfoEntry(entry, 'Alice at sea', options)).toBe(false);
        expect(matchesWorldInfoEntry({ ...entry, selectiveLogic: 1 }, 'Alice at sea', options)).toBe(true);
        expect(matchesWorldInfoEntry({ ...entry, selectiveLogic: 2 }, 'Alice at home', options)).toBe(true);
        expect(matchesWorldInfoEntry({ ...entry, selectiveLogic: 0 }, 'Alice at sea', options)).toBe(true);
        const once = { substitute: key => key === '{{sea}}' ? 'sea' : key === 'sea' ? 'land' : key };
        expect(matchesWorldInfoEntry({ key: ['Alice'], keysecondary: ['{{sea}}'], selective: true }, 'Alice at sea', once)).toBe(true);
    });

    test('respects case, punctuation boundaries and regex keys', () => {
        expect(matchesWorldInfoEntry({ key: ['cat'] }, 'concatenate', { wholeWords: true })).toBe(false);
        expect(matchesWorldInfoEntry({ key: ['cat'] }, 'A cat!', { wholeWords: true })).toBe(true);
        expect(matchesWorldInfoEntry({ key: ['CAT'], caseSensitive: true }, 'cat')).toBe(false);
        expect(matchesWorldInfoEntry({ key: ['/ca.t/i'] }, 'The caat')).toBe(true);
        expect(parseWorldInfoKeyRegex('/a\\/b/i')?.test('A/b')).toBe(true);
        expect(parseWorldInfoKeyRegex('/a/b/')).toBeNull();
    });
});

describe('World Info timed effect windows', () => {
    test('uses the upstream duration boundary', () => {
        const { start, end } = getTimedEffectWindow(10, 1);
        expect(start).toBe(10);
        expect(end).toBe(11);
    });

    test('does not extend the duration window', () => {
        expect(getTimedEffectWindow(10, 3)).toEqual({ start: 10, end: 13 });
    });

    test('coerces string durations from legacy metadata', () => {
        expect(getTimedEffectWindow(5, '2')).toEqual({ start: 5, end: 7 });
    });

    test('expires sticky into protected cooldown without extending it on replay', () => {
        const entry = { world: 'Town', uid: 3, hash: 19, sticky: 2, cooldown: 3, delay: 4 };
        const saved = { sticky: { 'Town.3': { hash: 19, start: 4, end: 6, protected: false } }, cooldown: {} };
        const result = resolveWorldInfoTimedEffects([entry], 6, saved);
        expect(result.active.sticky.has(19)).toBe(false);
        expect(result.active.cooldown.has(19)).toBe(true);
        expect(result.metadata.cooldown['Town.3']).toEqual({ hash: 19, start: 6, end: 9, protected: true });
        expect(saved.cooldown).toEqual({});
        expect(resolveWorldInfoTimedEffects([entry], 6, saved)).toEqual(result);
        expect(resolveWorldInfoTimedEffects([entry], 9, result.metadata).active.cooldown.has(19)).toBe(false);
    });

    test('expires a sticky window when legacy metadata has no cooldown map', () => {
        const entry = { world: 'Town', uid: 3, hash: 19, sticky: 2, cooldown: 3 };
        const saved = { sticky: { 'Town.3': { hash: 19, start: 4, end: 6, protected: false } } };
        const result = resolveWorldInfoTimedEffects([entry], 6, saved);
        expect(result.metadata.cooldown['Town.3']).toEqual({ hash: 19, start: 6, end: 9, protected: true });
        expect(result.active.cooldown.has(19)).toBe(true);
    });

    test('does not mutate timed metadata on a dry scan and preserves existing windows', () => {
        const entry = { world: 'Town', uid: 3, hash: 19, sticky: 2, cooldown: 3, delay: 4 };
        const saved = { sticky: { 'Town.3': { hash: 19, start: 1, end: 2, protected: false } } };
        const dry = resolveWorldInfoTimedEffects([entry], 3, saved, true);
        expect(dry.active.sticky.size).toBe(0);
        expect(saved.cooldown).toBeUndefined();
        const applied = applyWorldInfoTimedEffects(dry.metadata, [entry], 3);
        expect(applied.sticky['Town.3']).toEqual(saved.sticky['Town.3']);
        expect(applied.cooldown['Town.3']).toEqual({ hash: 19, start: 3, end: 6, protected: false });
    });
});

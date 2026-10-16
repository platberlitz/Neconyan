import { describe, expect, test } from '@jest/globals';
import {
    MODE_FILTERS,
    familyCounts,
    filterEntries,
    groupEntries,
    hasActiveFilters,
    isAnimatedEntry,
    matchesQuery,
    modeCounts,
    randomSlug,
    stepSlug,
} from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/browse.js';
import { FAMILIES, THEMES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/themes/index.js';

const families = [{ id: 'original', label: 'Original' }, ...FAMILIES];
const entries = [
    { slug: 'stock', name: 'Original tracker style', family: 'original', familyLabel: 'Original', mode: 'host' },
    ...THEMES.map(theme => ({ ...theme, familyLabel: FAMILIES.find(family => family.id === theme.family).label })),
];

describe('Regex Agent Themes catalogue', () => {
    test('ships 118 themes with unique slugs and a known family each', () => {
        expect(THEMES).toHaveLength(118);
        expect(new Set(THEMES.map(theme => theme.slug)).size).toBe(THEMES.length);
        const familyIds = new Set(FAMILIES.map(family => family.id));
        expect(THEMES.filter(theme => !familyIds.has(theme.family))).toEqual([]);
    });

    test('every animated theme has a matching keyframe in the stylesheet', async () => {
        const { readFileSync } = await import('node:fs');
        const css = readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/style.css', import.meta.url), 'utf8');
        const animated = THEMES.filter(isAnimatedEntry);
        expect(animated.length).toBeGreaterThanOrEqual(26);
        for (const theme of animated) {
            expect(css).toContain(`[data-rat-motion='${theme.motion}'][data-rat-part='root']`);
            expect(css).toContain(`@keyframes rat-${theme.motion} {`);
        }
    });
});

describe('Regex Agent Themes browse helpers', () => {
    test('the animated filter crosses families and only keeps themes with motion', () => {
        const animated = filterEntries(entries, { mode: 'animated' });
        expect(animated.length).toBe(THEMES.filter(theme => theme.motion).length);
        expect(animated.every(isAnimatedEntry)).toBe(true);
        expect(animated.some(entry => entry.mode === 'light')).toBe(true);
        expect(animated.some(entry => entry.mode === 'dark')).toBe(true);
    });

    test('search matches name, slug, family, colour and motion words, all terms required', () => {
        const rain = entries.find(entry => entry.slug === 'rain-on-glass');
        expect(matchesQuery(rain, 'RAIN')).toBe(true);
        expect(matchesQuery(rain, 'rain-on')).toBe(true);
        expect(matchesQuery(rain, 'animated dark')).toBe(true);
        expect(matchesQuery(rain, 'animated light')).toBe(false);
        expect(matchesQuery(entries.find(entry => entry.slug === 'herbarium'), 'botanical')).toBe(true);
        expect(matchesQuery(rain, '   ')).toBe(true);
    });

    test('counts ignore their own filter so every chip and family shows what it would reveal', () => {
        const modes = modeCounts(entries, { family: 'all', query: '' });
        expect(modes.get('all')).toBe(entries.length);
        expect(modes.get('dark') + modes.get('light') + modes.get('adaptive')).toBe(entries.length - 1);
        expect(MODE_FILTERS.map(filter => filter.id)).toEqual(['all', 'dark', 'light', 'animated', 'adaptive', 'custom']);

        const darkFamilies = familyCounts(entries, { mode: 'dark', query: '' });
        const darkTotal = [...darkFamilies.values()].reduce((sum, count) => sum + count, 0);
        expect(darkTotal).toBe(modes.get('dark'));
        expect(darkFamilies.has('original')).toBe(false);
    });

    test('groups follow family order and keep each family in catalogue order', () => {
        const groups = groupEntries(filterEntries(entries, { mode: 'light' }), families);
        const order = families.map(family => family.id);
        const ids = groups.map(group => group.id);
        expect(ids).toEqual([...ids].sort((left, right) => order.indexOf(left) - order.indexOf(right)));
        const cute = groups.find(group => group.id === 'cute');
        const catalogueOrder = THEMES.filter(theme => theme.family === 'cute' && theme.mode === 'light').map(theme => theme.slug);
        expect(cute.entries.map(entry => entry.slug)).toEqual(catalogueOrder);
        expect(cute.label).toBe('Cute & Soft');
    });

    test('stepping wraps at both ends and enters a filter from outside it', () => {
        const ordered = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
        expect(stepSlug(ordered, 'a', 1)).toBe('b');
        expect(stepSlug(ordered, 'c', 1)).toBe('a');
        expect(stepSlug(ordered, 'a', -1)).toBe('c');
        expect(stepSlug(ordered, 'zzz', 1)).toBe('a');
        expect(stepSlug(ordered, 'zzz', -1)).toBe('c');
        expect(stepSlug([], 'a', 1)).toBe('a');
    });

    test('surprise never returns the theme already on screen when another exists', () => {
        const ordered = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
        expect(randomSlug(ordered, 'a', () => 0)).toBe('b');
        expect(randomSlug(ordered, 'a', () => 0.999)).toBe('c');
        expect(randomSlug([{ slug: 'a' }], 'a', () => 0.5)).toBe('a');
    });

    test('clear filters only appears when something is filtered', () => {
        expect(hasActiveFilters({ family: 'all', mode: 'all', query: '' })).toBe(false);
        expect(hasActiveFilters({ family: 'all', mode: 'all', query: '  ' })).toBe(false);
        expect(hasActiveFilters({ family: 'cute', mode: 'all', query: '' })).toBe(true);
        expect(hasActiveFilters({ family: 'all', mode: 'animated', query: '' })).toBe(true);
        expect(hasActiveFilters({ family: 'all', mode: 'all', query: 'moss' })).toBe(true);
    });
});

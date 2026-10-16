/**
 * DOM-free helpers for the Browse section: filtering, family grouping, and
 * stepping through the visible themes in the same order the gallery shows them.
 */

export const MODE_FILTERS = Object.freeze([
    Object.freeze({ id: 'all', label: 'All' }),
    Object.freeze({ id: 'dark', label: 'Dark' }),
    Object.freeze({ id: 'light', label: 'Light' }),
    Object.freeze({ id: 'animated', label: 'Animated' }),
    Object.freeze({ id: 'adaptive', label: 'Adaptive' }),
    Object.freeze({ id: 'custom', label: 'Custom' }),
]);

const MODE_LABELS = Object.freeze({
    dark: 'Dark',
    light: 'Light',
    adaptive: 'Adaptive',
    host: 'Original',
    custom: 'Custom',
});

export function modeLabel(mode) {
    return MODE_LABELS[mode] ?? String(mode ?? '');
}

export function isAnimatedEntry(entry) {
    return typeof entry?.motion === 'string' && entry.motion.length > 0;
}

export function matchesMode(entry, mode) {
    if (!mode || mode === 'all') {
        return true;
    }
    if (mode === 'animated') {
        return isAnimatedEntry(entry);
    }
    return entry.mode === mode;
}

export function matchesQuery(entry, query) {
    const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
        return true;
    }
    const haystack = [
        entry.name,
        entry.slug,
        entry.familyLabel,
        entry.mode,
        modeLabel(entry.mode),
        entry.motion,
        isAnimatedEntry(entry) ? 'animated motion' : '',
    ].filter(Boolean).join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
}

/**
 * Orders entries by family (in the given family order) while keeping each
 * family's own order, so stepping matches the grouped gallery.
 */
export function groupEntries(entries, familyOrder) {
    const order = new Map(familyOrder.map((family, index) => [family.id, index]));
    const groups = new Map();
    for (const entry of entries) {
        if (!groups.has(entry.family)) {
            groups.set(entry.family, []);
        }
        groups.get(entry.family).push(entry);
    }
    return [...groups.entries()]
        .sort(([left], [right]) => (order.get(left) ?? order.size) - (order.get(right) ?? order.size))
        .map(([id, items]) => ({
            id,
            label: familyOrder.find(family => family.id === id)?.label ?? items[0]?.familyLabel ?? id,
            entries: items,
        }));
}

export function filterEntries(entries, { family = 'all', mode = 'all', query = '' } = {}) {
    return entries.filter(entry => (family === 'all' || entry.family === family)
        && matchesMode(entry, mode)
        && matchesQuery(entry, query));
}

/** Counts per family for the current mode and search, ignoring the family filter itself. */
export function familyCounts(entries, { mode = 'all', query = '' } = {}) {
    const counts = new Map();
    for (const entry of entries) {
        if (!matchesMode(entry, mode) || !matchesQuery(entry, query)) {
            continue;
        }
        counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
    }
    return counts;
}

/** Counts per mode filter for the current family and search, ignoring the mode filter itself. */
export function modeCounts(entries, { family = 'all', query = '' } = {}) {
    const scoped = entries.filter(entry => (family === 'all' || entry.family === family)
        && matchesQuery(entry, query));
    const counts = new Map();
    for (const filter of MODE_FILTERS) {
        counts.set(filter.id, scoped.filter(entry => matchesMode(entry, filter.id)).length);
    }
    return counts;
}

export function hasActiveFilters({ family = 'all', mode = 'all', query = '' } = {}) {
    return family !== 'all' || mode !== 'all' || String(query ?? '').trim() !== '';
}

/**
 * Returns the slug `delta` steps away from `slug` in `ordered`, wrapping at both
 * ends. A slug outside the list steps to the first (forward) or last (back) entry.
 */
export function stepSlug(ordered, slug, delta) {
    if (!ordered.length) {
        return slug;
    }
    const index = ordered.findIndex(entry => entry.slug === slug);
    if (index === -1) {
        return (delta < 0 ? ordered[ordered.length - 1] : ordered[0]).slug;
    }
    const next = ((index + delta) % ordered.length + ordered.length) % ordered.length;
    return ordered[next].slug;
}

export function randomSlug(ordered, slug, random = Math.random) {
    const pool = ordered.filter(entry => entry.slug !== slug);
    if (!pool.length) {
        return slug;
    }
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    return pool[index].slug;
}

/**
 * A small in-memory cache for search responses.
 *
 * Every control in the browse dialog re-runs the search, so toggling SFW off and
 * back on, clearing a filter, or returning to a source you were just looking at
 * each cost a full round trip to a card site. None of those are new questions —
 * they are questions already answered a moment ago.
 *
 * Deliberately per-dialog and in-memory. Nothing is written to disk: a cached
 * page holds card names, taglines and tags from adult catalogues, and that
 * belongs in a tab the user can close, not in their settings file.
 */

/** Long enough to cover fiddling with the controls, short enough to stay current. */
const TTL_MS = 5 * 60_000;

/** Pages, not bytes. Twenty pages of 48 is a few hundred KB at most. */
const MAX_ENTRIES = 20;

export function createResultCache({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES, now = () => Date.now() } = {}) {
    /** @type {Map<string, { at: number, value: any }>} Insertion order is the LRU order. */
    const entries = new Map();

    return {
        /**
         * @param {unknown} key
         * @returns {any | null} the cached response, or null
         */
        get(key) {
            const id = keyOf(key);
            const hit = entries.get(id);
            if (!hit) {
                return null;
            }
            if (now() - hit.at > ttlMs) {
                entries.delete(id);
                return null;
            }
            // Re-inserting moves it to the end, which is what makes this an LRU
            // rather than a first-in-first-out queue.
            entries.delete(id);
            entries.set(id, hit);
            return hit.value;
        },

        set(key, value) {
            const id = keyOf(key);
            entries.delete(id);
            entries.set(id, { at: now(), value });

            while (entries.size > maxEntries) {
                entries.delete(entries.keys().next().value);
            }
        },

        clear() {
            entries.clear();
        },

        get size() {
            return entries.size;
        },
    };
}

/**
 * A stable string for a request body.
 *
 * JSON.stringify alone would not do: key order follows insertion, so the same
 * search built through two different code paths would miss its own entry.
 */
export function keyOf(value) {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) {
            out[key] = sortKeys(value[key]);
        }
    }
    return out;
}

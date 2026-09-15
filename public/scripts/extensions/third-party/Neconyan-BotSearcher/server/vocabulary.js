/**
 * In-memory tag-vocabulary cache.
 *
 * Vocabularies are catalogue data rather than user data, so one copy is shared
 * by all callers. A pending load is cached too: concurrent dialog opens should
 * produce one upstream request, not one request per user.
 */

export const VOCABULARY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createVocabularyCache({ ttlMs = VOCABULARY_TTL_MS, now = () => Date.now() } = {}) {
    const entries = new Map();

    return {
        /**
         * @param {any} adapter
         * @param {() => Promise<unknown>} [load]
         * @returns {Promise<any[]>}
         */
        get(adapter, load) {
            if (adapter?.capabilities?.tagVocabulary !== true
                || typeof adapter.fetchVocabulary !== 'function'
                || typeof adapter.id !== 'string' || adapter.id === '') {
                return Promise.resolve([]);
            }

            const cached = entries.get(adapter.id);
            if (Array.isArray(cached?.tags) && now() < cached.expiresAt) {
                return Promise.resolve(cached.tags);
            }
            if (cached?.pending) {
                return cached.pending;
            }

            const fetcher = typeof load === 'function' ? load : () => adapter.fetchVocabulary();
            const pending = Promise.resolve()
                .then(fetcher)
                .then((value) => {
                    const tags = Array.isArray(value) ? value : [];
                    if (entries.get(adapter.id)?.pending === pending) {
                        entries.set(adapter.id, { tags, expiresAt: now() + ttlMs });
                    }
                    return tags;
                }, (error) => {
                    if (entries.get(adapter.id)?.pending === pending) {
                        entries.delete(adapter.id);
                    }
                    throw error;
                });

            entries.set(adapter.id, { pending });
            return pending;
        },

        /** True only for a fresh value that needs no outbound work. */
        has(adapter) {
            const cached = entries.get(adapter?.id);
            return Array.isArray(cached?.tags) && now() < cached.expiresAt;
        },

        clear() {
            entries.clear();
        },
    };
}

const sharedCache = createVocabularyCache();

export function getVocabulary(adapter, load) {
    return sharedCache.get(adapter, load);
}

export function hasVocabulary(adapter) {
    return sharedCache.has(adapter);
}

export function clearVocabularyCache() {
    sharedCache.clear();
}

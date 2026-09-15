/** Dialog-scoped loading for source tag vocabularies. */

import { post } from './api.js';

/**
 * Each source is requested at most once while a browser dialog is open. A failed
 * vocabulary is deliberately an empty list: search and manual tag entry remain
 * fully usable when autocomplete is unavailable.
 */
export function createVocabularyLoader() {
    const cached = new Map();

    return {
        load(source) {
            if (source?.capabilities?.tagVocabulary !== true || typeof source.id !== 'string') {
                return Promise.resolve([]);
            }
            if (cached.has(source.id)) {
                return cached.get(source.id);
            }

            const pending = post('/tags', { source: source.id })
                .then((result) => (Array.isArray(result?.tags) ? result.tags : []))
                .catch(() => []);
            cached.set(source.id, pending);
            return pending;
        },

        clear() {
            cached.clear();
        },
    };
}

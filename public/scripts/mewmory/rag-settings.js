/** Shared defaults keep saved settings, retrieval and the settings form in agreement. */
export const RAG_DEFAULTS = Object.freeze({
    mode: 'hybrid', chunkSize: 1800, chunkOverlap: 200, queryMessages: 8,
    semanticWeight: 0.5, minSimilarity: 0, resultLimit: 12,
    maxPerSource: 3, neighbourChunks: 0, includeFiles: true, batchSize: 10,
});

export const PREFIX_PRESETS = Object.freeze([
    { label: 'No prefix', query: '', document: '' },
    { label: 'E5', query: 'query: ', document: 'passage: ' },
    { label: 'Nomic', query: 'search_query: ', document: 'search_document: ' },
    { label: 'BGE English', query: 'Represent this sentence for searching relevant passages: ', document: '' },
]);

import { currentRecords, eligibleRecords, fail, hash, refKey, sourceAt, sourceEligible } from './core.js';
import { embed, roleVersion } from './models.js';
import { lexicalSearch } from '../../public/scripts/util/lexical-search.js';
import { RAG_DEFAULTS } from '../../public/scripts/mewmory/rag-settings.js';
export { terms, lexicalSearch } from '../../public/scripts/util/lexical-search.js';

export function interviewText(record) {
    return record.interview.map(turn => 'Interviewer: ' + turn.question + '\n' + turn.answer).join('\n\n');
}

export function recordBody(record) {
    if (record.kind === 'interview') return interviewText(record);
    return [record.text, record.appearance ? 'Appearance: ' + record.appearance : '',
        record.speech ? 'Speech: ' + record.speech : ''].filter(Boolean).join('\n');
}

/** Exact source offsets preserve citations, including overlapping paragraphs and long unbroken words. */
export function splitPassages(text, { chunkSize = 1800, chunkOverlap = 200 } = {}) {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || !Number.isSafeInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) fail('Invalid passage size or overlap.');
    const result = [];
    for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + chunkSize);
        if (end < text.length) {
            const minimum = start + Math.max(chunkOverlap + 1, Math.floor(chunkSize / 2));
            for (const delimiter of ['\n\n', '\n', '. ', ' ']) {
                const boundary = text.lastIndexOf(delimiter, end - delimiter.length);
                if (boundary >= minimum) { end = boundary + delimiter.length; break; }
            }
            // Keep surrogate pairs together when a hard cut is unavoidable.
            if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
        }
        if (end <= start) end = Math.min(text.length, start + chunkSize);
        result.push({ text: text.slice(start, end), start, end });
        if (end === text.length) break;
        start = Math.max(start + 1, end - chunkOverlap);
        if (/[\uDC00-\uDFFF]/u.test(text[start])) start++;
    }
    return result;
}

export function searchDocuments(state, asOf = Infinity, config = {}) {
    const options = { ...RAG_DEFAULTS, ...config.retrieval };
    const eligible = eligibleRecords(state, { asOf });
    const names = new Map(currentRecords(eligible.filter(record => record.kind === 'entity'), record => record.entityId)
        .map(record => [record.entityId, [record.name, ...record.aliases].join(', ')]));
    const references = currentRecords(eligible.filter(record => ['entity', 'state'].includes(record.kind)), record => record.kind + ':' + record.entityId);
    const records = [...new Map([...eligible.filter(record => !record.historicalOnly && (!['entity', 'state'].includes(record.kind) || record.pinned)),
        ...references].map(record => [record.id, record])).values()];
    const documents = records.map(record => {
        const content = recordBody(record);
        return {
            id: record.id, kind: record.kind, dataType: 'memory', recordId: record.id, version: record.version,
            text: content, searchText: [names.get(record.ownerId || record.entityId), ...record.subjectIds.map(id => record.subjectNames?.[id] || names.get(id) || id),
                record.searchDescription || content].filter(Boolean).join('\n'),
            refs: record.refs, asOf: record.asOf, ownerId: record.ownerId,
            subjectIds: record.subjectIds, status: record.status,
            significance: record.significance, evidenceRefs: record.evidenceRefs, linkedRecordIds: record.dependencies.map(dependency => dependency.id),
        };
    });
    for (const ref of [...state.timeline, ...state.contextSources]) {
        if (!sourceEligible(state, ref, asOf)) continue;
        const source = state.sources[ref.id];
        if (source.type === 'file' && !options.includeFiles) continue;
        const revision = sourceAt(state, ref);
        // Small source passages keep recovery and embeddings bounded; the full revision stays in the archive.
        const passages = splitPassages(revision.text, options);
        passages.forEach((passage, index) => documents.push({
            id: 'source:' + refKey(ref) + ':' + index, kind: 'source', dataType: source.type,
            text: passage.text, searchText: revision.speaker + '\n' + passage.text, refs: [ref],
            sourceName: revision.speaker, chunkIndex: index, start: passage.start, end: passage.end,
            asOf: revision.sequence, ownerId: '', subjectIds: [], status: 'active',
        }));
    }
    return documents;
}

export function cosine(left, right) {
    if (left.length !== right.length) return -1;
    let dot = 0, a = 0, b = 0;
    for (let index = 0; index < left.length; index++) {
        dot += left[index] * right[index];
        a += left[index] ** 2;
        b += right[index] ** 2;
    }
    return a && b ? dot / Math.sqrt(a * b) : -1;
}

export function rankedCandidates(documents, query, vector, index, limit, options = {}) {
    const settings = { ...RAG_DEFAULTS, ...options };
    // An unavailable vector space always leaves keyword recovery available.
    const mode = settings.mode === 'semantic' && !vector ? 'keyword' : settings.mode;
    const lexical = mode !== 'semantic' ? lexicalSearch(documents, query, documents.length) : [];
    // ponytail: linear per-story vector search; use a measured ANN backend when large archives outgrow it.
    const semantic = vector && mode !== 'keyword' ? documents.filter(document => index[document.id]?.textHash === hash(document.searchText))
        .map(document => ({ document, score: cosine(vector, index[document.id].vector) }))
        .filter(item => item.score > settings.minSimilarity).sort((a, b) => b.score - a.score) : [];
    const scores = new Map();
    for (const [kind, ranked] of [['keyword', lexical], ['semantic', semantic]]) ranked.forEach(({ document, score }, rank) => {
        const weight = mode === 'hybrid' && vector ? kind === 'semantic' ? settings.semanticWeight : 1 - settings.semanticWeight : 1;
        if (!weight) return;
        const value = scores.get(document.id) || { document, score: 0, keywordScore: null, similarity: null };
        value.score += weight / (60 + rank + 1);
        value[kind === 'semantic' ? 'similarity' : 'keywordScore'] = score;
        scores.set(document.id, value);
    });
    const sourceCounts = new Map(); const seenText = new Set(); const selected = [];
    for (const item of [...scores.values()].sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))) {
        const key = item.document.kind === 'source' ? item.document.refs.map(refKey).join(',') : item.document.id;
        // Identical wording can belong to different characters' subjective memories.
        const fingerprint = item.document.kind === 'source' ? hash(item.document.text) : item.document.id;
        if (seenText.has(fingerprint) || (sourceCounts.get(key) || 0) >= settings.maxPerSource) continue;
        seenText.add(fingerprint); sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
        selected.push(item);
        if (selected.length >= limit) break;
    }
    return selected;
}

export function hybridCandidates(documents, query, vector, index, limit, options) {
    return rankedCandidates(documents, query, vector, index, limit, options).map(({ document, ...retrieval }) => ({ ...document, retrieval }));
}

export function expandNeighbours(documents, allDocuments, count = 0) {
    const result = new Map(documents.map(document => [document.id, document]));
    if (count) for (const document of documents.filter(item => item.kind === 'source')) {
        for (const neighbour of allDocuments) {
            if (neighbour.kind === 'source' && refKey(neighbour.refs[0]) === refKey(document.refs[0])
                && Math.abs(neighbour.chunkIndex - document.chunkIndex) <= count && !result.has(neighbour.id)) result.set(neighbour.id, neighbour);
        }
    }
    return [...result.values()];
}

/** Build a new vector space separately; queries use lexical recovery until its document side is ready. */
export async function updateIndex(state, directories, config, { signal, limit = 32, embedFn = embed } = {}) {
    if (!config.roles.embedding.enabled) return { usage: [], remaining: 0 };
    const documents = searchDocuments(state, Infinity, config).filter(document => config.roles.embedding.allowedData.includes(document.dataType));
    const version = roleVersion(config, 'embedding');
    const sameVersion = state.index.version === version;
    const existing = sameVersion ? state.index.vectors : state.index.build?.version === version ? state.index.build.vectors : {};
    const next = Object.fromEntries(documents.filter(document => existing[document.id]?.textHash === hash(document.searchText))
        .map(document => [document.id, existing[document.id]]));
    const missing = documents.filter(document => !next[document.id]);
    const usage = [];
    const policy = config.roles.embedding.nativePolicy;
    const batchSize = Math.min(config.retrieval?.batchSize || 10, policy?.source === 'vertexai' ? policy.settings.model.startsWith('gemini-embedding-') ? 1 : 5 : 10);
    let dimension = Object.values(next)[0]?.vector.length;
    for (let start = 0; start < Math.min(limit, missing.length); start += batchSize) {
        const batch = missing.slice(start, Math.min(start + batchSize, limit));
        const result = await embedFn(directories, config, batch.map(document => document.searchText), {
            signal, dataTypes: [...new Set(batch.map(document => document.dataType))],
        });
        usage.push(result.usage);
        dimension ||= result.vectors[0]?.length;
        if (result.vectors.length !== batch.length || !dimension || result.vectors.some(vector => !Array.isArray(vector) || vector.length !== dimension
            || !vector.some(value => value !== 0) || vector.some(value => !Number.isFinite(value)))) fail('Embedding dimensions changed or a vector was invalid. Set a new model revision and rebuild the index.', 502);
        batch.forEach((document, offset) => { next[document.id] = { textHash: hash(document.searchText), vector: result.vectors[offset] }; });
    }
    const remaining = Math.max(0, missing.length - limit);
    if (!remaining || sameVersion) state.index = { version, vectors: next, pending: remaining > 0 };
    else state.index = { ...state.index, pending: true, build: { version, vectors: next } };
    return { usage, remaining };
}

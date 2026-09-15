import { currentRecords, eligibleRecords, hash, refKey, sourceAt, sourceEligible } from './core.js';
import { embed, roleVersion } from './models.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
export function terms(value) {
    return [...segmenter.segment(String(value).normalize('NFKC').toLocaleLowerCase())]
        .filter(part => part.isWordLike).map(part => part.segment);
}

export function interviewText(record) {
    return record.interview.map(turn => 'Interviewer: ' + turn.question + '\n' + turn.answer).join('\n\n');
}

export function recordBody(record) {
    if (record.kind === 'interview') return interviewText(record);
    return [record.text, record.appearance ? 'Appearance: ' + record.appearance : '',
        record.speech ? 'Speech: ' + record.speech : ''].filter(Boolean).join('\n');
}

export function searchDocuments(state, asOf = Infinity) {
    const eligible = eligibleRecords(state, { asOf });
    const names = new Map(currentRecords(eligible.filter(record => record.kind === 'entity'), record => record.entityId)
        .map(record => [record.entityId, [record.name, ...record.aliases].join(', ')]));
    const references = currentRecords(eligible.filter(record => ['entity', 'state'].includes(record.kind)), record => record.kind + ':' + record.entityId);
    const records = [...new Map([...eligible.filter(record => !record.historicalOnly && (!['entity', 'state'].includes(record.kind) || record.pinned)),
        ...references].map(record => [record.id, record])).values()];
    const documents = records.map(record => {
        const content = recordBody(record);
        return {
            id: record.id, kind: record.kind, dataType: 'memory', recordId: record.id,
            text: content, searchText: [names.get(record.ownerId || record.entityId), ...record.subjectIds.map(id => record.subjectNames?.[id] || names.get(id) || id),
                record.searchDescription || content].filter(Boolean).join('\n'),
            refs: record.refs, asOf: record.asOf, ownerId: record.ownerId,
            subjectIds: record.subjectIds, status: record.status,
            significance: record.significance, evidenceRefs: record.evidenceRefs,
        };
    });
    for (const ref of [...state.timeline, ...state.contextSources]) {
        if (!sourceEligible(state, ref, asOf)) continue;
        const source = state.sources[ref.id];
        const revision = sourceAt(state, ref);
        // Small source passages keep recovery and embeddings bounded; the full revision stays in the archive.
        const passages = [];
        for (let start = 0; start < revision.text.length; start += 1600) {
            passages.push(revision.text.slice(start, start + 1800));
        }
        passages.forEach((passage, index) => documents.push({
            id: 'source:' + refKey(ref) + ':' + index, kind: 'source', dataType: source.type,
            text: passage, searchText: revision.speaker + '\n' + passage, refs: [ref],
            asOf: revision.sequence, ownerId: '', subjectIds: [], status: 'active',
        }));
    }
    return documents;
}

export function lexicalSearch(documents, query, limit = 24) {
    const queryTerms = new Set(terms(query));
    if (!queryTerms.size) return [];
    const tokenSets = documents.map(document => new Set(terms(document.text + '\n' + document.searchText)));
    const frequency = new Map([...queryTerms].map(term => [term, tokenSets.filter(tokens => tokens.has(term)).length]));
    return documents.map((document, index) => ({
        document,
        score: [...queryTerms].reduce((score, term) => score + (tokenSets[index].has(term)
            ? Math.log(1 + (documents.length + 1) / (1 + frequency.get(term))) : 0), 0)
            * (['background', 'resolved'].includes(document.status) ? 0.8 : 1),
    })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
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

export function hybridCandidates(documents, query, vector, index, limit) {
    const lexical = lexicalSearch(documents, query, limit);
    // ponytail: linear per-story vector search; use a measured ANN backend when large archives outgrow it.
    const semantic = vector ? documents.filter(document => index[document.id]?.textHash === hash(document.searchText))
        .map(document => ({ document, score: cosine(vector, index[document.id].vector) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit) : [];
    const scores = new Map();
    for (const ranked of [lexical, semantic]) ranked.forEach(({ document }, rank) => {
        const value = scores.get(document.id) || { document, score: 0 };
        value.score += 1 / (60 + rank + 1);
        scores.set(document.id, value);
    });
    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.document);
}

/** Build a new vector space separately; queries use lexical recovery until its document side is ready. */
export async function updateIndex(state, directories, config, { signal, limit = 32, embedFn = embed } = {}) {
    if (!config.roles.embedding.enabled) return { usage: [], remaining: 0 };
    const documents = searchDocuments(state).filter(document => config.roles.embedding.allowedData.includes(document.dataType));
    const version = roleVersion(config, 'embedding');
    const sameVersion = state.index.version === version;
    const existing = sameVersion ? state.index.vectors : state.index.build?.version === version ? state.index.build.vectors : {};
    const next = Object.fromEntries(documents.filter(document => existing[document.id]?.textHash === hash(document.searchText))
        .map(document => [document.id, existing[document.id]]));
    const missing = documents.filter(document => !next[document.id]);
    const usage = [];
    for (let start = 0; start < Math.min(limit, missing.length); start += 16) {
        const batch = missing.slice(start, Math.min(start + 16, limit));
        const result = await embedFn(directories, config, batch.map(document => document.searchText), {
            signal, dataTypes: [...new Set(batch.map(document => document.dataType))],
        });
        usage.push(result.usage);
        batch.forEach((document, offset) => { next[document.id] = { textHash: hash(document.searchText), vector: result.vectors[offset] }; });
    }
    const remaining = Math.max(0, missing.length - limit);
    if (!remaining || sameVersion) state.index = { version, vectors: next, pending: remaining > 0 };
    else state.index = { ...state.index, pending: true, build: { version, vectors: next } };
    return { usage, remaining };
}

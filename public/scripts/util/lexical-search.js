// A Node built with small ICU data has no word-break rules, and Intl.Segmenter then crashes
// the whole process instead of throwing (issue 80). Such runtimes split words with a pattern.
export function canSegmentWords(runtime = globalThis.process) {
    if (!runtime?.versions?.node || runtime.config?.variables?.icu_small !== true) return true;
    return Boolean(runtime.env?.NODE_ICU_DATA) || (runtime.execArgv ?? []).some(arg => arg.startsWith('--icu-data-dir'));
}

const segmenter = canSegmentWords() ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
const WORD = /[\p{L}\p{M}\p{N}_]+(?:['\u2019][\p{L}\p{M}\p{N}_]+)*/gu;

export function terms(value) {
    const text = String(value).normalize('NFKC').toLocaleLowerCase();
    if (!segmenter) return text.match(WORD) ?? [];
    return [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment);
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

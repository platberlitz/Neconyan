const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

export function terms(value) {
    return [...segmenter.segment(String(value).normalize('NFKC').toLocaleLowerCase())]
        .filter(part => part.isWordLike).map(part => part.segment);
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

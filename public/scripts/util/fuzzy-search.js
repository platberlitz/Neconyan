/** Matching shared by the browser's controls and the account's saved content. */
export function normaliseSearchText(value) {
    return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Bounded Damerau-Levenshtein distance includes an adjacent transposition.
function distance(left, right, limit) {
    if (Math.abs(left.length - right.length) > limit) return limit + 1;
    let older = null;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        const row = [i];
        for (let j = 1; j <= right.length; j++) {
            row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(left[i - 1] !== right[j - 1]));
            if (older && i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
                row[j] = Math.min(row[j], older[j - 2] + 1);
            }
        }
        if (Math.min(...row) > limit) return limit + 1;
        older = previous;
        previous = row;
    }
    return previous[right.length];
}

/** All query words must match. Exact and prefix matches always outrank typos. */
export function createSearchMatcher(query) {
    const normalised = normaliseSearchText(query).slice(0, 200);
    const terms = [...new Set(normalised.split(' ').filter(Boolean))].slice(0, 20);
    const cache = new Map();
    const wordScore = (term, word) => {
        const key = `${term}:${word}`;
        if (cache.has(key)) return cache.get(key);
        let score = word === term ? 80 : word.startsWith(term) ? 65 : 0;
        if (!score && term.length >= 4 && word.length <= 128) {
            const limit = term.length >= 8 ? 2 : 1;
            // Keep prefix completion useful when the typed prefix itself contains a typo.
            const edits = Math.min(distance(term, word, limit),
                distance(term, word.slice(0, term.length), limit),
                distance(term, word.slice(0, term.length + 1), limit));
            if (edits <= limit) score = 45 - edits * 5;
        }
        if (!score && term.length >= 3 && word.includes(term)) score = 20;
        if (cache.size < 20000) cache.set(key, score);
        return score;
    };
    return text => {
        if (!terms.length) return 0;
        const value = normaliseSearchText(text);
        if (value === normalised) return 100;
        if (value.startsWith(normalised)) return 90;
        const words = [...new Set(value.split(' '))];
        let score = 80;
        for (const term of terms) {
            let best = 0;
            for (const word of words) {
                best = Math.max(best, wordScore(term, word));
                if (best === 80) break;
            }
            if (!best) return 0;
            score = Math.min(score, best);
        }
        return score;
    };
}

export function searchSnippet(text, query, length = 180) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value.length <= length) return value;
    const matchers = normaliseSearchText(query).split(' ').filter(Boolean).map(createSearchMatcher);
    let found;
    for (const word of value.matchAll(/[\p{L}\p{N}]+/gu)) {
        if (matchers.some(match => match(word[0]))) { found = word; break; }
    }
    const start = Math.max(0, (found?.index ?? 0) - 45);
    return `${start ? '…' : ''}${value.slice(start, start + length)}${start + length < value.length ? '…' : ''}`;
}

import { serializeWorldInfoEntry } from '../world-info-character-book.js';

// Native World Info positions are part of the card interchange format.
const POSITIONS = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };

/** Retain untouched imported records byte-for-byte at the JSON value level. */
export function creatorEmbeddedBook(book) {
    const source = book.data.originalData ?? {};
    if (book.original && JSON.stringify(book.data) === JSON.stringify(book.original) && Array.isArray(source.entries)) return structuredClone(source);
    const entries = Object.entries(book.data.entries).map(([uid, entry]) => {
        const index = book.data.originalDataUidMap?.[uid];
        const original = Number.isInteger(index) ? source.entries?.[index] : undefined;
        if (original && JSON.stringify(entry) === JSON.stringify(book.original?.entries?.[uid])) return structuredClone(original);
        return serializeWorldInfoEntry(entry, POSITIONS, original);
    });
    return { ...structuredClone(source), name: book.name, entries };
}

export function creatorPublicationCard(draft) {
    const card = structuredClone(draft.card);
    const embedded = draft.books.filter(book => book.mode === 'embedded' && !book.detached);
    if (embedded.length > 1) throw new Error('A character card can contain one portable lorebook. Combine or detach the others.');
    if (embedded.length) card.data.character_book = creatorEmbeddedBook(embedded[0]);
    else if (draft.books.some(book => book.mode === 'embedded' && book.detached)) delete card.data.character_book;
    return card;
}

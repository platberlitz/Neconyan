import { serializeWorldInfoEntry } from '../world-info-character-book.js';
import { creatorCardV3 } from './model.js';

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

export function creatorPublicationCard(draft, { ccv3 = false } = {}) {
    const card = structuredClone(draft.card);
    const embedded = draft.books.filter(book => book.mode === 'embedded' && !book.detached);
    if (embedded.length > 1) throw new Error('A character card can contain one portable lorebook. Combine or detach the others.');
    if (embedded.length) card.data.character_book = creatorEmbeddedBook(embedded[0]);
    else if (draft.books.some(book => book.mode === 'embedded' && book.detached)) delete card.data.character_book;
    // Comparison must use the untouched imported shape, not format-only additions.
    if (!ccv3) return card;
    const result = creatorCardV3(card);
    const book = result.data.character_book;
    if (book) {
        book.extensions ??= {};
        book.entries ??= [];
        for (const entry of book.entries) {
            entry.keys ??= [];
            entry.content ??= '';
            entry.extensions ??= {};
            entry.enabled ??= true;
            entry.insertion_order ??= 100;
            entry.use_regex ??= false;
            if (entry.case_sensitive === null) delete entry.case_sensitive;
        }
    }
    return result;
}

/** Rebuild the editable portable book from the chosen comparison, including removal. */
export function adoptCreatorComparedCard(draft, card, convertCharacterBook) {
    const previous = draft.books.find(book => book.mode === 'embedded');
    draft.books = draft.books.filter(book => book.mode !== 'embedded');
    draft.card = structuredClone(card);
    const embedded = card.data.character_book;
    if (Array.isArray(embedded?.entries)) {
        const data = convertCharacterBook(embedded);
        draft.books.push({ id: previous?.id ?? crypto.randomUUID(), name: embedded.name || 'Portable lorebook', mode: 'embedded', data, original: structuredClone(data), revision: null });
    }
}

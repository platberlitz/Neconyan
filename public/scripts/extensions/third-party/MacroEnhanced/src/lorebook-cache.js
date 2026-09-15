/**
 * Macro handlers must answer synchronously, but World Info books load asynchronously.
 * This module keeps a synchronous mirror of the relevant books, prewarmed from
 * lifecycle events and patched directly from WORLDINFO_UPDATED payloads.
 */

/** @type {Map<string, {entries: object[], byUid: Map<string, object>, byTitle: Map<string, object>}>} */
const books = new Map();
/** @type {object[]} last WORLD_INFO_ACTIVATED payload */
let activeEntries = [];
/** @type {Set<string>} loads currently in flight, keyed by book name */
const loading = new Set();
/** @type {Set<string>} books whose last load failed. not retried until the next prewarm */
const failed = new Set();

function normalizeTitle(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function indexBook(name, data) {
    const entries = Object.values(data?.entries ?? {});
    const byUid = new Map();
    const byTitle = new Map();
    for (const entry of entries) {
        byUid.set(String(entry.uid), entry);
        const title = normalizeTitle(entry.comment);
        if (title && !byTitle.has(title)) {
            byTitle.set(title, entry);
        }
    }
    books.set(name, { entries, byUid, byTitle });
    failed.delete(name);
}

export function forgetBook(name) {
    books.delete(name);
}

export function clearCache() {
    books.clear();
    activeEntries = [];
    loading.clear();
    failed.clear();
}

export function setActiveEntries(entries) {
    activeEntries = Array.isArray(entries) ? [...entries] : [];
}

export function getActiveEntries() {
    return activeEntries;
}

export function isBookCached(name) {
    return books.has(name);
}

function stripExtension(fileName) {
    return String(fileName ?? '').replace(/\.[^/.]+$/, '');
}

/**
 * The books that should be warm for the current chat: the chat-bound book, the
 * globally selected books, the character's primary book, and charLore extras.
 *
 * @param {object} ctx - SillyTavern context.
 * @returns {string[]}
 */
export function computePrewarmNames(ctx) {
    const names = new Set();

    const chatBook = ctx.chatMetadata?.['world_info'];
    if (typeof chatBook === 'string' && chatBook) {
        names.add(chatBook);
    }

    for (const name of ctx.worldInfoSettings?.globalSelect ?? []) {
        if (name) {
            names.add(name);
        }
    }

    const character = ctx.characters?.[ctx.characterId];
    const primary = character?.data?.extensions?.world;
    if (typeof primary === 'string' && primary) {
        names.add(primary);
    }

    const avatarKey = stripExtension(character?.avatar);
    for (const loreEntry of ctx.worldInfoSettings?.charLore ?? []) {
        const entryKey = stripExtension(loreEntry?.name);
        if (entryKey && (entryKey === avatarKey || loreEntry?.name === character?.avatar)) {
            for (const extra of loreEntry.extraBooks ?? []) {
                if (extra) {
                    names.add(extra);
                }
            }
        }
    }

    return [...names];
}

/**
 * Loads a single book into the cache in the background. Safe to call repeatedly:
 * a failed load is remembered so per-evaluation lookups don't hammer the server —
 * the next prewarm (chat change, World Info settings change) retries.
 */
export function warmBook(ctx, name) {
    if (!name || books.has(name) || loading.has(name) || failed.has(name)) {
        return;
    }
    loading.add(name);
    Promise.resolve(ctx.loadWorldInfo(name))
        .then((data) => {
            if (data) {
                indexBook(name, data);
            } else {
                failed.add(name);
            }
        })
        .catch((error) => {
            failed.add(name);
            console.warn(`[Macro Enhanced] Failed to load lorebook "${name}"`, error);
        })
        .finally(() => loading.delete(name));
}

export function prewarm(ctx) {
    failed.clear();
    for (const name of computePrewarmNames(ctx)) {
        warmBook(ctx, name);
    }
}

/**
 * Book names to search when no explicit book is given, in precedence order:
 * chat book first, then character books, then global books.
 */
export function getSearchOrder(ctx) {
    const ordered = [];
    const seen = new Set();
    const push = (name) => {
        if (typeof name === 'string' && name && !seen.has(name)) {
            seen.add(name);
            ordered.push(name);
        }
    };

    push(ctx.chatMetadata?.['world_info']);

    const character = ctx.characters?.[ctx.characterId];
    push(character?.data?.extensions?.world);
    const avatarKey = stripExtension(character?.avatar);
    for (const loreEntry of ctx.worldInfoSettings?.charLore ?? []) {
        const entryKey = stripExtension(loreEntry?.name);
        if (entryKey && (entryKey === avatarKey || loreEntry?.name === character?.avatar)) {
            for (const extra of loreEntry.extraBooks ?? []) {
                push(extra);
            }
        }
    }

    for (const name of ctx.worldInfoSettings?.globalSelect ?? []) {
        push(name);
    }

    return ordered;
}

/**
 * Finds an entry by title (the entry's comment/memo, case-insensitive) or uid.
 *
 * @param {object} ctx - SillyTavern context.
 * @param {string} entryName - Title or uid of the entry.
 * @param {string} [bookName] - Optional explicit book. Searched books are warmed on miss.
 * @returns {{entry: object|null, book: string|null, missing: string[]}} missing = books not yet cached
 */
export function findEntry(ctx, entryName, bookName) {
    const searchBooks = bookName ? [bookName] : getSearchOrder(ctx);
    const wanted = normalizeTitle(entryName);
    const missing = [];

    for (const name of searchBooks) {
        const book = books.get(name);
        if (!book) {
            missing.push(name);
            warmBook(ctx, name);
            continue;
        }
        const entry = book.byTitle.get(wanted) ?? book.byUid.get(String(entryName).trim());
        if (entry) {
            return { entry, book: name, missing };
        }
    }

    return { entry: null, book: null, missing };
}

/**
 * Enabled entries across the given books (cached books only).
 */
export function getEnabledEntries(bookNames) {
    const result = [];
    for (const name of bookNames) {
        const book = books.get(name);
        if (!book) {
            continue;
        }
        for (const entry of book.entries) {
            if (!entry.disable) {
                result.push({ entry, book: name });
            }
        }
    }
    return result;
}

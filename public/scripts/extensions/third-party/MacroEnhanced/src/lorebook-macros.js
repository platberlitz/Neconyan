import { safeRegister } from './registration.js';
import {
    findEntry,
    getActiveEntries,
    getEnabledEntries,
    getSearchOrder,
    isBookCached,
    warmBook,
} from './lorebook-cache.js';
import { estimateTokens } from './utility-impl.js';
import { fnv1a } from './state-impl.js';

export const CATEGORY_LOREBOOK = 'enhanced-lorebook';

/** Readable fields for {{lorefield}}. a whitelist over the entry mirror. */
const LORE_FIELDS = {
    title: (entry) => entryTitle(entry),
    keys: (entry) => (entry.key ?? []).join(', '),
    secondarykeys: (entry) => (entry.keysecondary ?? []).join(', '),
    content: (entry) => String(entry.content ?? ''),
    position: (entry) => String(entry.position ?? ''),
    depth: (entry) => String(entry.depth ?? ''),
    order: (entry) => String(entry.order ?? ''),
    probability: (entry) => String(entry.probability ?? ''),
    constant: (entry) => (entry.constant ? 'true' : 'false'),
    enabled: (entry) => (entry.disable ? 'false' : 'true'),
    uid: (entry) => String(entry.uid),
};

/** Guards {{lore}} against entries that (directly or via nesting) include themselves. */
const inFlight = new Set();

function entryTitle(entry) {
    const comment = String(entry.comment ?? '').trim();
    if (comment) {
        return comment;
    }
    const firstKey = Array.isArray(entry.key) ? entry.key[0] : undefined;
    return firstKey ? String(firstKey) : String(entry.uid);
}

function lookup(entryName, bookName, warn) {
    const ctx = SillyTavern.getContext();
    const { entry, book, missing } = findEntry(ctx, entryName, bookName || undefined);
    if (!entry) {
        if (missing.length) {
            warn(`Lorebook${missing.length > 1 ? 's' : ''} ${missing.map(name => `"${name}"`).join(', ')} not loaded yet. try again in a moment.`);
        } else {
            warn(`No lorebook entry named "${entryName}" found${bookName ? ` in "${bookName}"` : ''}.`);
        }
        return null;
    }
    return { entry, book };
}

export function registerLorebookMacros() {
    safeRegister('lore', {
        aliases: [{ alias: 'wi', visible: false }],
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'entry', description: 'The entry title (its memo/comment) or uid.' },
            { name: 'book', optional: true, description: 'A specific lorebook name. Without it, the chat, character and global books are searched in that order.' },
        ],
        description: 'Inserts the content of a lorebook entry. Macros inside the entry are expanded too.',
        returns: 'the entry\'s content, or empty when it is not found',
        exampleUsage: ['{{lore::Backstory}}', '{{lore::Kingdom::My World}}'],
        handler: ({ unnamedArgs: [entryName, bookName], resolve, warn }) => {
            const found = lookup(entryName, bookName, warn);
            if (!found) {
                return '';
            }
            const guardKey = `${found.book}::${found.entry.uid}`;
            if (inFlight.has(guardKey)) {
                warn(`Lorebook entry "${entryName}" includes itself; returning its raw content.`);
                return String(found.entry.content ?? '');
            }
            inFlight.add(guardKey);
            try {
                return resolve(String(found.entry.content ?? ''));
            } finally {
                inFlight.delete(guardKey);
            }
        },
    });

    safeRegister('lorekeys', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'entry', description: 'The entry title (its memo/comment) or uid.' },
            { name: 'book', optional: true, description: 'A specific lorebook name.' },
        ],
        description: 'Lists the trigger keywords of a lorebook entry, comma separated.',
        returns: 'a comma separated list of keywords',
        exampleUsage: ['{{lorekeys::Backstory}}'],
        handler: ({ unnamedArgs: [entryName, bookName], warn }) => {
            const found = lookup(entryName, bookName, warn);
            if (!found) {
                return '';
            }
            return (found.entry.key ?? []).join(', ');
        },
    });

    safeRegister('loreexists', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'entry', description: 'The entry title (its memo/comment) or uid.' },
            { name: 'book', optional: true, description: 'A specific lorebook name.' },
        ],
        description: 'Checks whether a lorebook entry exists. Returns "true" or "false".',
        returns: 'true or false',
        exampleUsage: ['{{if {{loreexists::Backstory}}}}...{{/if}}'],
        handler: ({ unnamedArgs: [entryName, bookName], warn }) => {
            const ctx = SillyTavern.getContext();
            const { entry, missing } = findEntry(ctx, entryName, bookName || undefined);
            if (!entry && missing.length) {
                warn(`Lorebook${missing.length > 1 ? 's' : ''} ${missing.map(name => `"${name}"`).join(', ')} not loaded yet. "false" may be wrong until then.`);
            }
            return entry ? 'true' : 'false';
        },
    });

    safeRegister('lorecount', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'scope', optional: true, defaultValue: 'active', description: '"active" (triggered last generation), "bound" (enabled entries in the books bound to this chat) or "all".' },
        ],
        description: 'Counts lorebook entries.',
        returns: 'a whole number',
        returnType: 'integer',
        exampleUsage: ['{{lorecount}}', '{{lorecount::bound}}'],
        handler: ({ unnamedArgs: [scope], warn }) => {
            const ctx = SillyTavern.getContext();
            const mode = String(scope || 'active').toLowerCase();
            if (mode === 'active') {
                return String(getActiveEntries().length);
            }
            if (mode === 'bound') {
                return String(getEnabledEntries(getSearchOrder(ctx)).length);
            }
            if (mode === 'all') {
                const names = ctx.getWorldInfoNames?.() ?? [];
                const uncached = names.filter(name => !isBookCached(name));
                uncached.forEach(name => warmBook(ctx, name));
                if (uncached.length) {
                    warn(`${uncached.length} lorebook(s) not loaded yet; the count only covers loaded books.`);
                }
                return String(getEnabledEntries(names).length);
            }
            warn(`Unknown scope "${scope}". use active, bound or all.`);
            return '';
        },
    });

    safeRegister('loreactive', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'separator', optional: true, defaultValue: ', ', description: 'Placed between the entry titles.' },
        ],
        description: 'Lists the titles of the lorebook entries that triggered during the last generation.',
        returns: 'a comma separated list of entry titles',
        exampleUsage: ['{{loreactive}}'],
        handler: ({ unnamedArgs: [separator] }) => {
            const sep = separator === undefined || separator === '' ? ', ' : separator;
            return getActiveEntries().map(entryTitle).join(sep);
        },
    });

    safeRegister('lorebooks', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'separator', optional: true, defaultValue: ', ', description: 'Placed between the book names.' },
        ],
        description: 'Lists the lorebooks bound to this chat (chat book, character books, global books).',
        returns: 'a comma separated list of lorebook names',
        exampleUsage: ['{{lorebooks}}'],
        handler: ({ unnamedArgs: [separator] }) => {
            const ctx = SillyTavern.getContext();
            const sep = separator === undefined || separator === '' ? ', ' : separator;
            return getSearchOrder(ctx).join(sep);
        },
    });

    /** Warms uncached books and warns about them; returns the cached subset's entries. */
    const enabledEntriesWithWarning = (ctx, names, warn) => {
        const uncached = names.filter(name => !isBookCached(name));
        uncached.forEach(name => warmBook(ctx, name));
        if (uncached.length) {
            warn(`Lorebook${uncached.length > 1 ? 's' : ''} ${uncached.map(name => `"${name}"`).join(', ')} not loaded yet. the result only covers loaded books.`);
        }
        return getEnabledEntries(names);
    };

    safeRegister('loreentries', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'book', optional: true, defaultValue: '', description: 'A specific lorebook name. Without it, all books bound to this chat.' },
            { name: 'separator', optional: true, defaultValue: ', ', description: 'Placed between the entry titles.' },
        ],
        description: 'Lists the titles of the enabled entries in a lorebook (or in every book bound to this chat).',
        returns: 'a comma separated list of entry titles',
        exampleUsage: ['{{loreentries}}', '{{loreentries::My World}}'],
        handler: ({ unnamedArgs: [bookName, separator], warn }) => {
            const ctx = SillyTavern.getContext();
            const names = bookName ? [bookName] : getSearchOrder(ctx);
            const sep = separator === undefined || separator === '' ? ', ' : separator;
            return enabledEntriesWithWarning(ctx, names, warn)
                .map(({ entry }) => entryTitle(entry))
                .join(sep);
        },
    });

    safeRegister('lorefield', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'entry', description: 'The entry title (its memo/comment) or uid.' },
            { name: 'field', description: `One of: ${Object.keys(LORE_FIELDS).join(', ')}.` },
            { name: 'book', optional: true, description: 'A specific lorebook name.' },
        ],
        description: 'Reads one field of a lorebook entry (its keywords, position, depth, probability, ...).',
        returns: 'the field value, or empty when the field is unknown',
        exampleUsage: ['{{lorefield::Backstory::keys}}', '{{lorefield::Backstory::probability}}'],
        handler: ({ unnamedArgs: [entryName, field, bookName], warn }) => {
            const reader = LORE_FIELDS[String(field ?? '').trim().toLowerCase()];
            if (!reader) {
                warn(`{{lorefield}}: "${field}" is not a readable field. use one of: ${Object.keys(LORE_FIELDS).join(', ')}.`);
                return '';
            }
            const found = lookup(entryName, bookName, warn);
            if (!found) {
                return '';
            }
            return reader(found.entry);
        },
    });

    safeRegister('loretokens', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'scope', optional: true, defaultValue: 'active', description: '"active" (triggered last generation) or "bound" (all enabled entries in this chat\'s books).' },
        ],
        description: 'A rough token estimate (~4 characters per token) of lorebook content. pairs with {{lorecount}} for budget checks.',
        returns: 'an estimated token count',
        returnType: 'integer',
        exampleUsage: ['{{loretokens}}', '{{loretokens::bound}}'],
        handler: ({ unnamedArgs: [scope], warn }) => {
            const ctx = SillyTavern.getContext();
            const mode = String(scope || 'active').toLowerCase();
            if (mode === 'active') {
                return String(estimateTokens(getActiveEntries().map(entry => String(entry.content ?? '')).join('\n')));
            }
            if (mode === 'bound') {
                const entries = enabledEntriesWithWarning(ctx, getSearchOrder(ctx), warn);
                return String(estimateTokens(entries.map(({ entry }) => String(entry.content ?? '')).join('\n')));
            }
            warn(`Unknown scope "${scope}". use active or bound.`);
            return '';
        },
    });

    safeRegister('lorepick', {
        category: CATEGORY_LOREBOOK,
        unnamedArgs: [
            { name: 'book', optional: true, defaultValue: '', description: 'A specific lorebook name. Without it, all books bound to this chat.' },
            { name: 'key', optional: true, defaultValue: '', description: 'A label that keeps different picks independent.' },
        ],
        description: 'Inserts the content of one enabled entry. always the same one for this chat and key. A cache-friendly random story seed.',
        returns: 'the chosen entry\'s content',
        exampleUsage: ['{{lorepick::Story Seeds}}', '{{lorepick::Story Seeds::second-seed}}'],
        handler: ({ unnamedArgs: [bookName, key], resolve, warn }) => {
            const ctx = SillyTavern.getContext();
            const names = bookName ? [bookName] : getSearchOrder(ctx);
            const candidates = enabledEntriesWithWarning(ctx, names, warn)
                .sort((a, b) => String(a.entry.uid).localeCompare(String(b.entry.uid), undefined, { numeric: true }));
            if (!candidates.length) {
                warn('{{lorepick}}: no enabled entries to pick from.');
                return '';
            }
            const chatSeed = String(ctx.chatMetadata?.chat_id_hash ?? '');
            const picked = candidates[fnv1a(`${chatSeed}:${String(bookName ?? '')}:${String(key ?? '')}`) % candidates.length];
            const guardKey = `${picked.book}::${picked.entry.uid}`;
            if (inFlight.has(guardKey)) {
                warn('{{lorepick}}: the picked entry includes itself; returning its raw content.');
                return String(picked.entry.content ?? '');
            }
            inFlight.add(guardKey);
            try {
                return resolve(String(picked.entry.content ?? ''));
            } finally {
                inFlight.delete(guardKey);
            }
        },
    });
}

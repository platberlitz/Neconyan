import { isPathfinderSubmoduleEnabled } from '../agent-store.js';
import { getLinkApiRequestFormat } from '../../../linkapi-utils.js';
import { getSettings, getTree, getAllEntryUids, isEntryEligible, isLorebookEnabled, canReadBook, canWriteBook, canDeleteBook, parseEntryUid } from './tree-store.js';

const CHAT_LOREBOOK_METADATA_KEY = 'world_info';

const PATHFINDER_LOG_PREFIX = '[Pawthfinder]';

export const TOOL_NAMES = {
    SEARCH: 'Pathfinder_Search',
    REMEMBER: 'Pathfinder_Remember',
    UPDATE: 'Pathfinder_Update',
    FORGET: 'Pathfinder_Forget',
    SUMMARIZE: 'Pathfinder_Summarize',
    REORGANIZE: 'Pathfinder_Reorganize',
    MERGE_SPLIT: 'Pathfinder_MergeSplit',
    NOTEBOOK: 'Pathfinder_Notebook',
};

export const ALL_TOOL_NAMES = Object.values(TOOL_NAMES);

/** Tools that modify lorebook data and can be gated behind a confirmation dialog. */
export const CONFIRMABLE_TOOLS = new Set([
    TOOL_NAMES.REMEMBER,
    TOOL_NAMES.UPDATE,
    TOOL_NAMES.FORGET,
    TOOL_NAMES.SUMMARIZE,
    TOOL_NAMES.REORGANIZE,
    TOOL_NAMES.MERGE_SPLIT,
]);

/**
 * Resolve the tool_choice value that forces tool use, when the user enabled
 * "require tool use on every response". The server backends translate:
 * Anthropic-format backends use 'any'; OpenAI-format backends use 'required'.
 * @param {string} chatCompletionSource - Source id from the generation data
 * @param {string} model - Model id used to resolve format-switching providers
 * @returns {string|null} Value for tool_choice, or null when not forcing
 */
export function getForcedToolChoice(chatCompletionSource, model) {
    if (!isPathfinderSubmoduleEnabled()) {
        return null;
    }

    const s = getSettings();
    if (!s.sidecarEnabled || !s.mandatoryTools) {
        return null;
    }

    if (chatCompletionSource === 'ai21') {
        return null;
    }

    const usesAnthropicFormat = chatCompletionSource === 'claude'
        || (chatCompletionSource === 'linkapi' && getLinkApiRequestFormat(model) === 'anthropic');
    return usesAnthropicFormat ? 'any' : 'required';
}

export function getActiveTunnelVisionBooks(s = getSettings()) {
    if (!isPathfinderSubmoduleEnabled()) {
        return [];
    }

    const books = Array.isArray(s.enabledLorebooks)
        ? s.enabledLorebooks.filter(b => isLorebookEnabled(b, s))
        : [];

    if (s.includeContextualLorebooks !== false || s.autoUseAttachedLorebook) {
        books.push(...getContextualLorebooks());
    }

    return Array.from(new Set(books.filter(book => book && s.bookPermissions?.[book]?.enabled !== false)));
}

function addBookSource(sources, name, type) {
    const bookName = String(name ?? '').trim();
    if (!bookName) {
        return;
    }

    const existing = sources.find(source => source.name === bookName);
    if (existing) {
        existing.types.add(type);
        return;
    }

    sources.push({
        name: bookName,
        types: new Set([type]),
    });
}

function getChatMetadata(ctx) {
    return ctx?.chatMetadata ?? ctx?.chat_metadata ?? {};
}

function getPowerUserSettings(ctx) {
    return ctx?.powerUserSettings ?? ctx?.power_user ?? {};
}

function getWorldInfoSettings(ctx) {
    return ctx?.worldInfoSettings ?? ctx?.world_info ?? {};
}

function hasActiveGroup(ctx) {
    return ctx?.groupId !== null && ctx?.groupId !== undefined && String(ctx.groupId).trim() !== '';
}

export function getContextualLorebookDetails() {
    const ctx = window?.SillyTavern?.getContext?.();
    const sources = [];
    const chatLorebook = getChatMetadata(ctx)?.[CHAT_LOREBOOK_METADATA_KEY];
    const personaLorebook = getPowerUserSettings(ctx)?.persona_description_lorebook;

    addBookSource(sources, chatLorebook, 'chat');
    addBookSource(sources, personaLorebook, 'persona');

    for (const character of getContextCharacters(ctx)) {
        const primaryBook = character?.data?.extensions?.world || character?.data?.character_book?.name;
        addBookSource(sources, primaryBook, hasActiveGroup(ctx) ? 'group' : 'character');

        const fileName = getCharacterFileName(character);
        const extraCharLore = getWorldInfoSettings(ctx)?.charLore?.find?.(entry => String(entry?.name ?? '') === fileName);
        if (Array.isArray(extraCharLore?.extraBooks)) {
            for (const book of extraCharLore.extraBooks) {
                addBookSource(sources, book, hasActiveGroup(ctx) ? 'group' : 'character');
            }
        }
    }

    return sources.map(source => ({
        name: source.name,
        types: [...source.types],
        type: [...source.types][0] ?? 'attached',
    }));
}

export function getContextualLorebooks() {
    return getContextualLorebookDetails().map(source => source.name);
}

function getContextCharacters(ctx) {
    if (!ctx?.characters?.length) {
        return [];
    }

    if (hasActiveGroup(ctx)) {
        const group = ctx.groups?.find?.(item => String(item?.id ?? '') === String(ctx.groupId ?? ''));
        const memberAvatars = Array.isArray(group?.members) ? group.members : [];
        return memberAvatars
            .map(avatar => ctx.characters.find(character => character?.avatar === avatar))
            .filter(Boolean);
    }

    const character = ctx.characters[ctx.characterId];
    return character ? [character] : [];
}

function getCharacterFileName(character) {
    const avatar = String(character?.avatar || '');
    return avatar.replace(/\.[^.]+$/, '');
}

export function getReadableBooks(s = getSettings()) {
    return getActiveTunnelVisionBooks(s).filter(b => canReadBook(b, s));
}

export function getWritableBooks(s = getSettings()) {
    return getActiveTunnelVisionBooks(s).filter(b => canWriteBook(b, s));
}

export function getDeletableBooks(s = getSettings()) {
    return getActiveTunnelVisionBooks(s).filter(b => canDeleteBook(b, s));
}

export function getToolWriteOptions(bookName, options = {}, getAllowedBooks = getWritableBooks) {
    // Queued writes must recheck permissions after loading, not only when invoked.
    return {
        ...options,
        signal: options.signal,
        isCurrent: () => (!options.isCurrent || options.isCurrent()) && getAllowedBooks().includes(bookName),
    };
}

export function isToolReadCurrent(bookName, options = {}) {
    return !options.signal?.aborted && (!options.isCurrent || options.isCurrent()) && getReadableBooks().includes(bookName);
}

export function getToolArgumentError(args, parameters) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Error: Tool arguments must be an object.';
    for (const [name, definition] of Object.entries(parameters?.properties ?? {})) {
        const value = args[name];
        if (value === undefined) continue;
        // UID and deletion-flag parsers retain their documented legacy string forms.
        if (definition.type === 'string' && typeof value !== 'string') return `Error: "${name}" must be text.`;
        if (definition.enum && !definition.enum.includes(value?.trim?.().toLowerCase())) {
            return `Error: "${name}" must be one of: ${definition.enum.join(', ')}.`;
        }
    }
    return null;
}

export async function prepareToolCall(tool, args, options = {}) {
    const argumentError = getToolArgumentError(args, tool.parameters);
    if (argumentError) throw new Error(argumentError);
    const prepared = { ...args };
    if (!CONFIRMABLE_TOOLS.has(tool.name)) return { args: prepared, options };
    const hardDelete = prepared.hard_delete === true || /^(true|1|yes)$/i.test(String(prepared.hard_delete ?? '').trim());
    const merge = tool.name === TOOL_NAMES.MERGE_SPLIT && prepared.action?.trim().toLowerCase() === 'merge';
    const allowed = tool.name === TOOL_NAMES.FORGET && hardDelete ? getDeletableBooks()
        : getWritableBooks().filter(book => !merge || canDeleteBook(book));
    const requested = prepared.book?.trim() ?? '';
    const bookError = getUnknownBookError(requested, allowed);
    if (bookError) throw new Error(bookError);
    prepared.book = resolveTargetBook(requested, allowed);
    if (!prepared.book) throw new Error('No Pawthfinder-enabled lorebook allows this operation.');
    const uids = ['uid', 'uid1', 'uid2'].filter(key => prepared[key] !== undefined).map(key => {
        const uid = parseEntryUid(prepared[key]);
        if (uid === null) throw new Error(`Error: "${key}" must be a valid entry UID.`);
        return uid;
    });
    const expectedEntries = [];
    if (uids.length) {
        const data = await globalThis.window?.SillyTavern?.getContext?.()?.loadWorldInfo?.(prepared.book);
        options.signal?.throwIfAborted();
        if (options.isCurrent && !options.isCurrent()) throw new DOMException('Cancelled', 'AbortError');
        for (const uid of uids) {
            const entry = Object.values(data?.entries ?? {}).find(entry => entry?.uid === uid);
            if (!entry || entry.agentBlacklisted) throw new Error(`Entry UID ${uid} is unavailable in "${prepared.book}".`);
            expectedEntries.push([uid, JSON.stringify(entry)]);
        }
    }
    return { args: prepared, options: { ...options, expectedEntries } };
}

export function resolveTargetBook(requestedBook, writableBooks = null) {
    const books = writableBooks ?? getWritableBooks();
    if (books.length === 0) return null;
    if (requestedBook && books.includes(requestedBook)) {
        return requestedBook;
    }

    return books[0];
}

/**
 * For UID-addressed operations an explicitly named book must not silently
 * fall back to another book — UIDs are per-book, so the fallback would hit
 * an unrelated entry. Returns an error string, or null when the request is
 * fine (no book named, or the named book is allowed).
 * @param {string} requestedBook - Book name from the tool call, may be empty
 * @param {string[]} allowedBooks - Books the operation may target
 * @returns {string|null}
 */
export function getUnknownBookError(requestedBook, allowedBooks) {
    const name = String(requestedBook ?? '').trim();
    if (!name || allowedBooks.includes(name)) {
        return null;
    }

    return `Error: Lorebook "${name}" is not available for this operation. Available: ${allowedBooks.join(', ') || 'none'}.`;
}

export function getBookListWithDescriptions() {
    const books = getReadableBooks();
    return books.map(b => {
        const tree = getTree(b);
        const entryCount = getAllEntryUids(tree).length;
        return `📚 ${b} (${entryCount} entries)`;
    }).join('\n');
}

export function preflightToolRuntimeState() {
    const books = getActiveTunnelVisionBooks();
    return {
        hasBooks: books.length > 0,
        bookCount: books.length,
        books,
    };
}

/**
 * Get entry content by UID from a lorebook
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID
 * @returns {Promise<Object|null>} Entry object with uid, comment, content, etc.
 */
export async function getEntryContent(bookName, uid, options = {}) {
    if (!isToolReadCurrent(bookName, options)) return null;
    const ctx = window?.SillyTavern?.getContext?.();
    if (!ctx?.loadWorldInfo) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Cannot fetch lorebook entry because loadWorldInfo is unavailable.`, {
            bookName,
            uid,
        });
        return null;
    }

    try {
        const bookData = await ctx.loadWorldInfo(bookName);
        if (!isToolReadCurrent(bookName, options)) return null;
        if (!bookData?.entries) {
            console.warn(`${PATHFINDER_LOG_PREFIX} Lorebook "${bookName}" has no entries while fetching UID ${uid}.`);
            return null;
        }

        for (const entry of Object.values(bookData.entries)) {
            if (isEntryEligible(entry) && entry.uid === uid) {
                return {
                    uid: entry.uid,
                    world: entry.world || bookName,
                    comment: entry.comment || entry.key?.[0] || '',
                    content: entry.content || '',
                    key: entry.key || [],
                    keysecondary: entry.keysecondary || [],
                    selective: entry.selective ?? false,
                    selectiveLogic: entry.selectiveLogic ?? 0,
                    caseSensitive: entry.caseSensitive,
                    matchWholeWords: entry.matchWholeWords,
                    constant: entry.constant ?? false,
                    decorators: entry.decorators || [],
                    disable: entry.disable ?? false,
                };
            }
        }
        console.warn(`${PATHFINDER_LOG_PREFIX} Entry ${uid} was not found in lorebook "${bookName}".`);
    } catch (err) {
        console.warn(`[Pawthfinder] Failed to get entry ${uid} from ${bookName}:`, err);
    }

    return null;
}

/**
 * Get all entries from a lorebook with their content
 * @param {string} bookName - Lorebook name
 * @returns {Promise<Object[]>} Array of entry objects
 */
export async function getAllEntriesWithContent(bookName, options = {}) {
    if (!isToolReadCurrent(bookName, options)) return [];
    const ctx = window?.SillyTavern?.getContext?.();
    if (!ctx?.loadWorldInfo) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Cannot fetch lorebook contents because loadWorldInfo is unavailable.`, {
            bookName,
        });
        return [];
    }

    try {
        const bookData = await ctx.loadWorldInfo(bookName);
        if (!isToolReadCurrent(bookName, options)) return [];
        if (!bookData?.entries) {
            console.warn(`${PATHFINDER_LOG_PREFIX} Lorebook "${bookName}" has no entries while fetching all content.`);
            return [];
        }

        return Object.values(bookData.entries)
            .filter(isEntryEligible)
            .map(entry => ({
                uid: entry.uid,
                world: entry.world || bookName,
                comment: entry.comment || entry.key?.[0] || '',
                content: entry.content || '',
                key: entry.key || [],
                keysecondary: entry.keysecondary || [],
                selective: entry.selective ?? false,
                selectiveLogic: entry.selectiveLogic ?? 0,
                caseSensitive: entry.caseSensitive,
                matchWholeWords: entry.matchWholeWords,
                constant: entry.constant ?? false,
                decorators: entry.decorators || [],
            }));
    } catch (err) {
        console.warn(`[Pawthfinder] Failed to get entries from ${bookName}:`, err);
        return [];
    }
}

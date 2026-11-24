/**
 * Which linked lorebooks no longer exist. DOM-free and dependency-free: the chat-open warning and the
 * Scratchpad rule `card-lorebook-missing` both call it, so they cannot disagree about a link.
 */

export const LOREBOOK_LINK_KIND = Object.freeze({
    cardMain: 'card-main',
    cardExtra: 'card-extra',
    chat: 'chat',
    conversation: 'conversation',
});

/**
 * @typedef {{ kind: string, name: string, owner?: string, avatar?: string, embedded?: boolean }} LorebookLink
 */

function toKnownSet(known) {
    if (known instanceof Set) return known;
    return new Set(Array.from(known, item => String(item)));
}

/**
 * Whether a lorebook name is in a list of names. The list holds file names without the extension, and the
 * server drops trailing spaces and dots when it looks a name up, so 'Book ' finds 'Book'. Case counts.
 * @param {Iterable<string>|null|undefined} known Names that exist, or null when the list is not known
 * @param {string} name Linked name
 * @returns {boolean|null} null when the list is not known
 */
export function isKnownLorebook(known, name) {
    if (known === null || known === undefined) return null;
    const lookup = toKnownSet(known);
    if (lookup.has(name)) return true;
    const stripped = name.replace(/[. ]+$/, '');
    return stripped !== name && stripped !== '' && lookup.has(stripped);
}

/**
 * The lorebooks one card links: its main lorebook and its extra lorebooks.
 * @param {object} character Character record
 * @param {string[]|Record<string, string[]>} [extraBooks] Extra lorebooks as a list, or as World Info's per-card list keyed by file name
 * @returns {LorebookLink[]}
 */
export function cardLorebookLinks(character, extraBooks = []) {
    const avatar = String(character?.avatar ?? '');
    const filename = avatar.replace(/\.[^.]+$/, '');
    const owner = String(character?.name ?? character?.data?.name ?? '');
    const links = [];
    const main = String(character?.data?.extensions?.world ?? '');
    if (main.trim()) links.push({ kind: LOREBOOK_LINK_KIND.cardMain, name: main, owner, avatar, embedded: Boolean(character?.data?.character_book) });
    const list = Array.isArray(extraBooks)
        ? extraBooks
        : Array.isArray(extraBooks?.[filename]) ? extraBooks[filename] : [];
    for (const item of list) {
        const name = String(item ?? '');
        if (name.trim()) links.push({ kind: LOREBOOK_LINK_KIND.cardExtra, name, owner, avatar });
    }
    return links;
}

/**
 * Every lorebook link of the chat that is open.
 * @param {{ cards?: object[], charLore?: Array<{name?: string, extraBooks?: string[]}>, chatLorebook?: string, conversationOverrides?: string[] }} source
 * @returns {LorebookLink[]}
 */
export function listLorebookLinks({ cards = [], charLore = [], chatLorebook = '', conversationOverrides = [] } = {}) {
    const links = [];
    const seen = new Set();
    const add = link => {
        const key = [link.kind, link.avatar ?? '', link.name].join('\n');
        if (seen.has(key)) return;
        seen.add(key);
        links.push(link);
    };
    const lore = Array.isArray(charLore) ? charLore : [];
    for (const card of cards) {
        const filename = String(card?.avatar ?? '').replace(/\.[^.]+$/, '');
        const extra = lore.find(item => item?.name === filename)?.extraBooks;
        cardLorebookLinks(card, Array.isArray(extra) ? extra : []).forEach(add);
    }
    const chat = String(chatLorebook ?? '');
    if (chat.trim()) add({ kind: LOREBOOK_LINK_KIND.chat, name: chat });
    for (const override of Array.isArray(conversationOverrides) ? conversationOverrides : []) {
        if (String(override ?? '').trim()) add({ kind: LOREBOOK_LINK_KIND.conversation, name: String(override) });
    }
    return links;
}

/**
 * The links whose lorebook is not in the list. A list that is not known (null or undefined) finds nothing, so
 * a list that has not loaded can never produce a warning; an empty array is a known list with no lorebooks.
 * @param {LorebookLink[]} links
 * @param {Iterable<string>|null|undefined} known
 * @returns {LorebookLink[]}
 */
export function findMissingLorebookLinks(links, known) {
    if (known === null || known === undefined) return [];
    const lookup = toKnownSet(known);
    return links.filter(link => !isKnownLorebook(lookup, link.name));
}

/** Identity of one link inside one chat, for 'already told them'. */
export function lorebookLinkKey(link) {
    return [link.kind, link.avatar ?? '', link.name].join('\u0000');
}

/**
 * 'Told them already' for the chat that is open. Opening another chat (or none) starts a new round, so a chat
 * that is opened again can warn again; the same chat being refreshed or switched between modes cannot.
 */
const toldLinks = new Set();
let openChatKey = '';

/**
 * 'Said no' for the page session: links the person answered with 'Keep them' or the notice's cross. A card's
 * link belongs to the card, so it stays quiet in every chat of that card; a chat's or Conversation's own link
 * belongs to that chat. A notice that was only cleared because the chat changed is not an answer.
 */
const dismissedLinks = new Set();

const dismissalKey = (chatKey, link) => (link.kind === LOREBOOK_LINK_KIND.chat || link.kind === LOREBOOK_LINK_KIND.conversation
    ? `${chatKey}\u0001${lorebookLinkKey(link)}`
    : lorebookLinkKey(link));

/** Records that the person answered no to these links. */
export function dismissLorebookLinks(chatKey, links) {
    for (const link of links) dismissedLinks.add(dismissalKey(String(chatKey ?? ''), link));
}

/**
 * The notice on screen, so it can be taken away when the chat changes. The notice module registers one.
 * @type {{ links: LorebookLink[], clear: () => void }|null}
 */
let shownNotice = null;

export function registerLorebookNotice(notice) {
    shownNotice = notice;
}

/** Takes the notice off screen (not an answer). With a test, only when one of its links passes it. */
export function clearLorebookNotice(test) {
    const notice = shownNotice;
    if (!notice || (typeof test === 'function' && !notice.links.some(test))) return false;
    shownNotice = null;
    notice.clear();
    return true;
}

export function noteLorebookChatOpened(chatKey) {
    const key = String(chatKey ?? '');
    if (key === openChatKey) return false;
    openChatKey = key;
    toldLinks.clear();
    clearLorebookNotice();
    return true;
}

export function isLorebookChatCurrent(chatKey) {
    return String(chatKey ?? '') === openChatKey;
}

const isTold = (chatKey, link) => toldLinks.has(lorebookLinkKey(link)) || dismissedLinks.has(dismissalKey(String(chatKey ?? ''), link));

/** The links not yet told (or settled or said no to) in the chat that is open. Changes nothing. */
export function filterUntoldLorebookLinks(chatKey, links) {
    if (!isLorebookChatCurrent(chatKey)) return [];
    return links.filter(link => !isTold(chatKey, link));
}

/** Marks links as told and returns only the ones that had not been. */
export function takeUntoldLorebookLinks(chatKey, links) {
    if (!isLorebookChatCurrent(chatKey)) return [];
    const fresh = [];
    for (const link of links) {
        if (isTold(chatKey, link)) continue;
        toldLinks.add(lorebookLinkKey(link));
        fresh.push(link);
    }
    return fresh;
}

/**
 * The Conversation modules register a reader here so the chat-open check can ask whether the Conversation
 * workspace is open, which thread it shows and what lorebook overrides that thread holds, without importing them.
 * @typedef {{ key: string, overrides: string[] }} ConversationLorebooks
 */
let conversationReader = null;

/** @param {(() => ConversationLorebooks|null)|null} reader */
export function setConversationLorebookReader(reader) {
    conversationReader = typeof reader === 'function' ? reader : null;
}

/** @returns {ConversationLorebooks|null} null when the Conversation workspace is not open */
export function readConversationLorebooks() {
    try {
        const state = conversationReader?.();
        if (!state) return null;
        return { key: String(state.key ?? ''), overrides: (state.overrides ?? []).map(item => String(item ?? '')) };
    } catch {
        return null;
    }
}

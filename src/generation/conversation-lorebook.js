import path from 'node:path';
import { getCounter } from '../mewmory/tokens.js';
import { readJsonShared } from '../mewmory/store.js';
import { prepareWorldInfoEntries } from '../../public/scripts/world-info-scan-core.js';
import { formatPromptText } from '../../public/scripts/neconyan-conversation/shared-helpers.js';
import { TRANSCRIPT_MESSAGE_LIMIT } from '../../public/scripts/neconyan-conversation/constants.js';
import { readAvailableBooks, readWorldInfoScanSettings } from './world-info.js';
import { scanWorldInfo, worldInfoScanWindow } from './world-info-scan.js';

const FALLBACK_CONTEXT = 8192;
const MESSAGE_TEXT_LIMIT = 1800;

function scanLines(messages, includeNames) {
    const lines = [];
    for (const message of (Array.isArray(messages) ? messages : []).slice(-TRANSCRIPT_MESSAGE_LIMIT)) {
        const text = formatPromptText(message?.mes, MESSAGE_TEXT_LIMIT);
        if (!text) continue;
        lines.push(includeNames ? `${message.name || 'Speaker'}: ${text}` : text);
    }
    return lines.reverse();
}

function collectText(result) {
    return [
        result.worldInfoBefore,
        result.worldInfoAfter,
        ...result.EMEntries.map(entry => entry.content),
        ...result.WIDepthEntries.flatMap(entry => entry.entries),
        ...result.ANBeforeEntries,
        ...result.ANAfterEntries,
        ...Object.values(result.outletEntries).flat(),
    ].filter(value => typeof value === 'string' && value.trim()).join('\n');
}

/**
 * The lorebooks a character card links, in link order and without repeats: its main lorebook, then the extra
 * lorebooks World Info keeps for that card file (`world_info.charLore`), as Roleplay and the link warning read them.
 * Chat, persona and global lorebooks are not card links, so they never appear here.
 * @param {object} directories User directories
 * @param {object} character Normalized or raw character record
 * @param {string} [avatar] Card file name, which the normalized record does not carry
 * @returns {string[]}
 */
export function conversationCharacterLorebooks(directories, character = {}, avatar = character?.avatar || '') {
    const main = character?.extensions?.world ?? character?.data?.extensions?.world;
    let extraBooks = [];
    const file = path.parse(String(avatar || '')).name;
    if (file) {
        try {
            const saved = readJsonShared(path.join(directories.root, 'settings.json'), {});
            const charLore = { ...saved, ...saved?.world_info_settings }.world_info?.charLore;
            const found = Array.isArray(charLore) ? charLore.find(item => item?.name === file)?.extraBooks : [];
            if (Array.isArray(found)) extraBooks = found;
        } catch {
            extraBooks = [];
        }
    }
    const names = [main, ...extraBooks].filter(name => typeof name === 'string' && name.trim());
    return [...new Set(names)];
}

/**
 * Scan lorebooks against a Conversation's recent messages.
 * With a 'Lorebook Override' name, only that book is read; card, chat and global lorebooks stay out, and a missing
 * or unreadable book loads nothing: `{ name, found: false, text: '' }`, otherwise `{ name, found: true, text }`.
 * With no override ('Character default'), the speaking card's linked lorebooks are scanned together, skipping any
 * that are missing or unreadable. That returns null when the card links none, otherwise
 * `{ name, books, found, text, characterDefault: true }`, where `name` lists the books that added entries.
 * Entries follow each book's own rules and the account's World Info scan settings, as in Roleplay.
 */
export async function captureConversationLorebook({ directories, name, messages, userName = 'User', character = {}, avatar = character?.avatar || '', maxContext, random = Math.random }) {
    const bookName = typeof name === 'string' ? name.trim() : '';
    if (!bookName) return captureCharacterLorebooks({ directories, messages, userName, character, avatar, maxContext, random });
    const missing = { name: bookName, found: false, text: '' };
    try {
        const book = readAvailableBooks(directories, [bookName])[bookName];
        if (!book) return missing;
        const { text } = await scanBooks({ directories, books: { [bookName]: book }, type: 'globalLore', messages, userName, character, avatar, maxContext, random });
        return { name: bookName, found: true, text };
    } catch {
        return missing;
    }
}

async function captureCharacterLorebooks({ directories, messages, userName, character, avatar, maxContext, random }) {
    const linked = conversationCharacterLorebooks(directories, character, avatar);
    if (!linked.length) return null;
    const books = {};
    for (const name of linked) {
        try {
            const book = readAvailableBooks(directories, [name])[name];
            if (book) books[name] = book;
        } catch {
            // One unusable linked book must not hide the others or block the reply.
        }
    }
    const read = Object.keys(books);
    const empty = { name: '', books: read, found: read.length > 0, text: '', characterDefault: true };
    if (!read.length) return empty;
    try {
        const { text, contributors } = await scanBooks({ directories, books, type: 'characterLore', messages, userName, character, avatar, maxContext, random });
        if (!text) return empty;
        return { ...empty, name: read.filter(book => contributors.has(book)).join(', '), text };
    } catch {
        return empty;
    }
}

async function scanBooks({ directories, books, type, messages, userName, character, avatar, maxContext, random }) {
    const charName = character.name || 'Character';
    const substitute = value => String(value).replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
    const lore = Object.entries(books).flatMap(([bookName, book]) => Object.entries(book.data.entries).map(([key, entry]) => {
        const { uid = Number.isNaN(Number(key)) ? key : Number(key), ...rest } = entry;
        return { uid, world: bookName, ...rest };
    }));
    const settings = readWorldInfoScanSettings(directories);
    const entries = prepareWorldInfoEntries({ [type]: lore }, Number(settings.world_info_character_strategy ?? 1));
    const lines = scanLines(messages, settings.world_info_include_names !== false);
    const limit = Number.isSafeInteger(maxContext) && maxContext > 0 ? maxContext : FALLBACK_CONTEXT;
    const { count } = await getCounter('o200k_base');
    const contributors = new Set();
    const result = await scanWorldInfo({
        entries,
        chat: lines.slice(0, worldInfoScanWindow(entries, settings)),
        chatLength: lines.length,
        settings,
        global: {
            trigger: 'normal',
            characterFile: path.parse(String(avatar || '')).name,
            characterTags: [],
            inject: [],
            characterDescription: character.description || '',
            characterPersonality: character.personality || '',
            scenario: character.scenario || '',
            creatorNotes: character.creator_notes || '',
        },
        maxContext: limit,
        countTokens: count,
        substitute,
        transform: (value, entry) => {
            const content = substitute(value);
            const shown = (entry?.position >= 0 && entry.position <= 6) || (entry?.position === 7 && entry.outletName);
            if (content.trim() && shown) contributors.add(entry.world);
            return content;
        },
        random,
    });
    return { text: collectText(result), contributors };
}

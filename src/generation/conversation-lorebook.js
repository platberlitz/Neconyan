import { getCounter } from '../mewmory/tokens.js';
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
 * Scan the one lorebook named by a Conversation's 'Lorebook Override' against its recent messages.
 * Only that book is read; card, chat and global lorebooks stay out. Returns null when no override is set,
 * `{ name, found: false, text: '' }` when the book is missing or unreadable, otherwise `{ name, found: true, text }`.
 * Entries follow the book's own rules and the account's World Info scan settings, as in Roleplay.
 */
export async function captureConversationLorebook({ directories, name, messages, userName = 'User', character = {}, maxContext, random = Math.random }) {
    const bookName = typeof name === 'string' ? name.trim() : '';
    if (!bookName) return null;
    const missing = { name: bookName, found: false, text: '' };
    try {
        const book = readAvailableBooks(directories, [bookName])[bookName];
        if (!book) return missing;
        const charName = character.name || 'Character';
        const substitute = value => String(value).replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
        const lore = Object.entries(book.data.entries).map(([key, entry]) => {
            const { uid = Number.isNaN(Number(key)) ? key : Number(key), ...rest } = entry;
            return { uid, world: bookName, ...rest };
        });
        const settings = readWorldInfoScanSettings(directories);
        const entries = prepareWorldInfoEntries({ globalLore: lore }, Number(settings.world_info_character_strategy ?? 1));
        const lines = scanLines(messages, settings.world_info_include_names !== false);
        const limit = Number.isSafeInteger(maxContext) && maxContext > 0 ? maxContext : FALLBACK_CONTEXT;
        const { count } = await getCounter('o200k_base');
        const result = await scanWorldInfo({
            entries,
            chat: lines.slice(0, worldInfoScanWindow(entries, settings)),
            chatLength: lines.length,
            settings,
            global: {
                trigger: 'normal',
                characterFile: character.avatar || '',
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
            transform: substitute,
            random,
        });
        return { name: bookName, found: true, text: collectText(result) };
    } catch {
        return missing;
    }
}

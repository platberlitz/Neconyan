import {
    getActiveCompanionResults,
    holdsReadableCompanionResults,
    isSuppressedCompanionResult,
} from '../extensions/in-chat-agents/companion/companion-shared.js';

export const COMPANION_NOTES_HEADING = '## Companion notes';
export const COMPANION_NOTES_MAX_BYTES = 24 * 1024;
export const COMPANION_NOTE_MAX_BYTES = 4 * 1024;
export const COMPANION_NOTES_INTRO = 'Notes written by Companion agents about the shared messages (current swipes only). They are read-only and are not part of the story text.';
export const COMPANION_NOTES_OMITTED = 'Older companion notes omitted to stay within the size limit.';
const NOTE_SHORTENED = '[Note shortened to stay within the size limit.]';

function byteLength(text) {
    return new TextEncoder().encode(text).length;
}

function clip(text, maxBytes) {
    if (byteLength(text) <= maxBytes) return text;
    let low = 0;
    let high = Math.min(text.length, maxBytes);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
        else high = middle - 1;
    }
    let end = low;
    // Do not split a surrogate pair.
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return text.slice(0, end).trimEnd();
}

/** Note text without markup that does nothing for a reader and without headings that would split the shared context. */
export function cleanCompanionNote(content) {
    return String(content ?? '')
        .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '')
        .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, '')
        .replace(/\r\n?/g, '\n')
        .replace(/^([ \t]*)(#{1,6})(?=[ \t]|$)/gm, '$1\\$2')
        .trim();
}

function isCompletedNote(agentId, result) {
    return Boolean(result && typeof result === 'object'
        && result.status === 'done'
        && typeof result.content === 'string'
        && result.content.trim()
        && !isSuppressedCompanionResult(agentId, result));
}

function speakerName(message, fallback) {
    return String(fallback || message?.name || (message?.is_user ? 'User' : 'Character'));
}

/**
 * Lists the completed Companion notes on the messages a Roleplay context
 * shares. Only the current version of a message counts, so notes on an
 * alternative swipe stay out. Hidden messages that are not shared add only the
 * notes their Companion keeps in chat history while the message is hidden, and
 * never their story text.
 */
export function collectCompanionNotes(chat, kept, { includeHidden = false, picked = false } = {}) {
    const list = Array.isArray(chat) ? chat : [];
    const shared = new Map();
    for (const item of Array.isArray(kept) ? kept : []) {
        if (!Number.isInteger(item?.number) || (item.swipe && !item.current)) continue;
        if (!shared.has(item.number)) shared.set(item.number, item);
    }
    const sources = [...shared.values()].map(item => ({ number: item.number, name: item.name, hiddenOnly: false }));
    if (!includeHidden && !picked && shared.size) {
        const numbers = [...shared.keys()];
        const earliest = Math.min(...numbers);
        const visibleBefore = list.slice(0, earliest).some(message => message && !message.is_system);
        const start = visibleBefore ? earliest : 0;
        for (let number = start; number < list.length; number++) {
            if (list[number]?.is_system && !shared.has(number)) sources.push({ number, name: '', hiddenOnly: true });
        }
    }
    sources.sort((a, b) => a.number - b.number);

    const notes = [];
    for (const source of sources) {
        const message = list[source.number];
        if (!holdsReadableCompanionResults(message)) continue;
        for (const [agentId, result] of Object.entries(getActiveCompanionResults(message))) {
            if (!isCompletedNote(agentId, result)) continue;
            if (source.hiddenOnly && result.keepInChatHistoryWhenHostHidden !== true) continue;
            const content = cleanCompanionNote(result.content);
            if (!content) continue;
            notes.push({
                number: source.number,
                speaker: speakerName(message, source.name),
                agent: String(result.agentName || '').trim() || agentId,
                tag: typeof result.agentCategory === 'string' ? result.agentCategory.trim() : '',
                hidden: source.hiddenOnly,
                content,
            });
        }
    }
    return notes;
}

function noteBlock(note) {
    const tag = note.tag ? ` [${note.tag}]` : '';
    const title = note.hidden
        ? `### ${note.speaker}: ${note.agent}${tag} (on hidden message #${note.number})`
        : `### #${note.number} ${note.speaker}: ${note.agent}${tag}`;
    const limit = Math.max(0, COMPANION_NOTE_MAX_BYTES - byteLength(title) - 1);
    const content = byteLength(note.content) > limit
        ? `${clip(note.content, Math.max(0, limit - byteLength(NOTE_SHORTENED) - 1))}\n${NOTE_SHORTENED}`
        : note.content;
    return `${title}\n${content}`;
}

/**
 * The '## Companion notes' section, newest notes first to keep. Notes that do
 * not fit are dropped from the oldest end and the section says so. An empty
 * string means there is nothing to share.
 */
export function formatCompanionNotes(notes, maxBytes = COMPANION_NOTES_MAX_BYTES) {
    const list = Array.isArray(notes) ? notes : [];
    const budget = Math.min(COMPANION_NOTES_MAX_BYTES, Math.max(0, Number(maxBytes) || 0));
    if (!list.length) return { text: '', count: 0, omitted: 0 };
    const fixed = byteLength(COMPANION_NOTES_HEADING) + 2 + byteLength(COMPANION_NOTES_INTRO);
    const omittedBytes = 2 + byteLength(COMPANION_NOTES_OMITTED);
    const blocks = [];
    let used = fixed;
    for (let index = list.length - 1; index >= 0; index--) {
        const block = noteBlock(list[index]);
        const bytes = 2 + byteLength(block);
        const reserve = index > 0 ? omittedBytes : 0;
        if (used + bytes + reserve > budget) break;
        blocks.unshift(block);
        used += bytes;
    }
    if (!blocks.length) return { text: '', count: 0, omitted: list.length };
    const omitted = list.length - blocks.length;
    return {
        text: [
            COMPANION_NOTES_HEADING,
            COMPANION_NOTES_INTRO,
            ...(omitted ? [COMPANION_NOTES_OMITTED] : []),
            ...blocks,
        ].join('\n\n'),
        count: blocks.length,
        omitted,
    };
}

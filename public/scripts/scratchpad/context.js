import { chat, chat_metadata, characters, getCurrentChatId, name1, substituteParams, this_chid } from '../../script.js';
import { getGroupMembers, groups, selected_group } from '../group-chats.js';
import { buildAssistantKnowledge } from '../neconyan-assistant-knowledge.js';
import {
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadKey,
    getCurrentCharAvatar,
} from '../neconyan-conversation/context.js';
import { composeConversationPersonaDescription, getConversationPersonaName } from '../neconyan-conversation/personas.js';
import { getSettings as getConversationSettings } from '../neconyan-conversation/settings-store.js';
import { conversationState } from '../neconyan-conversation/state.js';
import { power_user } from '../power-user.js';
import { getTokenCountAsync } from '../tokenizers.js';
import { loadWorldInfo, selected_world_info, world_info } from '../world-info.js';

const MAX_CONTEXT_BYTES = 1_400_000;
const MAX_CARD_FIELD = 8_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_LORE_ENTRIES = 40;
const MAX_LORE_CHARS = 24_000;
const LORE_SCAN_MESSAGES = 5;
const CARD_FIELDS = [
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
];

function clip(text, limit) {
    const value = String(text ?? '');
    return value.length > limit ? `${value.slice(0, limit)}\n[...]` : value;
}

function clipLabel(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function characterByAvatar(avatar) {
    return characters.find(item => item?.avatar === avatar) || null;
}

/**
 * Describes the chat that is open right now, or null when no chat is open.
 * Scratchpad sessions are stored against this key, so switching chats never
 * mixes two stories together.
 */
export function currentSource() {
    if (conversationState.conversationWorkspaceOpen) {
        const avatar = getCurrentCharAvatar();
        if (!avatar) return null;
        const groupId = getConversationGroupIdForAvatar(avatar) || '';
        const branch = getActiveConversationBranch(avatar, { create: false, groupId });
        if (!branch?.id) return null;
        const group = groupId ? getConversationGroupById(groupId) : null;
        const name = group?.name || characterByAvatar(avatar)?.name || 'Conversation';
        return {
            kind: 'conversation',
            key: `conversation:${getConversationThreadKey(avatar, groupId)}:${branch.id}`,
            label: clipLabel(`${name} - ${branch.name || 'Conversation'}`),
            avatar,
            groupId,
            branchId: branch.id,
            personaId: getConversationPersonaId(),
        };
    }

    const chatId = getCurrentChatId();
    if (!chatId) return null;
    if (selected_group) {
        const group = groups.find(item => item.id === selected_group);
        return {
            kind: 'roleplay',
            key: `group:${selected_group}:${chatId}`,
            label: clipLabel(`${group?.name || 'Group chat'} - ${chatId}`),
            groupId: selected_group,
            chatId,
        };
    }
    const character = characters[this_chid];
    if (!character?.avatar) return null;
    return {
        kind: 'roleplay',
        key: `character:${character.avatar}:${chatId}`,
        label: clipLabel(`${character.name} - ${chatId}`),
        avatar: character.avatar,
        chatId,
    };
}

export function wireSource(source) {
    return source ? { kind: source.kind, key: source.key, label: source.label } : null;
}

export function isCurrentSource(source) {
    const live = currentSource();
    return Boolean(source && live && live.key === source.key);
}

function requireCurrentSource(source) {
    if (!isCurrentSource(source)) throw new Error('Open the chat this Scratchpad belongs to before sending.');
}

export function sourceUserName(source) {
    return source?.kind === 'conversation' ? getConversationPersonaName(source.personaId, name1) : name1;
}

/** An empty name means the chat uses the active connection rather than a saved profile. */
export function sourceConnectionProfile(source) {
    return source?.kind === 'conversation'
        ? String(getConversationSettings(source.avatar, source).connection_profile || '').trim()
        : '';
}

/** Characters taking part in the source chat, as full character objects. */
export function sourceCharacters(source) {
    if (!source) return [];
    if (source.kind === 'conversation') {
        if (source.groupId) {
            const members = getConversationGroupById(source.groupId)?.members || [];
            return members.map(characterByAvatar).filter(Boolean);
        }
        return [characterByAvatar(source.avatar)].filter(Boolean);
    }
    if (source.groupId) return getGroupMembers(source.groupId).filter(Boolean);
    return [characterByAvatar(source.avatar)].filter(Boolean);
}

/** The live message list of the source chat, numbered the way Scratchpad shows them. */
export function sourceMessages(source) {
    if (!source) return [];
    if (source.kind === 'conversation') {
        const branch = getActiveConversationBranch(source.avatar, { ...source, create: false });
        const list = Array.isArray(branch?.messages) ? branch.messages : [];
        return list.map((message, index) => ({
            ref: String(message?.id ?? `i${index}`),
            number: index,
            name: message?.role === 'user' ? (message?.name || sourceUserName(source)) : (message?.name || (message?.role === 'system' ? 'System' : 'Character')),
            text: String(message?.mes ?? message?.content ?? ''),
            hidden: false,
            isUser: message?.role === 'user',
        }));
    }
    return chat.map((message, index) => ({
        ref: String(index),
        number: index,
        name: message?.name || (message?.is_user ? name1 : 'Character'),
        text: String(message?.mes ?? ''),
        hidden: Boolean(message?.is_system),
        isUser: Boolean(message?.is_user),
    }));
}

function selectMessages(messages, settings) {
    const picked = Array.isArray(settings?.picked) ? settings.picked : [];
    if (picked.length) {
        const wanted = new Set(picked);
        return { messages: messages.filter(item => wanted.has(item.ref)), picked: true };
    }
    const depth = Math.max(0, Number(settings?.depth) || 0);
    const pool = settings?.include?.hidden ? messages : messages.filter(item => !item.hidden);
    return { messages: depth ? pool.slice(-depth) : [], picked: false };
}

function keyMatches(key, haystack, lowerHaystack) {
    const value = String(key ?? '').trim();
    if (!value) return false;
    const regex = /^\/(.+)\/([a-z]*)$/s.exec(value);
    if (regex) {
        try {
            return new RegExp(regex[1], regex[2].replace(/[gy]/g, '')).test(haystack);
        } catch {
            return false;
        }
    }
    return lowerHaystack.includes(value.toLowerCase());
}

export function loreOverrideKey(entry) {
    return `${entry.world}::${entry.uid}`;
}

function sourceLorebooks(source) {
    const books = [];
    for (const character of sourceCharacters(source)) {
        books.push(character?.data?.extensions?.world);
        const filename = character.avatar?.replace(/\.[^.]+$/, '');
        const extra = world_info.charLore?.find(item => item.name === filename)?.extraBooks;
        if (Array.isArray(extra)) books.push(...extra);
    }
    books.push(...selected_world_info, power_user.persona_description_lorebook);
    books.push(source?.kind === 'conversation'
        ? getConversationSettings(source.avatar, source).lorebook_override
        : chat_metadata.world_info);
    return [...new Set(books.filter(book => typeof book === 'string' && book.trim()))];
}

export function loreScanText({ source, settings, pendingText = '', sessionText = '' }) {
    return [
        ...selectMessages(sourceMessages(source), settings).messages.slice(-LORE_SCAN_MESSAGES).map(item => item.text),
        sessionText,
        pendingText,
    ].join('\n');
}

/**
 * Picks the lorebook entries to share: entries marked 'always', constant
 * entries, and entries whose keywords appear in the recent chat or the
 * user's new message. Entries marked 'never' are left out.
 */
export async function collectLore({ source, settings, scanText = '' }) {
    requireCurrentSource(source);
    const loaded = await Promise.all(sourceLorebooks(source).map(async world => {
        try {
            const data = await loadWorldInfo(world);
            if (!data?.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) return null;
            const entries = Object.entries(data.entries)
                .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
                .map(([uid, entry]) => ({ ...entry, uid: entry.uid ?? uid, world }));
            return { world, entries };
        } catch (error) {
            console.warn('Scratchpad could not read lorebook', world, error);
            return null;
        }
    }));
    requireCurrentSource(source);
    const books = loaded.filter(Boolean).map(book => book.world);
    const usable = loaded.filter(Boolean).flatMap(book => book.entries)
        .filter(entry => entry && !entry.disable && !entry.agentBlacklisted && entry.world !== undefined && entry.uid !== undefined);
    const overrides = settings?.loreOverrides || {};
    const lower = scanText.toLowerCase();
    const listed = usable.map(entry => {
        const key = loreOverrideKey(entry);
        const override = overrides[key] || null;
        let reason = null;
        if (override === 'always') reason = 'always';
        else if (override === 'never') reason = null;
        else if (entry.constant) reason = 'constant';
        else if (Array.isArray(entry.key) && entry.key.some(item => keyMatches(item, scanText, lower))) reason = 'keyword';
        if (settings?.include?.lore === false) reason = null;
        return {
            key,
            world: String(entry.world),
            uid: entry.uid,
            title: String(entry.comment || (entry.key || [])[0] || `Entry ${entry.uid}`),
            keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
            content: String(entry.content ?? ''),
            constant: Boolean(entry.constant),
            override,
            reason,
            included: false,
        };
    });
    const rank = { always: 0, constant: 1, keyword: 2 };
    const candidates = listed.filter(item => item.reason).sort((a, b) => rank[a.reason] - rank[b.reason]);
    let used = 0;
    let count = 0;
    for (const item of candidates) {
        if (count >= MAX_LORE_ENTRIES) break;
        const size = item.content.length;
        if (used + size > MAX_LORE_CHARS && item.reason !== 'always') continue;
        item.included = true;
        used += size;
        count += 1;
    }
    return { books, entries: listed };
}

function formatLore(lore, macros) {
    const lines = [];
    if (lore.books.length) lines.push(`Lorebooks active in this chat: ${lore.books.join(', ')}`);
    for (const entry of lore.entries.filter(item => item.included)) {
        lines.push([
            `### ${entry.title}`,
            `book: ${entry.world} | uid: ${entry.uid}${entry.keys.length ? ` | keys: ${entry.keys.join(', ')}` : ''}${entry.constant ? ' | always active' : ''}`,
            substituteParams(entry.content, macros),
        ].join('\n'));
    }
    return lines.join('\n\n');
}

function formatCharacter(character, source, macros) {
    const name = character.name || 'Character';
    const fields = CARD_FIELDS
        .map(([field, label]) => {
            const raw = String(character?.data?.[field] ?? character?.[field] ?? '').trim();
            if (!raw) return '';
            const text = substituteParams(raw, { ...macros, name2Override: name });
            return `${label}:\n${clip(text, MAX_CARD_FIELD)}`;
        })
        .filter(Boolean);
    const scope = source.groupId ? ' (group member)' : '';
    return [`## Character: ${name}${scope}`, ...fields].join('\n');
}

/**
 * Builds the story context Scratchpad sends with a message. Nothing here is
 * saved; the text is rebuilt from the open chat each time.
 */
export async function buildContext({ source, settings, pendingText = '', sessionText = '' }) {
    requireCurrentSource(source);
    const include = settings?.include || {};
    const all = sourceMessages(source);
    const selection = selectMessages(all, settings);
    const people = sourceCharacters(source);
    const names = { user: sourceUserName(source), character: people.map(item => item.name).filter(Boolean).join(', ') };
    const macros = { name1Override: names.user, name2Override: names.character, replaceCharacterCard: false };
    const sections = [];

    sections.push([
        `Chat: ${source.label}`,
        `Mode: ${source.kind === 'conversation' ? 'Conversation (messaging-style chat)' : 'Roleplay'}`,
        `User: ${names.user}`,
    ].join('\n'));

    if (include.persona) {
        const description = source.kind === 'conversation'
            ? composeConversationPersonaDescription(source.personaId, source)
            : power_user.persona_description;
        const persona = substituteParams(String(description ?? '').trim(), macros);
        if (persona) sections.push(`## ${names.user} (the user's persona)\n${clip(persona, MAX_CARD_FIELD)}`);
    }

    if (include.card) {
        for (const character of people) sections.push(formatCharacter(character, source, macros));
    }

    if (include.authorsNote && source.kind === 'roleplay') {
        const note = substituteParams(String(chat_metadata?.note_prompt ?? '').trim(), macros);
        if (note) sections.push(`## Author's Note\n${clip(note, MAX_CARD_FIELD)}`);
    }

    let lore = { books: [], entries: [] };
    if (include.lore) {
        const scanText = loreScanText({ source, settings, sessionText, pendingText });
        lore = await collectLore({ source, settings, scanText });
        const text = formatLore(lore, macros);
        if (text) sections.push(`## Lorebooks\n${text}`);
    }

    const heading = selection.picked
        ? `## Picked messages (${selection.messages.length} of ${all.length})`
        : `## Latest messages (${selection.messages.length} of ${all.length})`;
    const lines = selection.messages.map(item => `#${item.number} ${item.name}${item.hidden ? ' (hidden)' : ''}:\n${clip(item.text, MAX_MESSAGE_CHARS)}`);
    sections.push([heading, ...lines].join('\n\n'));

    let text = sections.join('\n\n');
    const encoded = new TextEncoder().encode(text);
    if (encoded.length > MAX_CONTEXT_BYTES) text = `${new TextDecoder().decode(encoded.subarray(0, MAX_CONTEXT_BYTES - 10)).replace(/\uFFFD$/, '')}\n[...]`;
    requireCurrentSource(source);

    const loreBooks = include.lore ? lore.books : [];
    return {
        text,
        names,
        lore,
        messageCount: selection.messages.length,
        totalMessages: all.length,
        picked: selection.picked,
        capabilities: {
            lore: loreBooks.length > 0,
            character: people.length > 0,
            chat: source.kind === 'roleplay',
            members: source.groupId ? people.map(item => item.name).filter(Boolean) : [],
        },
    };
}

export async function estimateTokens(text) {
    try {
        return await getTokenCountAsync(text);
    } catch {
        return Math.ceil(new TextEncoder().encode(text).length / 4);
    }
}

/** App help for questions about Neconyan itself, shared with the bundled assistants. */
export async function buildHelp({ assistant, gender, text }) {
    try {
        const result = await buildAssistantKnowledge({
            character: { data: { extensions: { neconyan_assistant: { id: `${assistant}-${gender}` } } } },
            messages: [{ role: 'user', content: text }],
            maxTokens: 4096,
        });
        return result?.status === 'matched' ? String(result.text || '') : '';
    } catch {
        return '';
    }
}

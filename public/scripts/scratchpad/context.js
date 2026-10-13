import { chat, chat_metadata, characters, getCurrentChatId, name1, substituteParams, this_chid, unshallowCharacter } from '../../script.js';
import { getGroupMembers, groups, selected_group } from '../group-chats.js';
import { buildAssistantKnowledge } from '../neconyan-assistant-knowledge.js';
import {
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadKey,
} from '../neconyan-conversation/context.js';
import { composeConversationPersonaDescription, getConversationPersonaName } from '../neconyan-conversation/personas.js';
import { getSettings as getConversationSettings } from '../neconyan-conversation/settings-store.js';
import { conversationState } from '../neconyan-conversation/state.js';
import { power_user } from '../power-user.js';
import { user_avatar } from '../personas.js';
import { t } from '../i18n.js';
import { getRoleplaySourceId } from '../roleplay-save-chain.js';
import { getTokenCountAsync } from '../tokenizers.js';
import { loadWorldInfo, selected_world_info, world_info } from '../world-info.js';
import { readCurrentPreset } from './preset.js';
import { sameSourceContext } from './source.js';

const MAX_CONTEXT_BYTES = 1_400_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_LORE_ENTRIES = 40;
const MAX_LORE_CHARS = 24_000;
const LORE_SCAN_MESSAGES = 5;
let notebookSource = null;

/** Note discussions have their own sessions and never borrow the open story's context. */
export function setNotebookSource(note = null) {
    notebookSource = note ? { kind: 'notebook', key: `notebook:${note.notebookId}:${note.noteId}`,
        label: clipLabel(note.title || 'Note discussion'), notebookId: note.notebookId, noteId: note.noteId } : null;
}
const CARD_FIELDS = [
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
    ['first_mes', 'First message'],
    ['alternate_greetings', 'Alternate greetings'],
    ['group_only_greetings', 'Group-only greetings'],
    ['mes_example', 'Example messages'],
    ['creator_notes', 'Creator\'s notes'],
    ['system_prompt', 'System prompt'],
    ['post_history_instructions', 'Post-history instructions'],
];
const CARD_TOP_LEVEL_FIELDS = { creator_notes: 'creatorcomment' };

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
 * Describes the visible chat, or General when no story chat is visible.
 * The key guards live context; the scope shares sessions across a character's chats.
 */
export function currentSource() {
    if (notebookSource) return notebookSource;
    if (globalThis.document?.body?.classList.contains('neconyan-home-visible')) return generalSource({ personaId: homePersonaIsLocked() ? power_user.default_persona || '' : user_avatar || '' });
    if (conversationState.conversationWorkspaceOpen) {
        const avatar = conversationState.conversationSelectedAvatar || '';
        if (!avatar) return generalSource();
        const groupId = getConversationGroupIdForAvatar(avatar) || '';
        const branch = getActiveConversationBranch(avatar, { create: false, groupId });
        if (!branch?.id) return characterByAvatar(avatar)
            ? generalSource({ avatar, contextMode: 'conversation', personaId: getConversationPersonaId() }) : generalSource();
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
            scope: { kind: groupId ? 'group' : 'character', id: groupId || avatar },
        };
    }

    const chatId = getCurrentChatId();
    const character = characters[this_chid];
    if (!chatId) return generalSource({ avatar: selected_group ? '' : character?.avatar });
    if (selected_group) {
        const group = groups.find(item => item.id === selected_group);
        const id = getRoleplaySourceId({ group: true, chat: chatId });
        const legacyKey = `group:${selected_group}:${chatId}`;
        return {
            kind: 'roleplay',
            key: id ? `roleplay:${id}:group:${selected_group}` : legacyKey,
            ...(id ? { legacyKey } : {}),
            label: clipLabel(`${group?.name || 'Group chat'} - ${chatId}`),
            groupId: selected_group,
            chatId,
            scope: { kind: 'group', id: String(selected_group) },
        };
    }
    if (!character?.avatar) return generalSource();
    const id = getRoleplaySourceId({ group: false, avatar: character.avatar, chat: chatId });
    const legacyKey = `character:${character.avatar}:${chatId}`;
    return {
        kind: 'roleplay',
        key: id ? `roleplay:${id}` : legacyKey,
        ...(id ? { legacyKey } : {}),
        label: clipLabel(`${character.name} - ${chatId}`),
        avatar: character.avatar,
        chatId,
        scope: { kind: 'character', id: character.avatar },
    };
}

function generalSource({ avatar = '', contextMode = 'roleplay', personaId = user_avatar || '' } = {}) {
    return { kind: 'general', key: 'general', label: t`General Scratchpad`, contextMode, personaId,
        ...(characterByAvatar(avatar) ? { avatar } : {}) };
}

function homePersonaIsLocked() {
    if (!globalThis.document?.body?.classList.contains('neconyan-home-visible') || !user_avatar || (!getCurrentChatId() && !chat.length)) return false;
    if (chat_metadata.persona === user_avatar) return true;
    const character = characters[this_chid]?.avatar;
    return power_user.persona_descriptions?.[user_avatar]?.connections?.some(connection =>
        connection.type === 'character' && connection.id === character || connection.type === 'group' && String(connection.id) === String(selected_group)) || false;
}

export function wireSource(source) {
    return source ? { kind: source.kind, key: source.key, label: source.label, ...(source.legacyKey ? { legacyKey: source.legacyKey } : {}), ...(source.scope ? { scope: source.scope } : {}),
        ...(source.kind === 'general' ? Object.fromEntries(['avatar', 'contextMode', 'personaId'].filter(field => source[field] !== undefined).map(field => [field, source[field]])) : {}) } : null;
}

export function sameChat(source, other) {
    return sameSourceContext(source, other);
}

export function picksMatchSource(settings, source) {
    return !settings.pickedSource || sameChat(settings.pickedSource, source);
}

export function isCurrentSource(source) {
    const live = currentSource();
    return sameSourceContext(source, live);
}

function requireCurrentSource(source) {
    if (!isCurrentSource(source)) throw new Error(t`The Scratchpad context changed. Return to it before sending.`);
}

export function sourceUserName(source) {
    if (source?.kind === 'general' && source.contextMode !== 'conversation' && homePersonaIsLocked()) return String(power_user.personas?.[source.personaId] || 'User');
    return source?.kind === 'conversation' || source?.contextMode === 'conversation' ? getConversationPersonaName(source.personaId, name1) : name1;
}

function sourcePersonaDescription(source) {
    if (source.kind === 'conversation' || source.contextMode === 'conversation') return composeConversationPersonaDescription(source.personaId, source);
    if (source.kind !== 'general') return power_user.persona_description;
    const descriptor = power_user.persona_descriptions?.[source.personaId];
    if (homePersonaIsLocked()) return descriptor?.description || '';
    return descriptor ? descriptor.description ?? '' : power_user.persona_description;
}

/** An empty name means the chat uses the active connection rather than a saved profile. */
export function sourceConnectionProfile(source) {
    return source?.kind === 'conversation'
        ? String(getConversationSettings(source.avatar, source).connection_profile || '').trim()
        : '';
}

/** Characters taking part in the source chat, as full character objects. */
export function sourceCharacters(source) {
    if (!source || source.kind === 'notebook') return [];
    if (source.kind === 'general') return [characterByAvatar(source.avatar)].filter(Boolean);
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
    if (!source || source.kind === 'notebook' || source.kind === 'general') return [];
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
    return chat.map((message, index) => {
        const item = {
            ref: String(index),
            number: index,
            name: message?.name || (message?.is_user ? name1 : 'Character'),
            text: String(message?.mes ?? ''),
            hidden: Boolean(message?.is_system),
            isUser: Boolean(message?.is_user),
        };
        const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
        const current = Number.isInteger(message?.swipe_id) && message.swipe_id >= 0 && message.swipe_id < swipes.length
            ? message.swipe_id : swipes.indexOf(item.text);
        return { ...item, swipes: swipes.flatMap((text, swipe) => typeof text !== 'string' ? [] : [{
            ...item, ref: `${item.ref}:swipe:${swipe}`, messageRef: item.ref,
            swipe: swipe + 1, swipeCount: swipes.length, current: swipe === current,
            text: swipe === current ? item.text : text,
        }]) };
    });
}

function selectMessages(messages, settings, source) {
    const picked = Array.isArray(settings?.picked) ? settings.picked : [];
    if (picked.length) {
        if (!picksMatchSource(settings, source)) return { messages: [], picked: true };
        const wanted = new Set(picked);
        return { messages: messages.flatMap(item => {
            const swipes = (item.swipes ?? []).filter(swipe => wanted.has(swipe.ref));
            const current = wanted.has(item.ref) && !swipes.some(swipe => swipe.current);
            return [...(current ? [item] : []), ...swipes];
        }), picked: true };
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
    if (source?.kind === 'general') return [];
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
        ...selectMessages(sourceMessages(source), settings, source).messages.slice(-LORE_SCAN_MESSAGES).map(item => item.text),
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
    if (source.kind === 'notebook' || source.kind === 'general') return { books: [], entries: [] };
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

function cardText(character, field) {
    const data = character?.data?.[field];
    if (typeof data === 'string' && data.trim()) return data.trim();
    return String(character?.[CARD_TOP_LEVEL_FIELDS[field] || field] ?? '').trim();
}

function cardList(value) {
    return Array.isArray(value) ? value.map(item => String(item ?? '').trim()).filter(Boolean) : [];
}

function cardField(character, field, label) {
    if (field.endsWith('_greetings')) {
        const greetings = cardList(character?.data?.[field]);
        if (!greetings.length) return '';
        return [`### ${label} [${field}] (${greetings.length})`, ...greetings.map((text, index) => `Greeting ${index + 1}:\n${text}`)].join('\n\n');
    }
    const text = cardText(character, field);
    return text ? `### ${label} [${field}]\n${text}` : '';
}

/**
 * Card fields are shared whole and exactly as saved, macros included, because
 * Scratchpad's card edits replace a whole field and must keep what it does not change.
 */
function formatCharacter(character, source) {
    const name = character.name || 'Character';
    const data = character?.data || {};
    const tags = cardList(Array.isArray(character?.tags) ? character.tags : data.tags);
    const filename = character.avatar?.replace(/\.[^.]+$/, '');
    const extraBooks = cardList(world_info.charLore?.find(item => item.name === filename)?.extraBooks);
    const depthPrompt = String(data.extensions?.depth_prompt?.prompt ?? '').trim();
    const talkativeness = data.extensions?.talkativeness ?? character?.talkativeness;
    const details = [
        data.creator ? `Creator: ${data.creator}` : '',
        data.character_version ? `Version: ${data.character_version}` : '',
        tags.length ? `Tags [tags]: ${tags.join(', ')}` : '',
        data.extensions?.world ? `Linked lorebook: ${data.extensions.world}` : '',
        extraBooks.length ? `Extra lorebooks: ${extraBooks.join(', ')}` : '',
        source.groupId && talkativeness !== undefined && talkativeness !== '' ? `Talkativeness: ${talkativeness}` : '',
    ].filter(Boolean);
    const fields = CARD_FIELDS.map(([field, label]) => cardField(character, field, label)).filter(Boolean);
    if (depthPrompt) {
        const depth = data.extensions.depth_prompt.depth ?? 4;
        const role = data.extensions.depth_prompt.role || 'system';
        fields.push(`### Character's note (inserted at depth ${depth} as ${role})\n${depthPrompt}`);
    }
    if (character.shallow) fields.push('(Only part of this card could be loaded, so some fields may be missing.)');
    const scope = source.groupId ? ' (group member)' : '';
    return [[`## Character: ${name}${scope}`, ...details].join('\n'), ...fields].join('\n\n');
}

const PRESET_SLOT_SOURCES = {
    charDescription: 'the character card',
    charPersonality: 'the character card',
    scenario: 'the character card',
    dialogueExamples: 'the character card\'s example messages',
    personaDescription: 'the user\'s persona',
    worldInfoBefore: 'lorebooks',
    worldInfoAfter: 'lorebooks',
    chatHistory: 'the chat messages',
};

/**
 * The preset is its own section so its instructions are never mixed up with the
 * card, persona or lorebooks. Text stays exactly as saved, so no card text fills in.
 */
export function formatPreset(preset) {
    const name = preset?.name || 'Unnamed preset';
    const modules = Array.isArray(preset?.modules) ? preset.modules : [];
    const lines = [
        `## Current preset: ${name}`,
        [
            preset?.api ? `API: ${preset.api}` : '',
            `Modules: ${modules.filter(item => item.enabled).length} on, ${modules.filter(item => !item.enabled).length} off`,
        ].filter(Boolean).join(' | '),
        'This is the generation preset, shared separately from the character cards, persona and lorebooks. Modules are listed in prompt order and marked [on] or [off]; only [on] modules are sent when the story generates. Text is exactly as saved, macros included. A slot is a placeholder the app fills from elsewhere, not preset text.',
    ];
    for (const item of modules) {
        const where = item.depth !== null && item.depth !== undefined ? `in chat at depth ${item.depth}` : '';
        const tags = item.marker
            ? [`slot, filled from ${PRESET_SLOT_SOURCES[item.id] || 'elsewhere'}`]
            : [item.role, where].filter(Boolean);
        const heading = `### [${item.enabled ? 'on' : 'off'}] ${item.name}${tags.length ? ` (${tags.join(', ')})` : ''}`;
        lines.push(item.content ? `${heading}\n${item.content}` : heading);
    }
    if (!modules.length) lines.push('(This preset has no modules to show.)');
    return lines.join('\n\n');
}

/** Lazy loading keeps only a card's summary in memory, so load full cards before sharing them. */
async function loadSourceCharacters(source) {
    const people = sourceCharacters(source);
    await Promise.all(people.filter(item => item?.shallow).map(async item => {
        try {
            const index = characters.indexOf(item);
            if (index !== -1) await unshallowCharacter(String(index));
        } catch (error) {
            console.warn('Scratchpad could not load the full character card', item.avatar, error);
        }
    }));
    requireCurrentSource(source);
    return people.some(item => item?.shallow) ? sourceCharacters(source) : people;
}

/**
 * Builds the reference material for a message from the visible workspace.
 * Nothing here is saved; General never borrows a hidden story.
 */
export async function buildContext({ source, settings, pendingText = '', sessionText = '' }) {
    requireCurrentSource(source);
    if (source.kind === 'notebook') return {
        text: `Notebook discussion: ${source.label}\nOnly the explicitly shared notes are included. No story messages, persona, character cards or lorebooks are shared.`,
        names: { user: name1, character: '' }, lore: { books: [], entries: [] }, messageCount: 0, swipeCount: 0, totalMessages: 0, picked: false, preset: null,
        capabilities: { lore: false, character: false, chat: false, members: [] },
    };
    const include = settings?.include || {};
    const general = source.kind === 'general';
    const all = sourceMessages(source);
    const selection = general ? { messages: [], picked: false } : selectMessages(all, settings, source);
    const people = include.card ? await loadSourceCharacters(source) : sourceCharacters(source);
    const names = { user: sourceUserName(source), character: people.map(item => item.name).filter(Boolean).join(', ') };
    const macros = { name1Override: names.user, name2Override: names.character, replaceCharacterCard: false };
    const sections = [];

    sections.push([
        general ? 'General Scratchpad: no story chat is open. No story messages, Author\'s Note, chat metadata, preset or lorebook text is shared. Any selected character card is reference material, not a live story.' : `Chat: ${source.label}`,
        ...(general ? [] : [`Mode: ${source.kind === 'conversation' ? 'Conversation (messaging-style chat)' : 'Roleplay'}`]),
        `User: ${names.user}`,
    ].join('\n'));

    if (include.persona) {
        const description = sourcePersonaDescription(source);
        const raw = String(description ?? '').trim();
        // General may substitute names, never macros that can read the hidden story.
        const persona = general ? raw.replace(/\{\{\s*user\s*\}\}/gi, () => names.user).replace(/\{\{\s*char\s*\}\}/gi, () => names.character)
            : substituteParams(raw, macros);
        if (persona) sections.push(`## ${names.user} (the user's persona)\n${persona}`);
    }

    if (include.card && people.length) {
        sections.push('Character cards follow in full, exactly as saved. Macros such as {{char}} and {{user}} are left in place; {{char}} means that card\'s character. Field keys are shown in [brackets].');
        for (const character of people) sections.push(formatCharacter(character, source));
    }

    if (include.authorsNote && source.kind === 'roleplay') {
        const note = substituteParams(String(chat_metadata?.note_prompt ?? '').trim(), macros);
        if (note) sections.push(`## Author's Note\n${note}`);
    }

    let lore = { books: [], entries: [] };
    if (include.lore && !general) {
        const scanText = loreScanText({ source, settings, sessionText, pendingText });
        lore = await collectLore({ source, settings, scanText });
        const text = formatLore(lore, macros);
        if (text) sections.push(`## Lorebooks\n${text}`);
    }

    let preset = null;
    if (include.preset && source.kind === 'roleplay') {
        const snapshot = readCurrentPreset();
        sections.push(formatPreset(snapshot));
        const modules = Array.isArray(snapshot?.modules) ? snapshot.modules : [];
        preset = { name: snapshot?.name || '', on: modules.filter(item => item.enabled).length, off: modules.filter(item => !item.enabled).length };
    }

    const messageCount = new Set(selection.messages.map(item => item.messageRef ?? item.ref)).size;
    const swipeCount = selection.messages.filter(item => item.swipe).length;
    const heading = selection.picked
        ? (swipeCount ? `## Picked messages and swipes (${selection.messages.length} versions from ${messageCount} of ${all.length} messages)` : `## Picked messages (${messageCount} of ${all.length})`)
        : `## Latest messages (${selection.messages.length} of ${all.length})`;
    const lines = selection.messages.map(item => {
        const swipe = item.swipe ? ` [swipe ${item.swipe} of ${item.swipeCount}; ${item.current ? 'current' : 'alternative'}]` : '';
        return `#${item.number} ${item.name}${swipe}${item.hidden ? ' (hidden)' : ''}:\n${clip(item.text, MAX_MESSAGE_CHARS)}`;
    });
    if (!general) sections.push([heading, ...(swipeCount ? ['Swipes are alternative versions of the same message, shared for comparison. Only the current version belongs to the active story; do not treat alternatives as consecutive events.'] : []), ...lines].join('\n\n'));

    let text = sections.join('\n\n');
    const encoded = new TextEncoder().encode(text);
    if (encoded.length > MAX_CONTEXT_BYTES) text = `${new TextDecoder().decode(encoded.subarray(0, MAX_CONTEXT_BYTES - 10)).replace(/\uFFFD$/, '')}\n[...]`;
    requireCurrentSource(source);

    const loreBooks = include.lore ? lore.books : [];
    return {
        text,
        names,
        lore,
        messageCount,
        swipeCount,
        totalMessages: all.length,
        picked: selection.picked,
        preset,
        capabilities: {
            lore: loreBooks.length > 0,
            character: people.length > 0 && (!general || include.card === true),
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
        const referenceAssistant = ['miso', 'taro', 'nori'].includes(assistant) ? assistant : 'miso';
        const result = await buildAssistantKnowledge({
            character: { data: { extensions: { neconyan_assistant: { id: `${referenceAssistant}-${gender || 'neutral'}` } } } },
            messages: [{ role: 'user', content: text }],
            maxTokens: 4096,
        });
        return result?.status === 'matched' ? String(result.text || '') : '';
    } catch {
        return '';
    }
}

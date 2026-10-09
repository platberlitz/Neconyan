import {
    chat,
    chat_metadata,
    characters,
    deleteMessage,
    getOneCharacter,
    getRequestHeaders,
    getThumbnailUrl,
    name1,
    reloadCurrentChat,
    saveChatConditional,
    select_selected_character,
    syncMesToSwipe,
    this_chid,
    updateMessageBlock,
} from '../../script.js';
import { hideChatMessageRange } from '../chats.js';
import { event_types, eventSource } from '../events.js';
import { saveCharacterDraft } from '../neconyan-character-create.js';
import { normaliseCharacterDraft } from '../neconyan-character-draft.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { getNameAndAvatarForMessage } from '../slash-commands.js';
import { createWorldInfoEntry, deleteWorldInfoEntry, loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_names } from '../world-info.js';
import { isCurrentSource, sourceCharacters } from './context.js';
import { LIST_FIELDS, TEXT_FIELDS, TOP_LEVEL_FIELDS, fail, formatEntry, formatField, normaliseChange, parseEntry, parseField, stringList } from './proposals.js';

function entryView(entry) {
    return {
        title: String(entry?.comment ?? ''),
        keys: Array.isArray(entry?.key) ? entry.key.map(String) : [],
        content: String(entry?.content ?? ''),
        constant: Boolean(entry?.constant),
    };
}

async function readBook(book) {
    // A book made on another device or tab is missing from the list loaded at startup.
    if (!world_names?.includes(book)) await updateWorldInfoList();
    if (!world_names?.includes(book)) fail(`There is no lorebook called '${book}'.`);
    const data = await loadWorldInfo(book);
    if (!data?.entries) fail(`The lorebook '${book}' could not be read.`);
    return data;
}

function readEntry(data, change) {
    const entry = data.entries[change.uid];
    if (!entry) fail(`Entry ${change.uid} is no longer in '${change.book}'.`);
    if (entry.agentBlacklisted) fail('This entry is hidden from assistants, so Scratchpad will not change it.');
    return entry;
}

function conflict() {
    fail('This changed while the review was open, so nothing was saved. Ask again to get a fresh suggestion.');
}

function requireSource(source) {
    if (!isCurrentSource(source)) conflict();
}

async function saveBook(book, data, source) {
    requireSource(source);
    const saved = await saveWorldInfo(book, data, true);
    if (!saved) fail('The lorebook change was not saved. Review it again before retrying.');
}

async function lorebookPlan(change, source) {
    const data = await readBook(change.book);
    requireSource(source);
    if (change.action === 'add') {
        const after = { title: change.title, keys: change.keys, content: change.content, constant: change.constant };
        return {
            target: change.book,
            field: 'New entry',
            before: '',
            after: formatEntry(after),
            editable: true,
            async commit(edited) {
                const fresh = await readBook(change.book);
                requireSource(source);
                const entry = createWorldInfoEntry(change.book, fresh);
                if (!entry) fail('A new entry could not be added to this lorebook.');
                const value = parseEntry(edited, after);
                Object.assign(entry, { comment: value.title, key: value.keys, content: value.content, constant: value.constant });
                await saveBook(change.book, fresh, source);
            },
        };
    }
    const current = entryView(readEntry(data, change));
    const before = formatEntry(current);
    if (change.action === 'delete') {
        return {
            target: `${change.book}, entry ${change.uid}`,
            field: 'Whole entry',
            before,
            after: '(deleted)',
            editable: false,
            async commit() {
                const fresh = await readBook(change.book);
                requireSource(source);
                if (formatEntry(entryView(readEntry(fresh, change))) !== before) conflict();
                await deleteWorldInfoEntry(fresh, change.uid, { silent: true });
                await saveBook(change.book, fresh, source);
            },
        };
    }
    const proposed = {
        title: change.title ?? current.title,
        keys: change.keys ?? current.keys,
        content: change.content ?? current.content,
        constant: change.constant ?? current.constant,
    };
    return {
        target: `${change.book}, entry ${change.uid}`,
        field: 'Entry',
        before,
        after: formatEntry(proposed),
        editable: true,
        async commit(edited) {
            const fresh = await readBook(change.book);
            requireSource(source);
            const entry = readEntry(fresh, change);
            if (formatEntry(entryView(entry)) !== before) conflict();
            const value = parseEntry(edited, proposed);
            Object.assign(entry, { comment: value.title, key: value.keys, content: value.content, constant: value.constant });
            await saveBook(change.book, fresh, source);
        },
    };
}

function readCharacterField(character, field) {
    if (field === 'tags') return Array.isArray(character?.tags) ? character.tags.map(String) : stringList(character?.data?.tags);
    if (field === 'alternate_greetings') return Array.isArray(character?.data?.alternate_greetings) ? character.data.alternate_greetings.map(String) : [];
    const data = character?.data?.[field];
    if (typeof data === 'string') return data;
    return String(character?.[TOP_LEVEL_FIELDS[field] || field] ?? '');
}

function findCharacter(source, name) {
    const wanted = name.trim().toLowerCase();
    const match = sourceCharacters(source).find(item => String(item?.name ?? '').trim().toLowerCase() === wanted);
    if (!match) fail(`Scratchpad can only change characters in this chat, and '${name}' is not one of them.`);
    return match;
}

async function characterPlan(change, source) {
    const avatar = findCharacter(source, change.character).avatar;
    const snapshot = await fetch('/api/characters/get', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, with_revision: true }),
    });
    if (!snapshot.ok) fail('This character could not be read.');
    const revision = snapshot.headers.get('X-Character-Revision');
    if (!/^[a-f0-9]{64}$/.test(revision ?? '')) fail('The character revision could not be checked. Reload the page and try again.');
    const character = await snapshot.json();
    requireSource(source);
    const current = readCharacterField(character, change.field);
    const append = change.action === 'append';
    const before = formatField(change.field, current);
    return {
        target: character.name,
        field: append ? 'Add alternate greetings' : TEXT_FIELDS[change.field] || LIST_FIELDS[change.field],
        before,
        beforeLabel: append ? 'Existing greetings (kept)' : undefined,
        after: formatField(change.field, change.value),
        afterLabel: append ? 'New greetings to append' : undefined,
        editable: true,
        hint: append ? 'New greetings go after the last existing alternate greeting. Separate new greetings with a line containing only ---.'
            : change.field === 'alternate_greetings' ? 'Separate greetings with a line containing only ---.' : change.field === 'tags' ? 'Separate tags with commas.' : '',
        async commit(edited) {
            requireSource(source);
            const proposed = parseField(change.field, edited);
            if (append && !proposed.length) fail('This addition has no new greetings.');
            const value = append ? [...current, ...proposed] : proposed;
            const body = { avatar, expected_revision: revision, data: { [change.field]: value } };
            if (TOP_LEVEL_FIELDS[change.field]) body[TOP_LEVEL_FIELDS[change.field]] = value;
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                if (response.status === 409) conflict();
                const payload = await response.json().catch(() => ({}));
                fail(payload?.message || 'The character could not be saved.');
            }
            await getOneCharacter(avatar);
            const index = characters.findIndex(item => item?.avatar === avatar);
            if (index >= 0) {
                await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character: characters[index] } });
                if (String(index) === String(this_chid)) select_selected_character(this_chid, { switchMenu: false });
            }
        },
    };
}

function messageSnapshot(index) {
    const message = chat[index];
    if (!message) return null;
    return `${message.name}${message.is_system ? ' (hidden)' : ''}\n${message.mes ?? ''}`;
}

function requireMessage(index) {
    const message = chat[index];
    if (!message) fail(`Message #${index} is no longer in this chat.`);
    return message;
}

async function saveMessages(source, options = {}) {
    requireSource(source);
    if (await saveChatConditional({ ...options, throwOnError: true }) !== true) {
        fail('The message change was not saved. Review it again before retrying.');
    }
}

function buildInsertedMessage(change, source, edited) {
    const sendDate = getMessageTimeStamp();
    let message;
    if (change.speaker === 'user') {
        message = { name: name1, is_user: true, is_system: false, send_date: sendDate, mes: edited, extra: {} };
        if (user_avatar in power_user.personas) message.force_avatar = getThumbnailUrl('persona', user_avatar);
    } else {
        const people = sourceCharacters(source);
        const wanted = (change.name || '').trim().toLowerCase();
        const character = people.find(item => String(item?.name ?? '').trim().toLowerCase() === wanted) || people[0];
        if (!character) fail('There is no character in this chat to speak this message.');
        const { name, force_avatar, original_avatar } = getNameAndAvatarForMessage(character, character.name);
        message = { name, is_user: false, is_system: false, send_date: sendDate, mes: edited, force_avatar, original_avatar, extra: {} };
    }
    message.extra = { api: 'manual', model: 'Scratchpad', gen_id: Date.now() };
    message.swipe_id = 0;
    message.swipes = [message.mes];
    message.swipe_info = [{ send_date: sendDate, gen_started: null, gen_finished: null, extra: { ...message.extra } }];
    return message;
}

function chatPlan(change, source) {
    if (source.kind !== 'roleplay') fail('Scratchpad can only change messages in Roleplay chats.');
    if (change.action === 'insert') {
        const anchor = messageSnapshot(change.after);
        if (anchor === null) fail(`Message #${change.after} is no longer in this chat.`);
        const speaker = change.speaker === 'user' ? name1 : (change.name || 'Character');
        return {
            target: `After message #${change.after}`,
            field: `New message from ${speaker}`,
            before: '',
            after: change.text,
            editable: true,
            async commit(edited) {
                if (!isCurrentSource(source)) conflict();
                if (messageSnapshot(change.after) !== anchor) conflict();
                const message = buildInsertedMessage(change, source, edited);
                chat_metadata.tainted = true;
                chat.splice(change.after + 1, 0, message);
                await saveMessages(source);
                requireSource(source);
                await reloadCurrentChat();
            },
        };
    }
    const message = requireMessage(change.message);
    const before = messageSnapshot(change.message);
    const target = `Message #${change.message} from ${message.name}`;
    if (change.action === 'edit') {
        return {
            target,
            field: 'Message text',
            before: String(message.mes ?? ''),
            after: change.text,
            editable: true,
            async commit(edited) {
                if (!isCurrentSource(source) || messageSnapshot(change.message) !== before) conflict();
                const live = requireMessage(change.message);
                live.mes = edited;
                syncMesToSwipe(change.message);
                await eventSource.emit(event_types.MESSAGE_EDITED, change.message);
                if (!isCurrentSource(source) || chat[change.message] !== live) conflict();
                await updateMessageBlock(change.message, live);
                if (!isCurrentSource(source) || chat[change.message] !== live) conflict();
                await eventSource.emit(event_types.MESSAGE_UPDATED, change.message);
                if (chat[change.message] !== live) conflict();
                await saveMessages(source);
            },
        };
    }
    if (change.action === 'hide' || change.action === 'unhide') {
        const unhide = change.action === 'unhide';
        return {
            target,
            field: 'Visibility',
            before: `${message.is_system ? 'Hidden' : 'Visible'}\n\n${message.mes ?? ''}`,
            after: `${unhide ? 'Visible' : 'Hidden'}\n\n${message.mes ?? ''}`,
            editable: false,
            async commit() {
                if (!isCurrentSource(source) || messageSnapshot(change.message) !== before) conflict();
                if (!await hideChatMessageRange(change.message, change.message, unhide)) {
                    fail('The message visibility change was not saved. Review it again before retrying.');
                }
            },
        };
    }
    return {
        target,
        field: 'Whole message',
        before: String(message.mes ?? ''),
        after: '(deleted)',
        editable: false,
        async commit() {
            if (!isCurrentSource(source) || messageSnapshot(change.message) !== before) conflict();
            const live = requireMessage(change.message);
            await deleteMessage(change.message, undefined, false);
            requireSource(source);
            if (chat.includes(live)) fail('The message deletion was not saved. Review it again before retrying.');
            await saveMessages(source, { allowShrink: true });
        },
    };
}

/**
 * Reads the live value a change would replace and returns everything the
 * review needs. Nothing is written until commit() is called.
 */
export async function prepareChange(change, source) {
    if (!isCurrentSource(source)) fail('Open the chat this Scratchpad belongs to before applying changes.');
    change = normaliseChange(change);
    if (change.type === 'character' && change.action === 'create') {
        const draft = normaliseCharacterDraft(change);
        let committed;
        return {
            target: draft.character.name,
            field: 'New character card',
            before: '',
            after: JSON.stringify(draft, null, 2),
            editable: true,
            hint: 'Edit the character fields in this JSON. Leave avatarPrompt empty to use the default picture.',
            async commit(edited) {
                requireSource(source);
                if (committed) return committed;
                let value;
                try { value = JSON.parse(edited); } catch { fail('The character draft must be valid JSON. Check its quotes and commas.'); }
                committed = await saveCharacterDraft(normaliseCharacterDraft(value), {
                    assert: () => requireSource(source), isCurrent: () => isCurrentSource(source),
                });
                return committed;
            },
        };
    }
    if (change.type === 'lorebook') return lorebookPlan(change, source);
    if (change.type === 'character') return characterPlan(change, source);
    return chatPlan(change, source);
}

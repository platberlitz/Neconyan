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
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { getNameAndAvatarForMessage } from '../slash-commands.js';
import { createWorldInfoEntry, deleteWorldInfoEntry, loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_names } from '../world-info.js';
import { isCurrentSource, sourceCharacters } from './context.js';
import { LIST_FIELDS, TEXT_FIELDS, TOP_LEVEL_FIELDS, fail, formatEntry, formatField, parseEntry, parseField, stringList } from './proposals.js';

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

async function lorebookPlan(change) {
    const data = await readBook(change.book);
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
                const entry = createWorldInfoEntry(change.book, fresh);
                if (!entry) fail('A new entry could not be added to this lorebook.');
                const value = parseEntry(edited, after);
                Object.assign(entry, { comment: value.title, key: value.keys, content: value.content, constant: value.constant });
                await saveWorldInfo(change.book, fresh, true);
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
                if (formatEntry(entryView(readEntry(fresh, change))) !== before) conflict();
                await deleteWorldInfoEntry(fresh, change.uid, { silent: true });
                await saveWorldInfo(change.book, fresh, true);
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
            const entry = readEntry(fresh, change);
            if (formatEntry(entryView(entry)) !== before) conflict();
            const value = parseEntry(edited, proposed);
            Object.assign(entry, { comment: value.title, key: value.keys, content: value.content, constant: value.constant });
            await saveWorldInfo(change.book, fresh, true);
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

function characterPlan(change, source) {
    const character = findCharacter(source, change.character);
    const avatar = character.avatar;
    const before = formatField(change.field, readCharacterField(character, change.field));
    return {
        target: character.name,
        field: TEXT_FIELDS[change.field] || LIST_FIELDS[change.field],
        before,
        after: formatField(change.field, change.value),
        editable: true,
        hint: change.field === 'alternate_greetings' ? 'Separate greetings with a line containing only ---.' : change.field === 'tags' ? 'Separate tags with commas.' : '',
        async commit(edited) {
            const live = characters.find(item => item?.avatar === avatar);
            if (!live) fail('This character is no longer available.');
            if (formatField(change.field, readCharacterField(live, change.field)) !== before) conflict();
            const value = parseField(change.field, edited);
            const body = { avatar, data: { [change.field]: value } };
            if (TOP_LEVEL_FIELDS[change.field]) body[TOP_LEVEL_FIELDS[change.field]] = value;
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (!response.ok) {
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
                await saveChatConditional();
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
                await updateMessageBlock(change.message, live);
                await eventSource.emit(event_types.MESSAGE_UPDATED, change.message);
                await saveChatConditional();
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
                await hideChatMessageRange(change.message, change.message, unhide);
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
            await deleteMessage(change.message, undefined, false);
        },
    };
}

/**
 * Reads the live value a change would replace and returns everything the
 * review needs. Nothing is written until commit() is called.
 */
export async function prepareChange(change, source) {
    if (!isCurrentSource(source)) fail('Open the chat this Scratchpad belongs to before applying changes.');
    if (change.type === 'lorebook') return lorebookPlan(change);
    if (change.type === 'character') return characterPlan(change, source);
    return chatPlan(change, source);
}

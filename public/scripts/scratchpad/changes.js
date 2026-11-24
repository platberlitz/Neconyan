import {
    chat,
    chat_metadata,
    characters,
    deleteMessage,
    getOneCharacter,
    getRequestHeaders,
    extractMessageBias,
    getThumbnailUrl,
    isGenerating,
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
import { t } from '../i18n.js';
import { saveCharacterDraft } from '../neconyan-character-create.js';
import { normaliseCharacterDraft } from '../neconyan-character-draft.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import { appendManualSwipe, selectManualSwipe } from '../manual-swipe.js';
import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { getNameAndAvatarForMessage } from '../slash-commands.js';
import { createWorldInfoEntry, deleteWorldInfoEntry, loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_names } from '../world-info.js';
import { syncLorebookOriginalEntry } from '../neconyan-lorebook-tools-core.js';
import { isCurrentSource, sourceCharacters, wireSource } from './context.js';
import {
    applyLorebookActivationFields,
    describeLorebookSettingChanges,
    snapshotLorebookEntry,
} from './lorebook-fields.js';
import { DIALOGUE_COLOR, describeChange, fail, formatEntry, formatField, normaliseChange, parseEntry, parseField } from './proposals.js';
import { characterField, characterFieldPatch, readCharacterField } from './character-fields.js';

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

function lorebookEditUndo(change, beforeEntry, entry) {
    return { kind: 'lorebook-edit', book: change.book, uid: change.uid, beforeEntry, afterSnapshot: snapshotLorebookEntry(entry) };
}

function requireDisabledEntryAllowed(entry, change, disabledEntriesListed) {
    if (!entry.disable) return;
    if (!disabledEntriesListed) {
        fail('This entry is disabled and was not shared with the assistant. Turn on Problem checks with Lorebooks shared before changing it.');
    }
    if (Object.hasOwn(change, 'content')) {
        fail('Disabled lorebook entries do not share their content, so Scratchpad will not edit their text while disabled. Enable the entry first.');
    }
    if (change.disable !== false) {
        fail('Disabled lorebook entries can only be enabled from Scratchpad; set disable to false first.');
    }
}

async function lorebookPlan(change, source, { disabledEntriesListed = false, lorebookGuard } = {}) {
    const data = await readBook(change.book);
    requireSource(source);
    lorebookGuard?.();
    if (change.action === 'add') {
        const after = { title: change.title, keys: change.keys, content: change.content, constant: change.constant };
        const settings = describeLorebookSettingChanges(null, change, { isAdd: true });
        return {
            target: change.book,
            field: 'New entry',
            before: '',
            after: formatEntry(after),
            settings,
            editable: true,
            async commit(edited) {
                const validated = normaliseChange(change);
                lorebookGuard?.();
                const fresh = await readBook(validated.book);
                requireSource(source);
                const entry = createWorldInfoEntry(validated.book, fresh);
                if (!entry) fail('A new entry could not be added to this lorebook.');
                applyLorebookActivationFields(entry, validated);
                const value = parseEntry(edited, after);
                Object.assign(entry, { comment: value.title, key: value.keys, content: value.content, constant: value.constant });
                if (value.constant) entry.vectorized = false;
                syncLorebookOriginalEntry(fresh, entry.uid);
                await saveBook(validated.book, fresh, source);
                return { undo: { kind: 'lorebook-add', book: validated.book, uid: entry.uid, afterSnapshot: snapshotLorebookEntry(entry) } };
            },
        };
    }
    const entry = readEntry(data, change);
    const current = entryView(entry);
    const before = formatEntry(current);
    const beforeSnapshot = snapshotLorebookEntry(entry);
    if (change.action === 'delete') {
        return {
            target: `${change.book}, entry ${change.uid}`,
            field: 'Whole entry',
            before,
            after: '',
            snapshot: beforeSnapshot,
            editable: false,
            async commit() {
                const validated = normaliseChange(change);
                lorebookGuard?.();
                const fresh = await readBook(validated.book);
                requireSource(source);
                const live = readEntry(fresh, validated);
                if (snapshotLorebookEntry(live) !== beforeSnapshot) conflict();
                const beforeEntry = structuredClone(live);
                await deleteWorldInfoEntry(fresh, validated.uid, { silent: true });
                await saveBook(validated.book, fresh, source);
                return { undo: { kind: 'lorebook-delete', book: validated.book, uid: validated.uid, beforeEntry } };
            },
        };
    }
    requireDisabledEntryAllowed(entry, change, disabledEntriesListed);
    const hasTextEdit = !entry.disable && (Object.hasOwn(change, 'title') || Object.hasOwn(change, 'content'));
    if (!hasTextEdit) {
        const settings = describeLorebookSettingChanges(entry, change, { includeTitle: Boolean(entry.disable) });
        if (!settings.length) fail('That lorebook entry already has those settings.');
        return {
            target: `${change.book}, entry ${change.uid}`,
            field: 'Activation settings',
            before: settings.map(row => `${row.label}: ${row.before}`).join('\n'),
            after: settings.map(row => `${row.label}: ${row.after}`).join('\n'),
            snapshot: beforeSnapshot,
            settings,
            hideTextDiff: true,
            editable: false,
            async commit() {
                const validated = normaliseChange(change);
                lorebookGuard?.();
                const fresh = await readBook(validated.book);
                requireSource(source);
                const freshEntry = readEntry(fresh, validated);
                requireDisabledEntryAllowed(freshEntry, validated, disabledEntriesListed);
                if (snapshotLorebookEntry(freshEntry) !== beforeSnapshot) conflict();
                const beforeEntry = structuredClone(freshEntry);
                if (Object.hasOwn(validated, 'title')) freshEntry.comment = validated.title;
                applyLorebookActivationFields(freshEntry, validated);
                syncLorebookOriginalEntry(fresh, freshEntry.uid);
                await saveBook(validated.book, fresh, source);
                return { undo: lorebookEditUndo(validated, beforeEntry, freshEntry) };
            },
        };
    }
    const proposed = {
        title: change.title ?? current.title,
        keys: change.keys ?? current.keys,
        content: change.content ?? current.content,
        constant: change.constant ?? current.constant,
    };
    const settings = describeLorebookSettingChanges(entry, change);
    return {
        target: `${change.book}, entry ${change.uid}`,
        field: 'Entry',
        before,
        after: formatEntry(proposed),
        snapshot: beforeSnapshot,
        settings,
        editable: true,
        async commit(edited) {
            const validated = normaliseChange(change);
            lorebookGuard?.();
            const fresh = await readBook(validated.book);
            requireSource(source);
            const freshEntry = readEntry(fresh, validated);
            requireDisabledEntryAllowed(freshEntry, validated, disabledEntriesListed);
            if (snapshotLorebookEntry(freshEntry) !== beforeSnapshot) conflict();
            const beforeEntry = structuredClone(freshEntry);
            applyLorebookActivationFields(freshEntry, validated);
            const value = parseEntry(edited, proposed);
            Object.assign(freshEntry, { comment: value.title, key: value.keys, content: value.content, constant: value.constant });
            if (value.constant) freshEntry.vectorized = false;
            syncLorebookOriginalEntry(fresh, freshEntry.uid);
            await saveBook(validated.book, fresh, source);
            return { undo: lorebookEditUndo(validated, beforeEntry, freshEntry) };
        },
    };
}

function authorsNotePlan(change, source) {
    if (source.kind !== 'roleplay') fail(t`Scratchpad can only change the Author's Note of a Roleplay chat.`);
    const read = () => String(chat_metadata?.note_prompt ?? '');
    const before = read();
    return {
        target: t`Author's Note`,
        field: t`This chat's note`,
        before,
        after: change.value,
        editable: true,
        async commit(edited) {
            requireSource(source);
            if (read() !== before) conflict();
            const value = String(edited ?? '');
            chat_metadata.note_prompt = value;
            let saved = false;
            try {
                saved = await saveChatConditional({ throwOnError: true }) === true;
            } finally {
                if (!saved) chat_metadata.note_prompt = before;
            }
            if (!saved) fail(t`The Author's Note was not saved. Review it again before retrying.`);
            const box = globalThis.document?.getElementById('extension_floating_prompt');
            if (box) box.value = value;
            return { undo: { kind: 'authors-note', chatKey: source.key, before, after: value } };
        },
    };
}

async function mewmoryPlan(change, source, sessionId) {
    if (source.kind !== 'roleplay') fail(t`Mewmory corrections are only available in a Roleplay chat.`);
    if (!sessionId) fail(t`Open this Scratchpad session again before saving a memory correction.`);
    const api = await import('./api.js');
    const current = await api.readMewmoryRecord(wireSource(source), sessionId, change.record);
    requireSource(source);
    const before = String(current[change.field] ?? '');
    return {
        target: t`Mewmory: ${change.record}`,
        field: change.field === 'status' ? t`Status` : t`Memory text`,
        before,
        after: change.value,
        editable: true,
        hint: change.field === 'status' ? t`Use active, background, resolved, uncertain or invalidated.` : t`Saving replaces this memory's text as your own correction. Mewmory keeps the earlier version, so you can undo it there.`,
        async commit(edited) {
            requireSource(source);
            const text = String(edited ?? '').trim();
            const value = change.field === 'status' ? text.toLowerCase() : text;
            const result = await api.correctMewmoryRecord(wireSource(source), sessionId, change.record,
                { field: change.field, value, expected: before, version: current.version });
            requireSource(source);
            const postVersion = Number.isInteger(result?.record?.version) ? result.record.version : null;
            return { undo: { kind: 'mewmory', chatKey: source.key, sessionId, record: change.record, field: change.field, before, after: value, postVersion } };
        },
    };
}

async function dialogueColorPlan(change) {
    const [state, palettes, ui] = await Promise.all([
        import('../extensions/third-party/sillytavern-character-colors/src/state.js'),
        import('../extensions/third-party/sillytavern-character-colors/src/palettes.js'),
        import('../extensions/third-party/sillytavern-character-colors/src/ui.js'),
    ]);
    const wanted = change.character.toLowerCase();
    const read = () => {
        const table = state.characterColors ?? {};
        const key = Object.keys(table).find(item => item.toLowerCase() === wanted || String(table[item]?.name ?? '').toLowerCase() === wanted);
        if (!key) fail(t`There is no character with that name in the colour table in use.`);
        return { key, entry: table[key] };
    };
    const found = read();
    const before = palettes.getBaseColor(found.entry);
    return {
        target: t`Dialogue colour: ${found.entry.name || change.character}`,
        field: t`Colour`,
        before,
        after: change.value,
        editable: true,
        async commit(edited) {
            const value = String(edited ?? '').trim().toLowerCase();
            if (!DIALOGUE_COLOR.test(value)) fail(t`A dialogue colour must be written as # and six hex digits, such as #c0ffee.`);
            const live = read();
            if (palettes.getBaseColor(live.entry) !== before) conflict();
            if (!ui.applyCharacterBaseColor(live.key, value, { saveImmediately: true })) fail(t`The dialogue colour was not saved. Review it again before retrying.`);
            try {
                ui.maybeAutoRecolorAfterColorChange();
                (await import('../extensions/third-party/sillytavern-character-colors/src/storage.js')).saveData();
            } catch (error) {
                console.warn('Scratchpad could not flush the Dialogue Colors save.', error);
            }
            // A character without a saved colour has nothing to go back to.
            if (!DIALOGUE_COLOR.test(String(before ?? ''))) return { undoUnavailableReason: t`This character had no saved dialogue colour before, so there is nothing to restore.` };
            return { undo: { kind: 'dialogue-color', key: live.key, character: change.character, before, after: value } };
        },
    };
}

async function cssSnippetPlan(change) {
    const runtime = await import('../extensions/css-snippets/src/runtime.js');
    const read = () => {
        const snippet = (runtime.getSettings().snippetList ?? []).find(item => item?.id === change.snippet && !item.isDeleted);
        if (!snippet) fail(t`There is no CSS snippet with that ID any more.`);
        return snippet;
    };
    const snippet = read();
    const before = String(snippet[change.field] ?? '');
    return {
        target: t`CSS snippet: ${snippet.name || change.snippet}`,
        field: { name: t`Name`, content: t`CSS` }[change.field],
        before,
        after: change.value,
        editable: true,
        async commit(edited) {
            const value = change.field === 'name' ? String(edited ?? '').replace(/\s+/g, ' ').trim() : String(edited ?? '');
            if (change.field === 'name' && !value) fail(t`A CSS snippet needs a name.`);
            if (change.field === 'content' && value.trim() && globalThis.document && runtime.hasNoReadableRules(value)) {
                fail(t`The browser cannot read any rule in that CSS, so nothing was saved.`);
            }
            const live = read();
            if (String(live[change.field] ?? '') !== before) conflict();
            live[change.field] = value;
            // The runtime's save also applies the styles, which must not happen while the extension is turned off.
            if (globalThis.document?.getElementById('csss--css-snippets')) {
                runtime.saveSnippet(live);
            } else {
                live.modifiedOn = Date.now();
                runtime.getCtx().saveSettingsDebounced();
            }
            return { undo: { kind: 'css-snippet', snippet: change.snippet, field: change.field, before, after: value } };
        },
    };
}

async function regexPlan(change) {
    const engine = await import('../extensions/regex/engine.js');
    const read = () => {
        const script = engine.getScriptsByType(engine.SCRIPT_TYPES.GLOBAL).find(item => item?.id === change.script);
        if (!script) fail(t`There is no global regex script with that ID any more.`);
        return script;
    };
    const script = read();
    const before = String(script[change.field] ?? '');
    return {
        target: t`Regex script: ${script.scriptName || change.script}`,
        field: { scriptName: t`Name`, findRegex: t`Find pattern`, replaceString: t`Replace with` }[change.field],
        before,
        after: change.value,
        editable: true,
        async commit(edited) {
            const value = change.field === 'scriptName' ? String(edited ?? '').replace(/\s+/g, ' ').trim() : String(edited ?? '');
            if (change.field === 'scriptName' && !value) fail(t`A regex script needs a name.`);
            if (change.field === 'findRegex' && value) {
                const { regexFromString } = await import('../utils.js');
                if (!regexFromString(value)) fail(t`That Find pattern is not a valid regular expression, so nothing was saved.`);
            }
            const live = read();
            if (String(live[change.field] ?? '') !== before) conflict();
            live[change.field] = value;
            engine.RegexProvider?.instance?.clear?.();
            await engine.saveScriptsByType(engine.getScriptsByType(engine.SCRIPT_TYPES.GLOBAL), engine.SCRIPT_TYPES.GLOBAL);
            try {
                const list = await import('../extensions/regex/index.js');
                await list.loadRegexScripts?.();
            } catch (error) {
                console.warn('Scratchpad could not refresh the Regexes list.', error);
            }
            return { undo: { kind: 'regex', script: change.script, field: change.field, before, after: value } };
        },
    };
}

async function agentPlan(change) {
    const store = await import('../extensions/in-chat-agents/agent-store.js');
    const read = () => {
        const agent = store.getAgentById(change.agent);
        if (!agent) fail(t`There is no saved Agent with that ID any more.`);
        return agent;
    };
    const agent = read();
    const before = String(agent[change.field] ?? '');
    return {
        target: t`Agent: ${agent.name || change.agent}`,
        field: { name: t`Name`, description: t`Description`, prompt: t`Prompt` }[change.field],
        before,
        after: change.value,
        editable: true,
        async commit(edited) {
            const value = change.field === 'name' ? String(edited ?? '').replace(/\s+/g, ' ').trim() : String(edited ?? '');
            if (change.field === 'name' && !value) fail(t`An Agent needs a name.`);
            if (String(read()[change.field] ?? '') !== before) conflict();
            let stale = false;
            try {
                await store.saveAgent(change.agent, {
                    update: current => {
                        if (String(current?.[change.field] ?? '') !== before) {
                            stale = true;
                            return null;
                        }
                        return { ...current, [change.field]: value };
                    },
                });
            } catch (error) {
                if (error?.status === 409) conflict();
                throw error;
            }
            if (stale) conflict();
            return { undo: { kind: 'agent', agent: change.agent, field: change.field, before, after: value } };
        },
    };
}

function findCharacter(source, name) {
    const wanted = name.trim().toLowerCase();
    const matches = sourceCharacters(source).filter(item => String(item?.name ?? '').trim().toLowerCase() === wanted);
    if (matches.length > 1) fail(t`More than one shared character is called '${name}'. Choose an unambiguous target.`);
    if (!matches.length) fail(source.kind === 'general' ? t`Scratchpad can only change the selected, shared character, and '${name}' is not that character.`
        : `Scratchpad can only change characters in this chat, and '${name}' is not one of them.`);
    return matches[0];
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
        field: append ? 'Add alternate greetings' : characterField(change.field).label,
        before,
        beforeLabel: append ? 'Existing greetings (kept)' : undefined,
        after: formatField(change.field, change.value),
        afterLabel: append ? 'New greetings to append' : undefined,
        getAfterText: append ? edited => formatField(change.field, [...current, ...parseField(change.field, edited)]) : undefined,
        editable: true,
        hint: append ? 'New greetings go after the last existing alternate greeting. Separate new greetings with a line containing only ---.'
            : characterField(change.field).type === 'greetings' ? 'Separate greetings with a line containing only ---.' : change.field === 'tags' ? 'Separate tags with commas.' : characterField(change.field).hint || '',
        async commit(edited) {
            requireSource(source);
            if (findCharacter(source, change.character).avatar !== avatar) conflict();
            const proposed = parseField(change.field, edited);
            if (append && !proposed.length) fail('This addition has no new greetings.');
            const value = append ? [...current, ...proposed] : proposed;
            if (change.field === 'extensions.world' && value) {
                await updateWorldInfoList();
                requireSource(source);
                if (!world_names.includes(value)) fail(`There is no lorebook called '${value}'.`);
            }
            const body = { avatar, expected_revision: revision, ...characterFieldPatch(change.field, value) };
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
            return { undo: { kind: 'character', avatar, field: change.field, before: current, after: value } };
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
                return { undo: { kind: 'chat-insert', chatKey: source.key, index: change.after + 1, message: structuredClone(message) } };
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
                const previous = String(live.mes ?? '');
                live.mes = edited;
                syncMesToSwipe(change.message);
                await eventSource.emit(event_types.MESSAGE_EDITED, change.message);
                if (!isCurrentSource(source) || chat[change.message] !== live) conflict();
                await updateMessageBlock(change.message, live);
                if (!isCurrentSource(source) || chat[change.message] !== live) conflict();
                await eventSource.emit(event_types.MESSAGE_UPDATED, change.message);
                if (chat[change.message] !== live) conflict();
                await saveMessages(source);
                return { undo: { kind: 'chat-edit', chatKey: source.key, index: change.message, name: String(live.name ?? ''), before: previous, after: String(edited ?? '') } };
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
                return { undo: { kind: 'chat-visibility', chatKey: source.key, index: change.message, name: String(message.name ?? ''), mes: String(message.mes ?? ''), hidden: !unhide } };
            },
        };
    }
    return {
        target,
        field: 'Whole message',
        before: String(message.mes ?? ''),
        after: '',
        editable: false,
        async commit() {
            if (!isCurrentSource(source) || messageSnapshot(change.message) !== before) conflict();
            const live = requireMessage(change.message);
            const removed = structuredClone(live);
            await deleteMessage(change.message, undefined, false);
            requireSource(source);
            if (chat.includes(live)) fail('The message deletion was not saved. Review it again before retrying.');
            await saveMessages(source, { allowShrink: true });
            return {
                undo: {
                    kind: 'chat-delete', chatKey: source.key, index: change.message, message: removed, length: chat.length,
                    previous: messageSnapshot(change.message - 1), next: messageSnapshot(change.message),
                },
            };
        },
    };
}

/**
 * Finds the story reply that a Scratchpad reply can become another version of.
 * Nothing is written until addReplyVersion() is called.
 */
export function replyVersionTarget(source) {
    if (source?.kind !== 'roleplay') fail('Scratchpad can only add reply versions in Roleplay chats.');
    if (!isCurrentSource(source)) fail('The chat changed, so nothing was added. Return to it and try again.');
    const index = chat.length - 1;
    const message = chat[index];
    if (!message) fail('This chat has no reply to add a version to yet.');
    if (message.is_user) fail('The last message in this chat is yours. A version can only be added to a character\'s reply.');
    if (message.is_system) fail('The last message in this chat is hidden, so a version cannot be added to it.');
    return { index, name: String(message.name ?? ''), snapshot: messageSnapshot(index) };
}

export async function addReplyVersion(source, target, text) {
    if (!isCurrentSource(source) || chat.length - 1 !== target.index || messageSnapshot(target.index) !== target.snapshot) {
        fail('The story changed while you were deciding, so nothing was added. Try again.');
    }
    if (isGenerating()) fail('A story reply is still being written. Wait for it to finish, then try again.');
    const message = chat[target.index];
    const index = appendManualSwipe(message, text, { sendDate: getMessageTimeStamp(), bias: extractMessageBias(text), model: 'Scratchpad' });
    syncMesToSwipe(target.index);
    selectManualSwipe(message, index);
    await saveMessages(source);
    requireSource(source);
    await reloadCurrentChat();
}

const NOT_UNDOABLE = {
    'character:create': 'Scratchpad does not delete characters it created. Remove the card from your library if you no longer want it.',
    'persona:create': 'Scratchpad does not delete personas it created. Remove it from Personas if you no longer want it.',
    'persona-note:create': 'Scratchpad does not delete Scenario Notes it created. Remove it from the persona if you no longer want it.',
    creator: 'This opened a private Catelier draft. Delete the draft in Catelier if you no longer want it.',
};
const TARGET_KEYS = ['book', 'uid', 'character', 'preset', 'api', 'module', 'agent', 'script', 'snippet', 'record', 'message', 'after', 'persona', 'note'];
const receipts = new WeakMap();

function receiptTarget(change, plan) {
    const target = { kind: change.type, label: String(plan.target ?? '') };
    for (const key of TARGET_KEYS) {
        const value = change[key];
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) target[key] = value;
    }
    return target;
}

function receiptAfter(plan, edited) {
    if (typeof plan.getAfterText === 'function') return String(plan.getAfterText(edited) ?? '');
    return String((plan.editable ? edited : plan.after) ?? '');
}

/** Builds the Change history receipt for a commit that has just been saved. */
export function changeReceipt(change, plan, edited, result) {
    const undo = result && typeof result === 'object' && result.undo && typeof result.undo === 'object' ? result.undo : null;
    const fallback = NOT_UNDOABLE[`${change.type}:${change.action}`] ?? NOT_UNDOABLE[change.type] ?? 'Automatic undo is not available for this change.';
    return {
        type: change.type,
        action: String(change.action ?? ''),
        description: describeChange(change),
        target: receiptTarget(change, plan),
        field: String(plan.field ?? ''),
        before: String(plan.before ?? ''),
        after: receiptAfter(plan, edited),
        undo,
        undoable: Boolean(undo),
        undoUnavailableReason: undo ? '' : String(result?.undoUnavailableReason || fallback),
    };
}

function withReceipt(change, plan, edited, result) {
    const cacheable = result !== null && typeof result === 'object';
    if (cacheable && receipts.has(result)) return receipts.get(result);
    const rest = cacheable ? { ...result } : {};
    delete rest.undo;
    delete rest.undoUnavailableReason;
    const wrapped = { ...rest, receipt: changeReceipt(change, plan, edited, result) };
    if (cacheable) receipts.set(result, wrapped);
    return wrapped;
}

/**
 * Reads the live value a change would replace and returns everything the
 * review needs. Nothing is written until commit() is called, which resolves
 * to the saved result plus a Change history receipt.
 */
export async function prepareChange(change, source, options = {}) {
    if (!isCurrentSource(source)) fail(t`Return to this Scratchpad context before applying changes.`);
    const normalised = normaliseChange(change);
    const plan = await preparePlan(normalised, source, options);
    if (!plan || typeof plan.commit !== 'function') return plan;
    const commit = plan.commit.bind(plan);
    plan.commit = async edited => withReceipt(normalised, plan, edited, await commit(edited));
    return plan;
}

async function preparePlan(change, source, { sharedAvatar = '', sharedPersona, personaGuard, sharedPreset, presetGuard, creationGuard, creatorKey = '', agentsShared = false, authorsNoteShared = false, regexShared = false, cssSnippetsShared = false, dialogueColorsShared = false, mewmoryShared = false, sessionId = '', sharedLorebook = '', disabledEntriesListed = false, lorebookGuard } = {}) {
    if (change.type === 'preset') {
        const { preparePresetChange } = await import('./preset-changes.js');
        return preparePresetChange(change, sharedPreset, () => { requireSource(source); presetGuard?.(); });
    }
    if (['persona', 'persona-note'].includes(change.type) && change.action === 'create') {
        const { preparePersonaCreation } = await import('./persona-create.js');
        return preparePersonaCreation(change, source, { shared: sharedPersona, guard: change.type === 'persona-note' ? personaGuard : creationGuard, key: creatorKey });
    }
    if (change.type === 'persona' || change.type === 'persona-note') {
        const { preparePersonaChange } = await import('./persona-changes.js');
        return preparePersonaChange(change, source, sharedPersona, personaGuard);
    }
    if (change.type === 'creator') {
        const { CreatorSession } = await import('../creator/session.js');
        const { scratchpadCreatorDraft } = await import('../creator/scratchpad-draft.js');
        const client = new CreatorSession();
        if (!creatorKey) fail('This Catelier proposal needs its original Scratchpad message.');
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(creatorKey));
        const id = `scratchpad-${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 48)}`;
        return {
            target: change.name, field: 'Private Catelier draft', before: '', after: JSON.stringify(change, null, 2), editable: true,
            hint: 'This saves a private draft in Catelier, not a character in your library. Reapplying this proposal opens the same draft.',
            async commit(edited) {
                requireSource(source); client.assertOwner();
                let value;
                try { value = JSON.parse(edited); } catch { fail('The Catelier proposal must be valid JSON.'); }
                const draft = scratchpadCreatorDraft(value, id);
                try {
                    await client.request('get', { id });
                    requireSource(source);
                    return { creatorDraftId: id };
                } catch (error) { if (error.status !== 404) throw error; }
                requireSource(source);
                await client.request('save', { draft, expectedRevision: null });
                requireSource(source);
                return { creatorDraftId: id };
            },
        };
    }
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
                const draft = normaliseCharacterDraft(value);
                committed = saveCharacterDraft(draft, {
                    assert: () => requireSource(source), isCurrent: () => isCurrentSource(source),
                }).catch(error => {
                    committed = null;
                    throw error;
                });
                return committed;
            },
        };
    }
    if (change.type === 'agent') {
        if (!agentsShared) fail(t`Share Agents under Context before saving a change to one.`);
        return agentPlan(change);
    }
    if (change.type === 'authors-note') {
        if (!authorsNoteShared) fail(t`Share the Author's Note under Context before saving a change to it.`);
        return authorsNotePlan(change, source);
    }
    if (change.type === 'regex') {
        if (!regexShared) fail(t`Share Regexes under Context before saving a change to one.`);
        return regexPlan(change);
    }
    if (change.type === 'css-snippet') {
        if (!cssSnippetsShared) fail(t`Share CSS Snippets under Context before saving a change to one.`);
        return cssSnippetPlan(change);
    }
    if (change.type === 'dialogue-color') {
        if (!dialogueColorsShared) fail(t`Share Dialogue Colors under Context before saving a change to one.`);
        return dialogueColorPlan(change);
    }
    if (change.type === 'mewmory') {
        if (!mewmoryShared) fail(t`Share Mewmory under Context before saving a memory correction.`);
        return mewmoryPlan(change, source, sessionId);
    }
    if (change.type === 'lorebook') {
        if (source.kind === 'general' && (!sharedLorebook || change.book !== sharedLorebook)) fail(t`Share that lorebook under Context before saving a change to it.`);
        return lorebookPlan(change, source, { disabledEntriesListed, lorebookGuard });
    }
    if (change.type === 'character') {
        if (source.kind === 'general' && (!source.avatar || sharedAvatar !== source.avatar)) fail(t`Share the selected character card before requesting a change.`);
        return characterPlan(change, source);
    }
    return chatPlan(change, source);
}

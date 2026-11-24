import {
    chat,
    chat_metadata,
    characters,
    getOneCharacter,
    getRequestHeaders,
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
import { loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_names } from '../world-info.js';
import { deleteLorebookOriginalEntry, syncLorebookOriginalEntry } from '../neconyan-lorebook-tools-core.js';
import { currentSource, wireSource } from './context.js';
import { snapshotLorebookEntry } from './lorebook-fields.js';
import { characterFieldPatch, readCharacterField } from './character-fields.js';
import { refuseUndo, UndoConflictError, UndoUnavailableError } from './undo-errors.js';

export { UndoConflictError, UndoUnavailableError };

const CONFLICTS = {
    character: () => t`This character card was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    lorebook: () => t`This lorebook entry was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    'authors-note': () => t`The Author's Note was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    agent: () => t`This Agent was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    regex: () => t`This regex script was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    'css-snippet': () => t`This CSS snippet was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    'dialogue-color': () => t`This dialogue colour was changed after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    message: () => t`This message was changed after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    chat: () => t`This chat changed after Scratchpad saved the change, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
    mewmory: () => t`This memory was corrected again after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.`,
};

function conflict(area) {
    throw new UndoConflictError(CONFLICTS[area]());
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function requireChat(undo, source) {
    const live = currentSource();
    if (!undo.chatKey || live?.key !== undo.chatKey || (source && source.key !== undo.chatKey)) {
        refuseUndo(t`Open the chat this change was made in before undoing it.`);
    }
}

async function readBook(book) {
    if (!world_names?.includes(book)) await updateWorldInfoList();
    if (!world_names?.includes(book)) throw new UndoConflictError(t`The lorebook '${book}' no longer exists, so there is nothing to undo.`);
    const data = await loadWorldInfo(book);
    if (!data?.entries) throw new Error(t`The lorebook '${book}' could not be read.`);
    return data;
}

async function saveBook(book, data) {
    if (!await saveWorldInfo(book, data, true)) throw new Error(t`The lorebook was not restored. Try again in a moment.`);
}

async function undoLorebook(undo) {
    const data = await readBook(undo.book);
    const live = data.entries[undo.uid];
    if (undo.kind === 'lorebook-delete') {
        if (live) conflict('lorebook');
        data.entries[undo.uid] = structuredClone(undo.beforeEntry);
        syncLorebookOriginalEntry(data, String(undo.uid));
        return saveBook(undo.book, data);
    }
    if (!live || snapshotLorebookEntry(live) !== undo.afterSnapshot) conflict('lorebook');
    if (undo.kind === 'lorebook-add') {
        delete data.entries[undo.uid];
        deleteLorebookOriginalEntry(data, String(undo.uid));
    } else {
        data.entries[undo.uid] = structuredClone(undo.beforeEntry);
        syncLorebookOriginalEntry(data, String(undo.uid));
    }
    return saveBook(undo.book, data);
}

async function readCharacter(avatar) {
    const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, with_revision: true }),
        cache: 'no-cache',
    });
    if (response.status === 404) throw new UndoConflictError(t`That character no longer exists, so there is nothing to undo.`);
    if (!response.ok) throw new Error(t`The character could not be read. Try again in a moment.`);
    const revision = response.headers.get('X-Character-Revision') ?? '';
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error(t`The character could not be read. Try again in a moment.`);
    return { character: await response.json(), revision };
}

async function undoCharacter(undo) {
    const { character, revision } = await readCharacter(undo.avatar);
    if (!same(readCharacterField(character, undo.field), undo.after)) conflict('character');
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar: undo.avatar, expected_revision: revision, ...characterFieldPatch(undo.field, undo.before) }),
    });
    if (response.status === 409) conflict('character');
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || t`The character was not restored. Try again in a moment.`);
    }
    await getOneCharacter(undo.avatar);
    const index = characters.findIndex(item => item?.avatar === undo.avatar);
    if (index >= 0) {
        await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character: characters[index] } });
        if (String(index) === String(this_chid)) select_selected_character(this_chid, { switchMenu: false });
    }
}

async function undoAuthorsNote(undo, source) {
    requireChat(undo, source);
    if (String(chat_metadata?.note_prompt ?? '') !== undo.after) conflict('authors-note');
    chat_metadata.note_prompt = undo.before;
    try {
        if (await saveChatConditional({ throwOnError: true }) !== true) throw new Error(t`The Author's Note was not restored. Try again in a moment.`);
    } catch (error) {
        if (chat_metadata.note_prompt === undo.before) chat_metadata.note_prompt = undo.after;
        throw error;
    }
    const box = globalThis.document?.getElementById('extension_floating_prompt');
    if (box) box.value = undo.before;
}

async function undoStoredText(undo) {
    if (undo.kind === 'agent') {
        const store = await import('../extensions/in-chat-agents/agent-store.js');
        if (!store.getAgentById(undo.agent)) throw new UndoConflictError(t`That Agent no longer exists, so there is nothing to undo.`);
        let stale = false;
        try {
            await store.saveAgent(undo.agent, {
                update: current => {
                    if (String(current?.[undo.field] ?? '') !== undo.after) {
                        stale = true;
                        return null;
                    }
                    return { ...current, [undo.field]: undo.before };
                },
            });
        } catch (error) {
            if (error?.status === 409) conflict('agent');
            throw error;
        }
        if (stale) conflict('agent');
        return;
    }
    if (undo.kind === 'regex') {
        const engine = await import('../extensions/regex/engine.js');
        const script = engine.getScriptsByType(engine.SCRIPT_TYPES.GLOBAL).find(item => item?.id === undo.script);
        if (!script) throw new UndoConflictError(t`That regex script no longer exists, so there is nothing to undo.`);
        if (String(script[undo.field] ?? '') !== undo.after) conflict('regex');
        script[undo.field] = undo.before;
        engine.RegexProvider?.instance?.clear?.();
        await engine.saveScriptsByType(engine.getScriptsByType(engine.SCRIPT_TYPES.GLOBAL), engine.SCRIPT_TYPES.GLOBAL);
        try {
            await (await import('../extensions/regex/index.js')).loadRegexScripts?.();
        } catch (error) {
            console.warn('Scratchpad could not refresh the Regexes list.', error);
        }
        return;
    }
    const runtime = await import('../extensions/css-snippets/src/runtime.js');
    const snippet = (runtime.getSettings().snippetList ?? []).find(item => item?.id === undo.snippet && !item.isDeleted);
    if (!snippet) throw new UndoConflictError(t`That CSS snippet no longer exists, so there is nothing to undo.`);
    if (String(snippet[undo.field] ?? '') !== undo.after) conflict('css-snippet');
    snippet[undo.field] = undo.before;
    if (globalThis.document?.getElementById('csss--css-snippets')) {
        runtime.saveSnippet(snippet);
    } else {
        snippet.modifiedOn = Date.now();
        runtime.getCtx().saveSettingsDebounced();
    }
}

async function undoDialogueColor(undo) {
    const [state, palettes, ui] = await Promise.all([
        import('../extensions/third-party/sillytavern-character-colors/src/state.js'),
        import('../extensions/third-party/sillytavern-character-colors/src/palettes.js'),
        import('../extensions/third-party/sillytavern-character-colors/src/ui.js'),
    ]);
    const entry = state.characterColors?.[undo.key];
    if (!entry) throw new UndoConflictError(t`That character is no longer in the colour table, so there is nothing to undo.`);
    if (palettes.getBaseColor(entry) !== undo.after) conflict('dialogue-color');
    if (!ui.applyCharacterBaseColor(undo.key, undo.before, { saveImmediately: true })) throw new Error(t`The dialogue colour was not restored. Try again in a moment.`);
    try {
        ui.maybeAutoRecolorAfterColorChange();
        (await import('../extensions/third-party/sillytavern-character-colors/src/storage.js')).saveData();
    } catch (error) {
        console.warn('Scratchpad could not flush the Dialogue Colors save.', error);
    }
}

function snapshot(index) {
    const message = chat[index];
    return message ? `${message.name}${message.is_system ? ' (hidden)' : ''}\n${message.mes ?? ''}` : null;
}

async function saveMessages(options = {}) {
    if (await saveChatConditional({ ...options, throwOnError: true }) !== true) throw new Error(t`The chat was not saved. Try again in a moment.`);
}

async function undoMessage(undo, source) {
    requireChat(undo, source);
    const live = chat[undo.index];
    if (undo.kind === 'chat-edit') {
        if (!live || live.name !== undo.name || String(live.mes ?? '') !== undo.after) conflict('message');
        live.mes = undo.before;
        syncMesToSwipe(undo.index);
        await eventSource.emit(event_types.MESSAGE_EDITED, undo.index);
        updateMessageBlock(undo.index, live);
        await eventSource.emit(event_types.MESSAGE_UPDATED, undo.index);
        return saveMessages();
    }
    if (undo.kind === 'chat-visibility') {
        if (!live || live.name !== undo.name || String(live.mes ?? '') !== undo.mes || Boolean(live.is_system) !== Boolean(undo.hidden)) conflict('message');
        if (!await hideChatMessageRange(undo.index, undo.index, Boolean(undo.hidden))) throw new Error(t`The message visibility was not restored. Try again in a moment.`);
        return;
    }
    if (undo.kind === 'chat-insert') {
        if (!live || live.name !== undo.message?.name || String(live.mes ?? '') !== String(undo.message?.mes ?? '')) conflict('message');
        chat.splice(undo.index, 1);
        chat_metadata.tainted = true;
        try {
            await saveMessages({ allowShrink: true });
        } catch (error) {
            if (!chat.includes(live)) chat.splice(undo.index, 0, live);
            throw error;
        }
        return reloadCurrentChat();
    }
    // A deleted message goes back only while the messages around its old place are unchanged.
    if (chat.length !== undo.length || snapshot(undo.index - 1) !== undo.previous || snapshot(undo.index) !== undo.next) conflict('chat');
    const restored = structuredClone(undo.message);
    chat.splice(undo.index, 0, restored);
    chat_metadata.tainted = true;
    try {
        await saveMessages();
    } catch (error) {
        const at = chat.indexOf(restored);
        if (at >= 0) chat.splice(at, 1);
        throw error;
    }
    return reloadCurrentChat();
}

async function undoMewmory(undo, source) {
    requireChat(undo, source);
    const api = await import('./api.js');
    const wire = wireSource(source ?? currentSource());
    let current;
    try {
        current = await api.readMewmoryRecord(wire, undo.sessionId, undo.record);
    } catch (error) {
        if (error?.status === 404) throw new UndoConflictError(t`That memory is no longer saved, so there is nothing to undo.`);
        throw error;
    }
    const record = current?.record ?? current;
    if (String(record?.[undo.field] ?? '') !== undo.after) conflict('mewmory');
    try {
        await api.correctMewmoryRecord(wire, undo.sessionId, undo.record, { field: undo.field, value: undo.before, expected: undo.after, version: record.version });
    } catch (error) {
        if (error?.status === 409) conflict('mewmory');
        throw error;
    }
}

/** Put a saved Scratchpad change back the way it was, refusing when the target changed since. */
export async function undoChange(entry, source = null) {
    const undo = entry?.undo;
    if (!entry?.undoable || !undo || typeof undo.kind !== 'string') {
        refuseUndo(entry?.undoUnavailableReason || t`Automatic undo is not available for this change.`);
    }
    if (entry.status === 'undone') refuseUndo(t`That change was already undone.`);
    switch (undo.kind) {
        case 'lorebook-add':
        case 'lorebook-edit':
        case 'lorebook-delete':
            return undoLorebook(undo);
        case 'character':
            return undoCharacter(undo);
        case 'authors-note':
            return undoAuthorsNote(undo, source);
        case 'preset':
            return (await import('./preset-changes.js')).undoPresetChange(undo);
        case 'persona':
            return (await import('./persona-changes.js')).undoPersonaChange(undo);
        case 'agent':
        case 'regex':
        case 'css-snippet':
            return undoStoredText(undo);
        case 'dialogue-color':
            return undoDialogueColor(undo);
        case 'chat-edit':
        case 'chat-visibility':
        case 'chat-insert':
        case 'chat-delete':
            return undoMessage(undo, source);
        case 'mewmory':
            return undoMewmory(undo, source);
        default:
            return refuseUndo(t`Automatic undo is not available for this change.`);
    }
}

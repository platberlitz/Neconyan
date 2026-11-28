import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';
import {
    chatSaveNoticeKey,
    clearSaveFailureNotice,
    groupChatSaveNoticeKey,
    lastSaveFailure,
    noteSaveFailure,
    showUndoneChangeNotice,
} from '../public/scripts/save-failure-notices.js';
import { loadSaveFailureWording } from './save-failure-wording-vm.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declarations = ast.body.map(node => node.declaration ?? node);
const SLICED = [
    'captureUndoScope',
    'isUndoScopeCurrent',
    'cloneUndoValue',
    'messageUndoSeamIsIntact',
    'restoreMessageUndo',
    'createMessageUndoRecord',
    'getCurrentChatSaveNoticeKey',
    'prepareChatForDeletion',
    'showDeletionNotSavedNotice',
    'saveMessageDeletion',
    'deleteMessage',
];

const t = (strings, ...values) => String.raw({ raw: strings }, ...values);
const UNREACHABLE_DELETE = 'Neconyan could not reach its server, so nothing was deleted. Check your internet connection, then try again.';

function slice(name) {
    const node = declarations.find(candidate => candidate.id?.name === name);
    if (!node) throw new Error(`${name} is missing from public/script.js`);
    return source.slice(node.start, node.end);
}

function unconfirmed(reason) {
    return Object.assign(new Error('The save could not be confirmed. Keep a copy of your edits before reloading.'), {
        code: 'ROLEPLAY_SAVE_UNCERTAIN',
        reason,
    });
}

/**
 * Builds the delete path from public/script.js with a fake chat screen: one row per rendered message.
 * The fake save writes the chat to `disk` while the server is up and fails like an outage while it is down.
 */
function createDeleteRuntime({ chatName, group = false }) {
    const notices = [];
    const events = [];
    const server = { up: true, hold: null, saves: [] };
    const messages = ['Hello there.', 'A reply to delete.', 'The last word.'].map((mes, index) => ({
        mes,
        is_user: index % 2 === 0,
        swipes: [mes],
        swipe_id: 0,
        extra: { note: `message ${index}` },
    }));
    const runtime = vm.createContext({
        console: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
        structuredClone,
        t,
        chat: messages.slice(),
        chat_metadata: {},
        itemizedPrompts: [],
        this_edit_mes_id: undefined,
        this_chid: group ? undefined : 0,
        selected_group: group ? 'g1' : null,
        groups: [{ id: 'g1', chat_id: chatName }],
        characters: [{ avatar: 'bunny.png', chat: chatName }],
        chatGeneration: 1,
        activeUndoRecord: null,
        messageDeletionSave: null,
        disk: messages.map(message => structuredClone(message)),
        dom: [],
        document: { activeElement: null },
        HTMLElement: class {},
        lodash: { isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
        POPUP_TYPE: { CONFIRM: 'confirm' },
        POPUP_RESULT: { AFFIRMATIVE: 1 },
        callGenericPopup: jest.fn(async () => true),
        getChatExportOwnerKey: () => 'alice',
        getCurrentChatId: () => chatName,
        getChatGeneration: () => runtime.chatGeneration,
        getFirstDisplayedMessageId: () => 0,
        getUndoRenderSnapshot: () => ({ firstId: 0, lastId: runtime.chat.length - 1, count: runtime.chat.length, anchor: null }),
        renderRestoredMessageRows: () => {
            runtime.dom = runtime.chat.map(message => ({ message }));
        },
        restoreItemizedPrompts: jest.fn(),
        deleteItemizedPromptForMessage: jest.fn(),
        unobserveChatMessageResize: jest.fn(),
        updateViewMessageIds: jest.fn(),
        refreshSwipeButtons: jest.fn(),
        warnUndoConflict: jest.fn(),
        deleteSwipe: jest.fn(),
        isUndoRestoreBlocked: () => false,
        dismissUndo: () => { runtime.activeUndoRecord = null; },
        clearUndoRecord: () => { runtime.activeUndoRecord = null; },
        showUndoRecord: record => { runtime.activeUndoRecord = record; },
        chatSaveNoticeKey,
        groupChatSaveNoticeKey,
        lastSaveFailure,
        noteSaveFailure,
        toastr: {
            // Notices stay up for the whole test, as a toast would while the person reads it.
            error: jest.fn((message, title) => {
                notices.push({ message, title });
            }),
            warning: jest.fn(),
        },
        showUndoneChangeNotice: (key, message, title) => showUndoneChangeNotice(key, message, title, runtime.toastr.error),
        showSaveFailureNotice: (_key, message, title) => runtime.toastr.error(message, title),
        eventSource: { emit: jest.fn(async (name, value) => { events.push({ name, value }); }) },
        event_types: { MESSAGE_DELETED: 'message_deleted' },
    });
    runtime.dom = runtime.chat.map(message => ({ message }));
    runtime.chatElement = {
        find(selector) {
            const id = Number(/mesid="(-?\d+)"/.exec(selector)?.[1]);
            const row = runtime.dom[id];
            if (!row) return { length: 0, remove() {} };
            return { length: 1, remove: () => { runtime.dom.splice(runtime.dom.indexOf(row), 1); } };
        },
    };
    loadSaveFailureWording(runtime);
    const key = group ? groupChatSaveNoticeKey(chatName) : chatSaveNoticeKey('bunny.png', chatName);
    runtime.saveChatConditional = jest.fn(async (options = {}) => {
        server.saves.push({ options, chat: runtime.chat.slice() });
        if (server.hold) await server.hold;
        if (!server.up) {
            const error = unconfirmed('unreachable');
            const kind = runtime.reportChatSaveFailure(key, group ? 'Group Chat could not be saved' : 'Chat could not be saved', {
                error,
                quiet: options.quietSaveFailure === true,
            });
            if (options.throwOnError) throw runtime.markReportedSaveFailure(error, kind);
            return false;
        }
        runtime.disk = runtime.chat.map(message => structuredClone(message));
        clearSaveFailureNotice(key);
        return true;
    });
    for (const name of SLICED) vm.runInContext(slice(name), runtime);
    return { runtime, server, notices, events, key, messages };
}

const screenText = runtime => runtime.dom.map(row => row.message.mes);
const chatText = runtime => runtime.chat.map(message => message.mes);
const diskText = runtime => runtime.disk.map(message => message.mes);

describe('deleting a message while its chat cannot save', () => {
    test('a deletion that could not be saved goes back where it was, with one notice', async () => {
        const { runtime, server, notices, events, key, messages } = createDeleteRuntime({ chatName: 'Rollback chat' });
        server.up = false;

        await runtime.deleteMessage(1, undefined, false, { offerUndo: true });

        expect(runtime.chat[1]).toBe(messages[1]);
        expect(chatText(runtime)).toEqual(['Hello there.', 'A reply to delete.', 'The last word.']);
        expect(screenText(runtime)).toEqual(chatText(runtime));
        expect(diskText(runtime)).toEqual(chatText(runtime));
        expect(runtime.activeUndoRecord).toBeNull();
        expect(runtime.restoreItemizedPrompts).toHaveBeenCalledTimes(1);
        expect(notices).toEqual([{ title: 'Message not deleted', message: UNREACHABLE_DELETE }]);
        expect(events).toEqual([]);
        expect(lastSaveFailure(key)).toBe('unreachable');
        expect(server.saves[0].options).toEqual({ allowShrink: true, throwOnError: true, quietSaveFailure: true });
        expect(server.saves[0].chat).not.toContain(messages[1]);
    });

    test('a known save failure is checked first, and the message is not touched while it continues', async () => {
        const { runtime, server, notices, events, key, messages } = createDeleteRuntime({ chatName: 'Refusal chat' });
        noteSaveFailure(key, 'verifying');
        server.up = false;

        await runtime.deleteMessage(1, undefined, false, { offerUndo: true });

        expect(server.saves).toHaveLength(1);
        expect(server.saves[0].options).toEqual({ throwOnError: true, quietSaveFailure: true });
        expect(server.saves[0].chat).toContain(messages[1]);
        expect(runtime.chat).toEqual(messages);
        expect(screenText(runtime)).toEqual(chatText(runtime));
        expect(runtime.deleteItemizedPromptForMessage).not.toHaveBeenCalled();
        expect(runtime.activeUndoRecord).toBeNull();
        expect(notices).toEqual([{ title: 'Message not deleted', message: UNREACHABLE_DELETE }]);
        expect(events).toEqual([]);
    });

    test('once saves recover, the same deletion works and is saved', async () => {
        const { runtime, server, notices, events, key, messages } = createDeleteRuntime({ chatName: 'Recovery chat' });
        server.up = false;
        await runtime.deleteMessage(1, undefined, false, { offerUndo: true });
        expect(runtime.chat[1]).toBe(messages[1]);

        server.up = true;
        await runtime.deleteMessage(1, undefined, false, { offerUndo: true });

        expect(chatText(runtime)).toEqual(['Hello there.', 'The last word.']);
        expect(screenText(runtime)).toEqual(chatText(runtime));
        expect(diskText(runtime)).toEqual(chatText(runtime));
        expect(lastSaveFailure(key)).toBeNull();
        expect(runtime.activeUndoRecord?.label).toBe('Message deleted. Paw it back?');
        expect(events).toEqual([{ name: 'message_deleted', value: 2 }]);
        expect(notices).toHaveLength(1);
        // The pre-check save, then the deletion's own save.
        expect(server.saves.map(save => save.options.allowShrink === true)).toEqual([true, false, true]);
    });

    test('a second deletion waits for the first one to save, and both stay when it fails', async () => {
        const { runtime, server, notices, events, messages } = createDeleteRuntime({ chatName: 'Queued chat' });
        let release;
        server.up = false;
        server.hold = new Promise(resolve => { release = resolve; });

        const first = runtime.deleteMessage(1, undefined, false);
        await Promise.resolve();
        expect(chatText(runtime)).toEqual(['Hello there.', 'The last word.']);
        const second = runtime.deleteMessage(1, undefined, false);
        await Promise.resolve();
        expect(chatText(runtime)).toEqual(['Hello there.', 'The last word.']);

        release();
        server.hold = null;
        await Promise.all([first, second]);

        expect(runtime.chat).toEqual(messages);
        expect(runtime.chat[2]).toBe(messages[2]);
        expect(screenText(runtime)).toEqual(chatText(runtime));
        expect(events).toEqual([]);
        expect(notices).toEqual([{ title: 'Message not deleted', message: UNREACHABLE_DELETE }]);
    });

    test('a group chat deletion uses the group chat save record', async () => {
        const { runtime, server, notices, key, messages } = createDeleteRuntime({ chatName: 'Group rollback', group: true });
        server.up = false;

        await runtime.deleteMessage(0, undefined, false);

        expect(runtime.chat[0]).toBe(messages[0]);
        expect(screenText(runtime)).toEqual(chatText(runtime));
        expect(lastSaveFailure(key)).toBe('unreachable');
        expect(notices).toEqual([{ title: 'Message not deleted', message: UNREACHABLE_DELETE }]);
    });

    test('a deletion that cannot be put back keeps the chat save notice instead', async () => {
        const { runtime, server, notices, messages } = createDeleteRuntime({ chatName: 'Changed chat' });
        let release;
        server.up = false;
        server.hold = new Promise(resolve => { release = resolve; });

        const pending = runtime.deleteMessage(1, undefined, false);
        await Promise.resolve();
        runtime.chat.splice(0, 1);
        runtime.dom.splice(0, 1);
        release();
        server.hold = null;
        await pending;

        expect(runtime.chat).not.toContain(messages[1]);
        expect(notices).toEqual([{
            title: 'Chat could not be saved',
            message: 'Neconyan could not reach its server, so recent changes are not saved yet. Check your internet connection and keep this tab open. Neconyan tries again with your next change.',
        }]);
    });
});

describe('range deletion and /cut wiring', () => {
    const rangeStart = source.indexOf('// Neconyan: never take messages off screen while their chat cannot save.');
    const rangeHandler = source.slice(rangeStart, source.indexOf('await deletionPromise;', rangeStart));

    test('deleting from a message onwards checks the save first and puts the messages back if the save fails', () => {
        expect(rangeStart).toBeGreaterThan(0);
        expect(rangeHandler).toContain('const saveError = await prepareChatForDeletion(noticeKey);');
        expect(rangeHandler).toContain('showDeletionNotSavedNotice(noticeKey, saveError, t`Messages not deleted`);');
        expect(rangeHandler).toContain('const originals = chat.slice(startIndex);');
        expect(rangeHandler).toContain('saveMessageDeletion(record, originals, noticeKey, t`Messages not deleted`)');
        expect(rangeHandler).not.toContain('saveChatConditional({ allowShrink: true })');
        expect(rangeHandler.indexOf('prepareChatForDeletion')).toBeLessThan(rangeHandler.indexOf('chat.length = startIndex;'));
    });

    test('/cut stops at a message whose deletion was put back', () => {
        const powerUser = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
        const cut = powerUser.slice(powerUser.indexOf('async function doMesCut'), powerUser.indexOf('await saveChatConditional();', powerUser.indexOf('async function doMesCut')));
        expect(cut).toContain('await deleteMessage(mesIDToCut, null, false);');
        expect(cut).toMatch(/if \(target && chat\.includes\(target\)\) \{\n\s+return cutText;\n\s+\}\n\s+cutText \+= \(target\?\.mes \|\| ''\) \+ '\\n';/);
    });
});

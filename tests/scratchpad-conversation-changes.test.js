import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const store = { branch: null };
const conversationState = { generationActive: false, conversationReplyBusy: false };
const regenerationBusyKeys = new Set();
let saveResult = true;
let nextId = 1;
const getActiveConversationBranch = jest.fn((avatar, options) => (store.branch && avatar === 'Nova.png' && options.create === false && options.branchId === store.branch.id ? store.branch : null));
const saveConversationMessageThread = jest.fn(({ messages }) => { store.branch.messages = structuredClone(messages); });
const persistConversationStoreNow = jest.fn(async () => saveResult);
const createConversationMessage = jest.fn(({ role, name, mes }) => ({ id: `new-${nextId++}`, role, name, mes, extra: {} }));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''), translate: text => text }));
jest.unstable_mockModule('../public/scripts/scratchpad/context.js', () => ({
    sourceCharacters: () => [{ name: 'Nova' }],
    sourceUserName: () => 'Sam',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({ getActiveConversationBranch }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({ createConversationMessage }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-render.js', () => ({ saveConversationMessageThread }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ persistConversationStoreNow }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState, regenerationBusyKeys }));

const { conversationChatPlan, undoConversationChange } = await import('../public/scripts/scratchpad/conversation-changes.js');
const { normaliseChange } = await import('../public/scripts/scratchpad/proposals.js');
const { UndoConflictError, UndoUnavailableError } = await import('../public/scripts/scratchpad/undo-errors.js');

const source = { kind: 'conversation', key: 'conversation:t:b1', avatar: 'Nova.png', branchId: 'b1', groupId: '', personaId: 'sam.png' };
let current = true;
const isCurrentSource = jest.fn(() => current);
const conflict = jest.fn(area => {
    throw (area ? new UndoConflictError(`conflict:${area}`) : new Error('This changed while the review was open, so nothing was saved.'));
});
const tools = { conflict, isCurrentSource };
const messages = () => store.branch.messages;
const plan = value => conversationChatPlan(normaliseChange(value), source, tools);

beforeEach(() => {
    jest.clearAllMocks();
    current = true;
    saveResult = true;
    nextId = 1;
    conversationState.generationActive = false;
    conversationState.conversationReplyBusy = false;
    regenerationBusyKeys.clear();
    store.branch = { id: 'b1', preview: '', messages: [
        { id: 'm0', role: 'user', name: 'Sam', mes: 'Hello there.', extra: {} },
        { id: 'm1', role: 'character', name: 'Nova', mes: 'Hi, Sam.', extra: { token_count: 4 } },
        { id: 'm2', role: 'user', name: 'Sam', mes: 'How was the harbour?', extra: {} },
    ] };
});

describe('Conversation message changes', () => {
    test('edits a message, clears its token count, saves it now and records an undo receipt', async () => {
        const review = await plan({ type: 'chat', action: 'edit', message: 1, text: 'Hi, Sam. Welcome back.' });
        expect(review).toMatchObject({ target: 'Message #1 from Nova', field: 'Message text', before: 'Hi, Sam.', after: 'Hi, Sam. Welcome back.', editable: true });
        const result = await review.commit('Hi, Sam. The tide is in.');
        expect(messages()[1]).toEqual({ id: 'm1', role: 'character', name: 'Nova', mes: 'Hi, Sam. The tide is in.', extra: {} });
        expect(saveConversationMessageThread).toHaveBeenCalledWith(expect.objectContaining({ avatar: 'Nova.png', branchId: 'b1', groupId: '', personaId: 'sam.png' }));
        expect(persistConversationStoreNow).toHaveBeenCalledTimes(1);
        expect(result.undo).toEqual({ kind: 'conversation-edit', avatar: 'Nova.png', branchId: 'b1', groupId: '', personaId: 'sam.png', id: 'm1', index: 1, role: 'character', name: 'Nova', before: 'Hi, Sam.', after: 'Hi, Sam. The tide is in.' });

        await undoConversationChange(result.undo, { conflict });
        expect(messages()[1].mes).toBe('Hi, Sam.');
        expect(persistConversationStoreNow).toHaveBeenCalledTimes(2);
    });

    test('inserts after a message or at the start, using the persona and character names', async () => {
        const after = await plan({ type: 'chat', action: 'insert', after: 0, speaker: 'character', text: 'A gull lands.' });
        expect(after).toMatchObject({ target: 'After message #0', field: 'New message from Nova', before: '', editable: true });
        const inserted = await after.commit('A gull lands.');
        expect(messages().map(message => message.id)).toEqual(['m0', 'new-1', 'm1', 'm2']);
        expect(createConversationMessage).toHaveBeenLastCalledWith({ role: 'character', name: 'Nova', mes: 'A gull lands.' });
        expect(inserted.undo).toMatchObject({ kind: 'conversation-insert', id: 'new-1', index: 1, message: { id: 'new-1', role: 'character', name: 'Nova', mes: 'A gull lands.' } });

        const start = await plan({ type: 'chat', action: 'insert', after: -1, speaker: 'user', text: 'Morning.' });
        expect(start).toMatchObject({ target: 'At the start of the Conversation', field: 'New message from Sam' });
        await start.commit('Morning.');
        expect(messages()[0]).toMatchObject({ id: 'new-2', role: 'user', name: 'Sam', mes: 'Morning.' });

        await undoConversationChange(inserted.undo, { conflict });
        expect(messages().map(message => message.id)).toEqual(['new-2', 'm0', 'm1', 'm2']);
    });

    test('deletes a message and undo puts the whole message back in place', async () => {
        const review = await plan({ type: 'chat', action: 'delete', message: 1 });
        expect(review).toMatchObject({ field: 'Whole message', before: 'Hi, Sam.', after: '', editable: false });
        const result = await review.commit();
        expect(messages().map(message => message.id)).toEqual(['m0', 'm2']);
        expect(result.undo).toMatchObject({ kind: 'conversation-delete', id: 'm1', index: 1, message: { id: 'm1', mes: 'Hi, Sam.', extra: { token_count: 4 } } });
        await undoConversationChange(result.undo, { conflict });
        expect(messages().map(message => message.id)).toEqual(['m0', 'm1', 'm2']);
        expect(messages()[1].extra).toEqual({ token_count: 4 });
    });

    test.each(['hide', 'unhide'])('rejects %s, because Conversation messages cannot be hidden', async action => {
        await expect(plan({ type: 'chat', action, message: 0 })).rejects.toThrow('Conversation messages cannot be hidden.');
        expect(saveConversationMessageThread).not.toHaveBeenCalled();
    });

    test('refuses to save when the message, branch or open source changed, or a reply is running', async () => {
        const edit = await plan({ type: 'chat', action: 'edit', message: 0, text: 'Hello, Nova.' });
        messages()[0].mes = 'Edited by hand.';
        await expect(edit.commit('Hello, Nova.')).rejects.toThrow('changed while the review was open');

        const insert = await plan({ type: 'chat', action: 'insert', after: 1, text: 'Later.' });
        messages()[1].mes = 'Changed anchor.';
        await expect(insert.commit('Later.')).rejects.toThrow('changed while the review was open');

        const remove = await plan({ type: 'chat', action: 'delete', message: 2 });
        current = false;
        await expect(remove.commit()).rejects.toThrow('changed while the review was open');
        current = true;
        conversationState.generationActive = true;
        await expect(remove.commit()).rejects.toThrow('Wait for the Conversation reply to finish');
        conversationState.generationActive = false;
        store.branch = { ...store.branch, id: 'other' };
        await expect(remove.commit()).rejects.toThrow('changed while the review was open');
        expect(saveConversationMessageThread).not.toHaveBeenCalled();
    });

    test('a missing branch or message is refused before review', async () => {
        await expect(plan({ type: 'chat', action: 'edit', message: 9, text: 'x' })).rejects.toThrow('Message #9 is no longer in this Conversation.');
        await expect(plan({ type: 'chat', action: 'insert', after: 9, text: 'x' })).rejects.toThrow('Message #9 is no longer in this Conversation.');
        store.branch = null;
        await expect(plan({ type: 'chat', action: 'delete', message: 0 })).rejects.toThrow('This Conversation branch is no longer open');
    });

    test('puts the old thread back in memory when the store cannot be saved', async () => {
        saveResult = false;
        const review = await plan({ type: 'chat', action: 'edit', message: 0, text: 'Hello, Nova.' });
        await expect(review.commit('Hello, Nova.')).rejects.toThrow('could not be saved, so nothing was changed');
        expect(saveConversationMessageThread).toHaveBeenCalledTimes(2);
        expect(messages()[0].mes).toBe('Hello there.');

        persistConversationStoreNow.mockRejectedValueOnce(new Error('offline'));
        const remove = await plan({ type: 'chat', action: 'delete', message: 0 });
        await expect(remove.commit()).rejects.toThrow('could not be saved');
        expect(messages()).toHaveLength(3);
    });

    test('undo stops on later edits, missing branches and running replies', async () => {
        const result = await (await plan({ type: 'chat', action: 'edit', message: 2, text: 'How was it?' })).commit('How was it?');
        messages()[2].mes = 'Changed by hand afterwards.';
        await expect(undoConversationChange(result.undo, { conflict })).rejects.toBeInstanceOf(UndoConflictError);
        expect(messages()[2].mes).toBe('Changed by hand afterwards.');

        const removed = await (await plan({ type: 'chat', action: 'delete', message: 0 })).commit();
        messages().unshift({ id: 'm0', role: 'user', name: 'Sam', mes: 'Back again.' });
        await expect(undoConversationChange(removed.undo, { conflict })).rejects.toBeInstanceOf(UndoConflictError);

        conversationState.conversationReplyBusy = true;
        await expect(undoConversationChange(result.undo, { conflict })).rejects.toBeInstanceOf(UndoUnavailableError);
        conversationState.conversationReplyBusy = false;
        store.branch = null;
        await expect(undoConversationChange(result.undo, { conflict })).rejects.toThrow('no longer exists');
    });
});

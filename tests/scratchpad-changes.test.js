import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const source = { kind: 'roleplay', key: 'original' };
const chat = [];
let current = true;
let book;
const saveChatConditional = jest.fn(async () => true);
const updateMessageBlock = jest.fn();
const emit = jest.fn();
const hideChatMessageRange = jest.fn(async () => true);
const deleteMessage = jest.fn(async index => { chat.splice(index, 1); });
const loadWorldInfo = jest.fn(async () => structuredClone(book));
const saveWorldInfo = jest.fn(async () => 'Garden');

jest.unstable_mockModule('../public/script.js', () => ({
    chat, chat_metadata: {}, characters: [], deleteMessage, getOneCharacter: jest.fn(), getRequestHeaders: () => ({}),
    getThumbnailUrl: jest.fn(), name1: 'User', reloadCurrentChat: jest.fn(), saveChatConditional,
    select_selected_character: jest.fn(), syncMesToSwipe: jest.fn(), this_chid: 0, updateMessageBlock,
}));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hideChatMessageRange }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' }, eventSource: { emit } }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'user.png' }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { personas: {} } }));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ getMessageTimeStamp: () => 'today' }));
jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({ getNameAndAvatarForMessage: () => ({ name: 'Nova' }) }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    world_names: ['Garden'], updateWorldInfoList: jest.fn(), loadWorldInfo, saveWorldInfo,
    createWorldInfoEntry: (_name, data) => (data.entries[1] = { uid: 1 }),
    deleteWorldInfoEntry: async (data, uid) => { delete data.entries[uid]; },
}));
jest.unstable_mockModule('../public/scripts/scratchpad/context.js', () => ({ isCurrentSource: () => current, sourceCharacters: () => [{ name: 'Nova' }] }));

const { prepareChange } = await import('../public/scripts/scratchpad/changes.js');

beforeEach(() => {
    jest.clearAllMocks();
    saveChatConditional.mockReset().mockResolvedValue(true);
    hideChatMessageRange.mockReset().mockResolvedValue(true);
    current = true;
    chat.splice(0, chat.length, { name: 'Nova', mes: 'Original message.', is_system: false });
    book = { entries: { 0: { uid: 0, comment: 'Flower', key: ['flower'], content: 'Original lore.' } } };
});

describe('Scratchpad reviewed saves', () => {
    test.each(['add', 'edit', 'delete'])('refuses a lorebook %s after switching chats during the review', async action => {
        const plan = await prepareChange({ type: 'lorebook', action, book: 'Garden', uid: 0, content: 'New lore.' }, source);
        current = false;
        await expect(plan.commit(plan.after)).rejects.toThrow('changed');
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });

    test('does not report a discarded lorebook save as successful', async () => {
        const plan = await prepareChange({ type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'New lore.' }, source);
        saveWorldInfo.mockResolvedValueOnce(null);
        await expect(plan.commit(plan.after)).rejects.toThrow('not saved');
    });

    test('refuses lore changed after review and saves a fresh review', async () => {
        const change = { type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'New lore.' };
        const old = await prepareChange(change, source);
        book.entries[0].content = 'Another edit.';
        await expect(old.commit(old.after)).rejects.toThrow('changed');
        expect(saveWorldInfo).not.toHaveBeenCalled();
        const fresh = await prepareChange(change, source);
        await fresh.commit(fresh.after);
        expect(saveWorldInfo.mock.calls[0][1].entries[0].content).toBe('New lore.');
    });

    test.each(['edit', 'insert', 'delete', 'hide', 'unhide'])('does not report a failed message %s as successful', async action => {
        const plan = await prepareChange({ type: 'chat', action, message: 0, after: 0, text: 'New message.' }, source);
        saveChatConditional.mockResolvedValueOnce(false);
        hideChatMessageRange.mockResolvedValueOnce(false);
        await expect(plan.commit(plan.after)).rejects.toThrow('saved');
    });

    test.each(['edit', 'insert', 'delete', 'hide', 'unhide'])('accepts a saved message %s', async action => {
        const plan = await prepareChange({ type: 'chat', action, message: 0, after: 0, text: 'New message.' }, source);
        await expect(plan.commit(plan.after)).resolves.toBeUndefined();
    });

    test('does not render or save a message edit into the newly selected chat', async () => {
        const plan = await prepareChange({ type: 'chat', action: 'edit', message: 0, text: 'New message.' }, source);
        emit.mockImplementationOnce(async () => { current = false; });
        await expect(plan.commit(plan.after)).rejects.toThrow('changed');
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(saveChatConditional).not.toHaveBeenCalled();
    });
});

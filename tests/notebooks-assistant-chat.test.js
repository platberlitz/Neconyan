import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/assistant-chat.js', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replaceAll('export ', '').replaceAll('import(', 'load(');

function fixture() {
    let account = 'one';
    let chatId = 'old';
    let generation = 1;
    let activeBranch = 'old-branch';
    const composer = { value: '', closest: () => null, dispatchEvent: jest.fn() };
    const open = jest.fn(async () => 'miso.png');
    const create = jest.fn(() => { activeBranch = 'new-branch'; return { id: activeBranch }; });
    const flush = jest.fn(async () => true);
    const workspace = jest.fn(() => true);
    const shell = { getActiveMode: jest.fn(() => 'roleplay'), activateMode: jest.fn(async () => true) };
    const context = vm.createContext({
        characters: [{ avatar: 'miso.png' }], this_chid: 0, is_send_press: false, is_group_generating: false, selected_group: null,
        getCurrentUserHandle: () => account, getCurrentChatId: () => chatId, getChatGeneration: () => generation,
        doNewChat: jest.fn(async () => { chatId = 'new'; generation++; }),
        document: { querySelector: selector => selector === '#send_textarea' && chatId === 'old' ? null : selector === '#sb_conversation_input' && activeBranch === 'old-branch' ? null : composer },
        Event, setTimeout,
        NeconyanShell: shell,
        load: async path => path.includes('welcome-screen') ? { openBundledAssistant: open }
            : path.endsWith('context.js') ? { createConversationBranchForAvatar: create, getActiveConversationBranch: () => ({ id: activeBranch }) }
                : path.endsWith('store-sync.js') ? { flushConversationStore: flush } : { openConversationWorkspaceForAvatar: workspace },
    });
    vm.runInContext(source, context);
    return { context, composer, open, create, flush, workspace, shell, account: value => { account = value; }, branch: value => { activeBranch = value; } };
}

const note = { title: 'Scene ideas', text: '# A scene\n\nOnly this note.' };
const request = { assistantId: 'miso-neutral', mode: 'roleplay', note };

describe('Notes assistant discussion', () => {
    test('opens a new roleplay chat and prepares the full note without sending it', async () => {
        const f = fixture();
        const result = await f.context.prepareNoteDiscussion(request);
        expect(f.context.doNewChat).toHaveBeenCalledTimes(1);
        expect(f.open).toHaveBeenCalledWith('miso-neutral', expect.anything());
        expect(result.avatar).toBe('miso.png');
        expect(f.composer.value).toContain(note.text);
        expect(f.composer.dispatchEvent).toHaveBeenCalledTimes(1);
        expect(f.create).not.toHaveBeenCalled();
    });

    test('creates and saves a separate Conversation without copying old memory', async () => {
        const f = fixture();
        const result = await f.context.prepareNoteDiscussion({ ...request, mode: 'conversation' });
        expect(f.create).toHaveBeenCalledWith('miso.png', 'Notes: Scene ideas', { groupId: '', copyMemory: false });
        expect(f.flush).toHaveBeenCalledWith('one');
        expect(f.workspace).toHaveBeenCalledWith('miso.png', { branchId: 'new-branch', groupId: null, showToast: false });
        expect(result.branchId).toBe('new-branch');
        expect(f.context.doNewChat).not.toHaveBeenCalled();
        expect(f.composer.value).toContain(note.text);
    });

    test('closes Conversation before selecting a different assistant', async () => {
        const f = fixture();
        f.shell.getActiveMode.mockReturnValue('conversation');
        await f.context.prepareNoteDiscussion(request);
        expect(f.shell.activateMode).toHaveBeenCalledWith('roleplay');
        expect(f.shell.activateMode.mock.invocationCallOrder[0]).toBeLessThan(f.open.mock.invocationCallOrder[0]);
    });

    test.each([{ assistantId: 'stranger' }, { mode: 'invalid' }])('rejects unsupported choices before changing anything: %j', async patch => {
        const f = fixture();
        await expect(f.context.prepareNoteDiscussion({ ...request, ...patch })).rejects.toThrow('Choose an assistant');
        expect(f.open).not.toHaveBeenCalled();
    });

    test('does not start while a reply is running or the note changed', async () => {
        const f = fixture();
        f.context.is_send_press = true;
        await expect(f.context.prepareNoteDiscussion(request)).rejects.toThrow('note or chat changed');
        f.context.is_send_press = false;
        await expect(f.context.prepareNoteDiscussion({ ...request, isCurrent: () => false })).rejects.toThrow('note or chat changed');
        expect(f.open).not.toHaveBeenCalled();
    });

    test('keeps an existing unsent message draft', async () => {
        const f = fixture();
        f.context.document.querySelector = () => f.composer;
        f.composer.value = 'My unsent message';
        await expect(f.context.prepareNoteDiscussion(request)).rejects.toThrow('message draft');
        expect(f.composer.value).toBe('My unsent message');
        expect(f.open).not.toHaveBeenCalled();
    });

    test('does not fill a composer if the account changes during save', async () => {
        const f = fixture();
        f.flush.mockImplementation(async () => { f.account('two'); });
        await expect(f.context.prepareNoteDiscussion({ ...request, mode: 'conversation' })).rejects.toThrow('note or chat changed');
        expect(f.composer.value).toBe('');
        expect(f.workspace).not.toHaveBeenCalled();
    });

    test('does not reopen or share into a branch chosen during save', async () => {
        const f = fixture();
        f.flush.mockImplementation(async () => { f.branch('other-branch'); });
        await expect(f.context.prepareNoteDiscussion({ ...request, mode: 'conversation' })).rejects.toThrow('chat changed');
        expect(f.composer.value).toBe('');
        expect(f.workspace).not.toHaveBeenCalled();
    });

    test('does not share the note when the new conversation cannot be saved', async () => {
        const f = fixture();
        f.flush.mockResolvedValue(false);
        await expect(f.context.prepareNoteDiscussion({ ...request, mode: 'conversation' })).rejects.toThrow('conversation could not be saved');
        expect(f.composer.value).toBe('');
        expect(f.workspace).not.toHaveBeenCalled();
    });

    test('does not overwrite an existing chat when creating a new one fails', async () => {
        const f = fixture();
        f.context.doNewChat.mockImplementation(async () => {});
        await expect(f.context.prepareNoteDiscussion(request)).rejects.toThrow('existing chat was kept');
        expect(f.composer.value).toBe('');
    });
});

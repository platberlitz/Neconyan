import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => ['refreshCurrentChatFromSaved', 'adoptSavedChatTail'].includes(row.id?.name))
    .map(row => source.slice(row.start, row.end)).join('\n');

function fixture() {
    const no = () => {};
    const chat = [{ mes: 'Keep this reply.', extra: {} }];
    const reload = jest.fn();
    const redraw = jest.fn();
    const remove = jest.fn();
    const read = jest.fn(async () => ({ records: [{ chat_metadata: { stylePins: ['kept'] } }, ...chat, { mes: 'Saved reply.', extra: {} }], evidence: {} }));
    const runtime = vm.createContext({
        console, chat, chat_metadata: { stylePins: ['kept'] }, chatGeneration: 1,
        this_chid: 0, selected_group: null, characters: [{ avatar: 'nova.png' }], is_delete_mode: false,
        isChatSaving: false, this_edit_mes_id: undefined, hasPendingChatSave: () => false,
        getCurrentChatId: () => 'chat', captureChatRenderValidity: () => () => runtime.chatGeneration === 1,
        loadRoleplayChat: read, rememberRoleplayRead: () => true,
        reloadChatMutex: { isBusy: false }, reloadCurrentChat: reload,
        chatElement: { 0: { querySelector: selector => selector.startsWith('.mes') ? {} : null }, find: () => ({ remove }) },
        getRenderedChatMessageWindow: () => ({ renderedMessageCount: 1, firstMessageId: 0, lastMessageId: 0 }),
        getChatRenderWindowSize: () => 50, removeRenderedChatMessages: remove,
        cancelDebouncedMetadataSave: no, ensureMessageMediaIsArray: no,
        saveItemizedPrompts: async () => {}, loadItemizedPrompts: async () => {},
        takeChatReloadReadingAnchor: () => null, isChatScrolledNearBottom: () => true,
        redisplayChat: redraw, pruneRenderedChatMessagesToWindow: no, syncRenderedChatLastMessageClass: no,
        syncChatHistoryWindowControls: no, refreshSwipeButtons: no, scrollLoadedChatToBottomThroughLifecycle: no,
        holdChatReloadReadingAnchor: no, event_types: {}, eventSource: { emit: async () => {} },
    });
    vm.runInContext(functions, runtime);
    return { runtime, read, reload, redraw, remove, chat };
}

test('a failed saved read leaves the messages and styles on screen and propagates the failure', async () => {
    const { runtime, read, reload, redraw, remove, chat } = fixture();
    read.mockRejectedValue(new Error('Offline'));
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('Offline');
    expect(chat).toEqual([{ mes: 'Keep this reply.', extra: {} }]);
    expect(runtime.chat_metadata).toEqual({ stylePins: ['kept'] });
    expect(reload).not.toHaveBeenCalled();
    expect(redraw).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(runtime.reloadChatMutex.isBusy).toBe(false);
});

test.each(['saving', 'pending save', 'editing', 'reload busy', 'unadoptable read'])('%s cannot clear the chat or count as an adopted reply', async state => {
    const { runtime, reload, redraw, remove, chat } = fixture();
    if (state === 'saving') runtime.isChatSaving = true;
    if (state === 'pending save') runtime.hasPendingChatSave = () => true;
    if (state === 'editing') runtime.this_edit_mes_id = 0;
    if (state === 'reload busy') runtime.reloadChatMutex.isBusy = true;
    if (state === 'unadoptable read') runtime.rememberRoleplayRead = () => false;
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow();
    expect(chat).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(redraw).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
});

test.each(['tail', 'large change', 'replacement', 'group'])('%s refresh adopts the read without clearing chat identity or metadata', async kind => {
    const { runtime, read, reload, redraw, chat } = fixture();
    const extra = { inChatAgentTransformHistory: [{ beforeText: 'Draft.', afterText: 'Saved reply.' }] };
    const saved = kind === 'large change' ? Array.from({ length: 12 }, (_, index) => ({ mes: `Changed ${index}.`, extra: {} }))
        : kind === 'replacement' ? [] : [...chat];
    saved.push({ mes: 'Saved reply.', extra });
    read.mockResolvedValue({ records: [{ chat_metadata: { stylePins: ['kept'] } }, ...saved], evidence: {} });
    if (kind === 'replacement') runtime.chatElement[0].querySelector = () => null;
    if (kind === 'group') runtime.selected_group = 'group-1';
    await runtime.refreshCurrentChatFromSaved();
    expect(chat).toEqual(saved);
    expect(chat.at(-1).extra).toEqual(extra);
    expect(runtime.chatGeneration).toBe(1);
    expect(runtime.chat_metadata).toEqual({ stylePins: ['kept'] });
    expect(reload).not.toHaveBeenCalled();
    expect(redraw).toHaveBeenCalledTimes(1);
});

test('a saved read completing after navigation cannot change the newly opened chat', async () => {
    const { runtime, read, redraw, reload, chat } = fixture();
    read.mockImplementation(async () => {
        runtime.chatGeneration++;
        chat.splice(0, chat.length, { mes: 'Another chat.' });
        return { records: [{}, { mes: 'Stale reply.' }], evidence: {} };
    });
    await runtime.refreshCurrentChatFromSaved();
    expect(chat).toEqual([{ mes: 'Another chat.' }]);
    expect(redraw).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
});

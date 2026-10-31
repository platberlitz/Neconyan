import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';
import { beginRoleplaySave, bindRoleplayAccount, finishRoleplaySave, rememberRoleplayRead, sendRoleplaySave } from '../public/scripts/roleplay-save-chain.js';

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
        console, chat, chat_metadata: { stylePins: ['kept'] }, chatGeneration: 1, chatScrollVersion: 0, savedChatRedraw: null,
        this_chid: 0, selected_group: null, characters: [{ avatar: 'nova.png' }], is_delete_mode: false,
        isChatSaving: false, this_edit_mes_id: undefined, hasPendingChatSave: () => false,
        getCurrentChatId: () => 'chat', captureChatRenderValidity: () => () => runtime.chatGeneration === 1,
        loadRoleplayChat: read, rememberRoleplayRead: () => true,
        reloadChatMutex: { isBusy: false }, reloadCurrentChat: reload,
        chatElement: { 0: { querySelector: selector => selector.startsWith('.mes') ? {} : null }, find: selector => ({ remove: () => remove(selector) }) },
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

test('the preview remains until the saved tail has been rendered', async () => {
    const { runtime, redraw, remove } = fixture();
    redraw.mockImplementation(async options => {
        expect(options.atomic).toBe(true);
        expect(remove).not.toHaveBeenCalledWith('#neconyan-roleplay-preview');
        await Promise.resolve();
        expect(remove).not.toHaveBeenCalledWith('#neconyan-roleplay-preview');
    });
    await runtime.refreshCurrentChatFromSaved();
    expect(remove).toHaveBeenCalledWith('#neconyan-roleplay-preview');
});

test('an unchanged read preserves the detached original for a cancelled replacement to restore', async () => {
    const { runtime, read, redraw, remove, chat } = fixture();
    chat.push({ mes: 'Original reply.', extra: {} });
    // The original is held by the replacement marker, so the visible window ends before it.
    read.mockResolvedValue({ records: [{ chat_metadata: runtime.chat_metadata }, ...chat], evidence: {} });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalledWith('[data-roleplay-replacement]');
    expect(chat.at(-1).mes).toBe('Original reply.');
});

test.each([1, 2])('a kept thinking-only append redraws the detached source at %s and the new reply', async replacementIndex => {
    const { runtime, read, redraw, remove, chat } = fixture();
    chat.splice(0, chat.length, ...Array.from({ length: 3 }, (_, index) => ({ mes: `Original ${index}.`,
        swipes: ['Older alternative.', `Original ${index}.`], swipe_id: 1, extra: {} })));
    const originals = structuredClone(chat);
    const kept = { mes: '', extra: { reasoning: 'Paid thinking.',
        generation_outcome: { version: 1, status: 'error', reason: 'reasoning_only' } } };
    const visible = [0, 1, 2].filter(index => index !== replacementIndex);
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: visible.length,
        firstMessageId: visible[0], lastMessageId: visible.at(-1) });
    runtime.chatElement[0].querySelector = selector => {
        if (selector === '[data-roleplay-replacement]') return { dataset: { roleplayReplacement: String(replacementIndex) } };
        return /^\.mes\[mesid="(\d+)"\]$/.test(selector) && visible.includes(Number(selector.match(/\d+/)[0])) ? {} : null;
    };
    read.mockResolvedValue({ records: [{}, ...originals, kept], evidence: {} });
    let rendered;
    redraw.mockImplementation(async ({ startIndex, onCommit }) => {
        rendered = chat.slice(startIndex, startIndex + runtime.getChatRenderWindowSize());
        onCommit();
    });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(rendered).toContainEqual(originals[replacementIndex]);
    expect(rendered.at(-1)).toEqual(kept);
    expect(chat.slice(0, 3)).toEqual(originals);
    expect(remove).toHaveBeenCalledWith('[data-roleplay-replacement]');
});

test('a detached tail still follows its kept appended reply when earlier metadata fills the render window', async () => {
    const { runtime, read, redraw, chat } = fixture();
    chat.splice(0, chat.length, ...Array.from({ length: 50 }, (_, index) => ({ mes: `Reply ${index}.` })));
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: 49, firstMessageId: 0, lastMessageId: 48 });
    runtime.chatElement[0].querySelector = selector => selector === '[data-roleplay-replacement]'
        ? { dataset: { roleplayReplacement: '49' } } : selector.startsWith('.mes') ? {} : null;
    runtime.chatElement[0].clientHeight = 700;
    runtime.isChatScrolledNearBottom = () => false;
    runtime.takeChatReloadReadingAnchor = () => ({ messageId: 50, offsetTop: 100 });
    read.mockResolvedValue({ records: [{}, ...chat.map(message => ({ ...message, extra: {} })),
        { mes: '', extra: { reasoning: 'Kept thinking.' } }], evidence: {} });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 1, replaceRenderedWindow: true, atomic: true }));
});

test.each([true, false])('a full window follows the saved tail only while reading at the bottom: %s', async nearBottom => {
    const { runtime, read, redraw, chat } = fixture();
    chat.splice(0, chat.length, ...Array.from({ length: 50 }, (_, index) => ({ mes: `Reply ${index}.` })));
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: 50, firstMessageId: 0, lastMessageId: 49 });
    runtime.isChatScrolledNearBottom = () => nearBottom;
    read.mockResolvedValue({ records: [{}, ...chat.map(message => ({ ...message, extra: {} })), { mes: 'New reply.' }], evidence: {} });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledWith(expect.objectContaining({ startIndex: nearBottom ? 1 : 0, replaceRenderedWindow: nearBottom, atomic: true }));
});

test.each([1, 5, 50])('a %s-message window includes the finished reply while reading above its bottom', async windowSize => {
    const { runtime, read, redraw, chat } = fixture();
    chat.splice(0, chat.length, ...Array.from({ length: 60 }, (_, index) => ({ mes: `Reply ${index}.` })));
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: windowSize, firstMessageId: 60 - windowSize, lastMessageId: 59 });
    runtime.getChatRenderWindowSize = () => windowSize;
    runtime.chatElement[0].clientHeight = 700;
    runtime.isChatScrolledNearBottom = () => false;
    const anchor = { messageId: '60', offsetTop: -200 };
    runtime.takeChatReloadReadingAnchor = () => anchor;
    runtime.holdChatReloadReadingAnchor = jest.fn(() => true);
    runtime.scrollLoadedChatToBottomThroughLifecycle = jest.fn();
    // Earlier metadata changes require redrawing more than just the appended row.
    read.mockResolvedValue({ records: [{}, ...chat.map(message => ({ ...message, extra: {} })), { mes: 'Completed reply.' }], evidence: {} });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 61 - windowSize, replaceRenderedWindow: true, atomic: true }));
    expect(runtime.holdChatReloadReadingAnchor).toHaveBeenCalledWith(anchor, expect.any(Function));
    expect(runtime.scrollLoadedChatToBottomThroughLifecycle).not.toHaveBeenCalled();
});

test.each(['preview below viewport', 'older history', 'append only'])('saved readback preserves %s instead of rebuilding the tail unnecessarily', async scenario => {
    const { runtime, read, redraw, chat } = fixture();
    chat.splice(0, chat.length, ...Array.from({ length: 30 }, (_, index) => ({ mes: `Reply ${index}.` })));
    const older = scenario === 'older history';
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: 5, firstMessageId: older ? 10 : 25, lastMessageId: older ? 14 : 29 });
    runtime.getChatRenderWindowSize = () => 5;
    runtime.chatElement[0].clientHeight = 700;
    runtime.isChatScrolledNearBottom = () => false;
    runtime.takeChatReloadReadingAnchor = () => ({ messageId: '30', offsetTop: scenario === 'preview below viewport' ? 900 : 20 });
    const saved = scenario === 'append only' ? [...chat] : chat.map(message => ({ ...message, extra: {} }));
    read.mockResolvedValue({ records: [{}, ...saved, { mes: 'Completed reply.' }], evidence: {} });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledWith(expect.objectContaining({ startIndex: older ? 10 : scenario === 'append only' ? 30 : 25, replaceRenderedWindow: false }));
});

test('a failed redraw leaves the preview available and the next readback retries the redraw', async () => {
    const { runtime, read, redraw, remove, chat } = fixture();
    const previous = [...chat];
    read.mockResolvedValue({ records: [{ chat_metadata: { stylePins: ['new'] } }, ...previous, { mes: 'Final reply.' }], evidence: {} });
    redraw.mockRejectedValueOnce(new Error('Render interrupted'));
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('Render interrupted');
    expect(remove).not.toHaveBeenCalled();
    expect(chat.at(-1).mes).toBe('Final reply.');
    expect(runtime.chat_metadata).toEqual({ stylePins: ['new'] });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(chat.at(-1).mes).toBe('Final reply.');
    expect(runtime.chat_metadata).toEqual({ stylePins: ['new'] });
    expect(remove).toHaveBeenCalledWith('#neconyan-roleplay-preview');
});

test('an editor opened during prompt storage leaves the old data and preview intact', async () => {
    const { runtime, redraw, remove, chat } = fixture();
    runtime.loadItemizedPrompts = async () => { runtime.this_edit_mes_id = 0; };
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('not ready');
    expect(chat).toHaveLength(1);
    expect(redraw).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
});

test('a deleted row after a failed redraw cannot leave the completed reply outside the retry', async () => {
    const { runtime, read, redraw, chat } = fixture();
    chat.push({ mes: 'Second old reply.' });
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: 2, firstMessageId: 0, lastMessageId: 1 });
    read.mockResolvedValueOnce({ records: [{}, ...chat, { mes: 'Completed reply.' }], evidence: {} });
    redraw.mockRejectedValueOnce(new Error('Render interrupted'));
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('Render interrupted');
    // Deleting an earlier row renumbers the old visible messages and the new data.
    chat.splice(0, 1);
    runtime.getRenderedChatMessageWindow = () => ({ renderedMessageCount: 1, firstMessageId: 0, lastMessageId: 0 });
    read.mockResolvedValue({ records: [{}, ...chat], evidence: {} });
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(redraw).toHaveBeenLastCalledWith(expect.objectContaining({ startIndex: 0, replaceRenderedWindow: true }));
    expect(chat.at(-1).mes).toBe('Completed reply.');
});

test('a late pending save keeps the completed reply and does not interrupt its redraw', async () => {
    const { runtime, redraw, remove, chat } = fixture();
    redraw.mockImplementationOnce(async options => {
        runtime.hasPendingChatSave = () => true;
        expect(options.isCurrent()).toBe(true);
        expect(chat.at(-1).mes).toBe('Saved reply.');
    });
    await runtime.refreshCurrentChatFromSaved();
    expect(chat).toHaveLength(2);
    expect(remove).toHaveBeenCalledWith('#neconyan-roleplay-preview');
    expect(redraw).toHaveBeenCalledTimes(1);
});

test('a failed swipe redraw cannot restore old text for a save using the new read evidence', async () => {
    const { runtime, read, redraw, chat } = fixture();
    const saved = [{ mes: 'Paid new swipe.', extra: {} }];
    const account = { accountId: '11111111-1111-4111-8111-111111111111', dataEpoch: 1 };
    const source = { instanceId: '22222222-2222-4222-8222-222222222222', revision: 2, rawHash: 'a'.repeat(64) };
    const locator = { group: false, avatar: 'nova.png', chat: 'chat' };
    bindRoleplayAccount('failed-redraw-save', account);
    read.mockResolvedValue({ records: [{}, ...saved], evidence: { account, source } });
    runtime.rememberRoleplayRead = rememberRoleplayRead;
    redraw.mockImplementationOnce(async () => {
        runtime.hasPendingChatSave = () => true;
        throw new Error('Render interrupted');
    });
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('Render interrupted');
    // Run the real save serialisation before any readback retry. Its evidence
    // and text must both describe the new swipe, never old text with new authority.
    const token = beginRoleplaySave(locator, { operationKey: 'save-after-render-failure' });
    const send = jest.fn(async body => ({ ok: true, status: 200, json: async () => ({ ok: true, integrity: 'saved',
        roleplay: { account, source, changed: false, operationKey: JSON.parse(body).roleplay.operationKey } }) }));
    try {
        await expect(sendRoleplaySave(token, { avatar_url: locator.avatar, file_name: locator.chat, chat: [{}, ...chat] }, send)).resolves.toMatchObject({ ok: true });
    } finally {
        await finishRoleplaySave(token);
    }
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ chat: [{}, ...saved], roleplay: { source } });
    runtime.hasPendingChatSave = () => false;
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledTimes(2);
});

test('an open editor during preparation keeps the new data and retries the undrawn swipe', async () => {
    const { runtime, read, redraw, chat } = fixture();
    read.mockResolvedValue({ records: [{}, { mes: 'Paid new swipe.' }], evidence: {} });
    redraw.mockImplementationOnce(async options => {
        runtime.this_edit_mes_id = 0;
        expect(options.isCurrent()).toBe(false);
    });
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('not ready');
    expect(chat[0].mes).toBe('Paid new swipe.');
    runtime.this_edit_mes_id = undefined;
    await runtime.refreshCurrentChatFromSaved();
    expect(redraw).toHaveBeenCalledTimes(2);
});

test('scrolling while batches prepare prevents a stale jump to the bottom', async () => {
    const { runtime, redraw } = fixture();
    runtime.scrollLoadedChatToBottomThroughLifecycle = jest.fn();
    redraw.mockImplementation(async () => { runtime.chatScrollVersion++; });
    await runtime.refreshCurrentChatFromSaved();
    expect(runtime.scrollLoadedChatToBottomThroughLifecycle).not.toHaveBeenCalled();
});

test('a failure after navigation never rolls back the newly opened chat', async () => {
    const { runtime, redraw, chat } = fixture();
    redraw.mockImplementation(async () => {
        runtime.chatGeneration++;
        chat.splice(0, chat.length, { mes: 'Another chat.' });
        throw new Error('Stale render failed');
    });
    await expect(runtime.refreshCurrentChatFromSaved()).rejects.toThrow('Stale render failed');
    expect(chat).toEqual([{ mes: 'Another chat.' }]);
});

import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let chatId = 'first';
let generation = 1;
const listeners = new Map();
const conversationState = { conversationWorkspaceOpen: false };
const chat = [];
const chatMetadata = {};
const saveMetadata = jest.fn(async () => true);
let contextSize = 30;
let popupAnswer = 1;
const hideChatMessageRange = jest.fn(async (start, end, unhide, filter, options) => {
    for (let index = start; index <= end; index++) Object.assign(chat[index], { is_system: true, extra: { mewmoryKeepHidden: options?.keepInMewmory } });
    return true;
});
global.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn() };
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'default-user' }));
jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'Mara.png' }], this_chid: 0, chat_metadata: chatMetadata, is_send_press: false,
    getCurrentChatId: () => chatId, getChatGeneration: () => generation, chat, getMaxContextTokens: () => contextSize,
    flushPendingChatSaves: async () => true, getRequestHeaders: () => ({}), saveMetadata,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ is_group_generating: false, selected_group: null }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getFriendlyTokenizerName: () => ({ tokenizerKey: 'openai' }), getTokenCountAsync: async text => text.length,
}));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hideChatMessageRange }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' }, POPUP_RESULT: { AFFIRMATIVE: 1 }, Popup: class { show() { return popupAnswer; } },
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ uuidv4: () => 'memory-test-submission' }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text === 'Needs attention' ? 'Bitte überprüfen' : text,
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: new Proxy({}, { get: (_, name) => name }), eventSource: { on: (name, handler) => {
        const handlers = [...listeners.get(name)?.handlers || [], handler];
        listeners.set(name, Object.assign((...args) => handlers.map(item => item(...args)), { handlers }));
    } },
}));
const { enableMewmoryForNewChat, getMewmoryLocator, getMewmoryScope, getOverflowMessages, hideOverflowAutomatically, hideOverflowMessages, initMewmory, mewmory, notifyMewmory, prepareMewmoryGeneration, processMewmory, refreshMewmory, requestMewmory, stopMewmoryBackfill } = await import('../public/scripts/mewmory/index.js');
const config = { revision: 1, roles: {} };
const response = data => ({ ok: true, json: async () => data });

beforeEach(() => {
    generation++;
    chatId = 'first';
    conversationState.conversationWorkspaceOpen = false;
    for (const key of Object.keys(chatMetadata)) delete chatMetadata[key];
    saveMetadata.mockClear();
    global.window = Object.assign(new EventTarget(), { clearTimeout: jest.fn(), setTimeout: jest.fn() });
    global.document = { querySelectorAll: () => [] };
    global.fetch = jest.fn(async (url, { body }) => response(url.endsWith('config/get')
        ? { config, stories: [] } : { locator: JSON.parse(body).locator, enabled: false, revision: 1 }));
    Object.assign(mewmory, { view: null, config: null, stories: [], error: '', loading: false, busy: false, backfilling: false });
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('status labels are translated without changing the state used by the interface', () => {
    const button = { dataset: {}, setAttribute: jest.fn(), querySelector: () => null };
    global.document.querySelectorAll = () => [button];
    mewmory.error = 'A failed request';
    notifyMewmory();
    expect(button.dataset.mewmoryStatus).toBe('Needs attention');
    expect(button.title).toBe('Mewmory: Bitte überprüfen');
    expect(button.setAttribute).toHaveBeenCalledWith('aria-label', button.title);
});

test('new chats and branches load even without a listed archive or a mounted panel', async () => {
    for (const name of ['new-chat', 'branch']) {
        chatId = name;
        const view = await refreshMewmory();
        expect(view.locator.chat).toBe(name);
        expect(mewmory.loading).toBe(false);
    }
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('inspect'))).toHaveLength(2);
});

test('a late configuration reply cannot clear a newer chat or its error state', async () => {
    const delayed = Promise.withResolvers();
    fetch.mockImplementationOnce(() => delayed.promise);
    const first = refreshMewmory();
    chatId = 'second';
    generation++;
    await refreshMewmory();
    delayed.resolve(response({ config, stories: [] }));
    await first;
    expect(mewmory.view.locator.chat).toBe('second');
    expect(mewmory.error).toBe('');
});

test('newer refreshes win within the same chat, and successful loading clears an old error', async () => {
    const delayed = Promise.withResolvers();
    fetch.mockImplementationOnce(() => delayed.promise);
    const first = refreshMewmory({ query: 'old' });
    await refreshMewmory({ query: 'new' });
    delayed.resolve(response({ config, stories: [] }));
    await first;
    expect(mewmory.filters.query).toBe('new');
    mewmory.error = 'Earlier failure';
    await refreshMewmory();
    expect(mewmory.error).toBe('');
});

test('a multi-step action cannot send its next request to another chat', async () => {
    const scope = getMewmoryScope();
    chatId = 'second';
    await expect(requestMewmory('index', {}, { scope })).rejects.toThrow('active chat changed');
    expect(fetch).not.toHaveBeenCalled();
});

test('native chat changes and returning from Conversation load immediately', async () => {
    initMewmory();
    listeners.get('CHAT_CHANGED')();
    expect(fetch).toHaveBeenCalled();
    await refreshMewmory();
    conversationState.conversationWorkspaceOpen = true;
    global.window.dispatchEvent(new Event('sb:conversation-workspace-state-changed'));
    expect(getMewmoryLocator()).toBeNull();
    conversationState.conversationWorkspaceOpen = false;
    global.window.dispatchEvent(new Event('sb:conversation-workspace-state-changed'));
    await refreshMewmory();
    expect(mewmory.view.locator.chat).toBe('first');
});

test('first generation inspects its saved chat while the memory panel is closed', async () => {
    const messages = [{ mes: 'Hello', mewmorySourceIndex: 0 }];
    expect(await prepareMewmoryGeneration(messages)).toEqual({ enabled: false, chat: messages });
    expect(fetch.mock.calls.some(([url]) => url.endsWith('inspect'))).toBe(true);
});

test('backfill starts one server job, restores its status and cancels only on an explicit stop', async () => {
    initMewmory();
    let status = 'running';
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config, stories: [] });
        if (url.endsWith('process/cancel')) status = 'cancelled';
        return response({ locator: JSON.parse(body).locator, enabled: true, revision: 2,
            health: { pending: 100, processing: { status, all: true } } });
    });
    mewmory.view = { enabled: true, revision: 1 };
    await processMewmory({ all: true, checkpoint: true });
    const starts = fetch.mock.calls.filter(([url]) => url.endsWith('/process'));
    expect(starts).toHaveLength(1);
    expect(JSON.parse(starts[0][1].body)).toMatchObject({ all: true, checkpoint: true, background: true });
    expect(mewmory.backfilling).toBe(true);
    chatId = 'second';
    generation++;
    listeners.get('CHAT_CHANGED')();
    await refreshMewmory();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('process/cancel'))).toBe(false);
    expect(mewmory.busy).toBe(true);
    await stopMewmoryBackfill();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('process/cancel'))).toHaveLength(1);
    expect(mewmory.busy).toBe(false);
});

test('pending automatic work keeps status observation alive until the server starts or fails it', async () => {
    initMewmory();
    global.window.setTimeout.mockClear();
    let status = 'complete';
    fetch.mockImplementation(async (url, { body }) => response(url.endsWith('config/get')
        ? { config: { ...config, autoUpdate: true, roles: { extractor: { enabled: true } } }, stories: [] }
        : { locator: JSON.parse(body).locator, enabled: true, revision: 2, health: { pending: 1, processing: { status } } }));
    listeners.get('MESSAGE_SENT')();
    await global.window.setTimeout.mock.lastCall[0]();
    expect(global.window.setTimeout).toHaveBeenCalledTimes(2);
    expect(global.window.setTimeout.mock.lastCall[1]).toBe(15000);
    status = 'failed';
    await global.window.setTimeout.mock.lastCall[0]();
    expect(global.window.setTimeout).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/process'))).toBe(false);
});

test('generation waits for the newest overlapping refresh instead of treating a selected chat as unavailable', async () => {
    const firstConfig = Promise.withResolvers();
    const secondConfig = Promise.withResolvers();
    const started = Promise.withResolvers();
    fetch.mockImplementationOnce(() => { started.resolve(); return firstConfig.promise; });
    const messages = [{ mes: 'Hello', mewmorySourceIndex: 0 }];
    const generation = prepareMewmoryGeneration(messages);
    await started.promise;
    fetch.mockImplementationOnce(() => secondConfig.promise);
    const newer = refreshMewmory();
    firstConfig.resolve(response({ config, stories: [] }));
    secondConfig.resolve(response({ config, stories: [] }));
    await expect(generation).resolves.toEqual({ enabled: false, chat: messages });
    await newer;
    expect(mewmory.error).toBe('');
});

test('hiding old messages keeps the latest reply and what fits the context size, and marks them for Mewmory', async () => {
    const line = (is_user, mes, extra = {}) => ({ is_user, mes, ...extra });
    chat.splice(0, chat.length, line(true, 'aaaaaaaaaa'), line(false, 'bbbbbbbbbb'), line(true, 'cccccccccc', { is_system: true }),
        line(false, 'dddddddddd'), line(true, 'eeeeeeeeee'), line(false, 'ffffffffff'), line(true, 'gggggggggg'));
    contextSize = 30;
    expect((await getOverflowMessages()).indices).toEqual([0, 1, 3]);
    contextSize = 1;
    expect((await getOverflowMessages()).indices).toEqual([0, 1, 3, 4]);
    contextSize = 1000;
    expect((await getOverflowMessages()).indices).toEqual([]);

    contextSize = 30;
    popupAnswer = 0;
    expect(await hideOverflowMessages()).toBe(0);
    expect(hideChatMessageRange).not.toHaveBeenCalled();
    popupAnswer = 1;
    expect(await hideOverflowMessages()).toBe(3);
    expect(hideChatMessageRange.mock.calls.map(call => call.slice(0, 2))).toEqual([[0, 1], [3, 3]]);
    expect(hideChatMessageRange.mock.calls.every(call => call[4]?.keepInMewmory === true)).toBe(true);
    expect(chat.map(message => Boolean(message.is_system))).toEqual([true, true, true, true, false, false, false]);
});

test('automatic hiding runs after a reply only where Mewmory is on and the setting asks for it', async () => {
    initMewmory();
    const line = (is_user, mes, extra = {}) => ({ is_user, mes, ...extra });
    const reset = () => chat.splice(0, chat.length, line(true, 'aaaaaaaaaa'), line(false, 'bbbbbbbbbb'), line(true, 'cccccccccc', { is_system: true }),
        line(false, 'dddddddddd'), line(true, 'eeeeeeeeee'), line(false, 'ffffffffff'), line(true, 'gggggggggg'));
    reset();
    hideChatMessageRange.mockClear();
    contextSize = 1000;
    mewmory.view = { enabled: true, revision: 1 };
    mewmory.config = { ...config, autoHide: false, autoHideTokens: 30 };
    expect(await hideOverflowAutomatically()).toBe(0);
    mewmory.config.autoHide = true;
    mewmory.view.enabled = false;
    expect(await hideOverflowAutomatically()).toBe(0);
    expect(hideChatMessageRange).not.toHaveBeenCalled();

    mewmory.view.enabled = true;
    listeners.get('GENERATION_ENDED')();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(hideChatMessageRange.mock.calls.map(call => call.slice(0, 2))).toEqual([[0, 1], [3, 3]]);
    expect(hideChatMessageRange.mock.calls.every(call => call[4]?.keepInMewmory === true)).toBe(true);
    expect(global.toastr.info).toHaveBeenLastCalledWith('Hid 3 older messages past 30 tokens. Mewmory still remembers them.');
    expect(await hideOverflowAutomatically()).toBe(0);
});

const settle = async () => {
    for (let step = 0; step < 10; step++) await new Promise(resolve => setTimeout(resolve, 0));
};
const enabledCalls = () => fetch.mock.calls.filter(([url]) => url.endsWith('/enabled'));

test('every new chat turns Mewmory on once, and switching it off afterwards sticks', async () => {
    initMewmory();
    // Opening a chat already saves Mewmory's record once, so a brand-new chat is not at revision 0.
    let state = { enabled: false, revision: 1 };
    let settings = { ...config, enableNewChats: true };
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config: settings, stories: [] });
        if (url.endsWith('/enabled')) state = { enabled: JSON.parse(body).enabled, revision: state.revision + 1 };
        return response({ locator: JSON.parse(body).locator, ...state });
    });
    chat.splice(0, chat.length, { is_user: false, mes: 'Hello there' });
    const configured = jest.fn();
    global.window.addEventListener('mewmory:configured', configured);
    listeners.get('CHAT_CREATED')();
    await settle();
    expect(enabledCalls()).toHaveLength(1);
    expect(JSON.parse(enabledCalls()[0][1].body)).toMatchObject({ enabled: true, revision: 1, locator: { chat: 'first' } });
    expect(mewmory.view.enabled).toBe(true);
    expect(chatMetadata.mewmory_new_chat).toBe(true);
    expect(saveMetadata).toHaveBeenCalledTimes(1);
    expect(configured).toHaveBeenCalledTimes(1);

    state = { enabled: false, revision: 4 };
    await refreshMewmory();
    chat.push({ is_user: true, mes: 'One' });
    listeners.get('MESSAGE_SENT')();
    listeners.get('CHAT_CREATED')();
    await settle();
    expect(enabledCalls()).toHaveLength(1);

    delete chatMetadata.mewmory_new_chat;
    listeners.get('CHAT_CHANGED')();
    await settle();
    expect(enabledCalls()).toHaveLength(1);
    chat.push({ is_user: false, mes: 'Two' }, { is_user: true, mes: 'Three' });
    expect(await enableMewmoryForNewChat(await refreshMewmory())).toBe(false);
    chat.splice(1);
    settings = { ...config, enableNewChats: false };
    listeners.get('GROUP_CHAT_CREATED')();
    await settle();
    expect(enabledCalls()).toHaveLength(1);
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();
});

test('a new chat without a greeting turns Mewmory on with the first message', async () => {
    initMewmory();
    let state = { enabled: false, revision: 2 };
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config: { ...config, enableNewChats: true }, stories: [] });
        if (url.endsWith('/enabled')) state = { enabled: true, revision: 3 };
        return response({ locator: JSON.parse(body).locator, ...state });
    });
    chat.splice(0, chat.length, { is_user: true, mes: 'Hi' });
    await Promise.all(listeners.get('MESSAGE_SENT')());
    expect(enabledCalls()).toHaveLength(1);
    expect(mewmory.view.enabled).toBe(true);
    expect(chatMetadata.mewmory_new_chat).toBe(true);
});

test('generation, first-message and prompt preparation wait for a delayed new-chat enable while chat-created events do not block', async () => {
    initMewmory();
    const delayedEnable = Promise.withResolvers();
    const delayedSave = Promise.withResolvers();
    let state = { enabled: false, revision: 1 };
    saveMetadata.mockImplementationOnce(() => delayedSave.promise);
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config: { ...config, enableNewChats: true }, stories: [] });
        if (url.endsWith('/enabled')) {
            await delayedEnable.promise;
            state = { enabled: true, revision: 2 };
        }
        if (url.endsWith('/prepare')) return response({ excludedIndices: [], npcText: '', memoryText: 'Remembered', inspection: {} });
        return response({ locator: JSON.parse(body).locator, ...state });
    });
    chat.splice(0, chat.length, { is_user: false, mes: 'Hello there' });
    expect(listeners.get('CHAT_CREATED')()).toEqual([undefined]);
    expect(listeners.get('GENERATION_STARTED')('normal', {}, true)).toEqual([undefined]);
    await settle();
    expect(enabledCalls()).toHaveLength(1);
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();

    chat.push({ is_user: true, mes: 'First turn' });
    let generationResolved = false;
    let messageResolved = false;
    let preparedResolved = false;
    const started = Promise.all(listeners.get('GENERATION_STARTED')()).then(() => { generationResolved = true; });
    const sent = Promise.all(listeners.get('MESSAGE_SENT')()).then(() => { messageResolved = true; });
    const prepared = prepareMewmoryGeneration([{ mes: 'First turn', mewmorySourceIndex: 0 }]).then(result => {
        preparedResolved = true;
        return result;
    });
    await settle();
    expect(generationResolved).toBe(false);
    expect(messageResolved).toBe(false);
    expect(preparedResolved).toBe(false);
    expect(enabledCalls()).toHaveLength(1);

    delayedEnable.resolve();
    await settle();
    expect(chatMetadata.mewmory_new_chat).toBe(true);
    expect(saveMetadata).toHaveBeenCalledTimes(1);
    expect(generationResolved).toBe(false);
    expect(messageResolved).toBe(false);
    expect(preparedResolved).toBe(false);

    delayedSave.resolve(true);
    const [, , preparedResult] = await Promise.all([started, sent, prepared]);
    expect(generationResolved).toBe(true);
    expect(messageResolved).toBe(true);
    expect(preparedResolved).toBe(true);
    expect(preparedResult.memoryText).toBe('Remembered');
    expect(mewmory.view.enabled).toBe(true);
    expect(enabledCalls()).toHaveLength(1);

    chatId = 'group-first';
    generation++;
    delete chatMetadata.mewmory_new_chat;
    state = { enabled: false, revision: 1 };
    const delayedGroupEnable = Promise.withResolvers();
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config: { ...config, enableNewChats: true }, stories: [] });
        if (url.endsWith('/enabled')) {
            await delayedGroupEnable.promise;
            state = { enabled: true, revision: 2 };
        }
        return response({ locator: JSON.parse(body).locator, ...state });
    });
    chat.splice(0, chat.length, { is_user: false, mes: 'Group greeting' });
    expect(listeners.get('GROUP_CHAT_CREATED')()).toEqual([undefined]);
    let groupGenerationResolved = false;
    const groupStarted = Promise.all(listeners.get('GENERATION_STARTED')()).then(() => { groupGenerationResolved = true; });
    await settle();
    expect(groupGenerationResolved).toBe(false);
    delayedGroupEnable.resolve();
    await groupStarted;
    expect(mewmory.view.enabled).toBe(true);
    expect(chatMetadata.mewmory_new_chat).toBe(true);
});

test('a failed new-chat enable leaves no marker and retries on a later event, including after a 409 conflict', async () => {
    initMewmory();
    let attempts = 0;
    let state = { enabled: false, revision: 1 };
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config: { ...config, enableNewChats: true }, stories: [] });
        if (url.endsWith('/enabled')) {
            attempts++;
            if (attempts === 1) return { ok: false, status: 500, json: async () => ({ error: 'Temporary failure' }) };
            if (attempts === 2) {
                state = { enabled: false, revision: 3 };
                return { ok: false, status: 409, json: async () => ({ error: 'Mewmory changed somewhere else.' }) };
            }
            state = { enabled: true, revision: state.revision + 1 };
        }
        return response({ locator: JSON.parse(body).locator, ...state });
    });
    chat.splice(0, chat.length, { is_user: false, mes: 'Greeting' });
    expect(listeners.get('CHAT_CREATED')()).toEqual([undefined]);
    await settle();
    expect(enabledCalls()).toHaveLength(1);
    expect(mewmory.view.enabled).toBe(false);
    expect(mewmory.error).toBe('Temporary failure');
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();
    expect(saveMetadata).not.toHaveBeenCalled();

    chat.push({ is_user: true, mes: 'Try again' });
    await Promise.all(listeners.get('MESSAGE_SENT')());
    expect(enabledCalls()).toHaveLength(3);
    expect(JSON.parse(enabledCalls()[1][1].body).revision).toBe(1);
    expect(JSON.parse(enabledCalls()[2][1].body).revision).toBe(3);
    expect(mewmory.view.enabled).toBe(true);
    expect(mewmory.error).toBe('');
    expect(chatMetadata.mewmory_new_chat).toBe(true);
    expect(saveMetadata).toHaveBeenCalledTimes(1);
});

test('stopping generation, aborting a request signal, or timing out ends the wait without cancelling the enable', async () => {
    initMewmory();
    let delayedEnable = Promise.withResolvers();
    let state = { enabled: false, revision: 1 };
    fetch.mockImplementation(async (url, { body }) => {
        if (url.endsWith('config/get')) return response({ config: { ...config, enableNewChats: true }, stories: [] });
        if (url.endsWith('/enabled')) {
            const outcome = await delayedEnable.promise;
            if (outcome?.error) return { ok: false, status: 500, json: async () => ({ error: outcome.error }) };
            state = { enabled: true, revision: 2 };
        }
        return response({ locator: JSON.parse(body).locator, ...state });
    });

    chat.splice(0, chat.length, { is_user: false, mes: 'Greeting' });
    expect(listeners.get('CHAT_CREATED')()).toEqual([undefined]);
    const abortController = new AbortController();
    const signalWait = Promise.all(listeners.get('GENERATION_STARTED')('normal', { signal: abortController.signal }));
    abortController.abort();
    await signalWait;
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();

    const stopWait = Promise.all(listeners.get('GENERATION_STARTED')());
    listeners.get('GENERATION_STOPPED')();
    await stopWait;
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();

    delayedEnable.resolve();
    await settle();
    expect(mewmory.view.enabled).toBe(true);
    expect(chatMetadata.mewmory_new_chat).toBe(true);

    chatId = 'timeout-chat';
    generation++;
    delete chatMetadata.mewmory_new_chat;
    state = { enabled: false, revision: 1 };
    delayedEnable = Promise.withResolvers();
    jest.useFakeTimers();
    expect(listeners.get('CHAT_CREATED')()).toEqual([undefined]);
    let timedOutResolved = false;
    const timedOutWait = Promise.all(listeners.get('GENERATION_STARTED')()).then(() => { timedOutResolved = true; });
    await jest.advanceTimersByTimeAsync(15000);
    await timedOutWait;
    expect(timedOutResolved).toBe(true);
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();
    expect(listeners.get('GENERATION_STARTED')()).toEqual([undefined]);
    jest.useRealTimers();

    delayedEnable.resolve();
    await settle();
    expect(mewmory.view.enabled).toBe(true);
    expect(chatMetadata.mewmory_new_chat).toBe(true);

    chatId = 'timeout-error-chat';
    generation++;
    delete chatMetadata.mewmory_new_chat;
    state = { enabled: false, revision: 1 };
    delayedEnable = Promise.withResolvers();
    jest.useFakeTimers();
    expect(listeners.get('CHAT_CREATED')()).toEqual([undefined]);
    const failingTimeoutWait = Promise.all(listeners.get('GENERATION_STARTED')());
    await jest.advanceTimersByTimeAsync(15000);
    await failingTimeoutWait;
    jest.useRealTimers();

    delayedEnable.resolve({ error: 'Late failure after timeout' });
    await settle();
    expect(mewmory.error).toBe('Late failure after timeout');
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();
});

test('switching chats while new-chat enable is pending leaves the new chat and its metadata untouched', async () => {
    initMewmory();
    const delayedEnable = Promise.withResolvers();
    fetch.mockImplementation(async (url, { body }) => {
        const locator = JSON.parse(body || '{}').locator;
        if (url.endsWith('config/get')) return response({ config: { ...config, enableNewChats: true }, stories: [] });
        if (url.endsWith('/enabled')) {
            await delayedEnable.promise;
            return response({ locator, enabled: true, revision: 2 });
        }
        return response({ locator, enabled: false, revision: 1 });
    });
    chat.splice(0, chat.length, { is_user: false, mes: 'Greeting' });
    expect(listeners.get('CHAT_CREATED')()).toEqual([undefined]);
    await settle();
    expect(enabledCalls()).toHaveLength(1);

    const started = Promise.all(listeners.get('GENERATION_STARTED')());
    chatId = 'second';
    generation++;
    listeners.get('CHAT_CHANGED')();
    await started;
    await refreshMewmory();

    delayedEnable.resolve();
    await settle();
    expect(mewmory.view.locator.chat).toBe('second');
    expect(mewmory.view.enabled).toBe(false);
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();
    expect(saveMetadata).not.toHaveBeenCalled();
    expect(mewmory.error).toBe('');
});

test('explicitly disabled chats, disabled auto-enable and normal sends add no requests or waiting', async () => {
    initMewmory();
    chat.splice(0, chat.length, { is_user: true, mes: 'Hi' });
    mewmory.config = { ...config, enableNewChats: false };
    mewmory.view = { locator: { chat: 'first' }, enabled: false, revision: 1 };
    fetch.mockClear();
    expect(listeners.get('GENERATION_STARTED')()).toEqual([undefined]);
    await Promise.all(listeners.get('MESSAGE_SENT')());
    expect(fetch).not.toHaveBeenCalled();
    expect(chatMetadata.mewmory_new_chat).toBeUndefined();

    mewmory.config = { ...config, enableNewChats: true };
    chatMetadata.mewmory_new_chat = true;
    expect(listeners.get('GENERATION_STARTED')()).toEqual([undefined]);
    await Promise.all(listeners.get('MESSAGE_SENT')());
    expect(fetch).not.toHaveBeenCalled();
    expect(mewmory.view.enabled).toBe(false);

    mewmory.view = { locator: { chat: 'first' }, enabled: true, revision: 2 };
    expect(listeners.get('GENERATION_STARTED')()).toEqual([undefined]);
    await Promise.all(listeners.get('MESSAGE_SENT')());
    expect(fetch).not.toHaveBeenCalled();
});

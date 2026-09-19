import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let chatId = 'first';
let generation = 1;
const listeners = new Map();
const conversationState = { conversationWorkspaceOpen: false };
jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'Mara.png' }], this_chid: 0, chat_metadata: {}, is_send_press: false,
    getCurrentChatId: () => chatId, getChatGeneration: () => generation,
    flushPendingChatSaves: async () => true, getRequestHeaders: () => ({}),
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ is_group_generating: false, selected_group: null }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getFriendlyTokenizerName: () => ({ tokenizerKey: 'openai' }) }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ uuidv4: () => 'memory-test-submission' }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: new Proxy({}, { get: (_, name) => name }), eventSource: { on: (name, handler) => listeners.set(name, handler) },
}));
const { getMewmoryLocator, getMewmoryScope, initMewmory, mewmory, prepareMewmoryGeneration, processMewmory, refreshMewmory, requestMewmory, stopMewmoryBackfill } = await import('../public/scripts/mewmory/index.js');
const config = { revision: 1, roles: {} };
const response = data => ({ ok: true, json: async () => data });

beforeEach(() => {
    generation++;
    chatId = 'first';
    conversationState.conversationWorkspaceOpen = false;
    global.window = Object.assign(new EventTarget(), { clearTimeout: jest.fn(), setTimeout: jest.fn() });
    global.document = { querySelectorAll: () => [] };
    global.fetch = jest.fn(async (url, { body }) => response(url.endsWith('config/get')
        ? { config, stories: [] } : { locator: JSON.parse(body).locator, enabled: false, revision: 1 }));
    Object.assign(mewmory, { view: null, config: null, stories: [], error: '', loading: false, busy: false, backfilling: false });
});
afterEach(() => jest.restoreAllMocks());

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

/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockOaiSettings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-4-turbo',
};
const mockCharacters = [{ chat: 'cache-test' }];
const mockStorage = {
    getItem: jest.fn(async () => ({})),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
};

await jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: {
        createInstance: () => mockStorage,
    },
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: mockCharacters,
    event_types: {},
    eventSource: { on: jest.fn() },
    main_api: 'openai',
    nai_settings: {},
    online_status: 'no_connection',
    this_chid: 0,
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { tokenizer: 0 },
    registerDebugFunction: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: { OPENAI: 'openai', OPENAI_RESPONSES: 'openai_responses' },
    model_list: [],
    oai_settings: mockOaiSettings,
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: [],
    selected_group: null,
}));

// A real (if crude) hash, so distinct messages get distinct cache keys. The point of these
// tests is that priming and counting agree on the key, which a constant hash would hide.
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getStringHash: jest.fn((value) => {
        let hash = 0;
        for (let i = 0; i < String(value).length; i++) {
            hash = (Math.imul(31, hash) + String(value).charCodeAt(i)) | 0;
        }
        return hash;
    }),
}));

await jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({
    kai_flags: {},
    kai_settings: {},
}));

await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: {},
    textgenerationwebui_settings: { type: 'ooba' },
    getTextGenServer: jest.fn(() => ''),
    getTextGenModel: jest.fn(() => ''),
}));

await jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(),
    getCurrentOpenRouterModelTokenizer: jest.fn(),
    openRouterModels: [],
}));

const {
    countTokensOpenAI,
    countTokensOpenAIAsync,
    getTokenCount,
    getTokenCountAsync,
    getTokenizerModel,
    guesstimate,
    initTokenizers,
    primeOpenAITokenCache,
    resetTokenCache,
    saveTokenCache,
} = await import('../public/scripts/tokenizers.js');

/**
 * Distinct messages, so every one of them needs its own cache entry. The token cache is
 * module state that outlives a single test, so each test passes its own tag to stay isolated.
 */
/** Shared token-count budget across every cached chat in public/scripts/tokenizers.js. */
const CACHE_LIMIT = 16384;

function makeMessages(count, tag) {
    return Array.from({ length: count }, (_, i) => ({ role: 'assistant', content: `${tag} message number ${i}` }));
}

describe('OpenAI token cache priming', () => {
    beforeEach(async () => {
        globalThis.jQuery = { ajax: jest.fn() };
        mockOaiSettings.chat_completion_source = 'openai';
        mockOaiSettings.openai_model = 'gpt-4-turbo';
        mockCharacters[0].chat = 'cache-test';
        mockStorage.setItem.mockClear();
        mockStorage.getItem.mockResolvedValue({});
        await resetTokenCache({ toast: false });
    });

    test.each(['openai', 'openai_responses'])('uses the selected Astra model for %s token counts', async (source) => {
        mockOaiSettings.chat_completion_source = source;
        mockOaiSettings.openai_model = 'gpt-6-astra';
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [7] });

        expect(getTokenizerModel()).toBe('gpt-6-astra');
        await primeOpenAITokenCache(makeMessages(1, source));
        expect(globalThis.jQuery.ajax.mock.calls[0][0].url).toContain('model=gpt-6-astra');
    });

    test('counts a whole batch of messages in a single request', async () => {
        const messages = makeMessages(25, 'batch');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: messages.map(() => 7) });

        await primeOpenAITokenCache(messages);

        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
        const request = globalThis.jQuery.ajax.mock.calls[0][0];
        expect(request.url).toContain('per_message=1');
        expect(JSON.parse(request.data)).toHaveLength(25);
    });

    test('primed counts are reused by countTokensOpenAIAsync without further requests', async () => {
        const messages = makeMessages(3, 'reuse');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [11, 22, 33] });

        await primeOpenAITokenCache(messages);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);

        // This is the contract that matters: the key primeOpenAITokenCache writes has to be
        // the key countTokensOpenAIAsync looks up, or priming silently does nothing.
        const counts = [];
        for (const message of messages) {
            counts.push(await countTokensOpenAIAsync(message, true));
        }

        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
        expect(counts).toEqual([-1 + 11, -1 + 22, -1 + 33]);
    });

    test('skips messages that are already cached', async () => {
        const messages = makeMessages(2, 'skip');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [5, 6] });

        await primeOpenAITokenCache(messages);
        await primeOpenAITokenCache(messages);

        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
    });

    test('sends each distinct message once even when the history repeats one', async () => {
        const repeated = { role: 'user', content: 'same text' };
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [9] });

        await primeOpenAITokenCache([repeated, { ...repeated }, { ...repeated }]);

        expect(JSON.parse(globalThis.jQuery.ajax.mock.calls[0][0].data)).toHaveLength(1);
    });

    test('a failed prime leaves counting to the unbatched path', async () => {
        const messages = makeMessages(2, 'failed');
        globalThis.jQuery.ajax.mockRejectedValue({ status: 500, statusText: 'Server Error', readyState: 4 });

        await expect(primeOpenAITokenCache(messages)).resolves.toBeUndefined();

        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 4 });
        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(-1 + 4);
    });

    test('ignores a response that does not line up with the request', async () => {
        const messages = makeMessages(3, 'mismatch');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: [1, 2] });

        await primeOpenAITokenCache(messages);

        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 8 });
        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(-1 + 8);
    });

    test('does nothing when given no messages', async () => {
        await primeOpenAITokenCache([]);
        await primeOpenAITokenCache(undefined);

        expect(globalThis.jQuery.ajax).not.toHaveBeenCalled();
    });

    test('bounds saved counts in a long-running chat and recounts evicted messages exactly', async () => {
        const messages = makeMessages(CACHE_LIMIT + 1, 'long-chat');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: messages.map(() => 17) });
        await primeOpenAITokenCache(messages);
        await saveTokenCache();

        const saved = mockStorage.setItem.mock.calls.at(-1)[1];
        expect(Object.keys(saved['cache-test'])).toHaveLength(CACHE_LIMIT);
        expect(await countTokensOpenAIAsync(messages.at(-1), true)).toBe(16);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);

        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 17 });
        expect(await countTokensOpenAIAsync(messages[0], true)).toBe(16);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(2);
    });

    test('keeps recently read counts when a full chat cache needs space', async () => {
        const messages = makeMessages(CACHE_LIMIT, 'recent-count');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: messages.map(() => 17), token_count: 17 });
        await primeOpenAITokenCache(messages);
        await countTokensOpenAIAsync(messages[0], true);
        await countTokensOpenAIAsync({ role: 'user', content: 'new count' }, true);
        await countTokensOpenAIAsync(messages[0], true);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(2);

        await countTokensOpenAIAsync(messages[1], true);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(3);
    });

    test('bounds visited chats while keeping a recently revisited chat', async () => {
        const message = { role: 'user', content: 'chat cache lifetime' };
        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 9 });
        for (let index = 0; index < 8; index++) {
            mockCharacters[0].chat = `chat-${index}`;
            await countTokensOpenAIAsync(message, true);
        }
        mockCharacters[0].chat = 'chat-0';
        await countTokensOpenAIAsync(message, true);
        mockCharacters[0].chat = 'chat-8';
        await countTokensOpenAIAsync(message, true);
        await saveTokenCache();

        const saved = mockStorage.setItem.mock.calls.at(-1)[1];
        expect(Object.keys(saved)).toHaveLength(8);
        expect(saved['chat-0']).toBeDefined();
        expect(saved['chat-1']).toBeUndefined();
        expect(saved['chat-8']).toBeDefined();
    });

    test('trims a legacy cache on load and preserves recent reusable counts', async () => {
        const messages = makeMessages(2049, 'persisted');
        globalThis.jQuery.ajax.mockResolvedValue({ token_counts: messages.map(() => 17) });
        await primeOpenAITokenCache(messages);
        await saveTokenCache();
        const counts = mockStorage.setItem.mock.calls.at(-1)[1]['cache-test'];
        const oversizedCounts = { old: 1, ...counts, extra: 2 };
        mockStorage.getItem.mockResolvedValue(Object.fromEntries(
            Array.from({ length: 20 }, (_, index) => [`saved-${index}`, oversizedCounts]),
        ));

        await initTokenizers();
        await saveTokenCache();
        const saved = mockStorage.setItem.mock.calls.at(-1)[1];
        expect(Object.keys(saved)).toHaveLength(8);
        expect(Object.values(saved).reduce((total, chat) => total + Object.keys(chat).length, 0)).toBe(CACHE_LIMIT);
        expect(saved['saved-0']).toBeUndefined();
        mockCharacters[0].chat = 'saved-19';
        expect(await countTokensOpenAIAsync(messages.at(-1), true)).toBe(16);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(1);
    });

    test('an in-flight count cannot return its evicted chat to the cache', async () => {
        let finish;
        globalThis.jQuery.ajax.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = countTokensOpenAIAsync({ role: 'user', content: 'pending' }, true);
        globalThis.jQuery.ajax.mockResolvedValue({ token_count: 9 });
        for (let index = 0; index < 9; index++) {
            mockCharacters[0].chat = `other-${index}`;
            await countTokensOpenAIAsync({ role: 'user', content: 'other' }, true);
        }
        finish({ token_count: 15 });
        expect(await pending).toBe(14);
        await saveTokenCache();
        const saved = mockStorage.setItem.mock.calls.at(-1)[1];
        expect(Object.keys(saved)).toHaveLength(8);
        expect(saved['cache-test']).toBeUndefined();
    });

    test('loading a bounded cache avoids rewriting browser storage', async () => {
        mockStorage.getItem.mockResolvedValue({ 'cache-test': { 'gpt-4-123': 5 } });
        await initTokenizers();
        expect(mockStorage.setItem).not.toHaveBeenCalled();
        await saveTokenCache();
        expect(mockStorage.setItem.mock.calls.at(-1)[1]).toEqual({ 'cache-test': { 'gpt-4-123': 5 } });
    });

    test('invalid persisted buckets and counts are discarded rather than reused', async () => {
        mockStorage.getItem.mockResolvedValue({
            invalid: [12],
            'cache-test': { valid: 0, notNumeric: '12', notFinite: Infinity, missing: null },
        });
        await initTokenizers();
        expect(mockStorage.setItem.mock.calls.at(-1)[1]).toEqual({ 'cache-test': { valid: 0 } });
    });

    test('a history longer than the cache still counts in windows without per-message requests', async () => {
        const messages = makeMessages(4096, 'windowed-history');
        globalThis.jQuery.ajax.mockImplementation(async ({ data }) => ({ token_counts: JSON.parse(data).map(() => 17) }));

        // The prompt builder prepares 64 messages at a time, then reads those counts.
        for (let offset = 0; offset < messages.length; offset += 64) {
            const window = messages.slice(offset, offset + 64);
            await primeOpenAITokenCache(window);
            for (const message of window) {
                expect(await countTokensOpenAIAsync(message, true)).toBe(16);
            }
        }
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(64);
        await saveTokenCache();
        expect(Object.keys(mockStorage.setItem.mock.calls.at(-1)[1]['cache-test'])).toHaveLength(4096);
    });

    test('regenerating a long chat history reuses its counts instead of recounting every window', async () => {
        // A 3,000-message history, scanned newest to oldest on every generation. A per-chat
        // cap below the history length makes each pass evict the counts the next pass needs.
        const messages = makeMessages(3000, 'regenerated-history');
        globalThis.jQuery.ajax.mockImplementation(async ({ data }) => ({ token_counts: JSON.parse(data).map(() => 17) }));
        const generate = async () => {
            for (let offset = 0; offset < messages.length; offset += 64) {
                const window = messages.slice(offset, offset + 64);
                await primeOpenAITokenCache(window);
                for (const message of window) await countTokensOpenAIAsync(message, true);
            }
        };

        await generate();
        const firstPassRequests = globalThis.jQuery.ajax.mock.calls.length;
        expect(firstPassRequests).toBe(Math.ceil(messages.length / 64));
        await generate();
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(firstPassRequests);
    });

    test('a long active chat takes space from older chats before losing its own counts', async () => {
        const message = { role: 'user', content: 'older chat count' };
        globalThis.jQuery.ajax.mockImplementation(async ({ data }) => ({ token_counts: JSON.parse(data).map(() => 17), token_count: 9 }));
        mockCharacters[0].chat = 'older-chat';
        await countTokensOpenAIAsync(message, true);
        await saveTokenCache();
        expect(Object.keys(mockStorage.setItem.mock.calls.at(-1)[1]['older-chat'])).toHaveLength(1);

        mockCharacters[0].chat = 'active-chat';
        const messages = makeMessages(CACHE_LIMIT, 'active-chat');
        for (let offset = 0; offset < messages.length; offset += 64) {
            await primeOpenAITokenCache(messages.slice(offset, offset + 64));
        }
        await saveTokenCache();

        const saved = mockStorage.setItem.mock.calls.at(-1)[1];
        expect(saved['older-chat']).toBeUndefined();
        expect(Object.keys(saved['active-chat'])).toHaveLength(CACHE_LIMIT);
    });

    test('legacy synchronous counts share the bounded cache with asynchronous counts', async () => {
        const messages = makeMessages(CACHE_LIMIT + 1, 'sync-count');
        globalThis.jQuery.ajax.mockImplementation(({ success }) => success({ token_count: 17 }));
        for (const message of messages) expect(countTokensOpenAI(message, true)).toBe(16);
        expect(await countTokensOpenAIAsync(messages.at(-1), true)).toBe(16);
        expect(globalThis.jQuery.ajax).toHaveBeenCalledTimes(CACHE_LIMIT + 1);
        await saveTokenCache();
        expect(Object.keys(mockStorage.setItem.mock.calls.at(-1)[1]['cache-test'])).toHaveLength(CACHE_LIMIT);
    });

    test('plain-text counts stay bounded across synchronous and asynchronous callers', async () => {
        for (let index = 0; index < CACHE_LIMIT + 1; index++) {
            const text = `plain-text ${index}`;
            // Unset padding matches the shadow-prompt path for this mocked connection.
            const count = index % 2 ? getTokenCount(text) : await getTokenCountAsync(text);
            expect(count).toBe(guesstimate(text));
        }
        await saveTokenCache();
        expect(Object.keys(mockStorage.setItem.mock.calls.at(-1)[1]['cache-test'])).toHaveLength(CACHE_LIMIT);
        expect(globalThis.jQuery.ajax).not.toHaveBeenCalled();
    });

    test('resetting during an in-flight count keeps the cleared cache empty', async () => {
        let finish;
        globalThis.jQuery.ajax.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = countTokensOpenAIAsync({ role: 'user', content: 'reset while pending' }, true);
        await resetTokenCache({ toast: false });
        finish({ token_count: 15 });
        expect(await pending).toBe(14);
        await saveTokenCache();
        expect(mockStorage.setItem.mock.calls.at(-1)[1]).toEqual({});
    });
});

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const welcomeSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'welcome-screen.js'), 'utf8').replace(/\r\n/g, '\n');

function functionSource(name) {
    return (welcomeSource.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '').replace(/^export /, '');
}

function classSource(name) {
    return welcomeSource.match(new RegExp(`^class ${name} \\{[\\s\\S]*?^}\\n`, 'm'))?.[0] ?? '';
}

const pinnedChatsManagerSource = classSource('PinnedChatsManager');
const recentChatsSource = [
    functionSource('getRecentChatsSettings'),
    functionSource('saveRecentChatsSettings'),
    functionSource('invalidateRecentChats'),
    functionSource('getRecentChatsRequestKey'),
    functionSource('fetchRecentChatsData'),
    functionSource('requestRecentChatsData'),
    functionSource('shouldSeparateAgentRecentChats'),
    functionSource('isAgentRecentChat'),
    functionSource('getRecentChatType'),
    functionSource('getRecentChats'),
].join('\n');

function createRuntime({ rawData = [], responseOk = true, deferFetch = false } = {}) {
    const state = {
        owner: 'alice',
        characters: [{ avatar: 'Nova.png', name: 'Nova' }],
        groups: [],
        conversationChats: [],
        storage: new Map(),
        fetchCount: 0,
        requests: [],
        responseOk,
        rawData,
        deferFetch,
        pending: [],
        resolveNext(data = state?.rawData) {
            const pending = state.pending.shift();
            pending?.resolve({ ok: state.responseOk, json: async () => structuredClone(data) });
        },
    };
    const context = vm.createContext({
        console,
        structuredClone,
        AbortSignal: { timeout: () => undefined },
        HOME_REQUEST_TIMEOUT_MS: 30000,
        recentChatsSettingsKey: 'recentChatsSettings',
        pinnedChatsKey: 'pinnedChats',
        DEFAULT_MAX_DISPLAYED: 15,
        DEFAULT_COLLAPSED_DISPLAYED: 3,
        AGENT_MESSAGE_EXTRA_KEY: 'inChatAgents',
        AGENT_PROMPT_TRANSFORM_HISTORY_KEY: 'inChatAgentTransformHistory',
        accountStorage: {
            getItem: key => state.storage.has(key) ? state.storage.get(key) : null,
            setItem: (key, value) => state.storage.set(key, value),
            removeItem: key => state.storage.delete(key),
        },
        getCurrentUserHandle: () => state.owner,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getThumbnailUrlForViewport: () => 'thumbnail.png',
        system_avatar: 'system.png',
        timestampToMoment: value => ({ value: Number(value) || 0, format: format => `${format}:${value}` }),
        sortMoments: (first, second) => second.value - first.value,
        fetch: (url, options) => {
            state.fetchCount++;
            state.requests.push({ url, ...options });
            if (state.deferFetch) {
                return new Promise(resolve => {
                    state.pending.push({ resolve, data: state.rawData });
                });
            }
            return Promise.resolve({
                ok: state.responseOk,
                json: async () => structuredClone(state.rawData),
            });
        },
        getRecentConversationChats: async () => state.conversationChats,
        characters: state.characters,
        groups: state.groups,
        extension_settings: {},
    });
    context.globalThis = context;
    context.state = state;
    context.owner = state.owner;
    context.characters = state.characters;
    context.groups = state.groups;
    context.getCurrentUserHandle = () => context.owner;
    vm.runInContext(`
        let recentChatsInFlight = null;
        ${pinnedChatsManagerSource}
        ${recentChatsSource}
        this.PinnedChatsManager = PinnedChatsManager;
        this.getRecentChats = getRecentChats;
        this.invalidateRecentChats = invalidateRecentChats;
        this.saveRecentChatsSettings = saveRecentChatsSettings;
    `, context);
    return { ...context, state, setOwner: owner => { context.owner = owner; } };
}

const rawChat = {
    file_name: 'Chat.jsonl',
    avatar: 'Nova.png',
    group: '',
    last_mes: 1000,
    is_conversation: false,
    chat_metadata: {},
};

describe('recent chat request sharing', () => {
    let runtime;

    beforeEach(() => {
        runtime = createRuntime({ rawData: [structuredClone(rawChat)] });
    });

    test('shares one in-flight request between Home and the rail', async () => {
        const first = runtime.getRecentChats();
        const second = runtime.getRecentChats();
        const [home, rail] = await Promise.all([first, second]);

        expect(runtime.state.fetchCount).toBe(1);
        expect(home).toEqual(rail);
        expect(home[0]).toMatchObject({ chat_name: 'Chat', char_name: 'Nova' });
    });

    test('fetches fresh data after an earlier request completed', async () => {
        await runtime.getRecentChats();
        runtime.state.rawData = [{ ...rawChat, file_name: 'Newer.jsonl', last_mes: 2000 }];
        const refreshed = await runtime.getRecentChats();

        expect(runtime.state.fetchCount).toBe(2);
        expect(refreshed[0].chat_name).toBe('Newer');
    });

    test('does not let callers join a request invalidated while pending', async () => {
        runtime = createRuntime({ rawData: [{ ...rawChat, file_name: 'Before.jsonl' }], deferFetch: true });
        const before = runtime.getRecentChats();
        runtime.invalidateRecentChats();
        const after = runtime.getRecentChats();
        expect(runtime.state.fetchCount).toBe(2);

        runtime.state.resolveNext([{ ...rawChat, file_name: 'Before.jsonl' }]);
        runtime.state.resolveNext([{ ...rawChat, file_name: 'After.jsonl' }]);

        await expect(before).resolves.toEqual([expect.objectContaining({ chat_name: 'Before' })]);
        await expect(after).resolves.toEqual([expect.objectContaining({ chat_name: 'After' })]);
    });

    test('does not share an in-flight request across accounts', async () => {
        runtime = createRuntime({ rawData: [rawChat], deferFetch: true });
        const first = runtime.getRecentChats();
        runtime.setOwner('bob');
        const second = runtime.getRecentChats();
        expect(runtime.state.fetchCount).toBe(2);

        runtime.state.resolveNext([{ ...rawChat, file_name: 'Alice.jsonl' }]);
        runtime.state.resolveNext([{ ...rawChat, file_name: 'Bob.jsonl' }]);

        await expect(first).resolves.toEqual([expect.objectContaining({ chat_name: 'Alice' })]);
        await expect(second).resolves.toEqual([expect.objectContaining({ chat_name: 'Bob' })]);
    });

    test('pin changes send the new pin shape on the next request', async () => {
        await runtime.getRecentChats();
        runtime.PinnedChatsManager.toggle({ avatar: 'Nova.png', group: '', file_name: 'Chat.jsonl' }, true);
        await runtime.getRecentChats();

        expect(runtime.state.fetchCount).toBe(2);
        expect(JSON.parse(runtime.state.requests[1].body).pinned).toHaveLength(1);
    });

    test('settings changes send the new request shape', async () => {
        await runtime.getRecentChats();
        runtime.state.storage.set('recentChatsSettings', JSON.stringify({ maxDisplayed: 5, collapsedDisplayed: 2 }));
        await runtime.getRecentChats();

        expect(runtime.state.fetchCount).toBe(2);
        expect(JSON.parse(runtime.state.requests[1].body).max).toBe(5);
    });

    test('gives each concurrent consumer its own copy', async () => {
        const [home, rail] = await Promise.all([runtime.getRecentChats(), runtime.getRecentChats()]);
        home[0].chat_metadata.changed = true;
        home[0].char_name = 'Mutated';

        expect(rail[0].chat_metadata.changed).toBeUndefined();
        expect(rail[0].char_name).toBe('Nova');
        expect(runtime.state.rawData[0].chat_metadata.changed).toBeUndefined();
    });

    test('keeps each raw response immutable while building display rows', async () => {
        const raw = runtime.state.rawData[0];
        const first = await runtime.getRecentChats();
        const second = await runtime.getRecentChats();

        expect(raw.char_name).toBeUndefined();
        expect(first[0].char_name).toBe('Nova');
        expect(second[0].char_name).toBe('Nova');
        expect(runtime.state.fetchCount).toBe(2);
    });

    test('picks up external, send and import style updates on the next read', async () => {
        const first = await runtime.getRecentChats();
        expect(first.map(chat => chat.chat_name)).toEqual(['Chat']);

        // Representative of another device, a send, or an import changing the
        // server list without a Home/rail event.
        runtime.state.rawData = [
            { ...rawChat, file_name: 'External.jsonl', last_mes: 2000 },
            { ...rawChat, file_name: 'Imported.jsonl', last_mes: 3000 },
        ];
        runtime.state.characters[0].name = 'Nova Renamed';
        runtime.state.groups.push({ id: 'group', name: 'Group' });
        runtime.state.rawData.push({ ...rawChat, avatar: '', group: 'group', file_name: 'Group.jsonl', last_mes: 4000 });

        const second = await runtime.getRecentChats();
        expect(runtime.state.fetchCount).toBe(2);
        expect(second.map(chat => chat.chat_name)).toEqual(['Group', 'Imported', 'External']);
        expect(second.find(chat => chat.chat_name === 'External').char_name).toBe('Nova Renamed');
    });

    test('retries after a failed request', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        runtime.state.responseOk = false;
        await expect(runtime.getRecentChats()).resolves.toEqual([]);
        runtime.state.responseOk = true;
        await expect(runtime.getRecentChats()).resolves.toHaveLength(1);
        expect(runtime.state.fetchCount).toBe(2);
        jest.restoreAllMocks();
    });
});

describe('welcome startup listener order', () => {
    test('invalidates before opening Home on chat change', async () => {
        const calls = [];
        const handlers = new Map();
        const eventTypes = new Proxy({}, { get: (_target, key) => String(key) });
        const eventSource = {
            on(event, handler) {
                if (!event) return;
                if (!handlers.has(event)) handlers.set(event, []);
                handlers.get(event).push(handler);
            },
            makeFirst(event, handler) {
                if (!handlers.has(event)) handlers.set(event, []);
                const list = handlers.get(event);
                const index = list.indexOf(handler);
                if (index >= 0) list.splice(index, 1);
                list.unshift(handler);
            },
            async emit(event, ...args) {
                for (const handler of [...(handlers.get(event) ?? [])]) {
                    await handler(...args);
                }
            },
        };
        const context = vm.createContext({
            console,
            eventSource,
            event_types: eventTypes,
            PinnedChatsManager: { init() { } },
            ensureNeconyanRail() { },
            installChatNoteCapture() { },
            releaseChromeAfterBootSkeleton() { },
            applySimpleMode() { },
            SIMPLE_MODE_EVENT: 'simple',
            concealWelcomeHome() { },
            createForegroundRefreshCoalescer: () => ({ request() { } }),
            window: { addEventListener() { }, setTimeout() { return 0; }, clearTimeout() { } },
            document: { hidden: false, addEventListener() { }, body: { classList: { contains: () => false } } },
            getCurrentChatId: () => undefined,
            chat: [],
            openWelcomeScreen: async () => { calls.push('open'); },
            invalidateRecentChats: () => { calls.push('invalidate'); },
            scheduleNeconyanRailRefresh() { },
            syncNeconyanAssistantTools() { },
            resumeTutorial() { },
            accountStorage: { getItem: () => null, setItem() { }, removeItem() { } },
            assignCharacterAsAssistant() { },
        });
        context.globalThis = context;
        vm.runInContext(functionSource('initWelcomeScreen'), context);
        context.initWelcomeScreen();

        await eventSource.emit(eventTypes.CHAT_CHANGED);

        expect(calls).toContain('open');
        expect(calls.indexOf('invalidate')).toBe(0);
        expect(calls.indexOf('open')).toBeGreaterThan(calls.indexOf('invalidate'));
    });

    test('APP_READY starts one shared recent request for Home and the rail', async () => {
        const runtime = createRuntime({ rawData: [rawChat], deferFetch: true });
        const calls = [];
        const handlers = new Map();
        const eventTypes = new Proxy({}, { get: (_target, key) => String(key) });
        const eventSource = {
            on(event, handler) {
                if (!event) return;
                if (!handlers.has(event)) handlers.set(event, []);
                handlers.get(event).push(handler);
            },
            makeFirst(event, handler) {
                if (!handlers.has(event)) handlers.set(event, []);
                handlers.get(event).unshift(handler);
            },
            async emit(event, ...args) {
                for (const handler of [...(handlers.get(event) ?? [])]) {
                    await handler(...args);
                }
            },
        };
        const context = vm.createContext({
            console,
            eventSource,
            event_types: eventTypes,
            PinnedChatsManager: { init() { } },
            ensureNeconyanRail() { },
            installChatNoteCapture() { },
            releaseChromeAfterBootSkeleton() { },
            applySimpleMode() { },
            SIMPLE_MODE_EVENT: 'simple',
            concealWelcomeHome() { },
            createForegroundRefreshCoalescer: () => ({ request() { } }),
            window: { addEventListener() { }, setTimeout() { return 0; }, clearTimeout() { } },
            document: { hidden: false, addEventListener() { }, body: { classList: { contains: () => false } } },
            getCurrentChatId: () => undefined,
            chat: [],
            openWelcomeScreen: async () => {
                calls.push('open');
                return runtime.getRecentChats();
            },
            refreshNeconyanRail: async () => {
                calls.push('rail');
                return runtime.getRecentChats();
            },
            invalidateRecentChats: () => { calls.push('invalidate'); },
            scheduleNeconyanRailRefresh() { },
            syncNeconyanAssistantTools() { },
            resumeTutorial() { },
            accountStorage: { getItem: () => null, setItem() { }, removeItem() { } },
            assignCharacterAsAssistant() { },
        });
        context.globalThis = context;
        vm.runInContext(functionSource('initWelcomeScreen'), context);
        context.initWelcomeScreen();

        const ready = eventSource.emit(eventTypes.APP_READY);
        await Promise.resolve();
        await Promise.resolve();

        expect(runtime.state.fetchCount).toBe(1);
        runtime.state.resolveNext([rawChat]);
        await ready;
        expect(runtime.state.fetchCount).toBe(1);
        expect(calls).toEqual(['open', 'rail']);
    });
});

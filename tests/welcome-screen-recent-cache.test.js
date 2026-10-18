import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const welcomeSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'welcome-screen.js'), 'utf8').replace(/\r\n/g, '\n');

function functionSource(name) {
    return welcomeSource.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
}

function classSource(name) {
    return welcomeSource.match(new RegExp(`^class ${name} \\{[\\s\\S]*?^}\\n`, 'm'))?.[0] ?? '';
}

const pinnedChatsManagerSource = classSource('PinnedChatsManager');
const recentChatsSource = [
    functionSource('getRecentChatsSettings'),
    functionSource('saveRecentChatsSettings'),
    functionSource('invalidateRecentChats'),
    functionSource('getRecentChatsCacheKey'),
    functionSource('fetchRecentChatsData'),
    functionSource('requestRecentChatsData'),
    functionSource('shouldSeparateAgentRecentChats'),
    functionSource('isAgentRecentChat'),
    functionSource('getRecentChatType'),
    functionSource('getRecentChats'),
].join('\n');

function createRuntime({ rawData = [], responseOk = true } = {}) {
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
        let recentChatsDataCache = null;
        let recentChatsInFlight = null;
        let recentChatsGeneration = 0;
        let recentChatsRequestSequence = 0;
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

describe('recent chat request cache', () => {
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

    test('reuses a completed response without another request', async () => {
        await runtime.getRecentChats();
        await runtime.getRecentChats();
        expect(runtime.state.fetchCount).toBe(1);
    });

    test('explicit invalidation forces a fresh response', async () => {
        await runtime.getRecentChats();
        runtime.invalidateRecentChats();
        await runtime.getRecentChats();
        expect(runtime.state.fetchCount).toBe(2);
    });

    test('does not share a response across accounts', async () => {
        await runtime.getRecentChats();
        runtime.setOwner('bob');
        await runtime.getRecentChats();
        expect(runtime.state.fetchCount).toBe(2);
    });

    test('pin changes invalidate the cached request and its ordering input', async () => {
        await runtime.getRecentChats();
        runtime.PinnedChatsManager.toggle({ avatar: 'Nova.png', group: '', file_name: 'Chat.jsonl' }, true);
        await runtime.getRecentChats();

        expect(runtime.state.fetchCount).toBe(2);
        expect(JSON.parse(runtime.state.requests[1].body).pinned).toHaveLength(1);
    });

    test('settings changes do not reuse the old request shape', async () => {
        await runtime.getRecentChats();
        runtime.state.storage.set('recentChatsSettings', JSON.stringify({ maxDisplayed: 5, collapsedDisplayed: 2 }));
        await runtime.getRecentChats();

        expect(runtime.state.fetchCount).toBe(2);
        expect(JSON.parse(runtime.state.requests[1].body).max).toBe(5);
    });

    test('keeps the raw response immutable while building display rows', async () => {
        const raw = runtime.state.rawData[0];
        const first = await runtime.getRecentChats();
        const second = await runtime.getRecentChats();

        expect(raw.char_name).toBeUndefined();
        expect(first[0].char_name).toBe('Nova');
        expect(second[0].char_name).toBe('Nova');
        expect(runtime.state.fetchCount).toBe(1);
    });

    test('rebuilds character labels from current state without refetching', async () => {
        await runtime.getRecentChats();
        runtime.state.characters[0].name = 'Nova Renamed';
        const refreshed = await runtime.getRecentChats();

        expect(refreshed[0].char_name).toBe('Nova Renamed');
        expect(runtime.state.fetchCount).toBe(1);
    });

    test('does not cache a failed request', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        runtime.state.responseOk = false;
        await expect(runtime.getRecentChats()).resolves.toEqual([]);
        runtime.state.responseOk = true;
        await expect(runtime.getRecentChats()).resolves.toHaveLength(1);
        expect(runtime.state.fetchCount).toBe(2);
        jest.restoreAllMocks();
    });
});

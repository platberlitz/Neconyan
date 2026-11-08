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

describe('recent chat rename failures', () => {
    const renameFunctions = [
        { name: 'renameRecentCharacterChat', call: (context) => context.renameRecentCharacterChat('Nova.png', 'Old'), message: 'Could not rename that recent chat. Try again.' },
        { name: 'renameRecentGroupChat', call: (context) => context.renameRecentGroupChat('group-1', 'Old'), message: 'Could not rename that recent group chat. Try again.' },
    ];

    function createRenameContext({ rename, refresh = async () => undefined, renderTemplate = async () => '<div></div>' } = {}) {
        const toasts = [];
        const context = vm.createContext({
            console: { ...console, error: () => undefined, log: () => undefined },
            t: (strings, ...values) => String.raw({ raw: strings }, ...values),
            characters: [{ avatar: 'Nova.png' }],
            groups: [{ id: 'group-1' }],
            POPUP_TYPE: { INPUT: 'input' },
            renderTemplateAsync: renderTemplate,
            callGenericPopup: async () => 'New',
            renameGroupOrCharacterChat: rename,
            refreshWelcomeScreen: refresh,
            toastr: {
                success: message => toasts.push(['success', message]),
                error: message => toasts.push(['error', message]),
            },
        });
        context.globalThis = context;
        vm.runInContext(renameFunctions.map(({ name }) => functionSource(name)).join('\n'), context);
        return { context, toasts };
    }

    describe.each(renameFunctions)('$name', ({ call, message }) => {
        test('adds no toast when the rename failed, because the rename already showed its popup', async () => {
            const { context, toasts } = createRenameContext({ rename: async () => { throw new Error('Unsuccessful chat rename request.'); } });

            await call(context);

            expect(toasts).toEqual([]);
        });

        test('toasts when the failure happened outside the rename call', async () => {
            const { context, toasts } = createRenameContext({
                rename: async () => ({ oldFileName: 'Old', newFileName: 'New' }),
                refresh: async () => { throw new Error('refresh failed'); },
            });

            await call(context);

            expect(toasts).toEqual([['error', message]]);
        });

        test('toasts when the rename was cancelled before any popup', async () => {
            const { context, toasts } = createRenameContext({
                rename: async () => { throw new DOMException('The chat rename was cancelled.', 'AbortError'); },
            });

            await call(context);

            expect(toasts).toEqual([['error', message]]);
        });

        test('shows the success toast and no error toast when the rename works', async () => {
            const { context, toasts } = createRenameContext({ rename: async () => ({ oldFileName: 'Old', newFileName: 'New' }) });

            await call(context);

            expect(toasts.map(([kind]) => kind)).toEqual(['success']);
        });
    });
});

describe('Home recent chat identifiers after template sanitisation', () => {
    test.each([
        { avatar: ' Nova.png', chat_name: ' Chat ', group: '', recent_chat_type: 'individual' },
        { avatar: 'Nova.png', chat_name: 'Chat', group: '', recent_chat_type: 'individual' },
        { avatar: '', chat_name: ' Group chat ', group: ' group ', is_group: true, recent_chat_type: 'group' },
        { avatar: ' Nova.png', group: ' group ', chat_name: ' Direct chat ', is_conversation: true,
            conversation_branch_id: ' branch ', conversation_branch_name: ' Branch name ', recent_chat_type: 'conversation' },
        { avatar: ' <Nova> & "Kit".png', chat_name: ' <Chat> & "name" ', recent_chat_type: 'individual' },
    ])('uses the exact saved identity for $recent_chat_type: $chat_name', async recentChat => {
        const calls = [];
        class Element {
            constructor(attributes = {}) { this.attributes = attributes; }
            getAttribute(name) { return this.attributes[name] ?? null; }
            setAttribute(name, value) { this.attributes[name] = String(value); }
            querySelector() { return null; }
            querySelectorAll() { return []; }
            replaceChildren() {}
        }
        const attributes = {
            'data-avatar': recentChat.avatar ?? '', 'data-file': recentChat.chat_name,
            'data-group': recentChat.group ?? '', 'data-recent-chat-type': recentChat.recent_chat_type,
            'data-conversation-branch-id': recentChat.conversation_branch_id ?? '',
            'data-conversation-branch-name': recentChat.conversation_branch_name ?? '',
        };
        // DOMPurify trims attributes in the rendered HTML, but not the source records.
        const item = new Element(Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, value.trim()])));
        const button = () => ({ handlers: {}, closest: () => item,
            addEventListener(event, handler) { this.handlers[event] = handler; } });
        const open = button();
        const rename = button();
        const remove = button();
        const pin = button();
        const selectors = { '.recentChat': [item], '.recentChatOpen': [open],
            '.recentChat .renameChat': [rename], '.recentChat .deleteChat': [remove], '.recentChat .pinChat': [pin] };
        const fragment = { querySelector: () => new Element(), querySelectorAll: selector => selectors[selector] ?? [] };
        const capture = action => (...args) => { calls.push([action, ...args]); };
        const context = vm.createContext({
            console, HTMLElement: Element, welcomeRequestId: 1,
            document: { getElementById: () => new Element(), createRange: () => ({ createContextualFragment: () => fragment }),
                body: { classList: { contains: () => true, add() {} } } },
            window: {}, getWelcomeHost: () => new Element(),
            buildWelcomeTemplateData: () => ({}), renderTemplateAsync: async () => '',
            openNeconyanRecentChat: capture('open'),
            renameRecentCharacterChat: capture('rename-character'), deleteRecentCharacterChat: capture('delete-character'),
            renameRecentGroupChat: capture('rename-group'), deleteRecentGroupChat: capture('delete-group'),
            renameRecentConversationChat: capture('rename-conversation'), deleteRecentConversationChat: capture('delete-conversation'),
            PinnedChatsManager: { isPinned: () => false, toggle: capture('pin') }, refreshWelcomeScreen: async () => {},
        });
        vm.runInContext(functionSource('sendWelcomePanel'), context);
        await context.sendWelcomePanel([recentChat], false, 1);
        expect(item.attributes).toEqual(attributes);
        open.handlers.click();
        rename.handlers.click({ stopPropagation() {} });
        remove.handlers.click({ stopPropagation() {} });
        await pin.handlers.click({ stopPropagation() {} });
        let expected;
        if (recentChat.is_conversation) {
            expected = [
                ['open', { avatar: recentChat.avatar, group: recentChat.group, conversation_branch_id: recentChat.conversation_branch_id, is_conversation: true }],
                ['rename-conversation', recentChat.avatar, recentChat.group, recentChat.conversation_branch_id, recentChat.conversation_branch_name, recentChat],
                ['delete-conversation', recentChat.avatar, recentChat.group, recentChat.conversation_branch_id, recentChat],
                ['pin', recentChat, true],
            ];
        } else if (recentChat.is_group) {
            expected = [
                ['open', { group: recentChat.group, chat_name: recentChat.chat_name, is_group: true }],
                ['rename-group', recentChat.group, recentChat.chat_name], ['delete-group', recentChat.group, recentChat.chat_name], ['pin', recentChat, true],
            ];
        } else {
            expected = [
                ['open', { avatar: recentChat.avatar, chat_name: recentChat.chat_name }],
                ['rename-character', recentChat.avatar, recentChat.chat_name], ['delete-character', recentChat.avatar, recentChat.chat_name], ['pin', recentChat, true],
            ];
        }
        expect(calls).toEqual(expected);
    });
});

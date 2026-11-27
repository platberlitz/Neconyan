/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- These are Jest parameterised tests. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const extension_settings = {};
const settings = { _version: 7 };
let account = 'tester';

jest.unstable_mockModule('../public/script.js', () => ({
    getRequestHeaders: () => ({ 'X-CSRF': 'token' }),
    settings,
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/constants.js', () => ({
    CONVERSATION_STORE_KEY: 'neconyan_conversation',
    MAX_THREAD_MESSAGES: 250,
}));

const storeSync = await import('../public/scripts/neconyan-conversation/store-sync.js');

const KEY = 'neconyan_conversation';
const nativeFetch = globalThis.fetch;

function message(id, mes) {
    return { id, mes, role: 'character', name: 'Nova', extra: {} };
}

function store(characters, extra = {}) {
    return {
        version: 1,
        localStorageMigrated: false,
        settings: {},
        characters,
        groups: [],
        reminders: [],
        ...extra,
    };
}

function thread(messages, createdAt = '100') {
    return { branches: { b1: { id: 'b1', createdAt, messages } } };
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
    };
}

function seed(localStore, version) {
    extension_settings[KEY] = localStore;
    storeSync.bindConversationAccount('tester');
    storeSync.captureConversationStore(localStore, version);
}

beforeEach(() => {
    account = 'tester';
    for (const key of Object.keys(extension_settings)) {
        delete extension_settings[key];
    }
    settings._version = 7;
    globalThis.fetch = async () => jsonResponse(500, { error: 'no handler' });
});

afterEach(() => {
    globalThis.fetch = nativeFetch;
});

describe('conversation store synchronisation', () => {
    test('flushing leaves a clean store alone and uploads a pending edit exactly once', async () => {
        seed(store({ 'nova.png': thread([]) }), 7);
        globalThis.fetch = jest.fn(async (_url, options) => jsonResponse(200, {
            store: JSON.parse(options.body).store, version: 8,
        }));

        await expect(storeSync.flushConversationStore()).resolves.toBe(true);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        extension_settings[KEY].characters['nova.png'].branches.b1.messages.push(message('local', 'Keep my note'));
        storeSync.persistConversationStoreDebounced();
        await Promise.resolve();
        await expect(storeSync.flushConversationStore()).resolves.toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(storeSync.getConversationSavedSnapshot()).toEqual(extension_settings[KEY]);
    });

    test('a changed refresh notifies views after adopting the server copy', async () => {
        seed(store({ 'nova.png': thread([]) }), 7);
        const previousWindow = globalThis.window;
        const notifications = [];
        globalThis.window = { dispatchEvent: event => notifications.push({
            type: event.type,
            version: storeSync.getConversationSavedVersion(),
            messages: extension_settings[KEY].characters['nova.png'].branches.b1.messages.length,
        }) };
        globalThis.fetch = async () => jsonResponse(200, {
            store: store({ 'nova.png': thread([message('native', 'Hello')]) }), version: 8,
        });
        try {
            await storeSync.refreshConversationStore();
            await storeSync.refreshConversationStore();
            expect(notifications).toEqual([{
                type: 'neconyan:conversation-store-refreshed', version: 8, messages: 1,
            }]);
        } finally {
            globalThis.window = previousWindow;
        }
    });

    test('the first Conversation branch saves after the server initialises an absent store', async () => {
        seed({}, 0);
        const local = store({ 'nori.png': thread([]) }, { localStorageMigrated: true });
        extension_settings[KEY] = local;
        const saves = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/get')) return jsonResponse(200, { store: store({}), version: 1 });
            const body = JSON.parse(options.body);
            saves.push(body);
            if (saves.length === 1) return jsonResponse(409, { error: 'settings_conflict', version: 1 });
            return jsonResponse(200, { store: body.store, version: 2 });
        };
        expect(await storeSync.persistConversationStoreNow()).toBe(true);
        expect(saves).toHaveLength(2);
        expect(saves[1]).toEqual({ store: local, version: 1 });
        expect(storeSync.getConversationSavedSnapshot()).toEqual(local);
        expect(storeSync.getConversationSavedVersion()).toBe(2);
    });

    test('ownership capture persists the timezone and acknowledged settings once', async () => {
        const saved = store({});
        seed(saved, 7);
        const acknowledgement = { account: 'tester', settingsRevision: 3 };
        let version = 7;
        const configurations = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/automation/configure')) {
                const body = JSON.parse(options.body);
                configurations.push(body);
                saved.automation = { mode: body.mode, timeZone: body.timeZone, acknowledgement: body.acknowledgement };
                version++;
                return jsonResponse(200, { version, automation: saved.automation });
            }
            return jsonResponse(200, { store: saved, version });
        };
        await storeSync.ensureConversationAutomationOwnership({ acknowledgement });
        await storeSync.ensureConversationAutomationOwnership({ acknowledgement });
        expect(configurations).toEqual([{ mode: 'server', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', version: 7, acknowledgement }]);
        expect(storeSync.getConversationSavedVersion()).toBe(8);
        expect(extension_settings[KEY].automation.acknowledgement).toEqual(acknowledgement);
    });

    test('ownership capture refreshes a raced version and never acknowledges stale controls', async () => {
        seed(store({}), 7);
        const saved = store({});
        let version = 7;
        const configurations = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/automation/configure')) {
                const body = JSON.parse(options.body);
                configurations.push(body);
                if (configurations.length === 1) {
                    version = 9;
                    return jsonResponse(409, { error: 'active_settings_ack_stale', version });
                }
                saved.automation = { mode: body.mode, timeZone: body.timeZone };
                return jsonResponse(200, { version: ++version });
            }
            return jsonResponse(200, { store: saved, version });
        };
        await storeSync.ensureConversationAutomationOwnership({ acknowledgement: { account: 'tester', settingsRevision: 1 } });
        expect(configurations).toHaveLength(2);
        expect(configurations[1]).toMatchObject({ mode: 'server', version: 9 });
        expect(configurations[1].acknowledgement).toBeUndefined();
    });

    test('a lost new-branch save response can recover against server-added history metadata', async () => {
        seed(store({}), 7);
        extension_settings[KEY].characters['nova.png'] = thread([message('new', 'New branch')]);
        const server = structuredClone(extension_settings[KEY]);
        Object.assign(server.characters['nova.png'].branches.b1, { messageEditRevision: 8, messageContentHash: 'a'.repeat(64) });
        globalThis.fetch = jest.fn()
            .mockRejectedValueOnce(new Error('Lost response'))
            .mockResolvedValueOnce(jsonResponse(409, { error: 'settings_conflict' }))
            .mockResolvedValueOnce(jsonResponse(200, { store: server, version: 8 }))
            .mockResolvedValueOnce(jsonResponse(200, { store: server, version: 9 }));
        await expect(storeSync.persistConversationStoreNow()).rejects.toThrow('Lost response');
        expect(await storeSync.persistConversationStoreNow()).toBe(true);
        expect(extension_settings[KEY]).toEqual(server);
        expect(storeSync.getConversationSavedVersion()).toBe(9);
    });

    test('an ambiguous save response retains the local edit and the previous acknowledged pair', async () => {
        seed(store({ 'nova.png': thread([{ mes: 'Legacy', role: 'user' }]) }), 7);
        const baseline = structuredClone(extension_settings[KEY]);
        globalThis.fetch = async () => {
            extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Local replacement';
            return jsonResponse(200, { store: store({ 'nova.png': thread([{ mes: 'Server replacement', role: 'user' }]) }), version: 8 });
        };
        expect(await storeSync.persistConversationStoreNow()).toBe(false);
        expect(extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes).toBe('Local replacement');
        expect(storeSync.getConversationSavedSnapshot()).toEqual(baseline);
        expect(storeSync.getConversationSavedVersion()).toBe(7);
    });

    test.each([undefined, null, []])('a missing or invalid response store %j is never acknowledged', async (invalid) => {
        seed(store({ 'nova.png': thread([message('a', 'Keep')]) }), 7);
        const before = structuredClone(extension_settings[KEY]);
        globalThis.fetch = async () => jsonResponse(200, { store: invalid, version: 8 });
        await expect(storeSync.refreshConversationStore()).rejects.toThrow('Invalid Conversation store response');
        await expect(storeSync.persistConversationStoreNow()).rejects.toThrow('Invalid Conversation store response');
        expect(extension_settings[KEY]).toEqual(before);
        expect(storeSync.getConversationSavedVersion()).toBe(7);
    });

    test('startup migration remains local while general settings versions advance', async () => {
        seed(store({}), 7);
        extension_settings[KEY].characters['migrated.png'] = thread([message('legacy', 'Migrated locally')]);
        settings._version = 12;
        storeSync.initConversationStoreSync();
        storeSync.initConversationStoreSync();
        expect(storeSync.getConversationSavedVersion()).toBe(7);
        expect(storeSync.getConversationSavedSnapshot().characters).toEqual({});
        globalThis.fetch = async () => jsonResponse(200, {
            store: store({ 'native.png': thread([message('native', 'Saved remotely')]) }), version: 13,
        });
        await storeSync.refreshConversationStore();
        await storeSync.refreshConversationStore();
        expect(Object.keys(extension_settings[KEY].characters).sort()).toEqual(['migrated.png', 'native.png']);
        expect(storeSync.getConversationSavedSnapshot().characters['migrated.png']).toBeUndefined();
    });

    test('a confirmed absent store at version zero preserves later local migration', async () => {
        seed(null, 0);
        extension_settings[KEY] = store({ 'migrated.png': thread([message('legacy', 'Migrated locally')]) });
        storeSync.initConversationStoreSync();
        expect(storeSync.getConversationSavedVersion()).toBe(0);
        expect(storeSync.getConversationSavedSnapshot()).toEqual({});
        globalThis.fetch = async () => jsonResponse(200, { store: store({}), version: 1 });
        await storeSync.refreshConversationStore();
        expect(extension_settings[KEY].characters['migrated.png'].branches.b1.messages[0].id).toBe('legacy');
    });

    test.each([undefined, null, '8', -1, 0.5])('invalid response version %j cannot change the saved pair or local state', async (version) => {
        seed(store({ 'nova.png': thread([message('a', 'Keep')]) }), 7);
        const before = structuredClone(extension_settings[KEY]);
        globalThis.fetch = async () => jsonResponse(200, { store: store({}), version });
        await expect(storeSync.refreshConversationStore()).rejects.toThrow('Invalid Conversation store version');
        await expect(storeSync.persistConversationStoreNow()).rejects.toThrow('Invalid Conversation store version');
        expect(extension_settings[KEY]).toEqual(before);
        expect(storeSync.getConversationSavedSnapshot()).toEqual(before);
        expect(storeSync.getConversationSavedVersion()).toBe(7);
    });

    test.each([null, store({ 'nova.png': thread([message('private', 'Account A only')]) })])('initial binding cannot adopt another profile with store %j', async (downloaded) => {
        jest.resetModules();
        const fresh = await import('../public/scripts/neconyan-conversation/store-sync.js');
        extension_settings[KEY] = downloaded;
        globalThis.fetch = jest.fn();
        await expect(fresh.refreshConversationStore()).rejects.toThrow('account_changed');
        fresh.bindConversationAccount('tester');
        account = 'other-account';
        expect(() => fresh.initConversationStoreSync()).toThrow('account_changed');
        expect(() => fresh.bindConversationAccount(account)).toThrow('account_changed');
        await expect(fresh.persistConversationStoreNow()).rejects.toThrow('account_changed');
        await expect(fresh.refreshConversationStore()).rejects.toThrow('account_changed');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(extension_settings[KEY]).toEqual(downloaded);
        expect(fresh.getConversationSavedSnapshot()).toBeNull();
    });

    test('a refreshed identity cannot relabel the loaded store or baseline', async () => {
        seed(store({ 'nova.png': thread([message('private', 'Account A only')]) }), 7);
        const before = structuredClone(extension_settings[KEY]);
        account = 'other-account';
        globalThis.fetch = jest.fn();
        await expect(storeSync.persistConversationStoreNow()).rejects.toThrow('account_changed');
        await expect(storeSync.refreshConversationStore()).rejects.toThrow('account_changed');
        expect(() => storeSync.captureConversationStore(before, 7)).toThrow('account_changed');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(extension_settings[KEY]).toEqual(before);
        expect(storeSync.getConversationSavedSnapshot()).toEqual(before);
    });

    test('a late response cannot overwrite data after the current identity changes', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Account A')]) }), 7);
        const before = structuredClone(extension_settings[KEY]);
        globalThis.fetch = async (_url, options) => {
            expect(options.headers['X-Neconyan-Account']).toBe('tester');
            account = 'other-account';
            return jsonResponse(200, { store: store({}), version: 8 });
        };
        await expect(storeSync.refreshConversationStore()).rejects.toThrow('account_changed');
        expect(extension_settings[KEY]).toEqual(before);
        expect(storeSync.getConversationSavedVersion()).toBe(7);
    });

    test('a refresh merges a native server message into the local copy', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);

        globalThis.fetch = async (url) => {
            expect(url).toBe('/api/neconyan-conversation/store/get');
            return jsonResponse(200, {
                store: store({ 'nova.png': thread([message('a', 'Hi'), message('native', 'Hello')]) }),
                version: 12,
            });
        };

        const result = await storeSync.refreshConversationStore();

        expect(result.conflict).toBe(false);
        expect(result.version).toBe(12);
        expect(storeSync.getConversationSavedVersion()).toBe(12);
        const messages = extension_settings[KEY].characters['nova.png'].branches.b1.messages;
        expect(messages.map(item => item.id)).toEqual(['a', 'native']);
    });

    test('a refresh at an unchanged version keeps the local copy without a store download', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        extension_settings[KEY].characters['nova.png'].branches.b1.messages.push(message('local', 'Unsaved'));
        const before = extension_settings[KEY];

        globalThis.fetch = async (url, options) => {
            expect(url).toBe('/api/neconyan-conversation/store/get');
            expect(JSON.parse(options.body)).toEqual({ knownVersion: 7 });
            return jsonResponse(200, { unchanged: true, version: 7 });
        };

        const result = await storeSync.refreshConversationStore();

        expect(result).toMatchObject({ conflict: false, changed: false, version: 7 });
        expect(extension_settings[KEY]).toBe(before);
        expect(storeSync.getConversationSavedVersion()).toBe(7);
        expect(storeSync.getConversationSavedSnapshot().characters['nova.png'].branches.b1.messages.map(item => item.id)).toEqual(['a']);
    });

    test('a save posts the local store under the saved version and adopts the reply', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);

        globalThis.fetch = async (url, options) => {
            expect(url).toBe('/api/neconyan-conversation/store/save');
            expect(options.headers['X-Neconyan-Account']).toBe('tester');
            const body = JSON.parse(options.body);
            expect(body.version).toBe(7);
            expect(body.store.characters['nova.png'].branches.b1.messages[0].id).toBe('a');
            return jsonResponse(200, { store: body.store, version: 8 });
        };

        const ok = await storeSync.persistConversationStoreNow();

        expect(ok).toBe(true);
        expect(storeSync.getConversationSavedVersion()).toBe(8);
    });

    test('a version conflict refreshes and retries the save once', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);

        let saveAttempts = 0;
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/get')) {
                return jsonResponse(200, {
                    store: store({ 'nova.png': thread([message('a', 'Hi'), message('native', 'Hey')]) }),
                    version: 20,
                });
            }
            saveAttempts += 1;
            const body = JSON.parse(options.body);
            if (body.version !== 20) {
                return jsonResponse(409, { error: 'settings_conflict', version: 20 });
            }
            return jsonResponse(200, { store: body.store, version: 21 });
        };

        const ok = await storeSync.persistConversationStoreNow();

        expect(ok).toBe(true);
        expect(saveAttempts).toBe(2);
        expect(storeSync.getConversationSavedVersion()).toBe(21);
        const ids = extension_settings[KEY].characters['nova.png'].branches.b1.messages.map(item => item.id);
        expect(ids).toEqual(['a', 'native']);
    });

    test('a conflicting local reset is reported instead of overwriting the server', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Hi')], '100') }), 7);
        extension_settings[KEY].characters['nova.png'].branches.b1.createdAt = '999';

        globalThis.fetch = async () => jsonResponse(200, {
            store: store({ 'nova.png': thread([message('a', 'Changed'), message('native', 'New')], '100') }),
            version: 30,
        });

        const result = await storeSync.refreshConversationStore();

        expect(result.conflict).toBe(true);
        expect(result.store.characters['nova.png'].branches.b1.createdAt).toBe('100');
    });

    test('a refresh does not record an unsaved local edit as acknowledged', async () => {
        seed(store({ 'nova.png': thread([message('a', 'Server value')]) }), 7);
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Local edit';

        globalThis.fetch = async () => jsonResponse(200, {
            store: store({ 'nova.png': thread([message('a', 'Server value'), message('native', 'Hello')]) }),
            version: 12,
        });

        await storeSync.refreshConversationStore();
        const afterFirst = extension_settings[KEY].characters['nova.png'].branches.b1.messages;
        expect(afterFirst.find(item => item.id === 'a').mes).toBe('Local edit');
        expect(storeSync.getConversationSavedSnapshot().characters['nova.png'].branches.b1.messages.find(item => item.id === 'a').mes).toBe('Server value');

        await storeSync.refreshConversationStore();
        const afterSecond = extension_settings[KEY].characters['nova.png'].branches.b1.messages;
        expect(afterSecond.find(item => item.id === 'a').mes).toBe('Local edit');
    });

    test('a save keeps an edit made while the request was in flight', async () => {
        seed(store({ 'nova.png': thread([message('a', 'v1')]) }), 7);

        globalThis.fetch = async (url, options) => {
            expect(url).toBe('/api/neconyan-conversation/store/save');
            const body = JSON.parse(options.body);
            expect(body.store.characters['nova.png'].branches.b1.messages[0].mes).toBe('v1');
            // A concurrent edit lands while the save is awaiting its response.
            extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'v2';
            return jsonResponse(200, { store: body.store, version: 8 });
        };

        const ok = await storeSync.persistConversationStoreNow();

        expect(ok).toBe(true);
        expect(storeSync.getConversationSavedVersion()).toBe(8);
        expect(extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes).toBe('v2');
        expect(storeSync.getConversationSavedSnapshot().characters['nova.png'].branches.b1.messages[0].mes).toBe('v1');
    });
});

describe('conversation store synchronisation: unreconcilable saves and server edits', () => {
    const CONFLICT_TEXT = 'Some recent Conversation changes were not saved because they also changed on the server. The latest version is shown now; make those changes again.';
    const FAILED_TEXT = 'Could not save your last Conversation change. Try again in a moment.';
    const DELETE_ENDPOINT = '/api/neconyan-conversation/thread/delete';
    const GROUP_DELETE_ENDPOINT = '/api/neconyan-conversation/group/delete';
    const scope = (over = {}) => ({ removeKeys: [], keyPrefix: '', groupId: '', personaId: '', reminderIds: [], replaceKeys: {}, ...over });
    const previousWindow = globalThis.window;
    const previousToastr = globalThis.toastr;
    let events;

    beforeEach(() => {
        events = [];
        globalThis.toastr = { error: jest.fn() };
        globalThis.window = { dispatchEvent: event => { events.push(event); } };
    });

    afterEach(() => {
        jest.useRealTimers();
        globalThis.window = previousWindow;
        globalThis.toastr = previousToastr;
    });

    // The page reset a branch (new createdAt) while the server changed the same branch, so no merge can keep both.
    function seedUnreconcilable() {
        seed(store({ 'nova.png': thread([message('a', 'Hi')], '100') }), 7);
        extension_settings[KEY].characters['nova.png'].branches.b1.createdAt = '999';
        return store({ 'nova.png': thread([message('a', 'Changed'), message('native', 'New')], '100') });
    }

    function conflictServer(serverStore, saves) {
        return async (url, options) => {
            if (url.endsWith('/store/get')) return jsonResponse(200, { store: serverStore, version: 30 });
            const body = JSON.parse(options.body);
            saves.push(body);
            if (saves.length === 1) return jsonResponse(409, { error: 'settings_conflict', version: 30 });
            return jsonResponse(200, { store: body.store, version: body.version + 1 });
        };
    }

    test('an unreconcilable save adopts the server copy, reports it and saves the next edit', async () => {
        const serverStore = seedUnreconcilable();
        const saves = [];
        globalThis.fetch = conflictServer(serverStore, saves);
        expect(await storeSync.persistConversationStoreNow()).toBe(false);
        expect(storeSync.getConversationSavedVersion()).toBe(30);
        expect(extension_settings[KEY]).toEqual(serverStore);
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(CONFLICT_TEXT);
        extension_settings[KEY].characters['nova.png'].branches.b1.messages.push(message('again', 'Typed again'));
        expect(await storeSync.persistConversationStoreNow()).toBe(true);
        expect(saves).toHaveLength(2);
        expect(saves[1].version).toBe(30);
        expect(saves[1].store.characters['nova.png'].branches.b1.messages.map(item => item.id)).toEqual(['a', 'native', 'again']);
    });

    test('two adoptions inside 10 s give two conflict notices', async () => {
        for (let round = 0; round < 2; round++) {
            const serverStore = seedUnreconcilable();
            globalThis.fetch = conflictServer(serverStore, []);
            expect(await storeSync.persistConversationStoreNow()).toBe(false);
        }
        expect(globalThis.toastr.error.mock.calls).toEqual([[CONFLICT_TEXT], [CONFLICT_TEXT]]);
    });

    test('two failed saves inside 10 s give one failed notice', async () => {
        jest.useFakeTimers({ now: 9e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        globalThis.fetch = async () => jsonResponse(503, { error: 'unavailable' });
        for (let round = 0; round < 2; round++) {
            extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = `Edit ${round}`;
            storeSync.persistConversationStoreDebounced();
            await jest.advanceTimersByTimeAsync(700);
        }
        expect(globalThis.toastr.error.mock.calls).toEqual([[FAILED_TEXT]]);
    });

    test('a second 409 on a debounced save keeps the edit and saves it again by itself', async () => {
        jest.useFakeTimers({ now: 9.3e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        const saves = [];
        let version = 30;
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/get')) {
                return jsonResponse(200, { store: store({ 'nova.png': thread([message('a', 'Hi')]) }), version });
            }
            const body = JSON.parse(options.body);
            saves.push(body);
            if (saves.length <= 2) {
                version++;
                return jsonResponse(409, { error: 'settings_conflict', version });
            }
            return jsonResponse(200, { store: body.store, version: body.version + 1 });
        };
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Edit one';
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(3);
        expect(saves[2].store.characters['nova.png'].branches.b1.messages[0].mes).toBe('Edit one');
        expect(storeSync.getConversationSavedSnapshot().characters['nova.png'].branches.b1.messages[0].mes).toBe('Edit one');
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2000);
        expect(saves).toHaveLength(3);
    });

    test('an edit that keeps meeting a moved version says it was not saved and stays on the page', async () => {
        jest.useFakeTimers({ now: 9.4e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        const saves = [];
        let version = 30;
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/get')) {
                return jsonResponse(200, { store: store({ 'nova.png': thread([message('a', 'Hi')]) }), version });
            }
            saves.push(JSON.parse(options.body));
            version++;
            return jsonResponse(409, { error: 'settings_conflict', version });
        };
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Edit one';
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(5000);
        // The first save and three automatic tries, two requests each.
        expect(saves).toHaveLength(8);
        expect(globalThis.toastr.error.mock.calls).toEqual([[FAILED_TEXT]]);
        expect(extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes).toBe('Edit one');
        await jest.advanceTimersByTimeAsync(5000);
        expect(saves).toHaveLength(8);
    });

    // Saves always meet a moved version; the reads return `serverStore()`.
    function movingVersionServer(saves, serverStore, { rejectSave = () => false } = {}) {
        let version = 30;
        return async (url, options) => {
            if (url.endsWith('/store/get')) return jsonResponse(200, { store: serverStore(), version });
            saves.push(JSON.parse(options.body));
            if (rejectSave(saves.length)) return jsonResponse(503, { error: 'unavailable' });
            version++;
            return jsonResponse(409, { error: 'settings_conflict', version });
        };
    }

    async function expectFullRetryChain(saves, mes) {
        const before = saves.length;
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = mes;
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(5000);
        // The first save and three automatic tries, two requests each.
        expect(saves.length - before).toBe(8);
    }

    test('a real conflict inside the retry chain adopts the server copy, says so and stops trying', async () => {
        jest.useFakeTimers({ now: 9.6e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')], '100') }), 7);
        const baseline = store({ 'nova.png': thread([message('a', 'Hi')], '100') });
        const changedElsewhere = store({ 'nova.png': thread([message('a', 'Changed'), message('native', 'New')], '100') });
        const saves = [];
        let elsewhere = false;
        globalThis.fetch = movingVersionServer(saves, () => (elsewhere ? changedElsewhere : baseline));
        // The page reset the branch, so it can't merge with a change to the same branch elsewhere.
        extension_settings[KEY].characters['nova.png'].branches.b1.createdAt = '999';
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(2);
        elsewhere = true;
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(3);
        expect(extension_settings[KEY]).toEqual(changedElsewhere);
        expect(globalThis.toastr.error.mock.calls).toEqual([[CONFLICT_TEXT]]);
        await jest.advanceTimersByTimeAsync(5000);
        expect(saves).toHaveLength(3);
        expect(globalThis.toastr.error.mock.calls).toEqual([[CONFLICT_TEXT]]);
        // The adoption ended the chain, so the next edit gets every try again.
        await expectFullRetryChain(saves, 'Edit after adoption');
        expect(globalThis.toastr.error.mock.calls).toEqual([[CONFLICT_TEXT], [FAILED_TEXT]]);
    });

    test('an account change inside the retry chain says nothing and leaves the next chain every try', async () => {
        jest.useFakeTimers({ now: 9.7e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        const saves = [];
        globalThis.fetch = movingVersionServer(saves, () => store({ 'nova.png': thread([message('a', 'Hi')]) }));
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Edit one';
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(2);
        account = 'someone-else';
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(2);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        account = 'tester';
        await jest.advanceTimersByTimeAsync(5000);
        expect(saves).toHaveLength(2);
        await expectFullRetryChain(saves, 'Edit two');
        expect(globalThis.toastr.error.mock.calls).toEqual([[FAILED_TEXT]]);
    });

    test('a save rejected inside the retry chain says so and leaves the next chain every try', async () => {
        jest.useFakeTimers({ now: 9.8e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        const saves = [];
        globalThis.fetch = movingVersionServer(saves, () => store({ 'nova.png': thread([message('a', 'Hi')]) }), { rejectSave: count => count === 3 });
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Edit one';
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(3);
        expect(globalThis.toastr.error.mock.calls).toEqual([[FAILED_TEXT]]);
        await jest.advanceTimersByTimeAsync(5000);
        expect(saves).toHaveLength(3);
        // Past the 10 s quiet period for the failed notice.
        await jest.advanceTimersByTimeAsync(6000);
        await expectFullRetryChain(saves, 'Edit two');
        expect(globalThis.toastr.error.mock.calls).toEqual([[FAILED_TEXT], [FAILED_TEXT]]);
    });

    test('a second 409 on the retry keeps the edit and shows no notice', async () => {
        jest.useFakeTimers({ now: 9.5e12 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]), 'other.png': thread([message('o', 'Old')]) }), 7);
        const serverStore = store({ 'nova.png': thread([message('a', 'Hi')]), 'other.png': thread([message('o', 'Changed elsewhere')]) });
        const saves = [];
        let gets = 0;
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/get')) {
                gets++;
                return jsonResponse(200, { store: serverStore, version: 30 });
            }
            const body = JSON.parse(options.body);
            saves.push(body);
            if (saves.length <= 2) return jsonResponse(409, { error: 'settings_conflict', version: 31 });
            return jsonResponse(200, { store: body.store, version: body.version + 1 });
        };
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Edit one';
        storeSync.persistConversationStoreDebounced();
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(2);
        expect(gets).toBe(1);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        expect(extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes).toBe('Edit one');
        extension_settings[KEY].characters['nova.png'].branches.b1.messages.push(message('again', 'Edit two'));
        const ok = await storeSync.persistConversationStoreNow();
        expect(ok).toBe(true);
        expect(saves).toHaveLength(3);
        const sent = saves[2].store.characters['nova.png'].branches.b1.messages;
        expect(sent.map(item => item.mes)).toEqual(['Edit one', 'Edit two']);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        // The automatic try finds nothing left to save.
        await jest.advanceTimersByTimeAsync(700);
        expect(saves).toHaveLength(3);
    });

    test('a server edit runs after an in-flight save and drops the deleted thread locally', async () => {
        seed(store({ A: thread([message('a', 'Hi')]), B: thread([message('b', 'Yo')]) }), 7);
        extension_settings[KEY].characters.B.branches.b1.messages[0].mes = 'Yo, edited';
        const order = [];
        let releaseSave;
        const saveHeld = new Promise(resolve => { releaseSave = resolve; });
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/save')) {
                order.push('save');
                const body = JSON.parse(options.body);
                await saveHeld;
                return jsonResponse(200, { store: body.store, version: 8 });
            }
            order.push('delete');
            return jsonResponse(200, { changed: true, scope: scope({ removeKeys: ['A'] }), store: store({ B: thread([message('b', 'Yo, edited')]) }), version: 9 });
        };
        const saving = storeSync.persistConversationStoreNow();
        let reply;
        try {
            const editing = storeSync.applyConversationServerEdit(DELETE_ENDPOINT, { avatar: 'A' });
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(order).toEqual(['save']);
            releaseSave();
            expect(await saving).toBe(true);
            reply = await editing;
        } finally {
            // Never leave the held save pending: it would block the sync queue for the cases that follow.
            releaseSave();
            await saving.catch(() => {});
        }
        expect(order).toEqual(['save', 'delete']);
        expect(reply.version).toBe(9);
        expect(Object.keys(extension_settings[KEY].characters)).toEqual(['B']);
        expect(storeSync.getConversationSavedVersion()).toBe(9);
        expect(Object.keys(storeSync.getConversationSavedSnapshot().characters)).toEqual(['B']);
    });

    test('a solo delete drops a thread that exists only in the page, and the next save does not post it', async () => {
        seed(store({ B: thread([message('b', 'Yo')]) }), 7);
        extension_settings[KEY].characters.A = thread([message('page', 'Opened here only')], '500');
        const posted = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/save')) {
                const body = JSON.parse(options.body);
                posted.push(body);
                return jsonResponse(200, { store: body.store, version: 10 });
            }
            return jsonResponse(200, { changed: true, scope: scope({ removeKeys: ['A'] }), store: store({ B: thread([message('b', 'Yo')]) }), version: 9 });
        };
        await storeSync.applyConversationServerEdit(DELETE_ENDPOINT, { avatar: 'A' });
        expect(Object.keys(extension_settings[KEY].characters)).toEqual(['B']);
        extension_settings[KEY].characters.B.branches.b1.messages[0].mes = 'Edited after';
        expect(await storeSync.persistConversationStoreNow()).toBe(true);
        expect(posted).toHaveLength(1);
        expect(posted[0].version).toBe(9);
        expect(Object.keys(posted[0].store.characters)).toEqual(['B']);
    });

    test('a group delete drops an alias key the baseline never had', async () => {
        const group = { id: 'G', personaId: '', members: ['A', 'B'] };
        seed(store({ 'group:G:A': thread([message('a', 'Hist')]), C: thread([message('c', 'Yo')]) }, { groups: [group] }), 7);
        extension_settings[KEY].characters['group:G:B'] = extension_settings[KEY].characters['group:G:A'];
        delete extension_settings[KEY].characters['group:G:A'];
        const posted = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/save')) {
                const body = JSON.parse(options.body);
                posted.push(body);
                return jsonResponse(200, { store: body.store, version: 10 });
            }
            expect(url).toBe(GROUP_DELETE_ENDPOINT);
            return jsonResponse(200, { changed: true, scope: scope({ removeKeys: ['group:G:A'], keyPrefix: 'group:G:', groupId: 'G' }), store: store({ C: thread([message('c', 'Yo')]) }), version: 9 });
        };
        await storeSync.applyConversationServerEdit(GROUP_DELETE_ENDPOINT, { groupId: 'G' });
        expect(Object.keys(extension_settings[KEY].characters)).toEqual(['C']);
        expect(extension_settings[KEY].groups).toEqual([]);
        extension_settings[KEY].characters.C.branches.b1.messages[0].mes = 'Edited after';
        expect(await storeSync.persistConversationStoreNow()).toBe(true);
        expect(JSON.stringify(posted[0].store)).not.toContain('group:G');
        expect(posted[0].store.groups).toEqual([]);
    });

    test('a delete keeps an unsaved edit to another group record and shows no notice', async () => {
        const g1 = { id: 'G1', personaId: '', members: ['A', 'B'], conversation_settings: { auto_character_chat: true } };
        const g2 = { id: 'G2', personaId: '', members: ['B', 'C'], conversation_settings: { auto_character_chat: true } };
        seed(store({ C: thread([message('c', 'Yo')]) }, { groups: [g1, g2] }), 7);
        extension_settings[KEY].groups[1].conversation_settings.auto_character_chat = false;
        globalThis.fetch = async () => jsonResponse(200, { changed: true, scope: scope({ keyPrefix: 'group:G1:', groupId: 'G1' }), store: store({ C: thread([message('c', 'Yo')]) }, { groups: [g2] }), version: 9 });
        await storeSync.applyConversationServerEdit(GROUP_DELETE_ENDPOINT, { groupId: 'G1' });
        expect(extension_settings[KEY].groups.map(group => `${group.id}:${group.conversation_settings.auto_character_chat}`)).toEqual(['G2:false']);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('the refreshed event names what the server deleted', async () => {
        seed(store({ A: thread([message('a', 'Hi')]), B: thread([message('b', 'Yo')]) }), 7);
        globalThis.fetch = async () => jsonResponse(200, { changed: true, scope: scope({ removeKeys: ['A'] }), store: store({ B: thread([message('b', 'Yo')]) }), version: 9 });
        await storeSync.applyConversationServerEdit(DELETE_ENDPOINT, { avatar: 'A' });
        const afterEdit = events.filter(event => event.type === 'neconyan:conversation-store-refreshed');
        expect(afterEdit).toHaveLength(1);
        expect(afterEdit[0].detail.threadKeys).toEqual(['A']);

        events.length = 0;
        extension_settings[KEY].characters.N = thread([message('n', 'Opened here only')], '500');
        globalThis.fetch = async () => jsonResponse(200, { store: store({ B: thread([message('b', 'Yo'), message('native', 'Hello')]) }), version: 12 });
        await storeSync.refreshConversationStore();
        const afterRefresh = events.filter(event => event.type === 'neconyan:conversation-store-refreshed');
        expect(afterRefresh).toHaveLength(1);
        expect(afterRefresh[0].detail.threadKeys).toEqual([]);
        expect(afterRefresh[0].detail.groupIds).toEqual([]);
        expect(Object.keys(extension_settings[KEY].characters).sort()).toEqual(['B', 'N']);
    });

    test('a refresh after another tab deleted a group drops it although this page had changed it, and the next save does not post it', async () => {
        const g1 = { id: 'G1', personaId: '', members: ['A', 'B'], conversation_settings: { auto_character_chat: true } };
        const g2 = { id: 'G2', personaId: '', members: ['B', 'C'], conversation_settings: { auto_character_chat: true } };
        seed(store({ C: thread([message('c', 'Yo')]) }, { groups: [g1, g2] }), 7);
        extension_settings[KEY].groups[0].conversation_settings.auto_character_chat = false;
        const saves = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/get')) return jsonResponse(200, { store: store({ C: thread([message('c', 'Yo')]) }, { groups: [g2] }), version: 8 });
            const body = JSON.parse(options.body);
            saves.push(body);
            if (saves.length === 1) return jsonResponse(409, { error: 'settings_conflict', version: 8 });
            return jsonResponse(200, { store: body.store, version: 9 });
        };
        await expect(storeSync.flushConversationStore()).resolves.toBe(true);
        expect(saves).toHaveLength(2);
        expect(saves[1].store.groups.map(group => group.id)).toEqual(['G2']);
        expect(extension_settings[KEY].groups.map(group => group.id)).toEqual(['G2']);
        const refreshed = events.filter(event => event.type === 'neconyan:conversation-store-refreshed');
        expect(refreshed.some(event => event.detail.groupIds.includes('G1'))).toBe(true);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a 409 retry after a member change elsewhere keeps the server\'s members although this page changed the group\'s settings', async () => {
        const group = { id: 'G', personaId: '', name: 'Group: A, B, C', members: ['A', 'B', 'C'], disabled_members: [], conversation_settings: { auto_character_chat: true }, updatedAt: 1 };
        seed(store({ 'group:G:A': thread([message('g', 'Hi')]) }, { groups: [group] }), 7);
        extension_settings[KEY].groups[0].conversation_settings.auto_character_chat = false;
        const changed = { ...group, name: 'Group: B, C, D', members: ['B', 'C', 'D'], updatedAt: 5 };
        const saves = [];
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/store/get')) {
                return jsonResponse(200, { store: store({ 'group:G:B': thread([message('g', 'Hi')]) }, { groups: [changed] }), version: 8 });
            }
            const body = JSON.parse(options.body);
            saves.push(body);
            if (saves.length === 1) return jsonResponse(409, { error: 'settings_conflict', version: 8 });
            return jsonResponse(200, { store: body.store, version: 9 });
        };
        await expect(storeSync.flushConversationStore()).resolves.toBe(true);
        expect(saves).toHaveLength(2);
        expect(saves[1].store.groups[0].members).toEqual(['B', 'C', 'D']);
        expect(saves[1].store.groups[0].conversation_settings.auto_character_chat).toBe(false);
        expect(extension_settings[KEY].groups[0].members).toEqual(['B', 'C', 'D']);
        expect(extension_settings[KEY].groups[0].conversation_settings.auto_character_chat).toBe(false);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a pending edit taken over by a flush that fails shows the failed notice once', async () => {
        // Well past every earlier failed notice in this file, so the 10 s limit cannot hide this one.
        jest.useFakeTimers({ now: 1e13 });
        seed(store({ 'nova.png': thread([message('a', 'Hi')]) }), 7);
        globalThis.fetch = async () => jsonResponse(503, { error: 'unavailable' });
        extension_settings[KEY].characters['nova.png'].branches.b1.messages[0].mes = 'Pending edit';
        storeSync.persistConversationStoreDebounced();
        await Promise.resolve();
        const waiter = storeSync.waitForConversationEdits();
        const flushed = storeSync.flushConversationStore();
        await expect(flushed).rejects.toThrow();
        await expect(waiter).resolves.toBe(false);
        expect(globalThis.toastr.error.mock.calls).toEqual([[FAILED_TEXT]]);
    });
});

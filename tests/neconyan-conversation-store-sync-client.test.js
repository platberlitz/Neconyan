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

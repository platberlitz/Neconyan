import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const extension_settings = {};
const settings = { _version: 7 };

jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentUserHandle: () => 'tester',
    getRequestHeaders: () => ({ 'X-CSRF': 'token' }),
    settings,
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/constants.js', () => ({
    CONVERSATION_STORE_KEY: 'sillybunny_conversation',
}));

const storeSync = await import('../public/scripts/neconyan-conversation/store-sync.js');

const KEY = 'sillybunny_conversation';
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
    storeSync.captureConversationStore(localStore, version);
}

beforeEach(() => {
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

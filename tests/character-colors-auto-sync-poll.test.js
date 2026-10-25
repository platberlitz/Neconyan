/* global globalThis */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const MODULE_NAME = 'dialogue-colors';
const extensionSettings = {};
let storage;
let state;
let saveSettingsImpl;

function stubElement() {
    return {
        id: '',
        className: '',
        innerHTML: '',
        textContent: '',
        style: { cssText: '', display: '', color: '' },
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        appendChild() {},
        removeChild() {},
        insertBefore() {},
        setAttribute() {},
        removeAttribute() {},
        hasAttribute: () => false,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
        contains: () => false,
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
        focus() {},
    };
}

function createRecord(color = '#3366cc') {
    const entry = {
        name: 'Alice',
        color,
        baseColor: '#888888',
        locked: false,
        keep: false,
        aliases: [],
        style: '',
        dialogueCount: 1,
        group: '',
        font: '',
        gradient: null,
        gradientGenerator: null,
    };
    return {
        version: 10,
        timestamp: '2026-10-01T00:00:00.000Z',
        writerId: 'test-writer',
        sequence: 1,
        autoSyncEnabled: false,
        settings: { themeMode: 'auto', brightness: 0 },
        globalSettings: { themeMode: 'auto', brightness: 0 },
        colorData: {
            card_test: {
                colors: { alice: entry },
                groupProfiles: {},
                settings: {},
                updatedAt: '',
            },
        },
        presets: {},
        customPalettes: {},
        customPaletteMeta: {},
        customGradientPresets: {},
        ui: {},
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

let serverRecord;
let serverToken;
let requests;
let malformedUnchanged;
let fetchGate = null;

function refreshServerToken() {
    serverToken = createHash('sha256').update(JSON.stringify(serverRecord)).digest('hex');
}

async function installModules() {
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/st-api.js', () => ({
        converter: { makeHtml: value => String(value) },
        power_user: { quote_text_color: '#888888', encode_tags: false, personas: {} },
        escapeHtml: value => String(value),
        escapeRegex: value => String(value),
        extension_settings: extensionSettings,
        getContext: () => ({ chat: [], chatMetadata: {} }),
        eventSource: { on() {}, emit() {} },
        event_types: {},
        setExtensionPrompt() {},
        saveSettings: (...args) => saveSettingsImpl(...args),
        saveSettingsDebounced() {},
        saveCharacterDebounced() {},
        getCharacters: () => [],
        extension_prompt_types: {},
        extension_prompt_roles: {},
        generateQuietPrompt: async () => '',
        registerMacro() {},
        getRequestHeaders: () => ({}),
        saveMetadata() {},
        saveMetadataDebounced() {},
        promptManager: null,
    }));
    storage = await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/storage.js');
    state = await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js');
    state.settings.enabled = true;
    state.settings.coloringEngine = 'dom';
}

beforeEach(async () => {
    jest.clearAllTimers();
    jest.resetModules();
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    extensionSettings.regex = [];
    serverRecord = createRecord();
    refreshServerToken();
    requests = [];
    malformedUnchanged = false;
    fetchGate = null;
    saveSettingsImpl = async () => true;
    globalThis.document = {
        hidden: false,
        body: stubElement(),
        activeElement: null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createElement: stubElement,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };
    globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(0, 0, 0)' });
    globalThis.window = {
        innerWidth: 1024,
        innerHeight: 768,
        addEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} }),
    };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    globalThis.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000000' };

    globalThis.fetch = jest.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        const names = body.extensionSettings || [];
        const knownToken = body.extensionSettingsToken;
        requests.push({ names, token: knownToken, tokenPresent: Object.hasOwn(body, 'extensionSettingsToken') });
        if (fetchGate) await fetchGate.promise;
        if (malformedUnchanged) {
            malformedUnchanged = false;
            return {
                ok: true,
                status: 200,
                json: async () => ({ unchanged: true, extensionSettingsToken: '0'.repeat(64) }),
            };
        }
        if (knownToken && knownToken === serverToken) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    unchanged: true,
                    extensionSettingsToken: serverToken,
                    extensionSettingsTokens: { [MODULE_NAME]: serverToken },
                }),
            };
        }
        const extension_settings = { [MODULE_NAME]: clone(serverRecord) };
        if (names.includes('regex')) extension_settings.regex = [];
        return {
            ok: true,
            status: 200,
            json: async () => ({
                extension_settings,
                extensionSettingsToken: serverToken,
                extensionSettingsTokens: { [MODULE_NAME]: serverToken },
            }),
        };
    });

    jest.useFakeTimers();
    await installModules();
});

afterAll(() => {
    storage?.clearAutoSyncPending?.();
    storage?.stopAutoSyncPolling?.();
    jest.clearAllTimers();
    jest.useRealTimers();
});

async function primeToken() {
    extensionSettings[MODULE_NAME] = createRecord();
    serverRecord = createRecord();
    refreshServerToken();
    const first = await storage.loadSettingsFromServer();
    expect(first.disposition).toBe('confirm');
    requests = [];
    return serverToken;
}

async function flushMicrotasks(count = 32) {
    for (let index = 0; index < count; index++) await Promise.resolve();
}

async function settleModuleSaves() {
    // Exhaust the verification retries so the module record and token are left
    // in the same state a real failed save would produce.
    await flushMicrotasks();
    await jest.runAllTimersAsync();
    await flushMicrotasks();
}

describe('Dialogue Colors conditional auto-sync reads', () => {
    test('the first read asks for a token, then an identical poll is answered unchanged', async () => {
        extensionSettings[MODULE_NAME] = createRecord();
        serverRecord = createRecord();
        refreshServerToken();

        const first = await storage.loadSettingsFromServer();
        expect(first.ok).toBe(true);
        expect(first.disposition).toBe('confirm');
        expect(requests[0]).toMatchObject({ names: [MODULE_NAME], token: '', tokenPresent: true });

        const unchanged = await storage.loadSettingsFromServer();
        expect(unchanged).toEqual({ ok: true, found: true, unchanged: true, disposition: 'unchanged' });
        expect(requests[1]).toMatchObject({ names: [MODULE_NAME], token: serverToken, tokenPresent: true });
    });

    test('a changed block does not match the old token and the new colour is the final state', async () => {
        await primeToken();
        serverRecord = createRecord('#22aa66');
        refreshServerToken();

        const changed = await storage.loadSettingsFromServer();
        expect(changed.ok).toBe(true);
        expect(changed.disposition).toBe('apply');
        expect(requests[0].token).not.toBe(serverToken);
        expect(extensionSettings[MODULE_NAME].colorData.card_test.colors.alice.color).toBe('#22aa66');

        const unchanged = await storage.loadSettingsFromServer();
        expect(unchanged.disposition).toBe('unchanged');
        expect(requests[1].token).toBe(serverToken);
    });

    test('a pending local save asks for full data instead of trusting the token', async () => {
        await primeToken();
        storage.markAutoSyncPending(extensionSettings[MODULE_NAME]);
        requests = [];

        const result = await storage.loadSettingsFromServer();
        expect(result.disposition).not.toBe('unchanged');
        expect(requests).toHaveLength(1);
        expect(requests[0].token).toBe('');

        storage.clearAutoSyncPending();
    });

    test('an externally scheduled save that times out restores the server copy on the next full poll', async () => {
        await primeToken();
        const local = storage.persistModuleStore(createRecord('#ff0000'), { debounce: false });
        storage.markAutoSyncPending(local);
        await jest.runAllTimersAsync();
        expect(state.autoSyncPendingRecord).toBeNull();
        requests = [];

        const result = await storage.loadSettingsFromServer();
        expect(result.disposition).toBe('apply');
        expect(requests[0].token).toBe('');
        expect(extensionSettings[MODULE_NAME].colorData.card_test.colors.alice.color).toBe('#3366cc');
    });

    test('a pending debounce defers a read without adopting its token, then the next poll is full', async () => {
        await primeToken();
        storage.persistModuleStore(createRecord('#ff0000'));
        serverRecord = createRecord('#22aa66');
        refreshServerToken();
        requests = [];

        const deferred = await storage.loadSettingsFromServer();
        expect(deferred.disposition).toBe('deferred');
        expect(requests[0].token).toBe('');

        await settleModuleSaves();
        requests = [];
        const next = await storage.loadSettingsFromServer();
        expect(next.disposition).not.toBe('unchanged');
        expect(requests[0].token).toBe('');
        expect(extensionSettings[MODULE_NAME].colorData.card_test.colors.alice.color).toBe('#22aa66');
    });

    test('a verified save adopts the module block token', async () => {
        await primeToken();
        requests = [];

        storage.queueImmediateSettingsSave();
        await settleModuleSaves();
        expect(requests.some(request => request.names.includes('regex'))).toBe(true);

        requests = [];
        const unchanged = await storage.loadSettingsFromServer();
        expect(unchanged.disposition).toBe('unchanged');
        expect(requests[0].token).toBe(serverToken);
    });

    test('pending colour-state work supersedes a read without adopting its token, then the next poll is full', async () => {
        await primeToken();
        const { queueColorStateSave } = await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/live-colors.js');
        serverRecord = createRecord('#22aa66');
        refreshServerToken();
        requests = [];

        let releaseFetch;
        fetchGate = { promise: new Promise(resolve => { releaseFetch = resolve; }) };
        const polling = storage.loadSettingsFromServer();
        await Promise.resolve();
        queueColorStateSave();
        fetchGate = null;
        releaseFetch();
        const superseded = await polling;
        expect(superseded.disposition).toBe('superseded');
        expect(requests[0].token).not.toBe(serverToken);

        await settleModuleSaves();
        requests = [];
        const next = await storage.loadSettingsFromServer();
        expect(next.disposition).not.toBe('unchanged');
        expect(requests[0].token).toBe('');
        expect(extensionSettings[MODULE_NAME].colorData.card_test.colors.alice.color).toBe('#22aa66');
    });

    test('a poll that overlaps an in-flight save goes full and does not adopt the poll token', async () => {
        await primeToken();
        let releaseSave;
        saveSettingsImpl = () => new Promise(resolve => { releaseSave = () => resolve(true); });
        storage.queueImmediateSettingsSave();
        await Promise.resolve();
        serverRecord = createRecord('#22aa66');
        refreshServerToken();
        requests = [];

        const overlapped = await storage.loadSettingsFromServer();
        expect(overlapped.disposition).toBe('deferred');
        expect(requests[0].token).toBe('');

        releaseSave();
        saveSettingsImpl = async () => true;
        await settleModuleSaves();
        requests = [];
        const next = await storage.loadSettingsFromServer();
        expect(next.disposition).not.toBe('unchanged');
        expect(requests[0].token).toBe('');
        expect(extensionSettings[MODULE_NAME].colorData.card_test.colors.alice.color).toBe('#22aa66');
    });

    test('a malformed unchanged response falls back to one full read', async () => {
        await primeToken();
        serverRecord = createRecord('#123456');
        refreshServerToken();
        malformedUnchanged = true;
        requests = [];

        const result = await storage.loadSettingsFromServer();
        expect(result.ok).toBe(true);
        expect(result.disposition).not.toBe('unchanged');
        expect(requests).toHaveLength(2);
        expect(requests[1].token).toBe('');
        expect(extensionSettings[MODULE_NAME].colorData.card_test.colors.alice.color).toBe('#123456');
    });
});

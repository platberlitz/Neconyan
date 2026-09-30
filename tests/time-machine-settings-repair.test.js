/* global globalThis */
import { afterEach, expect, jest, test } from '@jest/globals';

// getSettings runs once per preset while capturing, so it tracks each repair it
// makes instead of comparing canonical JSON of the whole block. reconcile() only
// writes when a repair happened; these cases pin that it still notices each one.

const storePath = '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/store.js';
const originalFetch = globalThis.fetch;
const originalHost = globalThis.SillyTavern;

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalHost;
});

const NAME = 'cardtm_preset_abc.json';

function validRow(extra = {}) {
    return {
        kind: 'preset', target: 'openai/Saved', label: 'Saved', name: NAME,
        ts: 1, size: 10, hash: null, id: NAME, url: `/user/files/${NAME}`, ...extra,
    };
}

function cleanSettings(extra = {}) {
    return {
        settingsVersion: 1,
        snapshots: [validRow()],
        quarantinedSnapshots: [],
        captureCharacters: true,
        captureLorebooks: true,
        capturePresets: true,
        keepPerTarget: 10,
        maxTotalBytes: 50 * 1024 * 1024,
        lastCommit: 'token',
        ...extra,
    };
}

async function reconcileWrites(settings) {
    jest.resetModules();
    const store = await import(storePath);
    const extensionSettings = {
        [store.MODULE_NAME]: settings,
        character_attachments: {
            '__Neconyan-Card-Time-Machine__': [{ url: `/user/files/${NAME}`, size: 10, name: NAME, created: 1 }],
        },
    };
    const saveSettingsDebounced = jest.fn(() => {
        throw new Error('write attempted');
    });
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings, saveSettingsDebounced, getRequestHeaders: () => ({}) }),
    };
    globalThis.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ extension_settings: { [store.MODULE_NAME]: { lastCommit: 'token' } } }),
    }));
    try {
        await store.reconcile();
        return false;
    } catch (error) {
        if (error.message !== 'write attempted') {
            throw error;
        }
        return true;
    }
}

test('clean settings are left alone', async () => {
    expect(await reconcileWrites(cleanSettings())).toBe(false);
});

test.each([
    ['a row without its id', () => cleanSettings({ snapshots: [validRow({ id: undefined })] })],
    ['a row with an uncanonical url', () => cleanSettings({ snapshots: [validRow({ url: `user/files/${NAME}` })] })],
    ['an invalid row', () => cleanSettings({ snapshots: [validRow(), { kind: 'nope' }] })],
    ['a duplicate row', () => cleanSettings({ snapshots: [validRow(), validRow()] })],
    ['a missing quarantine list', () => cleanSettings({ quarantinedSnapshots: undefined })],
    ['a non-boolean capture flag', () => cleanSettings({ capturePresets: 'yes' })],
    ['a fractional retention count', () => cleanSettings({ keepPerTarget: 3.5 })],
    ['a missing size limit', () => cleanSettings({ maxTotalBytes: undefined })],
    ['a missing settings version', () => cleanSettings({ settingsVersion: undefined })],
])('%s is repaired and written', async (_label, make) => {
    expect(await reconcileWrites(make())).toBe(true);
});

/* global globalThis */
import { afterEach, expect, jest, test } from '@jest/globals';
import { liveCharacterState, restoreCharacter, restorePreset } from '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/api.js';

const originalFetch = globalThis.fetch;
const originalHost = globalThis.SillyTavern;
afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalHost;
});

function host() {
    const context = { getRequestHeaders: () => ({}), characters: [], tagMap: {}, constants: { unset: '__unset__' },
        getCharacters: jest.fn(), getPresetManager: () => ({ updateList: jest.fn() }) };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

test('character comparison reads a fresh card and restore carries its revision', async () => {
    const context = host();
    globalThis.fetch = jest.fn(async (url, options) => {
        if (url.endsWith('/get')) return { ok: true, headers: { get: () => 'checked-revision' },
            json: async () => ({ avatar: 'Nova.png', json_data: JSON.stringify({ name: 'Nova', description: 'Current' }) }) };
        expect(JSON.parse(options.body)).toMatchObject({ avatar: 'Nova.png', expected_revision: 'checked-revision' });
        return { ok: false, status: 409 };
    });
    const live = await liveCharacterState('Nova.png');
    expect(live.data.description).toBe('Current');
    expect(JSON.stringify(live)).not.toContain('revision');
    const error = await restoreCharacter('Nova.png', { name: 'Nova', description: 'Snapshot' }, live.data).catch(error => error);
    expect(error.status).toBe(409);
    expect(error.partial).toBeUndefined();
    expect(context.getCharacters).not.toHaveBeenCalled();
});

test('character restore refuses a card without a checked revision', async () => {
    host();
    globalThis.fetch = jest.fn();
    await expect(restoreCharacter('Nova.png', { name: 'Nova' }, { name: 'Nova' })).rejects.toThrow('Read the current');
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('preset restore passes checked content and treats a rejected write as no change', async () => {
    host();
    globalThis.fetch = jest.fn(async (_url, options) => {
        expect(JSON.parse(options.body)).toMatchObject({ expected_preset: { temperature: 0.5 } });
        return { ok: false, status: 409 };
    });
    const error = await restorePreset('openai', 'Moon', { temperature: 0.2 }, { temperature: 0.5 }).catch(error => error);
    expect(error.status).toBe(409);
    expect(error.partial).toBeUndefined();
});

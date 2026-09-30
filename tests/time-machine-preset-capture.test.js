/* global globalThis */
import { afterEach, expect, jest, test } from '@jest/globals';
import { hashOf } from '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/core.js';

const storePath = '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/store.js';
const save = jest.fn(async () => ({ id: 'snapshot' }));
const lastHashOf = jest.fn();
jest.unstable_mockModule(storePath, () => ({ save, lastHashOf, getSettings: () => ({ capturePresets: true }),
    MODULE_NAME: 'test', commitSettings: jest.fn() }));
const { capturePresets } = await import('../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/api.js');
const originalFetch = globalThis.fetch;
const originalHost = globalThis.SillyTavern;
afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalHost;
    jest.clearAllMocks();
});

test('unchanged automatic sweeps make one catalogue request and no snapshot mutations', async () => {
    const preset = { temperature: 0.7, prompts: [{ content: 'Saved prompt' }] };
    const hash = await hashOf({ data: preset });
    expect(hash).toBeTruthy();
    lastHashOf.mockReturnValue(hash);
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ openai_setting_names: ['Saved'], openai_settings: [JSON.stringify(preset)] }) }));
    expect(await capturePresets()).toEqual({ taken: 0, skipped: 1, failed: 0 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    // Manual verification still reaches the store's missing-file repair path.
    expect(await capturePresets({ force: true })).toEqual({ taken: 1, skipped: 0, failed: 0 });
    expect(save).toHaveBeenCalledTimes(1);
    lastHashOf.mockReturnValue('different');
    expect(await capturePresets()).toEqual({ taken: 1, skipped: 0, failed: 0 });
    expect(save).toHaveBeenCalledTimes(2);
});

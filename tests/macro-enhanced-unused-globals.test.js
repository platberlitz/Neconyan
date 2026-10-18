import { describe, expect, jest, test } from '@jest/globals';

import { describeChecked, findUnusedGlobals, removeGlobals, UNUSED_GLOBALS_ENDPOINT } from '../public/scripts/extensions/third-party/MacroEnhanced/src/unused-globals.js';
import { withReadOnlyVariables } from '../public/scripts/variable-read-only.js';

function makeContext(global) {
    return {
        extensionSettings: { variables: { global } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }),
        saveSettingsDebounced: jest.fn(),
    };
}

describe('MacroEnhanced unused global variables', () => {
    test('asks the server about every stored name and keeps only names that still exist', async () => {
        const ctx = makeContext({ pov: 'first', lumia_personality_standard: 'I, Lumia' });
        const fetchFn = jest.fn(async () => ({
            ok: true,
            json: async () => ({ unused: ['lumia_personality_standard', 'gone_meanwhile'], used: ['pov'], checked: { Preset: 2 }, unreadable: 0 }),
        }));

        const result = await findUnusedGlobals(ctx, fetchFn);

        expect(fetchFn).toHaveBeenCalledWith(UNUSED_GLOBALS_ENDPOINT, expect.objectContaining({ method: 'POST' }));
        expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ names: ['pov', 'lumia_personality_standard'] });
        expect(fetchFn.mock.calls[0][1].headers['X-CSRF-Token']).toBe('token');
        expect(result.unused).toEqual(['lumia_personality_standard']);
    });

    test('does not call the server when there are no global variables', async () => {
        const fetchFn = jest.fn();
        expect((await findUnusedGlobals(makeContext({}), fetchFn)).unused).toEqual([]);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    test('reports a server failure instead of removing anything', async () => {
        const fetchFn = jest.fn(async () => ({ ok: false, status: 500 }));
        await expect(findUnusedGlobals(makeContext({ a: '1' }), fetchFn)).rejects.toThrow('(500)');
    });

    test('removes only the confirmed names and saves once', () => {
        const ctx = makeContext({ pov: 'first', old_a: '1', old_b: '2' });
        expect(removeGlobals(ctx, ['old_a', 'old_b', 'missing'])).toEqual(['old_a', 'old_b']);
        expect(ctx.extensionSettings.variables.global).toEqual({ pov: 'first' });
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('removes nothing while variables are read-only', () => {
        const ctx = makeContext({ old_a: '1' });
        expect(withReadOnlyVariables(() => removeGlobals(ctx, ['old_a']))).toEqual([]);
        expect(ctx.extensionSettings.variables.global).toEqual({ old_a: '1' });
        expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('summarises what was checked in plain words', () => {
        expect(describeChecked({ Preset: 210, Character: 1, Settings: 1, Agent: 0 })).toBe('210 presets, 1 character, 1 settings file');
        expect(describeChecked({})).toBe('nothing');
    });
});

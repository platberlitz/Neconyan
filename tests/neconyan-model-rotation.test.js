import { describe, expect, jest, test } from '@jest/globals';

async function loadModule({ profiles = [], commandCallback = jest.fn() } = {}) {
    jest.resetModules();
    const extensionSettings = { connectionManager: { profiles, selectedProfile: null } };
    const listeners = new Map();
    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings }));
    await jest.unstable_mockModule('../public/scripts/events.js', () => ({
        eventSource: { on: jest.fn((event, handler) => listeners.set(event, handler)) },
        event_types: { GENERATION_AFTER_COMMANDS: 'generation_after_commands' },
    }));
    await jest.unstable_mockModule('../public/script.js', () => ({ online_status: 'valid', saveSettingsDebounced: jest.fn() }));
    await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        SlashCommandParser: { commands: { profile: { callback: commandCallback } } },
    }));
    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));

    const rotation = await import('../public/scripts/neconyan-model-rotation.js');
    return { rotation, extensionSettings, listeners, commandCallback };
}

describe('Neconyan model rotation', () => {
    test('picks a ticked profile and avoids repeating the last one', async () => {
        const { rotation } = await loadModule();
        const profiles = [
            { id: 'a', name: 'Alpha', model: 'm-a' },
            { id: 'b', name: 'Beta', model: 'm-b' },
            { id: 'c', name: 'Gamma', model: 'm-c' },
        ];

        expect(rotation.pickNextRotationProfile(profiles, ['a', 'b'], 'a', () => 0)?.id).toBe('b');
        expect(rotation.pickNextRotationProfile(profiles, ['a', 'b'], 'b', () => 0)?.id).toBe('a');
        expect(rotation.pickNextRotationProfile(profiles, ['a'], 'a', () => 0.9)?.id).toBe('a');
        expect(rotation.pickNextRotationProfile(profiles, [], '', () => 0)).toBeNull();
        expect(rotation.pickNextRotationProfile(profiles, ['missing'], '', () => 0)).toBeNull();
    });

    test('skips background and helper generations', async () => {
        const { rotation } = await loadModule();
        const enabled = { enabled: true };

        expect(rotation.shouldRotateForGeneration(enabled, 'normal', {}, false)).toBe(true);
        expect(rotation.shouldRotateForGeneration(enabled, 'swipe', {}, false)).toBe(true);
        expect(rotation.shouldRotateForGeneration(enabled, 'regenerate', {}, false)).toBe(true);
        expect(rotation.shouldRotateForGeneration(enabled, 'continue', {}, false)).toBe(true);
        expect(rotation.shouldRotateForGeneration(enabled, 'normal', {}, true)).toBe(false);
        expect(rotation.shouldRotateForGeneration(enabled, 'quiet', {}, false)).toBe(false);
        expect(rotation.shouldRotateForGeneration(enabled, 'normal', { isAuxiliaryGeneration: true }, false)).toBe(false);
        expect(rotation.shouldRotateForGeneration({ enabled: false }, 'normal', {}, false)).toBe(false);
    });

    test('normalises the stored settings object', async () => {
        const { rotation, extensionSettings } = await loadModule();
        extensionSettings.neconyanModelRotation = { enabled: 'yes', profileIds: 'nope', lastProfileId: 4 };

        const settings = rotation.getModelRotationSettings();
        expect(settings).toEqual({ enabled: false, profileIds: [], lastProfileId: '' });
        expect(extensionSettings.neconyanModelRotation).toBe(settings);
    });

    test('applies the picked profile through the /profile command', async () => {
        const commandCallback = jest.fn(async () => 'Beta');
        const { rotation, extensionSettings, listeners, commandCallback: callback } = await loadModule({
            profiles: [
                { id: 'a', name: 'Alpha', model: 'm-a' },
                { id: 'b', name: 'Beta', model: 'm-b' },
            ],
            commandCallback,
        });
        extensionSettings.neconyanModelRotation = { enabled: true, profileIds: ['a', 'b'], lastProfileId: 'a' };
        rotation.initModelRotation();
        expect(listeners.has('generation_after_commands')).toBe(true);

        await listeners.get('generation_after_commands')('normal', {}, false);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ await: 'true', timeout: '0' }, 'Beta');
        expect(extensionSettings.neconyanModelRotation.lastProfileId).toBe('b');
    });

    test('stays put when rotation is off or the generation is dry', async () => {
        const commandCallback = jest.fn();
        const { rotation, extensionSettings, listeners } = await loadModule({
            profiles: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
            commandCallback,
        });
        extensionSettings.neconyanModelRotation = { enabled: false, profileIds: ['a', 'b'], lastProfileId: '' };
        rotation.initModelRotation();

        await listeners.get('generation_after_commands')('normal', {}, false);
        expect(commandCallback).not.toHaveBeenCalled();

        extensionSettings.neconyanModelRotation.enabled = true;
        await listeners.get('generation_after_commands')('normal', {}, true);
        expect(commandCallback).not.toHaveBeenCalled();
    });
});

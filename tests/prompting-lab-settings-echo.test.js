import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const host = { extensionSettings: {}, saveSettingsDebounced: jest.fn() };

jest.unstable_mockModule('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/host.js', () => ({
    getContext: () => host,
}));

const { SETTINGS_KEY } = await import('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/constants.js');
const settings = await import('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/settings.js');

describe('Prompting Lab settings echoes', () => {
    beforeEach(() => {
        delete host.extensionSettings[SETTINGS_KEY];
        settings.updateSettings({ runRetention: 12 });
        settings.clearSettings();
    });

    test('recognises its own document and ignores a foreign change', () => {
        expect(settings.updateSettings({ runRetention: 7 }).runRetention).toBe(7);
        expect(settings.isOwnSettingsEcho()).toBe(true);

        host.extensionSettings[SETTINGS_KEY] = { ...host.extensionSettings[SETTINGS_KEY], runRetention: 9 };
        expect(settings.isOwnSettingsEcho()).toBe(false);
    });

    test('recognises a clear as its own echo', () => {
        settings.clearSettings();
        expect(settings.isOwnSettingsEcho()).toBe(true);
    });
});

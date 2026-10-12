import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { managerFixture } from './pinned-prompt-test-support.js';

/** Execute the real preset-change callback with only its UI/network dependencies replaced. */
async function fixture() {
    const { manager } = await managerFixture();
    const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
    const start = source.indexOf('function onSettingsPresetChange() {');
    const end = source.indexOf('\nfunction getMaxContextOpenAI(', start);
    const functions = ['migrateChatCompletionSettings', 'maybeShowPresetConnectionBindingReminder', 'syncMaxContextUnlockedControl',
        'setOpenRouterProviders', 'updateNanoGptProviderControls', 'rebuildOpenAIModelSelect', 'updateOpenAIModelFavoriteButton',
        'updateAdvancedFormattingVisibility', 'updateOpenAISettingsGroupVisibility', 'scheduleOpenAIUiRefresh', 'maybeApplyModelSamplingProfile', 'applyLogitBiasPresetSettings'];
    const dependencies = Object.fromEntries(functions.map(name => [name, jest.fn()]));
    const selection = { val: () => selection, prop: () => selection, trigger: () => selection, find: () => ({ text: () => 'B' }), empty() {} };
    const events = [];
    Object.assign(dependencies, { $: () => selection, structuredClone,
        oai_settings: { preset_settings_openai: 'A', bind_preset_to_connection: false }, openai_settings: [{ temperature: 0.7 }], openai_setting_names: { B: 0 },
        settingsToUpdate: { temperature: ['#temperature', 'temperature', false, false, false] }, shouldIncludeSamplingFieldsInPreset: () => true,
        coerceNumericPresetSetting: (_, value) => value, saveSettings: jest.fn(async () => true), saveOpenAIPreset: jest.fn(),
        event_types: { OAI_PRESET_CHANGED_BEFORE: 'before', OAI_PRESET_CHANGED_AFTER: 'after', PRESET_CHANGED: 'changed' },
        eventSource: { emit: async type => {
            events.push(type);
            if (type === 'before') manager.isPresetChanging = true;
            if (type === 'after') manager.isPresetChanging = false;
        } } });
    const change = new Function(...Object.keys(dependencies), 'let settingsPresetChangeGeneration = 0;\n' + source.slice(start, end) + '\nreturn onSettingsPresetChange;')(...Object.values(dependencies));
    return { change, dependencies, manager, events };
}

describe('preset application always releases prompt controls', () => {
    test.each(['rebuildOpenAIModelSelect', 'saveSettings'])('releases after %s throws and preserves the failure', async name => {
        const { change, dependencies, manager, events } = await fixture();
        const failure = new Error('fixture failure');
        dependencies[name].mockImplementation(() => { throw failure; });
        await expect(change()).rejects.toBe(failure);
        expect(events).toEqual(['before', 'after', 'changed']);
        expect(manager.isPresetChanging).toBe(false);
        expect(manager.setPromptEnabled('a', false)).toBe(true);
    });
    test('an older overlapping change does not release a newer pending change', async () => {
        const { change, dependencies, manager, events } = await fixture();
        let firstRelease, secondRelease;
        dependencies.saveSettings.mockImplementationOnce(() => new Promise(resolve => { firstRelease = resolve; }))
            .mockImplementationOnce(() => new Promise(resolve => { secondRelease = resolve; }));
        const first = change();
        await new Promise(resolve => setImmediate(resolve));
        const second = change();
        await new Promise(resolve => setImmediate(resolve));
        firstRelease(); await first;
        expect(manager.isPresetChanging).toBe(true);
        expect(events).toEqual(['before', 'before']);
        secondRelease(); await second;
        expect(manager.isPresetChanging).toBe(false);
        expect(events).toEqual(['before', 'before', 'after', 'changed']);
    });
});

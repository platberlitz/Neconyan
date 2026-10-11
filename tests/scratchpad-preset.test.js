import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const script = { main_api: 'openai' };
const oai_settings = { preset_settings_openai: 'Lantern' };
const prompts = [
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write {{char}}\'s next reply.' },
    { identifier: 'charDescription', name: 'Char Description', marker: true },
    { identifier: 'nsfw', name: 'Spice', role: 'system', content: 'Off text.' },
    { identifier: 'reminder', name: 'Reminder', role: 'user', content: 'Stay in tense.', injection_position: 1, injection_depth: 2 },
];
const promptManager = {
    serviceSettings: {},
    configuration: { promptOrder: { dummyId: 100001 } },
    activeCharacter: { id: 7 },
    orders: new Map(),
    getPromptOrderForCharacter(character) { return this.orders.get(character?.id) ?? []; },
    getPromptById(id) { return prompts.find(item => item.identifier === id) ?? null; },
};
const power_user = {
    sysprompt: { enabled: true, name: 'Neutral', content: 'Be {{char}}.', post_history: 'Stay short.' },
    instruct: { enabled: false, preset: 'Alpaca' },
    context: { preset: 'Default', story_string: '{{description}}' },
};
const presetName = { value: 'Samplers' };

jest.unstable_mockModule('../public/script.js', () => ({ main_api: script.main_api }));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings, promptManager }));
jest.unstable_mockModule('../public/scripts/PromptManager.js', () => ({ INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 } }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager: () => ({ getSelectedPresetName: () => presetName.value }) }));

async function load(api) {
    script.main_api = api;
    jest.resetModules();
    return import('../public/scripts/scratchpad/preset.js');
}
const { readCurrentPreset } = await load('openai');

beforeEach(() => {
    promptManager.orders = new Map([
        [7, [{ identifier: 'main', enabled: true }, { identifier: 'charDescription', enabled: true }, { identifier: 'nsfw', enabled: false }, { identifier: 'reminder', enabled: true }, { identifier: 'missing', enabled: true }]],
        [100001, [{ identifier: 'main', enabled: false }]],
    ]);
});

describe('Scratchpad preset reader', () => {
    test('reads Prompt Manager modules in order with on, off, role, depth and raw text', () => {
        const preset = readCurrentPreset();
        expect(preset).toMatchObject({ kind: 'chat', api: 'Chat Completion', name: 'Lantern' });
        expect(preset.modules).toEqual([
            { id: 'main', name: 'Main Prompt', enabled: true, marker: false, role: 'system', depth: null, content: 'Write {{char}}\'s next reply.' },
            { id: 'charDescription', name: 'Char Description', enabled: true, marker: true, role: '', depth: null, content: '' },
            { id: 'nsfw', name: 'Spice', enabled: false, marker: false, role: 'system', depth: null, content: 'Off text.' },
            { id: 'reminder', name: 'Reminder', enabled: true, marker: false, role: 'user', depth: 2, content: 'Stay in tense.' },
        ]);
    });

    test('falls back to the shared prompt order when the character has none', () => {
        promptManager.orders.delete(7);
        expect(readCurrentPreset().modules.map(item => [item.id, item.enabled])).toEqual([['main', false]]);
    });

    test('lists the system prompt, context and instruct templates in Text Completion', async () => {
        const { currentPresetName, readCurrentPreset } = await load('textgenerationwebui');
        const preset = readCurrentPreset();
        expect(currentPresetName()).toBe('Samplers');
        expect(preset).toMatchObject({ kind: 'text', api: 'Text Completion', name: 'Samplers' });
        expect(preset.modules.map(item => [item.name, item.enabled])).toEqual([
            ['System prompt: Neutral', true],
            ['Context template: Default', true],
            ['Instruct template: Alpaca', false],
        ]);
        expect(preset.modules[0].content).toBe('Be {{char}}.\n\nPost-history instructions:\nStay short.');
        expect(preset.modules[1].content).toBe('{{description}}');
    });
});

/* global globalThis */
import { afterEach, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const originalDocument = globalThis.document;
const originalJquery = globalThis.$;

afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.$ = originalJquery;
    jest.resetModules();
});

test('removed bundles and service adapter cannot be discovered or imported', () => {
    for (const file of ['public/scripts/extensions/memory/manifest.json', 'public/scripts/extensions/stable-diffusion/manifest.json', 'public/scripts/extensions/tts/coqui.js', 'src/vectors/extras-vectors.js', 'src/endpoints/stable-diffusion.js']) {
        expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(false);
    }
    expect(read('public/index.html')).not.toMatch(/id="(?:sd_container|summarize_container)"|sd_message_gen/);
    expect(read('src/server-startup.js')).not.toContain('app.use(\'/api/sd\'');
    expect(JSON.parse(read('default/content/settings.json')).extension_settings).not.toHaveProperty('memory');
    expect(existsSync(new URL('../public/scripts/extensions/quick-image-gen/manifest.json', import.meta.url))).toBe(true);
});

test('Edge migrates saved provider selection while retaining voice settings and checking availability', async () => {
    jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}) }));
    jest.unstable_mockModule('../public/scripts/extensions/tts/index.js', () => ({ getPreviewString: () => '', saveTtsProviderSettings: jest.fn() }));
    globalThis.document = { createElement: () => ({}) };
    const field = { val: () => field, text: () => field, on: () => field };
    globalThis.$ = () => field;
    const { EdgeTtsProvider } = await import('../public/scripts/extensions/tts/edge.js');
    const provider = new EdgeTtsProvider();
    provider.checkReady = jest.fn();
    await provider.loadSettings({ provider: 'extras', rate: 10, voiceMap: { Miso: 'en-US-JennyNeural' } });
    expect(provider.settings).toMatchObject({ provider: 'plugin', rate: 10, voiceMap: { Miso: 'en-US-JennyNeural' } });
    expect(provider.getGenerateUrl()).toBe('/api/plugins/edge-tts/generate');
    provider.isPluginAvailable = jest.fn(async () => false);
    await expect(provider.throwIfModuleMissing()).rejects.toThrow('plugin not loaded');
});

test('an unavailable retired voice adapter disables automatic narration and keeps saved voice data', () => {
    const source = read('public/scripts/extensions/tts/index.js').match(/^function loadSettings\(\) \{[\s\S]*?^}/m)[0];
    const saved = { currentProvider: 'Coqui', enabled: true, Coqui: { voiceMap: { Miso: 'saved-voice' } }, playback_rate: 1 };
    const field = new Proxy({}, { get: () => () => field });
    const saveSettingsDebounced = jest.fn();
    vm.runInNewContext(`(${source})()`, { extension_settings: { tts: saved }, defaultSettings: {}, $: () => field, updateRegexPatternWarning() {}, saveSettingsDebounced });
    expect(saved).toMatchObject({ currentProvider: 'System', enabled: false, Coqui: { voiceMap: { Miso: 'saved-voice' } } });
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
});

test('an unavailable caption provider cannot silently enable paid image requests', () => {
    const source = read('public/scripts/extensions/caption/index.js').match(/^function migrateSettings\(\) \{[\s\S]*?^}/m)[0];
    const saved = { source: 'extras', auto_mode: true, prompt: 'My caption prompt', multimodal_model: 'saved-model' };
    const saveSettingsDebounced = jest.fn();
    const context = { extension_settings: { caption: saved }, saveSettingsDebounced, PROMPT_DEFAULT: 'default', TEMPLATE_DEFAULT: 'template' };
    vm.runInNewContext(`(${source})()`, context);
    expect(saved).toMatchObject({ source: 'local', auto_mode: false, prompt: 'My caption prompt', multimodal_model: 'saved-model' });
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    vm.runInNewContext(`(${source})()`, context);
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
});

test.each([1, '1'])('a retired expression provider %p does not silently start paid model calls', api => {
    const source = read('public/scripts/extensions/expressions/index.js').match(/^function migrateSettings\(\) \{[\s\S]*?^}/m)[0];
    const settings = { api, fallback_expression: 'joy', llmPrompt: 'User prompt', agentSpritePrompt: 'User artwork prompt' };
    vm.runInNewContext(`(${source})()`, {
        extension_settings: { expressions: settings }, saveSettingsDebounced() {},
        EXPRESSION_API: { local: 0, llm: 2, none: 99 }, PROMPT_TYPE: { raw: 'raw' },
        EXPRESSION_SPRITE_FRAMING: { bust: 'bust' }, DEFAULT_EXPRESSION_SPRITE_FRAMING: 'bust',
        EXPRESSION_SPRITE_GENERATION_MODE: { individual: 'individual' }, DEFAULT_EXPRESSION_SPRITE_GENERATION_MODE: 'individual',
        DEFAULT_EXPRESSION_SPRITE_REMOVE_BACKGROUND: false, DEFAULT_EXPRESSION_SPRITE_PROMPT: 'default',
        LEGACY_DEFAULT_EXPRESSION_SPRITE_PROMPT: 'legacy', syncExpressionsAgentProfile: async () => {},
    });
    expect(settings).toMatchObject({ api: 99, fallback_expression: 'joy', llmPrompt: 'User prompt', agentSpritePrompt: 'User artwork prompt' });
});

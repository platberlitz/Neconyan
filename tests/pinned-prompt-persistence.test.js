import { describe, expect, jest, test } from '@jest/globals';
import lodash from '../node_modules/lodash/lodash.js';
import { loadIsolated, managerFixture } from './pinned-prompt-test-support.js';
import { buildChatCompletionPresetForSave } from '../public/scripts/openai-preset-utils.js';
import { settingsToUpdate } from '../public/scripts/chat-preset-mapping.js';

const field = 'neconyan_pinned_prompts';
async function fixture({ settingsSaved = true } = {}) {
    const error = jest.fn();
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ name: 'A' }) }));
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let delayed = false;
    const saveSettings = jest.fn(async () => { if (delayed) await barrier; return settingsSaved; });
    const { PresetManager } = await loadIsolated('scripts/preset-manager.js', {
        '../lib.js': { lodash }, '../script.js': { saveSettings, getRequestHeaders: () => ({}) },
    }, { fetch, toastr: { error } }, 'export { PresetManager };');
    const presetManager = Object.create(PresetManager.prototype);
    presetManager.apiId = 'openai';
    const { manager } = await managerFixture({ './preset-manager.js': { getPresetManager: api => api === 'openai' ? presetManager : null } }, { toastr: { error } });
    const presets = { A: structuredClone(manager.serviceSettings), B: { extensions: { other: 'B' } } };
    presets.A.prompts[0].content = 'saved content';
    presets.A.custom_model = 'saved model';
    presets.A.prompt_order[0].order[0].enabled = false;
    presetManager.getSelectedPresetName = () => manager.serviceSettings.preset_settings_openai;
    presetManager.getPresetList = () => ({ settings: manager.serviceSettings });
    presetManager.getCompletionPresetByName = name => presets[name];
    presetManager.updateList = jest.fn();
    return { manager, presets, presetManager, fetch, error, saveSettings, release, delay: () => { delayed = true; } };
}

describe('preset-owned pins use the real extension writer', () => {
    test('full save/export-style JSON round trip carries pins, while prompt fragments stay unchanged', async () => {
        const { manager } = await fixture();
        manager.serviceSettings.extensions[field] = { version: 1, identifiers: ['a', 'b'] };
        const built = buildChatCompletionPresetForSave(manager.serviceSettings, settingsToUpdate);
        const imported = JSON.parse(JSON.stringify(built));
        expect(imported.extensions[field]).toEqual({ version: 1, identifiers: ['a', 'b'] });
        expect(imported.extensions).not.toBe(manager.serviceSettings.extensions);
        let fragment;
        manager.export = (data, type) => { fragment = { data, type }; };
        // Use the actual existing fragment-export adapter without invoking browser downloads.
        const source = (await import('node:fs')).readFileSync(new URL('../public/scripts/PromptManager.js', import.meta.url), 'utf8');
        const start = source.indexOf('this.handleFullExport = () => {', source.indexOf('// Export all user prompts'));
        const end = source.indexOf('// Export user prompts and order for this character', start);
        new Function(source.slice(start, end)).call(manager);
        manager.configuration.promptOrder.dummyId = 42;
        manager.serviceSettings.prompts[0].marker = false;
        manager.handleFullExport();
        expect(fragment.type).toBe('full');
        expect(Object.keys(fragment.data).sort()).toEqual(['prompt_order', 'prompts']);
        expect(fragment.data.prompts.map(prompt => prompt.identifier)).toContain('a');
        expect(fragment.data.prompt_order).toEqual(manager.getPromptOrderForCharacter(manager.activeCharacter));
    });
    test('updates live and saved metadata without saving dirty prompt/order/model changes or selecting again', async () => {
        const { manager, presets, fetch, presetManager } = await fixture();
        const before = structuredClone(manager.serviceSettings);
        expect(await manager.setPromptPinned('a', true)).toBe(true);
        expect(manager.serviceSettings.extensions[field]).toEqual({ version: 1, identifiers: ['a'] });
        expect(presets.A.extensions[field]).toEqual(manager.serviceSettings.extensions[field]);
        expect(manager.serviceSettings.prompts).toEqual(before.prompts);
        const sent = JSON.parse(fetch.mock.calls[0][1].body);
        expect(sent.name).toBe('A');
        expect(sent.preset.prompts[0].content).toBe('saved content');
        expect(sent.preset.custom_model).toBe('saved model');
        expect(sent.preset.prompt_order[0].order[0].enabled).toBe(false);
        expect(sent.preset.extensions.other).toEqual({ keep: true });
        expect(presetManager.updateList).not.toHaveBeenCalled();
        expect(manager.render).not.toHaveBeenCalled();
        expect(manager.pendingPinWrite).toBeNull();
    });
    test('one in-flight write, captured name and no mutation of preset B after a switch', async () => {
        const f = await fixture();
        f.delay();
        const saving = f.manager.setPromptPinned('a', true);
        await new Promise(resolve => setImmediate(resolve));
        expect(await f.manager.setPromptPinned('b', true)).toBe(false);
        f.manager.serviceSettings.preset_settings_openai = 'B';
        f.manager.serviceSettings.extensions = structuredClone(f.presets.B.extensions);
        f.release();
        expect(await saving).toBe(true);
        expect(f.manager.serviceSettings.extensions).toEqual({ other: 'B' });
        expect(JSON.parse(f.fetch.mock.calls[0][1].body).name).toBe('A');
    });
    test('A -> B -> A reconciles a newly cloned pre-save field without overwriting unrelated edits', async () => {
        const f = await fixture();
        f.delay();
        const saving = f.manager.setPromptPinned('a', true);
        await new Promise(resolve => setImmediate(resolve));
        f.manager.serviceSettings.preset_settings_openai = 'B';
        f.manager.serviceSettings.extensions = structuredClone(f.presets.B.extensions);
        f.manager.serviceSettings.preset_settings_openai = 'A';
        f.manager.serviceSettings.extensions = { ...structuredClone(f.presets.A.extensions), newer: 123 };
        f.release();
        expect(await saving).toBe(true);
        expect(f.manager.serviceSettings.extensions[field]).toEqual({ version: 1, identifiers: ['a'] });
        expect(f.manager.serviceSettings.extensions.newer).toBe(123);
    });
    test('a newer explicit full save keeps its content and already-saved pins instead of being overwritten', async () => {
        const f = await fixture();
        f.delay();
        const saving = f.manager.setPromptPinned('a', true);
        await new Promise(resolve => setImmediate(resolve));
        // Normal full preset saving replaces the registered preset after acknowledgement.
        f.presets.A = structuredClone(f.manager.serviceSettings);
        f.presets.A.prompts[0].content = 'new explicitly saved content';
        f.release();
        expect(await saving).toBe(true);
        expect(f.fetch).not.toHaveBeenCalled();
        expect(f.presets.A.prompts[0].content).toBe('new explicitly saved content');
        expect(f.presets.A.extensions[field].identifiers).toEqual(['a']);
        expect(f.manager.serviceSettings.extensions[field].identifiers).toEqual(['a']);
        expect(f.error).not.toHaveBeenCalled();
    });
    test('failed preset save rolls back only this field, releases pending buttons and shows one error', async () => {
        const f = await fixture();
        f.fetch.mockImplementation(async () => {
            f.manager.serviceSettings.extensions.newer = 'keep';
            f.presets.A.extensions.newer = 'saved keep';
            return { ok: false };
        });
        expect(await f.manager.setPromptPinned('a', true)).toBe(false);
        expect(f.manager.serviceSettings.extensions).toEqual({ other: { keep: true }, newer: 'keep' });
        expect(f.presets.A.extensions).toEqual({ other: { keep: true }, newer: 'saved keep' });
        expect(f.manager.pendingPinWrite).toBeNull();
        expect(f.error).toHaveBeenCalledTimes(1);
        expect(f.manager.saveServiceSettings).toHaveBeenCalledTimes(1);
    });
    test('a failed older write never rolls back pins accepted by a newer full save', async () => {
        const f = await fixture();
        f.fetch.mockImplementation(async () => {
            f.presets.A = structuredClone(f.manager.serviceSettings);
            f.presets.A.prompts[0].content = 'later saved content';
            return { ok: false };
        });
        expect(await f.manager.setPromptPinned('a', true)).toBe(false);
        expect(f.presets.A.extensions[field].identifiers).toEqual(['a']);
        expect(f.manager.serviceSettings.extensions[field].identifiers).toEqual(['a']);
        expect(f.presets.A.prompts[0].content).toBe('later saved content');
        expect(f.error).toHaveBeenCalledTimes(1);
    });
    test('settings failure is not silently reported as a successful pin save', async () => {
        const f = await fixture({ settingsSaved: false });
        expect(await f.manager.setPromptPinned('a', true)).toBe(false);
        expect(f.fetch).not.toHaveBeenCalled();
        expect(f.manager.serviceSettings.extensions[field]).toBeUndefined();
        expect(f.error).toHaveBeenCalledTimes(1);
    });
    test('settlement restores a natively blurred pin, but never takes focus from the composer', async () => {
        const f = await fixture();
        const doc = { body: {}, activeElement: null };
        const label = { textContent: '' };
        let disabled;
        const row = { dataset: { pmIdentifier: 'a' }, querySelector: () => button };
        const button = { matches: () => true, closest: () => row, setAttribute() {}, querySelector: () => label,
            focus: jest.fn(() => { doc.activeElement = button; }) };
        Object.defineProperty(button, 'disabled', { get: () => disabled, set: value => { disabled = value; if (value && doc.activeElement === button) doc.activeElement = doc.body; } });
        f.manager.listElement = { ownerDocument: doc, contains: node => node === button,
            querySelectorAll: selector => selector === '.prompt-manager-pin-action' ? [button] : [row] };
        doc.activeElement = button;
        expect(await f.manager.setPromptPinned('a', true)).toBe(true);
        expect(button.focus).toHaveBeenCalledTimes(1);
        expect(doc.activeElement).toBe(button);
        button.focus.mockClear();
        const composer = {};
        f.fetch.mockImplementation(async () => { doc.activeElement = composer; return { ok: true, json: async () => ({ name: 'A' }) }; });
        expect(await f.manager.setPromptPinned('a', false)).toBe(true);
        expect(button.focus).not.toHaveBeenCalled();
        expect(doc.activeElement).toBe(composer);
    });
    test('failed A write cannot roll back B, nor a newer explicit field value', async () => {
        const f = await fixture();
        f.delay();
        const saving = f.manager.setPromptPinned('a', true);
        await new Promise(resolve => setImmediate(resolve));
        f.manager.serviceSettings.preset_settings_openai = 'B';
        f.manager.serviceSettings.extensions = { [field]: { version: 1, identifiers: ['b'] }, other: 'B' };
        f.fetch.mockRejectedValue(new Error('offline'));
        f.release();
        expect(await saving).toBe(false);
        expect(f.manager.serviceSettings.extensions[field].identifiers).toEqual(['b']);
    });
    test('removed preset or stale scope before dependency loading causes no write', async () => {
        const f = await fixture();
        const saving = f.manager.setPromptPinned('a', true);
        delete f.presets.A;
        expect(await saving).toBe(false);
        expect(f.fetch).not.toHaveBeenCalled();
        const g = await fixture();
        const stale = g.manager.setPromptPinned('a', true);
        g.manager.activeCharacter = { id: 7 };
        expect(await stale).toBe(false);
        expect(g.saveSettings).not.toHaveBeenCalled();
    });
});

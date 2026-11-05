import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { resolveProfileProxy } from '../public/scripts/connection-profile-request.js';

/** Run named top-level declarations of a real module in a context whose dependencies the test supplies. */
function load(context, file, names) {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const name of names) {
        const node = ast.body.map(item => item.declaration ?? item)
            .find(item => item.id?.name === name || item.declarations?.some(declaration => declaration.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(`${source.slice(node.start, node.end)}\nglobalThis.${name} = ${name};`, context);
    }
}

function profileContext(confirmProfileProxy, commands = profile => Object.assign(profile, { api: 'openai', proxy: 'Fixture proxy' })) {
    const element = { find: () => element, on: () => element };
    return vm.createContext({
        structuredClone, console, main_api: 'openai', uuidv4: () => 'id-1', MODULE_NAME: 'connection-manager', FANCY_NAMES: {}, NONE: '<None>',
        readProfileFromCommands: jest.fn(async (_mode, profile) => { commands(profile); }),
        makeFancyProfile: profile => profile, renderExtensionTemplateAsync: async () => '', $: () => element,
        extension_settings: { connectionManager: { profiles: [] } }, getUniqueName: name => name, collapseSpaces: value => value,
        callGenericPopup: jest.fn(), POPUP_TYPE: { INPUT: 'input' }, DOMPurify: { sanitize: value => value },
        toastr: { error: jest.fn() }, confirmProfileProxy,
    });
}

describe('a connection profile confirms its proxy when it is saved', () => {
    test('creating a profile asks about its proxy before saving it', async () => {
        const confirm = jest.fn(async () => true);
        const context = profileContext(confirm);
        load(context, 'scripts/extensions/connection-manager/index.js', ['createConnectionProfile']);
        const profile = await context.createConnectionProfile('Fixture');
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0]).toMatchObject({ mode: 'cc', api: 'openai', proxy: 'Fixture proxy' });
        expect(profile).toMatchObject({ name: 'Fixture', proxy: 'Fixture proxy' });
    });

    test('a declined proxy leaves the new profile unsaved', async () => {
        const context = profileContext(jest.fn(async () => false));
        load(context, 'scripts/extensions/connection-manager/index.js', ['createConnectionProfile']);
        await expect(context.createConnectionProfile('Fixture')).resolves.toBeNull();
    });

    test('updating a profile asks about its proxy, and a no puts the profile back', async () => {
        const confirm = jest.fn(async () => false);
        const context = profileContext(confirm, profile => Object.assign(profile, { proxy: 'New proxy' }));
        load(context, 'scripts/extensions/connection-manager/index.js', ['updateConnectionProfile']);
        const profile = { id: 'id-1', mode: 'cc', api: 'openai', proxy: 'Old proxy', exclude: [] };
        const before = structuredClone(profile);
        await expect(context.updateConnectionProfile(profile)).resolves.toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(profile).toEqual(before);
    });

    test('an accepted proxy keeps the updated profile', async () => {
        const context = profileContext(jest.fn(async () => true), profile => Object.assign(profile, { proxy: 'New proxy' }));
        load(context, 'scripts/extensions/connection-manager/index.js', ['updateConnectionProfile']);
        const profile = { id: 'id-1', mode: 'cc', api: 'openai', proxy: 'Old proxy', exclude: [] };
        await expect(context.updateConnectionProfile(profile)).resolves.toBe(true);
        expect(profile.proxy).toBe('New proxy');
    });

    test.each([
        ['the proxy preset it names', { mode: 'cc', api: 'openai', proxy: 'Fixture proxy' }, 'https://preset.invalid', 'openai'],
        ['the proxy it would send with no preset named', { mode: 'cc', api: 'claude' }, 'https://global.invalid', 'claude'],
    ])('confirms %s', async (_label, profile, proxy, source) => {
        const confirmSavedProxy = jest.fn(async () => true);
        const context = vm.createContext({
            CONNECT_API_MAP: { openai: { selected: 'openai', source: 'openai' }, claude: { selected: 'openai', source: 'claude' } },
            proxies: [{ name: 'Fixture proxy', url: 'https://preset.invalid', password: '' }],
            oai_settings: { reverse_proxy: 'https://global.invalid', proxy_password: '' },
            resolveProfileProxy, confirmSavedProxy, t: strings => strings.join(''),
        });
        load(context, 'scripts/extensions/shared.js', ['getChatCompletionProfileReverseProxy', 'confirmProfileProxy']);
        await expect(context.confirmProfileProxy(profile)).resolves.toBe(true);
        expect(confirmSavedProxy).toHaveBeenCalledWith(proxy, source, 'Connection profile not saved. Confirm its proxy address to save it.');
    });

    test('a Text Completion profile asks nothing', async () => {
        const confirmSavedProxy = jest.fn(async () => true);
        const context = vm.createContext({ CONNECT_API_MAP: {}, proxies: [], oai_settings: {}, resolveProfileProxy, confirmSavedProxy, t: strings => strings.join('') });
        load(context, 'scripts/extensions/shared.js', ['getChatCompletionProfileReverseProxy', 'confirmProfileProxy']);
        await expect(context.confirmProfileProxy({ mode: 'tc', api: 'koboldcpp' })).resolves.toBe(true);
        expect(confirmSavedProxy).not.toHaveBeenCalled();
    });
});

describe('a Chat Completion preset confirms its proxy when it is saved or imported', () => {
    function importContext(confirmPresetProxy, sensitiveChoice) {
        const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ name: 'Fixture' }) }));
        const selection = { prop: () => selection, trigger: () => selection, append: () => selection };
        const context = vm.createContext({
            console, JSON, fetch, confirmPresetProxy,
            getFileText: async file => file.text,
            Popup: { show: { confirm: jest.fn(async () => sensitiveChoice) } },
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
            callGenericPopup: jest.fn(async () => true), POPUP_TYPE: { CONFIRM: 'confirm' },
            eventSource: { emit: jest.fn(async () => {}) }, event_types: { OAI_PRESET_IMPORT_READY: 'ready' },
            migrateNanoGptProviderSettings: () => {}, getRequestHeaders: () => ({}),
            toastr: { error: jest.fn() }, t: strings => strings.join(''),
            oai_settings: {}, openai_settings: [], openai_setting_names: {},
            $: () => selection, document: { createElement: () => ({}) },
        });
        load(context, 'scripts/openai.js', ['sensitiveFields', 'onPresetImportFileChange']);
        return { context, fetch };
    }
    const proxyPreset = { name: 'Fixture.json', text: JSON.stringify({ chat_completion_source: 'openai', reverse_proxy: 'https://import.invalid', temperature: 1 }) };

    test('importing a preset with its proxy kept asks about that proxy, then saves it', async () => {
        const confirm = jest.fn(async () => true);
        const { context, fetch } = importContext(confirm, 0);
        await context.onPresetImportFileChange({ target: { files: [proxyPreset], value: 'x' } });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0]).toMatchObject({ reverse_proxy: 'https://import.invalid' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('a declined proxy leaves the import incomplete', async () => {
        const { context, fetch } = importContext(jest.fn(async () => false), 0);
        await context.onPresetImportFileChange({ target: { files: [proxyPreset], value: 'x' } });
        expect(fetch).not.toHaveBeenCalled();
    });

    test('removing the proxy fields on import means the checked body has no proxy', async () => {
        const confirm = jest.fn(async () => true);
        const { context } = importContext(confirm, 1);
        await context.onPresetImportFileChange({ target: { files: [proxyPreset], value: 'x' } });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0]).not.toHaveProperty('reverse_proxy');
    });

    test('saving a new preset that carries a proxy stops when the proxy is declined', async () => {
        const saveOpenAIPreset = jest.fn(async () => {});
        const confirmPresetProxy = jest.fn(async () => false);
        const context = vm.createContext({
            Popup: { show: { input: jest.fn(async () => 'Fixture') } }, t: strings => strings.join(''),
            oai_settings: { preset_settings_openai: 'Old', reverse_proxy: 'https://save.invalid' },
            getChatCompletionPreset: settings => ({ reverse_proxy: settings.reverse_proxy, chat_completion_source: 'openai' }),
            confirmPresetProxy, saveOpenAIPreset,
        });
        load(context, 'scripts/openai.js', ['onNewPresetClick']);
        await context.onNewPresetClick();
        expect(confirmPresetProxy).toHaveBeenCalledWith({ reverse_proxy: 'https://save.invalid', chat_completion_source: 'openai' }, 'Preset not saved. Confirm its proxy address to save it.');
        expect(saveOpenAIPreset).not.toHaveBeenCalled();
    });

    test('Update preset asks about the proxy before saving', () => {
        const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        const handler = source.slice(source.indexOf('$(\'#update_oai_preset\').on(\'click\''), source.indexOf('$(\'#impersonation_prompt_restore\')'));
        expect(handler).toContain('if (!await confirmPresetProxy(getChatCompletionPreset(oai_settings), t`Preset not saved. Confirm its proxy address to save it.`)) {');
        expect(handler.indexOf('confirmPresetProxy')).toBeLessThan(handler.indexOf('saveOpenAIPreset'));
    });

    test.each([
        ['its own source', { reverse_proxy: 'https://p.invalid', chat_completion_source: 'claude' }, 'claude'],
        ['the current source when it names none', { reverse_proxy: 'https://p.invalid' }, 'openai'],
    ])('a preset proxy is checked against %s', async (_label, preset, source) => {
        const confirmSavedProxy = jest.fn(async () => true);
        const context = vm.createContext({ confirmSavedProxy, oai_settings: { chat_completion_source: 'openai' } });
        load(context, 'scripts/openai.js', ['confirmPresetProxy']);
        await context.confirmPresetProxy(preset, 'message');
        expect(confirmSavedProxy).toHaveBeenCalledWith('https://p.invalid', source, 'message');
    });
});

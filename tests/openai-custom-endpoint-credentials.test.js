/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildCustomEndpointPresetForSave, normalizeCustomEndpointPreset } from '../public/scripts/openai-preset-utils.js';
import { generationSettingsSnapshot } from '../public/scripts/generation-settings.js';

const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const connectSource = source.match(/async function onConnectButtonClick\(e\) \{[\s\S]*?\n\}/)[0];
const keyInputSource = source.match(/function updateCustomEndpointKeyInput\(preset, key\) \{[\s\S]*?\n\}/)[0];
const activateSource = source.match(/async function activateCustomEndpointPresetSecret\([\s\S]*?\n\}/)[0];
const setPresetSource = source.match(/async function setCustomEndpointPreset\([\s\S]*?\n\}/)[0];
const saveSource = source.match(/\$\('#save_custom_endpoint'\)\.on\('click', async function \(\) \{[\s\S]*?\n\}\);/)[0];
const deleteSource = source.match(/\$\('#delete_custom_endpoint'\)\.on\('click', async function \(\) \{[\s\S]*?\n\}\);/)[0];
const changeSource = source.match(/async function onCustomEndpointPresetChange\([\s\S]*?\n\}/)[0];
const optionSource = source.match(/function getCustomEndpointPresetOption\(name\) \{[\s\S]*?\n\}/)[0];
const editedSource = source.match(/export function refreshCustomEndpointPresetEditedState\(\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '');
const pruneSource = source.match(/export function pruneStaleCustomEndpointSecretBindings\(\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '');
const renameSource = source.match(/function renameCustomEndpointPreset\(oldName, newName\) \{[\s\S]*?\n\}/)[0];
const syncSource = source.match(/export function syncCustomEndpointPresetSelectionBySecretId\(secretId\) \{[\s\S]*?\n\}/)[0].replace(/^export /, '');
const POPUP_TYPE = { CONFIRM: 'confirm' };
const POPUP_RESULT = { AFFIRMATIVE: 1, CANCEL: 0 };
const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const saverSource = ['buildSettingsPayloadExtensionSettings', 'saveSettings', 'saveSettingsInner', 'captureActiveGenerationSelection', 'normalizeSettingsVersion', 'normalizeSettingsRevision']
    .map(name => scriptSource.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join('\n');
const sources = Object.fromEntries([...source.matchAll(/chat_completion_sources\.([A-Z0-9_]+)/g)].map(([, name]) => [name, name.toLowerCase()]));
const keys = Object.fromEntries(Object.keys(sources).map(name => [name, `api_key_${name.toLowerCase()}`]));
const saveFailures = [
    ['HTTP', context => context.fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })],
    ['network', context => context.fetch.mockRejectedValue(new Error('Network failure'))],
    ['compression', context => context.compressRequest.mockRejectedValue(new Error('Compression failure'))],
    ...[undefined, 0, 1, 'invalid', 1.5].map(version => [
        `version ${version}`, context => context.fetch.mockResolvedValue({ ok: true, json: async () => ({ version, settingsRevision: 2 }) }),
    ]),
    ['invalid JSON', context => context.fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })],
    ['409', context => context.fetch.mockResolvedValue({ status: 409, json: async () => ({ version: 5 }) })],
    ['existing conflict', context => { context.settingsConflictReloadRequired = true; }],
    ['not ready', context => { context.settingsReady = false; }],
    ['temporary length', context => context.TempResponseLength.isCustomized.mockReturnValue(true)],
];

function createHarness({ profile = normalizeCustomEndpointPreset({ name: 'Saved endpoint', secretId: 'saved-id' }), input = '', writeResult = 'replacement-id' } = {}) {
    const values = new Map([['#api_key_custom', input], ['#custom_endpoint_preset_name', profile.name], ['#custom_endpoint_preset', profile.name]]);
    const attributes = new Map();
    const secretState = { [keys.CUSTOM]: [{ id: 'unrelated-active-id', active: true }] };
    let persistedSettings;
    const handlers = new Map();
    const optionTexts = new Map();
    const context = {
        ...Object.fromEntries([
            'firstRun', 'currentVersion', 'name1', 'active_character', 'active_group', 'user_avatar',
            'amount_gen', 'max_context', 'main_api', 'textgen_settings', 'swipes', 'horde_settings',
            'power_user', 'tags', 'tag_map', 'nai_settings', 'kai_settings',
            'background_settings', 'proxies', 'selected_proxy',
        ].map(name => [name, null])),
        extension_settings: { sillybunny_conversation: { characters: {} }, otherExtension: { enabled: true } },
        CONVERSATION_STORE_KEY: 'sillybunny_conversation',
        settingsSaveQueue: Promise.resolve(),
        pendingSettingsAcknowledgements: 0,
        acknowledgedGenerationSettings: null,
        generationSettingsSnapshot,
        getPresetManager: () => null,
        settingsReady: true,
        settingsConflictReloadRequired: false,
        settingsConflictPromptDismissed: false,
        lastServerSettingsVersion: 1,
        lastServerSettingsRevision: 1,
        settings: {},
        accountStorage: { getState: () => ({}) },
        getWorldInfoSettings: () => ({}),
        getRequestHeaders: () => ({}),
        getCurrentUserHandle: () => 'one',
        TempResponseLength: { isCustomized: jest.fn(() => false), restore: jest.fn() },
        promptSettingsConflictReload: jest.fn(async () => {}),
        compressRequest: jest.fn(async request => request),
        fetch: jest.fn(async (_, request) => {
            persistedSettings = JSON.parse(request.body);
            return { ok: true, json: async () => ({ version: persistedSettings._version + 1, settingsRevision: persistedSettings._settingsRevision + 1 }) };
        }),
        eventSource: { emit: jest.fn(async () => {}) },
        event_types: { SETTINGS_UPDATED: 'settings_updated' },
        chat_completion_sources: sources,
        SECRET_KEYS: keys,
        oai_settings: { chat_completion_source: sources.CUSTOM },
        selected_custom_endpoint_preset: profile,
        custom_endpoint_presets: [profile],
        normalizeCustomEndpointPreset,
        buildCustomEndpointPresetForSave,
        secret_state: secretState,
        console: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        t: strings => strings.join(''),
        toastr: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
        refreshModelIdSearchControlsForSource: jest.fn(),
        reconnectOpenAi: jest.fn(),
        updateCustomEndpointPresetOption: jest.fn(),
        appendCustomEndpointPresetOption: jest.fn(),
        rotateSecret: jest.fn(async () => {}),
        deleteSecret: jest.fn(async () => {}),
        callGenericPopup: jest.fn(async () => POPUP_RESULT.AFFIRMATIVE),
        POPUP_TYPE,
        POPUP_RESULT,
        $: selector => ({
            find() {
                return this;
            },
            on(event, handler) {
                handlers.set(selector, handler);
            },
            val(value) {
                if (value === undefined) return values.get(selector) ?? '';
                values.set(selector, value);
                return this;
            },
            attr(name, value) {
                attributes.set(`${selector}:${name}`, value);
                return this;
            },
            removeAttr(name) {
                attributes.delete(`${selector}:${name}`);
                return this;
            },
            trigger() {
                return this;
            },
            text(value) {
                if (value !== undefined) optionTexts.set(selector, value);
                return this;
            },
            filter(callback) {
                const name = values.get('#custom_endpoint_preset') ?? '';
                const matched = callback(0, { value: name });
                return {
                    length: matched ? 1 : 0,
                    remove() {
                        return this;
                    },
                    attr() {
                        return this;
                    },
                    text(value) {
                        if (value !== undefined) optionTexts.set(name, value);
                        return this;
                    },
                };
            },
        }),
        writeSecret: jest.fn(async () => {
            if (writeResult) {
                values.set('#api_key_custom', '');
                secretState[keys.CUSTOM] = [{ id: writeResult, active: true }];
            }
            return writeResult;
        }),
        startStatusLoading: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        getStatusOpen: jest.fn(async () => context.selected_custom_endpoint_preset?.secretId),
    };
    runInNewContext(`${saverSource}\n${keyInputSource}\n${connectSource}\n${activateSource}\n${setPresetSource}\n${changeSource}\n${saveSource}\n${deleteSource}\n${optionSource}\n${editedSource}\n${pruneSource}\n${renameSource}\n${syncSource}`, context);
    return {
        context,
        profile,
        values,
        attributes,
        optionTexts,
        POPUP_TYPE,
        POPUP_RESULT,
        connect: () => context.onConnectButtonClick({ stopPropagation() {} }),
        save: () => handlers.get('#save_custom_endpoint')(),
        deleteProfile: () => handlers.get('#delete_custom_endpoint')(),
        reload: () => createHarness({ profile: persistedSettings.selected_custom_endpoint_preset }),
        persisted: () => persistedSettings,
    };
}

describe('Custom endpoint profile credentials on Connect', () => {
    test('does not reselect A when B is selected during the settings response', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        const other = normalizeCustomEndpointPreset({ name: 'B', model: 'model-b', secretId: 'b-id' });
        harness.context.custom_endpoint_presets.push(other);
        let finishSave;
        const fetch = harness.context.fetch.getMockImplementation();
        harness.context.fetch.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(fetch(...args));
        }));

        const saving = harness.save();
        await new Promise(resolve => setImmediate(resolve));
        harness.values.set('#custom_endpoint_preset', 'B');
        await harness.context.onCustomEndpointPresetChange();
        finishSave();
        await saving;

        expect(harness.context.selected_custom_endpoint_preset).toBe(other);
        expect(harness.context.oai_settings.custom_model).toBe('model-b');
        expect(harness.values.get('#custom_endpoint_preset')).toBe('B');
    });

    test.each(saveFailures)('does not report success or continue replacement Connect on %s', async (_, fail) => {
        for (const action of ['save', 'connect']) {
            const harness = createHarness({ input: 'replacement-test-key' });
            fail(harness.context);
            await harness[action]();

            expect(harness.context.toastr.success).not.toHaveBeenCalled();
            expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
            expect(harness.profile.secretId).toBe('replacement-id');
            expect(harness.values.get('#api_key_custom')).toBe('');
        }
    });

    test.each(['save', 'connect'])('retains the written binding for Save retry after %s settings failure', async action => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.context.fetch.mockRejectedValueOnce(new Error('Network failure'));
        await harness[action]();
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');

        await harness.save();
        expect(harness.context.writeSecret).toHaveBeenCalledTimes(1);
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.reload().profile.secretId).toBe('replacement-id');
        expect(JSON.stringify(harness.persisted())).not.toContain('replacement-test-key');
    });

    test.each(['save', 'connect'])('does not persist a failed secret write and allows %s retry', async action => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.context.writeSecret.mockResolvedValueOnce(null);
        await harness[action]();
        expect(harness.context.fetch).not.toHaveBeenCalled();
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.values.get('#api_key_custom')).toBe('replacement-test-key');

        await harness[action]();
        expect(harness.context.writeSecret).toHaveBeenCalledTimes(2);
        expect(harness.reload().profile.secretId).toBe('replacement-id');
    });

    test('persists the profile binding before reporting a successful Save', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.values.set('#custom_endpoint_preset_name', harness.profile.name);
        harness.values.set('#custom_api_url_text', 'https://endpoint.example/v1');
        harness.values.set('#custom_model_id', 'test-model');
        let finishSave;
        const fetch = harness.context.fetch.getMockImplementation();
        harness.context.fetch.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(fetch(...args));
        }));

        const saving = harness.save();
        await new Promise(resolve => setImmediate(resolve));

        expect(harness.context.fetch).toHaveBeenCalledTimes(1);
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.context.selected_custom_endpoint_preset).toBe(harness.profile);
        expect(harness.values.get('#custom_endpoint_preset')).toBe(harness.profile.name);
        finishSave();
        await saving;
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.persisted().custom_endpoint_presets[0].key).toBe('');
        expect(JSON.stringify(harness.persisted())).not.toContain('replacement-test-key');
        expect(harness.reload().profile.secretId).toBe('replacement-id');
    });

    test('persists a replacement binding before checking the connection', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        let finishSave;
        const fetch = harness.context.fetch.getMockImplementation();
        harness.context.fetch.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(fetch(...args));
        }));

        const connecting = harness.connect();
        await new Promise(resolve => setImmediate(resolve));

        expect(harness.context.fetch).toHaveBeenCalledTimes(1);
        expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
        finishSave();
        await connecting;
        expect(harness.context.getStatusOpen).toHaveBeenCalledTimes(1);
    });

    test('replaces the saved credential before connecting and keeps it after reload', async () => {
        const harness = createHarness({ input: ' replacement-test-key ' });

        await harness.connect();

        expect(harness.context.writeSecret).toHaveBeenCalledWith(keys.CUSTOM, 'replacement-test-key');
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.profile.key).toBe('');
        expect(harness.values.get('#api_key_custom')).toBe('');
        expect(harness.attributes.get('#api_key_custom:placeholder')).toBe('(saved secret)');
        expect(await harness.context.getStatusOpen.mock.results[0].value).toBe('replacement-id');

        const reloaded = harness.reload();
        await reloaded.connect();
        expect(reloaded.context.writeSecret).not.toHaveBeenCalled();
        expect(await reloaded.context.getStatusOpen.mock.results[0].value).toBe('replacement-id');
    });

    test('reuses the profile credential when no replacement was entered', async () => {
        const harness = createHarness();

        await harness.connect();
        await harness.connect();

        expect(harness.context.writeSecret).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(await harness.context.getStatusOpen.mock.results[0].value).toBe('saved-id');
    });

    test('binds a key entered for a legacy profile without a secret id', async () => {
        const harness = createHarness({
            profile: normalizeCustomEndpointPreset({ name: 'Legacy endpoint', key: 'legacy-test-key' }),
            input: 'replacement-test-key',
        });

        await harness.connect();

        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.profile.key).toBe('');
    });

    test('leaves the None profile unbound when connecting a manually entered key', async () => {
        const harness = createHarness({
            profile: normalizeCustomEndpointPreset({ name: 'None' }),
            input: 'manual-test-key',
        });

        await harness.connect();

        expect(harness.context.writeSecret).toHaveBeenCalledWith(keys.CUSTOM, 'manual-test-key');
        expect(harness.profile.secretId).toBe('');
    });

    test('does not connect with the old key if saving its replacement fails', async () => {
        const harness = createHarness({ input: 'replacement-test-key', writeResult: null });

        await harness.connect();

        expect(harness.context.writeSecret).toHaveBeenCalledTimes(1);
        expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.values.get('#api_key_custom')).toBe('replacement-test-key');
    });

    test('binds the key to the original profile if selection changes while it is being saved', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        const otherProfile = { ...harness.profile, name: 'Other endpoint' };
        harness.context.writeSecret.mockImplementation(async () => {
            harness.context.selected_custom_endpoint_preset = otherProfile;
            return 'replacement-id';
        });

        await harness.connect();

        expect(harness.profile.secretId).toBe('replacement-id');
        expect(otherProfile.secretId).toBe('saved-id');
        expect(harness.attributes.has('#api_key_custom:placeholder')).toBe(false);
    });
});

describe('Custom endpoint profile hardening', () => {
    test('does not bind a keyless new profile to a secret owned by another profile', async () => {
        const harness = createHarness();
        harness.context.custom_endpoint_presets.push(normalizeCustomEndpointPreset({ name: 'Owner', secretId: 'unrelated-active-id' }));
        harness.values.set('#custom_endpoint_preset_name', 'Local endpoint');
        harness.values.set('#custom_api_url_text', 'http://127.0.0.1:8080/v1');
        harness.values.set('#custom_model_id', 'local-model');

        await harness.save();

        const saved = harness.context.custom_endpoint_presets.find(preset => preset.name === 'Local endpoint');
        expect(saved.secretId).toBe('replacement-id');
        expect(saved.secretId).not.toBe('unrelated-active-id');
    });

    test('binds the active secret to a keyless new profile when no other profile owns it', async () => {
        const harness = createHarness();
        harness.values.set('#custom_endpoint_preset_name', 'Local endpoint');
        harness.values.set('#custom_api_url_text', 'http://127.0.0.1:8080/v1');
        harness.values.set('#custom_model_id', 'local-model');

        await harness.save();

        const saved = harness.context.custom_endpoint_presets.find(preset => preset.name === 'Local endpoint');
        expect(saved.secretId).toBe('unrelated-active-id');
        expect(harness.context.writeSecret).not.toHaveBeenCalled();
    });

    test('rebinds an existing profile to the active secret when saved with an empty key box', async () => {
        const harness = createHarness();
        harness.values.set('#custom_endpoint_preset_name', harness.profile.name);

        await harness.save();

        expect(harness.profile.secretId).toBe('unrelated-active-id');
        expect(harness.context.writeSecret).not.toHaveBeenCalled();
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
    });

    test('clears typed key text before rotating a profile secret and skips the second reconnect', async () => {
        const harness = createHarness();
        const other = normalizeCustomEndpointPreset({ name: 'B', secretId: 'b-id' });
        harness.context.custom_endpoint_presets.push(other);
        harness.values.set('#api_key_custom', 'typed-not-sent');
        harness.values.set('#custom_endpoint_preset', 'B');
        let inputDuringRotate;
        harness.context.rotateSecret.mockImplementation(async () => {
            inputDuringRotate = harness.values.get('#api_key_custom');
        });

        await harness.context.onCustomEndpointPresetChange();

        expect(inputDuringRotate).toBe('');
        expect(harness.context.rotateSecret).toHaveBeenCalledWith(keys.CUSTOM, 'b-id');
        expect(harness.context.reconnectOpenAi).not.toHaveBeenCalled();
    });

    test('refuses to delete None or a missing profile', async () => {
        const harness = createHarness();
        harness.values.set('#custom_endpoint_preset', 'None');

        await harness.deleteProfile();

        expect(harness.context.toastr.error).toHaveBeenCalledTimes(1);
        expect(harness.context.callGenericPopup).not.toHaveBeenCalled();
        expect(harness.context.custom_endpoint_presets).toHaveLength(1);
    });

    test('deletes the dropdown selection after confirmation, keeps the fields and drops the unshared secret', async () => {
        const harness = createHarness();
        harness.context.secret_state[keys.CUSTOM] = [{ id: 'saved-id', active: true }];
        harness.values.set('#custom_endpoint_preset', harness.profile.name);

        await harness.deleteProfile();

        expect(harness.context.custom_endpoint_presets.some(preset => preset.name === harness.profile.name)).toBe(false);
        expect(harness.values.get('#custom_endpoint_preset')).toBe('None');
        expect(harness.context.oai_settings.custom_url).toBeUndefined();
        expect(harness.context.deleteSecret).toHaveBeenCalledWith(keys.CUSTOM, 'saved-id');
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
    });

    test('keeps the profile when deletion is not confirmed', async () => {
        const harness = createHarness();
        harness.values.set('#custom_endpoint_preset', harness.profile.name);
        harness.context.callGenericPopup.mockResolvedValueOnce(POPUP_RESULT.CANCEL);

        await harness.deleteProfile();

        expect(harness.context.custom_endpoint_presets).toHaveLength(1);
        expect(harness.context.deleteSecret).not.toHaveBeenCalled();
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
    });

    test('renames a profile in place and updates connection profiles that reference it', async () => {
        const harness = createHarness();
        harness.context.secret_state[keys.CUSTOM] = [{ id: 'saved-id', active: true }];
        const connectionProfile = { 'custom-endpoint-profile': harness.profile.name };
        harness.context.extension_settings = { connectionManager: { profiles: [connectionProfile] } };
        harness.values.set('#custom_endpoint_preset_name', 'Renamed endpoint');

        await harness.save();

        expect(harness.profile.name).toBe('Renamed endpoint');
        expect(connectionProfile['custom-endpoint-profile']).toBe('Renamed endpoint');
        expect(harness.context.custom_endpoint_presets).toHaveLength(1);
        expect(harness.context.toastr.success).toHaveBeenCalledWith('Custom Endpoint Profile Renamed');
    });

    test('clears a binding that points at a secret which no longer exists', () => {
        const harness = createHarness();
        harness.context.secret_state[keys.CUSTOM] = [{ id: 'other-id', active: true }];

        expect(harness.context.pruneStaleCustomEndpointSecretBindings()).toBe(true);

        expect(harness.profile.secretId).toBe('');
        expect(harness.profile.key).toBe('');
        expect(harness.context.toastr.warning).toHaveBeenCalledTimes(1);
    });

    test('follows a secret rotation to the profile that owns it', () => {
        const harness = createHarness();
        const other = normalizeCustomEndpointPreset({ name: 'B', secretId: 'b-id' });
        harness.context.custom_endpoint_presets.push(other);
        harness.values.set('#custom_endpoint_preset', harness.profile.name);

        expect(harness.context.syncCustomEndpointPresetSelectionBySecretId('b-id')).toBe(true);

        expect(harness.context.selected_custom_endpoint_preset).toBe(other);
        expect(harness.values.get('#custom_endpoint_preset')).toBe('B');
    });

    test('marks the selected profile as edited when the live URL or model differ', () => {
        const harness = createHarness();
        harness.context.oai_settings.custom_url = 'https://other.example/v1';
        harness.context.oai_settings.custom_model = 'other-model';

        harness.context.refreshCustomEndpointPresetEditedState();

        expect(harness.optionTexts.get(harness.profile.name)).toBe(`${harness.profile.name} (edited)`);
    });
});

describe('Queued settings save acknowledgement', () => {
    test('queued settings from a previous login are discarded and current saves send their account', async () => {
        const { context } = createHarness();
        let account = 'one';
        context.getCurrentUserHandle = () => account;
        const old = context.saveSettings(0, { returnResult: true });
        account = 'two';
        expect(await old).toBe(false);
        expect(context.fetch).not.toHaveBeenCalled();
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
        expect(context.fetch.mock.calls[0][1].headers['X-Neconyan-Account']).toBe('two');
    });

    test('a settings response finishing after a login change cannot publish its old payload', async () => {
        const { context } = createHarness();
        let account = 'one';
        context.getCurrentUserHandle = () => account;
        context.fetch.mockResolvedValueOnce({ ok: true, json: async () => { account = 'two'; return { version: 2 }; } });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.eventSource.emit).not.toHaveBeenCalled();
    });
    test.each([false, true])('preserves the default result and optionally confirms success: %s', async returnResult => {
        const { context } = createHarness();
        expect(await context.saveSettings(0, { returnResult })).toBe(returnResult ? true : undefined);
        expect(context.lastServerSettingsVersion).toBe(2);
        expect(context.settings._version).toBe(2);
        expect(context.eventSource.emit).toHaveBeenCalledWith('settings_updated');
        expect(await context.saveSettings()).toBeUndefined();
    });

    test.each(saveFailures)('returns false only when opted in on %s', async (_, fail) => {
        for (const returnResult of [false, true]) {
            const { context } = createHarness();
            fail(context);
            expect(await context.saveSettings(0, { returnResult })).toBe(returnResult ? false : undefined);
            expect(context.eventSource.emit).not.toHaveBeenCalled();
        }
    });

    test('waits for the completed settings update before confirming success', async () => {
        const { context } = createHarness();
        let finishUpdate;
        context.eventSource.emit.mockImplementation(() => new Promise(resolve => { finishUpdate = resolve; }));
        const completed = jest.fn();
        const saving = context.saveSettings(0, { returnResult: true }).then(completed);
        await new Promise(resolve => setImmediate(resolve));
        expect(completed).not.toHaveBeenCalled();
        finishUpdate();
        await saving;
        expect(completed).toHaveBeenCalledWith(true);
    });

    test('does not confirm success when the settings update event fails', async () => {
        const { context } = createHarness();
        context.eventSource.emit.mockRejectedValueOnce(new Error('Update failed'));
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
    });

    test('keeps the queue usable after a failed attempt and advances subsequent request versions', async () => {
        const { context } = createHarness();
        let failSave;
        context.fetch.mockImplementationOnce(() => new Promise((_, reject) => { failSave = reject; }));
        const first = context.saveSettings(0, { returnResult: true });
        const second = context.saveSettings(0, { returnResult: true });
        const third = context.saveSettings(0, { returnResult: true });
        await new Promise(resolve => setImmediate(resolve));
        expect(context.fetch).toHaveBeenCalledTimes(1);
        failSave(new Error('Network failure'));
        expect(await Promise.all([first, second, third])).toEqual([false, true, true]);
        expect(context.fetch.mock.calls.map(([, request]) => JSON.parse(request.body)._version)).toEqual([1, 1, 2]);
        expect(context.lastServerSettingsVersion).toBe(3);
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
    });

    test('preserves conflict state and blocks subsequent writes with the existing prompt', async () => {
        const { context } = createHarness();
        context.fetch.mockResolvedValueOnce({ status: 409, json: async () => ({ version: 5 }) });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.lastServerSettingsVersion).toBe(5);
        expect(context.settingsConflictReloadRequired).toBe(true);
        expect(context.settingsConflictPromptDismissed).toBe(false);
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(2);
        expect(context.toastr.error).not.toHaveBeenCalled();
    });

    test('defers until ready without waiting for its scheduled retry', async () => {
        const { context } = createHarness();
        context.settingsReady = false;
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.saveSettingsDebounced).toHaveBeenCalledWith();
        expect(context.fetch).not.toHaveBeenCalled();
        context.settingsReady = true;
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
    });

    test('preserves temporary-length retry counters and restores at the retry limit', async () => {
        const { context } = createHarness();
        context.TempResponseLength.isCustomized.mockReturnValue(true);
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(await context.saveSettings(attempt, { returnResult: true })).toBe(false);
            expect(context.saveSettingsDebounced).toHaveBeenLastCalledWith(attempt + 1);
        }
        expect(context.fetch).not.toHaveBeenCalled();
        expect(context.TempResponseLength.restore).not.toHaveBeenCalled();
        expect(await context.saveSettings(3, { returnResult: true })).toBe(true);
        expect(context.TempResponseLength.restore).toHaveBeenCalledWith(null);
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(3);
    });
});

import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the real save, adoption and conflict-recovery bodies against a small host fixture.
const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MODULE_NAME = 'NeconyanCardTimeMachine';
const exported = name => source.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`))[0].replace('export ', '');
const local = name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))[0];
const runtimeSource = [
    exported('adoptServerSettingsWrite'),
    exported('registerSamePageServerWriteRecovery'),
    local('consumeRecentSamePageWrite'),
    local('recoverSamePageSettingsConflict'),
    local('saveSettingsInner'),
    source.match(/export async function saveSettings\([\s\S]*?\n\}/)[0].replace('export ', ''),
].join('\n');

function runtime({ version = 8, revision = 4, wait = 1000 } = {}) {
    const context = {
        account: 'alice',
        settingsSaveQueue: Promise.resolve(),
        pendingSettingsAcknowledgements: 0,
        accountImportSettingsPause: null,
        settingsConflictReloadRequired: false,
        settingsConflictPromptDismissed: false,
        settingsReady: true,
        samePageServerWriteRecovery: null,
        recentSamePageServerWrite: null,
        SAME_PAGE_WRITE_WAIT_MS: wait,
        lastServerSettingsVersion: version,
        lastServerSettingsRevision: revision,
        acknowledgedGenerationSettings: { account: 'alice', settingsRevision: revision, controls: {} },
        lastSavedSettings: null,
        downloadedSettings: null,
        settings: {},
        fetch: jest.fn(),
        compressRequest: async request => request,
        getCurrentUserHandle: () => context.account,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        promptSettingsConflictReload: jest.fn(async () => {}),
        saveSettingsDebounced: jest.fn(),
        console: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        toastr: { error: jest.fn() },
        t: strings => strings[0],
        eventSource: { emit: jest.fn(async () => {}) },
        event_types: { SETTINGS_UPDATED: 'settings_updated' },
        normalizeSettingsVersion: value => {
            const number = Number(value);
            return Number.isSafeInteger(number) && number >= 0 ? number : 0;
        },
        normalizeSettingsRevision: value => {
            const number = Number(value);
            return Number.isSafeInteger(number) && number >= 0 ? number : 0;
        },
        generationSettingsSnapshot: () => ({}),
        rememberSavedSettings: () => ({ account: 'alice', body: 'accepted', acknowledgement: null }),
        matchesDownloadedSettings: () => false,
        captureActiveGenerationSelection: () => ({}),
        getWorldInfoSettings: () => ({}),
        extension_settings: {},
        buildSettingsPayloadExtensionSettings: () => structuredClone(context.extension_settings),
        accountStorage: { getState: () => ({}) },
        TempResponseLength: { isCustomized: () => false, restore: jest.fn() },
        firstRun: false,
        currentVersion: 'test',
        name1: 'User',
        active_character: '',
        active_group: '',
        user_avatar: '',
        amount_gen: 1,
        max_context: 1,
        main_api: 'openai',
        textgen_settings: {},
        swipes: false,
        horde_settings: {},
        power_user: {},
        tags: [],
        tag_map: {},
        nai_settings: {},
        kai_settings: {},
        oai_settings: {},
        background_settings: {},
        proxies: [],
        selected_proxy: null,
        custom_endpoint_presets: [],
        selected_custom_endpoint_preset: null,
        AbortController,
        setTimeout,
        clearTimeout,
    };
    runInNewContext(runtimeSource, context);
    return context;
}

const conflict = (extra = {}) => ({ status: 409, json: async () => ({ error: 'settings_conflict', version: 9, ...extra }) });
const success = (version = 10, settingsRevision = 6) => ({ ok: true, status: 200, json: async () => ({ version, settingsRevision }) });

function withBodies(context, responses) {
    const bodies = [];
    context.fetch = jest.fn(async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return responses.shift();
    });
    return bodies;
}

describe('same-page settings conflict recovery', () => {
    test('an unrelated 409 keeps the original prompt and performs no extra request', async () => {
        const context = runtime();
        context.fetch = jest.fn(async () => conflict());
        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(1);
        expect(context.lastServerSettingsVersion).toBe(9);
        expect(context.settingsConflictReloadRequired).toBe(true);
    });

    test('a completed same-page write retries exactly once with a rebuilt payload', async () => {
        const context = runtime();
        context.extension_settings = {
            [MODULE_NAME]: { snapshots: [{ id: 'old-row' }], lastCommit: 'old-commit', captureCharacters: false },
            character_attachments: { [MODULE_NAME]: [{ id: 'old-attachment' }], other: [{ id: 'keep-attachment' }] },
            local: { keep: true },
        };
        const recover = jest.fn(async ({ rejectedSettingsRevision, isAllowed }) => {
            expect(rejectedSettingsRevision).toBe(4);
            expect(isAllowed()).toBe(true);
            expect(context.adoptServerSettingsWrite({ account: 'alice', previousVersion: 8, previousSettingsRevision: 4, version: 9, settingsRevision: 5 })).toBe(true);
            context.extension_settings[MODULE_NAME].snapshots = [{ id: 'new-row' }];
            context.extension_settings[MODULE_NAME].lastCommit = 'server-job-1-123';
            context.extension_settings.character_attachments[MODULE_NAME] = [{ id: 'new-attachment' }];
            return { account: 'alice', previousSettingsRevision: 4, version: 9, settingsRevision: 5 };
        });
        context.registerSamePageServerWriteRecovery({ account: 'alice', recover });
        const bodies = withBodies(context, [conflict(), success()]);

        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(true);
        expect(context.fetch).toHaveBeenCalledTimes(2);
        expect(bodies[0]).toMatchObject({ _version: 8, _settingsRevision: 4 });
        expect(bodies[0].extension_settings).toEqual({
            [MODULE_NAME]: { snapshots: [{ id: 'old-row' }], lastCommit: 'old-commit', captureCharacters: false },
            character_attachments: { [MODULE_NAME]: [{ id: 'old-attachment' }], other: [{ id: 'keep-attachment' }] },
            local: { keep: true },
        });
        expect(bodies[1]).toMatchObject({ _version: 9, _settingsRevision: 5 });
        expect(bodies[1].extension_settings).toEqual({
            [MODULE_NAME]: { snapshots: [{ id: 'new-row' }], lastCommit: 'server-job-1-123', captureCharacters: false },
            character_attachments: { [MODULE_NAME]: [{ id: 'new-attachment' }], other: [{ id: 'keep-attachment' }] },
            local: { keep: true },
        });
        expect(context.promptSettingsConflictReload).not.toHaveBeenCalled();
        expect(context.recentSamePageServerWrite).toBeNull();
    });

    test('an adoption that lands before the 409 response is consumed without an active handle', async () => {
        const context = runtime();
        const bodies = [];
        context.fetch = jest.fn(async (_url, options) => {
            bodies.push(JSON.parse(options.body));
            if (bodies.length === 1) {
                context.lastServerSettingsVersion = 9;
                context.lastServerSettingsRevision = 5;
                context.recentSamePageServerWrite = { account: 'alice', previousSettingsRevision: 4, version: 9, settingsRevision: 5 };
                return conflict();
            }
            return success();
        });

        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(true);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toMatchObject({ _version: 9, _settingsRevision: 5 });
        expect(context.promptSettingsConflictReload).not.toHaveBeenCalled();
        expect(context.recentSamePageServerWrite).toBeNull();
    });

    test('a conversation-only version drift is reconciled by revision, not strict version equality', async () => {
        const context = runtime();
        const bodies = [];
        context.fetch = jest.fn(async (_url, options) => {
            bodies.push(JSON.parse(options.body));
            if (bodies.length === 1) {
                // A Conversation write moved the server version while this save was in flight.
                context.adoptServerSettingsWrite({ account: 'alice', previousVersion: 9, previousSettingsRevision: 4, version: 10, settingsRevision: 5 });
                return conflict();
            }
            return success(11, 6);
        });

        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(true);
        expect(bodies).toHaveLength(2);
        expect(bodies[0]).toMatchObject({ _version: 8, _settingsRevision: 4 });
        expect(bodies[1]).toMatchObject({ _version: 10, _settingsRevision: 5 });
        expect(context.promptSettingsConflictReload).not.toHaveBeenCalled();
    });

    test('normal adoption during the recovery callback is reused for the one retry', async () => {
        const context = runtime();
        context.registerSamePageServerWriteRecovery({
            account: 'alice',
            recover: async () => {
                // Normal delivery wins the race while the callback is still reading.
                context.adoptServerSettingsWrite({ account: 'alice', previousVersion: 8, previousSettingsRevision: 4, version: 9, settingsRevision: 5 });
                return null;
            },
        });
        const bodies = withBodies(context, [conflict(), success()]);

        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(true);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toMatchObject({ _version: 9, _settingsRevision: 5 });
        expect(context.promptSettingsConflictReload).not.toHaveBeenCalled();
    });

    test('a second 409 is not retried again', async () => {
        const context = runtime();
        context.registerSamePageServerWriteRecovery({
            account: 'alice',
            recover: async () => {
                context.lastServerSettingsVersion = 9;
                context.lastServerSettingsRevision = 5;
                context.recentSamePageServerWrite = { account: 'alice', previousSettingsRevision: 4, version: 9, settingsRevision: 5 };
                return { account: 'alice', previousSettingsRevision: 4, version: 9, settingsRevision: 5 };
            },
        });
        context.fetch = jest.fn(async () => conflict({ version: 10 }));

        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(2);
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(1);
        expect(context.lastServerSettingsVersion).toBe(10);
    });

    test('a failed or mismatched recovery falls through immediately', async () => {
        const context = runtime();
        const recover = jest.fn(async () => null);
        context.registerSamePageServerWriteRecovery({ account: 'alice', recover });
        context.fetch = jest.fn(async () => conflict());
        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(recover).toHaveBeenCalledTimes(1);
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(1);

        const mismatch = runtime();
        mismatch.registerSamePageServerWriteRecovery({ account: 'alice', recover: async () => ({
            account: 'alice', previousSettingsRevision: 3, version: 9, settingsRevision: 5,
        }) });
        mismatch.fetch = jest.fn(async () => conflict());
        await expect(mismatch.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(mismatch.fetch).toHaveBeenCalledTimes(1);
    });

    test('conversation conflicts never invoke the same-page recovery', async () => {
        const context = runtime();
        const recover = jest.fn(async () => null);
        context.registerSamePageServerWriteRecovery({ account: 'alice', recover });
        context.fetch = jest.fn(async () => conflict({ error: 'conversation_conflict' }));
        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(recover).not.toHaveBeenCalled();
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(1);
    });

    test('an account change during recovery cannot retry under the old account', async () => {
        const context = runtime();
        context.registerSamePageServerWriteRecovery({
            account: 'alice',
            recover: async () => {
                context.account = 'bob';
                return { account: 'bob', previousSettingsRevision: 4, version: 9, settingsRevision: 5 };
            },
        });
        context.fetch = jest.fn(async () => conflict());
        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.promptSettingsConflictReload).not.toHaveBeenCalled();
    });

    test('an import pause refuses recovery, marks a save for resume and does not prompt', async () => {
        const context = runtime();
        context.accountImportSettingsPause = { account: 'alice', dirty: false };
        const recover = jest.fn(async () => null);
        context.registerSamePageServerWriteRecovery({ account: 'alice', recover });
        context.fetch = jest.fn(async () => conflict());
        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(false);
        expect(recover).not.toHaveBeenCalled();
        expect(context.accountImportSettingsPause.dirty).toBe(true);
        expect(context.promptSettingsConflictReload).not.toHaveBeenCalled();
    });

    test('a hanging recovery is bounded and releases the save queue', async () => {
        const context = runtime({ wait: 20 });
        context.registerSamePageServerWriteRecovery({ account: 'alice', recover: () => new Promise(() => {}) });
        const responses = [conflict(), success()];
        context.fetch = jest.fn(async () => responses.shift());

        await expect(context.saveSettings(0, { returnResult: true })).resolves.toBe(false);
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(1);
        // A reload clears the conflict flag; the next save must run rather than wait forever.
        context.settingsConflictReloadRequired = false;
        await expect(context.saveSettings(0, { returnResult: true })).resolves.toBe(true);
        expect(context.fetch).toHaveBeenCalledTimes(2);
    });

    test('a successful accepted save clears the recent proof', async () => {
        const context = runtime();
        context.recentSamePageServerWrite = { account: 'alice', previousSettingsRevision: 4, version: 9, settingsRevision: 5 };
        context.fetch = jest.fn(async () => success());
        await expect(context.saveSettingsInner(0, 'alice')).resolves.toBe(true);
        expect(context.recentSamePageServerWrite).toBeNull();
    });

    test('adoption stores one recent proof and an account change clears it', () => {
        const context = runtime();
        expect(context.adoptServerSettingsWrite({ account: 'alice', previousVersion: 8, previousSettingsRevision: 4, version: 9, settingsRevision: 5 })).toBe(true);
        expect(context.recentSamePageServerWrite).toEqual({ account: 'alice', previousSettingsRevision: 4, version: 9, settingsRevision: 5 });
        context.account = 'bob';
        expect(context.adoptServerSettingsWrite({ account: 'bob', previousVersion: 9, previousSettingsRevision: 5, version: 10, settingsRevision: 6 })).toBe(true);
        expect(context.recentSamePageServerWrite).toEqual({ account: 'bob', previousSettingsRevision: 5, version: 10, settingsRevision: 6 });
        context.account = 'alice';
        expect(context.adoptServerSettingsWrite({ account: 'bob', previousVersion: 10, previousSettingsRevision: 6, version: 11, settingsRevision: 7 })).toBe(false);
        expect(context.recentSamePageServerWrite).toBeNull();
    });
});

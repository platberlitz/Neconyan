import { describe, expect, test } from '@jest/globals';

import { getSettingsVersion, prepareSettingsSave } from '../src/settings-version.js';

describe('settings version guard', () => {
    test('initializes unversioned settings on first guarded save', () => {
        const result = prepareSettingsSave({ username: 'User' }, { username: 'Old User' });

        expect(result).toMatchObject({ ok: true, version: 1 });
        expect(result.settings).toMatchObject({ username: 'User', _version: 1 });
    });

    test('increments when the incoming version matches disk', () => {
        const result = prepareSettingsSave({ _version: 3, username: 'User' }, { _version: 3, username: 'Old User' });

        expect(result).toMatchObject({ ok: true, version: 4 });
        expect(result.settings).toMatchObject({ username: 'User', _version: 4 });
    });

    test('rejects stale settings from another open device or tab', () => {
        const result = prepareSettingsSave({ _version: 2, username: 'Stale User' }, { _version: 3, username: 'Current User' });

        expect(result).toEqual({ ok: false, currentVersion: 3 });
    });

    test('rejects mismatched versions after restores or manual file changes', () => {
        const result = prepareSettingsSave({ _version: 5, username: 'Open Tab User' }, { _version: 3, username: 'Restored User' });

        expect(result).toEqual({ ok: false, currentVersion: 3 });
    });

    test('normalizes invalid settings versions to zero', () => {
        expect(getSettingsVersion({ _version: -1 })).toBe(0);
        expect(getSettingsVersion({ _version: 'not-a-number' })).toBe(0);
        expect(getSettingsVersion({ _version: '7' })).toBe(7);
    });

    const branchWrap = (version, revision, branch) => ({
        _version: version,
        _settingsRevision: revision,
        extension_settings: { sillybunny_conversation: { characters: { 'nova.png': { branches: { main: branch } } } } },
    });

    const canonicalCopy = value => JSON.parse(JSON.stringify(value));

    test('keeps the non-Conversation revision steady across Conversation-only writes', () => {
        const current = branchWrap(4, 2, { createdAt: 1, messages: [] });

        const native = prepareSettingsSave(branchWrap(4, 2, { createdAt: 1, messages: [{ id: 'server' }] }), current, { conversationOnly: true });
        expect(native).toMatchObject({ ok: true, version: 5, settingsRevision: 2 });
        expect(native.settings._settingsRevision).toBe(2);

        const general = prepareSettingsSave({ _version: 4, _settingsRevision: 2, username: 'New' }, current);
        expect(general).toMatchObject({ ok: true, version: 5, settingsRevision: 3 });
    });

    test('a general save that omits Conversation keeps the authoritative block', () => {
        const current = branchWrap(7, 1, { createdAt: 1, messages: [{ id: 'server' }] });
        const incoming = { _version: 7, _settingsRevision: 1, _conversationOmitted: true, username: 'New', extension_settings: {} };

        const result = prepareSettingsSave(incoming, current);
        expect(result).toMatchObject({ ok: true, version: 8, settingsRevision: 2 });
        expect(result.settings.extension_settings.sillybunny_conversation).toEqual(current.extension_settings.sillybunny_conversation);
        expect(result.settings._conversationOmitted).toBeUndefined();
    });

    test('rejects a legacy whole-settings write that changes server-managed Conversation', () => {
        const current = branchWrap(3, 0, { createdAt: 1, messages: [{ id: 'server' }], serverOperations: { job: {} } });
        const incoming = branchWrap(3, 0, { createdAt: 1, messages: [] });

        expect(prepareSettingsSave(incoming, current)).toMatchObject({ ok: false, currentVersion: 3, conversationConflict: true });

        const untouched = prepareSettingsSave(branchWrap(3, 0, current.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main), current);
        expect(untouched).toMatchObject({ ok: true, version: 4 });
    });

    test('tolerates a stale global version when only Conversation changed', () => {
        const current = branchWrap(9, 4, { createdAt: 1, messages: [{ id: 'server' }] });
        const incoming = { _version: 7, _settingsRevision: 4, username: 'New', extension_settings: {} };

        const result = prepareSettingsSave(incoming, current);
        expect(result).toMatchObject({ ok: true, version: 10, settingsRevision: 5 });
        expect(result.settings.username).toBe('New');
        expect(result.settings.extension_settings.sillybunny_conversation).toEqual(current.extension_settings.sillybunny_conversation);

        const mismatched = prepareSettingsSave({ ...incoming, _settingsRevision: 3 }, current);
        expect(mismatched).toEqual({ ok: false, currentVersion: 9 });
    });

    test('only native server effects may change Conversation completion receipts', () => {
        const wrap = branch => ({ _version: 2, _settingsRevision: 0, extension_settings: { sillybunny_conversation: { characters: { 'nova.png': { branches: { main: branch } } } } } });
        const receipt = { createdAt: 123, messages: [], serverOperations: { completed: { effects: { first: 'saved' } } } };
        const forging = wrap({ createdAt: 123, messages: [], serverOperations: { forged: true } });
        const branch = result => result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        expect(branch(prepareSettingsSave(forging, wrap(receipt), { conversationOnly: true })).serverOperations).toEqual(receipt.serverOperations);
        expect(branch(prepareSettingsSave(forging, wrap({ createdAt: 456, messages: [] }), { conversationOnly: true }))).not.toHaveProperty('serverOperations');
        expect(branch(prepareSettingsSave(forging, wrap(receipt), { trustedConversationEffects: true })).serverOperations).toEqual({ forged: true });
        expect(forging.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.serverOperations).toEqual({ forged: true });
    });

    test('a general save that keeps Conversation unchanged does not conflict', () => {
        const current = branchWrap(3, 0, { createdAt: 1, messages: [{ id: 'server' }], serverOperations: { job: {} } });
        const incoming = { _version: 3, _settingsRevision: 0, username: 'New', extension_settings: { sillybunny_conversation: canonicalCopy(current.extension_settings.sillybunny_conversation) } };

        const result = prepareSettingsSave(incoming, current);
        expect(result).toMatchObject({ ok: true, version: 4, settingsRevision: 1 });
        expect(result.settings.username).toBe('New');
        expect(result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.serverOperations).toEqual({ job: {} });
    });

    test('an explicit Conversation save may edit and delete messages but keeps records', () => {
        const withReceipts = { createdAt: 123, messages: [{ id: 'server' }], serverOperations: { job: { effects: { first: 'saved' } } }, automationClaims: { occurrence: 1 } };
        const current = branchWrap(5, 1, withReceipts);
        const edited = { createdAt: 123, messages: [{ id: 'server', mes: 'edited' }], serverOperations: { forged: true }, automationClaims: { forged: true } };

        const result = prepareSettingsSave(branchWrap(5, 1, edited), current, { conversationOnly: true });
        const branch = result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        expect(result).toMatchObject({ ok: true, version: 6 });
        expect(branch.messages).toEqual([{ id: 'server', mes: 'edited' }]);
        expect(branch.serverOperations).toEqual(withReceipts.serverOperations);
        expect(branch.automationClaims).toEqual(withReceipts.automationClaims);
    });

    test('an explicit Conversation save may delete a branch and its records', () => {
        const current = branchWrap(5, 1, { createdAt: 123, messages: [{ id: 'server' }], serverOperations: { job: {} } });
        const emptied = { _version: 5, _settingsRevision: 1, extension_settings: { sillybunny_conversation: { characters: { 'nova.png': { branches: {} } } } } };

        const result = prepareSettingsSave(emptied, current, { conversationOnly: true });
        expect(result).toMatchObject({ ok: true, version: 6 });
        expect(result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches).toEqual({});
    });

    test('a general save cannot wipe store-level receipts or bookkeeping', () => {
        const current = {
            _version: 6,
            _settingsRevision: 1,
            extension_settings: {
                sillybunny_conversation: {
                    serverOperations: { effect: { at: 1 } },
                    groupAsideLastSent: { key: 5 },
                    runtimeStatusOverrides: { speaker: { status: 'offline' } },
                    characters: {},
                },
            },
        };
        const incoming = {
            _version: 6,
            _settingsRevision: 1,
            extension_settings: { sillybunny_conversation: { characters: {}, serverOperations: { forged: true } } },
        };

        const result = prepareSettingsSave(incoming, current, { conversationOnly: true });
        const conversation = result.settings.extension_settings.sillybunny_conversation;
        expect(result).toMatchObject({ ok: true, version: 7 });
        expect(conversation.serverOperations).toEqual({ effect: { at: 1 } });
        expect(conversation.groupAsideLastSent).toEqual({ key: 5 });
        expect(conversation.runtimeStatusOverrides).toEqual({ speaker: { status: 'offline' } });
    });

    test('a deleted last managed branch still blocks a destructive general save', () => {
        const current = { _version: 4, _settingsRevision: 0, extension_settings: { sillybunny_conversation: { serverOperations: { effect: { at: 1 } }, characters: { 'nova.png': { branches: {} } } } } };
        const incoming = { _version: 4, _settingsRevision: 0, extension_settings: { sillybunny_conversation: { characters: { 'nova.png': { branches: {} } } } } };

        expect(prepareSettingsSave(incoming, current)).toMatchObject({ ok: false, currentVersion: 4, conversationConflict: true });
    });
});

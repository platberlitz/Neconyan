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
        const wrap = branch => ({ _version: 2, extension_settings: { sillybunny_conversation: { characters: { 'nova.png': { branches: { main: branch } } } } } });
        const current = wrap({ createdAt: 123, messages: [], serverOperations: { completed: { effects: { first: 'saved' } } } });
        const incoming = wrap({ createdAt: 123, messages: [], serverOperations: { forged: true } });
        const branch = result => result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        expect(branch(prepareSettingsSave(incoming, current)).serverOperations).toEqual({ completed: { effects: { first: 'saved' } } });
        expect(branch(prepareSettingsSave(incoming, wrap({ createdAt: 456, messages: [] })))).not.toHaveProperty('serverOperations');
        expect(branch(prepareSettingsSave(incoming, current, { trustedConversationEffects: true })).serverOperations).toEqual({ forged: true });
        expect(incoming.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.serverOperations).toEqual({ forged: true });
    });
});

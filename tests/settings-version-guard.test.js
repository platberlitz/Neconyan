import { describe, expect, test } from '@jest/globals';

import { getConversationMessagesHash, getSettingsVersion, prepareSettingsSave } from '../src/settings-version.js';

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

    test('authoritative automatic history can be copied to branches and groups but new automatic content is refused', () => {
        const message = { id: 'auto1', role: 'character', mes: 'Ping', extra: { conversation_mode_auto: true } };
        const current = branchWrap(1, 1, { createdAt: 1, messages: [message] });
        current.extension_settings.sillybunny_conversation.automation = { mode: 'server' };
        for (const options of [{ conversationOnly: true }]) {
            const incoming = canonicalCopy(current);
            const chars = incoming.extension_settings.sillybunny_conversation.characters;
            chars['nova.png'].branches.fork = { createdAt: 2, memorySummary: 'Copied memory', messages: [canonicalCopy(message)] };
            chars['group:g1:nova.png'] = { branches: { main: canonicalCopy(chars['nova.png'].branches.fork) } };
            const result = prepareSettingsSave(incoming, current, options);
            expect(result.ok).toBe(true);
            // Legacy whole-settings writers still cannot replace managed Conversation history.
            expect(prepareSettingsSave(incoming, current)).toMatchObject({ ok: false, conversationConflict: true });
            expect(result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.fork.memorySummary).toBe('Copied memory');
            chars['nova.png'].branches.fork.messages[0].mes = 'New browser result';
            expect(prepareSettingsSave(incoming, current, options)).toMatchObject({ ok: false, conversationConflict: true });
            chars['nova.png'].branches.fork.messages[0] = { ...message, id: 'new-auto' };
            expect(prepareSettingsSave(incoming, current, options)).toMatchObject({ ok: false, conversationConflict: true });
            delete chars['nova.png'].branches.fork;
            chars['nova.png'].branches.main.messages[0].mes = 'Edited in place';
            expect(prepareSettingsSave(incoming, current, options).ok).toBe(true);
        }
    });

    test('deterministic identity repair preserves accepted edit revisions and remaps the read boundary', () => {
        const messages = [{ id: 'old unsafe id', role: 'character', mes: 'Already read' }, { role: 'system', mes: '' }];
        const original = { createdAt: 1, messages, readThrough: 'old unsafe id', unread: 0, messageEditRevision: 3, messageContentHash: getConversationMessagesHash(messages) };
        const current = branchWrap(5, 1, original);
        const result = prepareSettingsSave(canonicalCopy(current), current, { conversationOnly: true });
        const branch = result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        expect(branch.messageEditRevision).toBe(3);
        expect(branch.readThrough).toBe(branch.messages[0].id);
        expect(branch.unread).toBe(0);
        expect(branch.messageContentHash).toBe(getConversationMessagesHash(branch.messages));
        const edited = canonicalCopy(result.settings);
        edited.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.messages[0].mes = 'Changed text';
        const changed = prepareSettingsSave(edited, result.settings, { conversationOnly: true });
        expect(changed.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.messageEditRevision).not.toBe(3);
    });

    test('stale summary timers cannot replace native memory on surviving branches or threads', () => {
        const memory = { memorySummary: 'Server memory', memoryMessageCount: 2, memoryUpdatedAt: 7, memorySummaryThrough: 'last' };
        const current = branchWrap(2, 1, { createdAt: 1, messages: [{ id: 'last', mes: 'Hello' }], ...memory });
        Object.assign(current.extension_settings.sillybunny_conversation.characters['nova.png'], memory);
        const incoming = canonicalCopy(current);
        const thread = incoming.extension_settings.sillybunny_conversation.characters['nova.png'];
        thread.memorySummary = thread.branches.main.memorySummary = 'Stale browser summary';
        for (const options of [{ conversationOnly: true }, {}]) {
            const result = prepareSettingsSave(incoming, current, options);
            expect(result.ok).toBe(true);
            const saved = result.settings.extension_settings.sillybunny_conversation.characters['nova.png'];
            expect(saved).toMatchObject(memory);
            expect(saved.branches.main).toMatchObject(memory);
        }
    });

    test('legacy numeric unread is protected on every save, with id-less and empty messages retained', () => {
        const original = { createdAt: 1, unread: 1, messages: [
            { role: 'character', mes: 'Read' }, { role: 'system', mes: '' }, { role: 'character', mes: 'Unread' },
        ] };
        const current = branchWrap(2, 0, original);
        const incoming = branchWrap(2, 0, { ...original, unread: 0 });
        for (const options of [{ conversationOnly: true }, { restoreSnapshot: true }, {}]) {
            const result = prepareSettingsSave(incoming, current, options);
            expect(result.ok).toBe(true);
            const branch = result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
            expect(branch.unread).toBe(1);
            expect(branch.readThrough).toBe(branch.messages[1].id);
            expect(branch.messages.map(message => message.mes)).toEqual(['Read', '', 'Unread']);
            expect(new Set(branch.messages.map(message => message.id)).size).toBe(3);
        }
        expect(original.messages.every(message => !message.id)).toBe(true);
    });

    test('ownership and receipts survive Conversation saves, imports and block-less resets', () => {
        const current = branchWrap(2, 1, { createdAt: 1, messages: [] });
        const protectedState = { automation: { mode: 'server', timeZone: 'Asia/Manila', acknowledgement: { account: 'alice', settingsRevision: 1 } },
            serverOperations: { job: { at: 1 } }, groupAsideLastSent: { aside: 1 }, runtimeStatusOverrides: { speaker: { status: 'online' } } };
        Object.assign(current.extension_settings.sillybunny_conversation, protectedState);
        const forged = canonicalCopy(current);
        forged.extension_settings.sillybunny_conversation.automation = { mode: 'browser' };
        expect(prepareSettingsSave(forged, current).ok).toBe(false);
        for (const options of [{ conversationOnly: true }, { restoreSnapshot: true }]) {
            const result = prepareSettingsSave(forged, current, options);
            expect(result.settings.extension_settings.sillybunny_conversation).toMatchObject(protectedState);
        }
        const reset = prepareSettingsSave({ _version: 2, _settingsRevision: 1, extension_settings: {} }, current, { restoreSnapshot: true });
        expect(reset.settings.extension_settings.sillybunny_conversation).toEqual(protectedState);
        expect(reset.settingsRevision).toBe(2);
    });

    test('only acknowledged new-client general saves refresh the background binding revision', () => {
        const current = branchWrap(3, 1, { createdAt: 1, messages: [] });
        current.extension_settings.sillybunny_conversation.automation = { mode: 'server', timeZone: 'UTC' };
        const incoming = { _version: 3, _settingsRevision: 1, _conversationOmitted: true, extension_settings: {} };
        const result = prepareSettingsSave(incoming, current, { acknowledgeAccount: 'alice' });
        expect(result.settings.extension_settings.sillybunny_conversation.automation).toEqual({ mode: 'server', timeZone: 'UTC', acknowledgement: { account: 'alice', settingsRevision: 2 } });
        expect(prepareSettingsSave(canonicalCopy(current), current, { acknowledgeAccount: 'alice' }).settings.extension_settings.sillybunny_conversation.automation.acknowledgement).toBeUndefined();
        expect(current.extension_settings.sillybunny_conversation.automation.acknowledgement).toBeUndefined();
    });

    test('server ownership refuses stale automatic appends but permits manual images and historical imports', () => {
        const original = { createdAt: 1, messages: [{ id: 'first', role: 'user', mes: 'Hello' }], unread: 0 };
        const current = branchWrap(1, 0, original);
        current.extension_settings.sillybunny_conversation.automation = { mode: 'server', timeZone: 'UTC' };
        const incoming = canonicalCopy(current);
        const extra = { conversation_mode_auto: true };
        incoming.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.messages.push({ id: 'stale', role: 'character', mes: 'Browser reply', extra });
        expect(prepareSettingsSave(incoming, current, { conversationOnly: true })).toMatchObject({ ok: false, conversationConflict: true });
        expect(prepareSettingsSave(incoming, current)).toMatchObject({ ok: false, conversationConflict: true });
        expect(prepareSettingsSave(incoming, current, { restoreSnapshot: true }).ok).toBe(true);
        delete extra.conversation_mode_auto;
        extra.conversation_mode_image = true;
        expect(prepareSettingsSave(incoming, current, { conversationOnly: true }).ok).toBe(true);
    });

    test('stale reminder status cannot undo firing or forget an accepted automatic occurrence', () => {
        const current = branchWrap(2, 1, { createdAt: 1, messages: [] });
        const store = current.extension_settings.sillybunny_conversation;
        store.automation = { mode: 'server', acceptedOccurrences: { hashed: 'job-id' } };
        store.reminders = [{ id: 'reminder', triggerAt: 123, text: 'Tea', fired: true, firedAt: 234 }];
        const incoming = canonicalCopy(current);
        incoming.extension_settings.sillybunny_conversation.reminders = [{ id: 'reminder', triggerAt: 123, text: 'Tea', fired: false }];
        delete incoming.extension_settings.sillybunny_conversation.automation;
        for (const options of [{ conversationOnly: true }, { restoreSnapshot: true }]) {
            const result = prepareSettingsSave(incoming, current, options);
            expect(result.ok).toBe(true);
            expect(result.settings.extension_settings.sillybunny_conversation.reminders[0]).toMatchObject({ fired: true, firedAt: 234 });
            expect(result.settings.extension_settings.sillybunny_conversation.automation).toEqual(store.automation);
        }
    });

    test('omitted messages, restores and same-identity recreation cannot reuse an old checkpoint', () => {
        const messages = [{ id: 'first', mes: 'First' }, { id: 'second', mes: 'Second' }];
        const original = { createdAt: 'same', messages, messageEditRevision: 3, messageContentHash: getConversationMessagesHash(messages) };
        const current = branchWrap(5, 1, original);
        const branch = result => result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        const omitted = { createdAt: 'same', messageEditRevision: 3, messageContentHash: getConversationMessagesHash([]) };
        const removed = prepareSettingsSave(branchWrap(5, 1, omitted), current, { conversationOnly: true });
        expect(branch(removed).messageEditRevision).toBe(6);
        const rewritten = prepareSettingsSave(branchWrap(6, 1, { ...omitted, messages: [{ mes: 'Replacement' }] }), removed.settings, { conversationOnly: true });
        expect(branch(rewritten).messageEditRevision).not.toBe(3);
        const backup = branchWrap(5, 0, { ...original, messages: messages.slice(0, 1) });
        const restored = prepareSettingsSave(backup, current, { restoreSnapshot: true });
        expect(restored).toMatchObject({ version: 6, settingsRevision: 2 });
        expect(branch(restored).messageEditRevision).toBe(6);
        const deleted = canonicalCopy(current);
        deleted.extension_settings.sillybunny_conversation.characters['nova.png'].branches = {};
        const deletion = prepareSettingsSave(deleted, current, { conversationOnly: true });
        const recreated = prepareSettingsSave(branchWrap(6, 1, { ...original, messages: [{ mes: 'Recreated' }] }), deletion.settings, { conversationOnly: true });
        expect(branch(recreated).messageEditRevision).toBe(7);
        expect(current.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main).toEqual(original);
    });

    test('message revisions distinguish trusted retention from deletion and ignore forged counters', () => {
        const messages = Array.from({ length: 250 }, (_, i) => ({ id: String(i), mes: `Message ${i}` }));
        const original = { createdAt: 1, messages, messageEditRevision: 3, messageContentHash: getConversationMessagesHash(messages) };
        const current = branchWrap(5, 1, original);
        const retained = [...messages.slice(2), { id: '250', mes: 'Message 250' }, { id: '251', mes: 'Message 251' }];
        const incoming = branchWrap(5, 1, { ...original, messages: retained, messageEditRevision: 0, messageContentHash: 'forged' });
        const branch = result => result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        const trusted = branch(prepareSettingsSave(incoming, current, { conversationOnly: true, trustedConversationAppend: true }));
        expect(trusted.messageEditRevision).toBe(3);
        expect(trusted.messageContentHash).toBe(getConversationMessagesHash(retained));
        expect(branch(prepareSettingsSave(incoming, current, { conversationOnly: true })).messageEditRevision).toBe(6);
        const metadata = branchWrap(5, 1, { ...original, preview: 'Only a preview', messageEditRevision: 99 });
        expect(branch(prepareSettingsSave(metadata, current, { conversationOnly: true })).messageEditRevision).toBe(3);
        const edited = canonicalCopy(current);
        edited.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.messages[0].mes = 'Raw file edit';
        expect(branch(prepareSettingsSave(incoming, edited, { trustedConversationEffects: true })).messageEditRevision).toBe(6);
        const replaced = branchWrap(5, 1, { ...original, createdAt: 2, messageEditRevision: 99 });
        expect(branch(prepareSettingsSave(replaced, current, { conversationOnly: true })).messageEditRevision).toBe(6);
    });

    test('keeps the non-Conversation revision steady across Conversation-only writes', () => {
        const current = branchWrap(4, 2, { createdAt: 1, messages: [] });

        const native = prepareSettingsSave(branchWrap(4, 2, { createdAt: 1, messages: [{ id: 'server', mes: 'Saved reply' }] }), current, { conversationOnly: true });
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
        const current = branchWrap(3, 0, { createdAt: 1, messages: [{ id: 'server', mes: 'Saved reply' }], serverOperations: { job: {} } });
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
        const current = branchWrap(3, 0, { createdAt: 1, messages: [{ id: 'server', mes: 'Saved reply' }], serverOperations: { job: {} } });
        const incoming = { _version: 3, _settingsRevision: 0, username: 'New', extension_settings: { sillybunny_conversation: canonicalCopy(current.extension_settings.sillybunny_conversation) } };

        const result = prepareSettingsSave(incoming, current);
        expect(result).toMatchObject({ ok: true, version: 4, settingsRevision: 1 });
        expect(result.settings.username).toBe('New');
        expect(result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.serverOperations).toEqual({ job: {} });
    });

    test('only the server may consume or forge pending presentation claims', () => {
        const withClaims = { createdAt: 123, messages: [{ id: 'server', mes: 'one' }], serverOperations: { job: {} }, pendingPresentations: { server: { at: 1, narration: null } } };
        const current = branchWrap(5, 1, withClaims);
        const forged = { createdAt: 123, messages: [{ id: 'server', mes: 'one' }], serverOperations: { job: {} }, pendingPresentations: { forged: true } };

        const result = prepareSettingsSave(branchWrap(5, 1, forged), current, { conversationOnly: true });
        const branch = result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        expect(result).toMatchObject({ ok: true, version: 6 });
        expect(branch.pendingPresentations).toEqual({ server: { at: 1, narration: null } });

        const emptied = prepareSettingsSave(branchWrap(5, 1, { createdAt: 123, messages: [{ id: 'server', mes: 'one' }], serverOperations: { job: {} } }), current, { conversationOnly: true });
        expect(emptied.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main.pendingPresentations).toEqual({ server: { at: 1, narration: null } });
    });

    /* eslint-disable playwright/no-standalone-expect -- Jest test.each callbacks are test bodies. */
    test.each(['edit', 'delete'])('a %s invalidates only the affected pending narration and cannot forge unread', action => {
        const original = { createdAt: 1, readThrough: 'read', unread: 2, messages: [
            { id: 'read', role: 'character', mes: 'Seen' },
            { id: 'a', role: 'character', mes: 'First' },
            { id: 'b', role: 'character', mes: 'Second' },
        ], pendingPresentations: { a: { at: 1 }, b: { at: 2 } } };
        const incoming = canonicalCopy(original);
        incoming.readThrough = 'b';
        incoming.unread = 0;
        if (action === 'edit') incoming.messages[1].mes = 'Edited';
        else incoming.messages.splice(1, 1);
        const result = prepareSettingsSave(branchWrap(1, 0, incoming), branchWrap(1, 0, original), { conversationOnly: true });
        const branch = result.settings.extension_settings.sillybunny_conversation.characters['nova.png'].branches.main;
        expect(branch.readThrough).toBe('read');
        expect(branch.unread).toBe(action === 'edit' ? 2 : 1);
        expect(branch.pendingPresentations).toEqual({ b: { at: 2 } });
    });
    /* eslint-enable playwright/no-standalone-expect */

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

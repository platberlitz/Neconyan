/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { createHash, randomUUID } from 'node:crypto';
import { getChatBackupSaveOptions } from '../public/scripts/chat-backup-sequence.js';
import { getQueuedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';
import { beginRoleplaySave, bindRoleplayAccount, confirmRoleplayOverwrite, finishRoleplaySave, parseRoleplayRead, rememberRoleplayRead, roleplayAccountStamp, sendRoleplaySave } from '../public/scripts/roleplay-save-chain.js';

const sources = Object.fromEntries(['script.js', 'scripts/extensions.js', 'scripts/group-chats.js', 'scripts/utils.js'].map(file => {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    return [file, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) }];
}));

// The host's lifecycle tests also execute extracted declarations to avoid booting the browser bundle.
function load(context, file, names) {
    const { source, ast } = sources[file];
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}

function saveContext(group = false) {
    const context = vm.createContext({
        console: { error: jest.fn(), warn: jest.fn() },
        selected_group: group ? 'group' : null,
        saveChat: jest.fn(async () => true),
        saveGroupChat: jest.fn(async () => true),
        cancelDebouncedChatSave: jest.fn(),
        cancelDebouncedMetadataSave: jest.fn(),
        setChatSaveActive: jest.fn(),
        saveTokenCache: jest.fn(async () => {}),
        saveItemizedPrompts: jest.fn(async () => {}),
        getCurrentChatId: () => 'story',
        chatGeneration: 1, getChatGeneration: () => 1,
        getChatBackupSaveOptions, getQueuedChatSaveAbortReason, uuidv4: randomUUID,
    });
    load(context, 'script.js', ['saveChatConditional', 'saveMetadata']);
    return context;
}

function loadQueuedSaveRuntime(context, group = false) {
    const account = { accountId: randomUUID(), dataEpoch: 1 };
    const source = { instanceId: randomUUID(), revision: 1, rawHash: 'a'.repeat(64) };
    bindRoleplayAccount(randomUUID(), account);
    bindRoleplayAccount('story-test', account);
    rememberRoleplayRead(group ? { group: true, chat: 'story' } : { group: false, avatar: 'story.png', chat: 'story' }, { account, source });
    Object.assign(context, {
        beginRoleplaySave, confirmRoleplayOverwrite, finishRoleplaySave, parseRoleplayRead, roleplayAccountStamp, sendRoleplaySave,
        getCurrentUserHandle: () => 'story-test', refreshCsrfToken: jest.fn(),
        getRequestHeaders: () => ({}), compressRequest: async request => request,
        fetchWithCsrfRetry: async (url, build) => context.fetch(url, await build()),
    });
    load(context, 'script.js', ['roleplayRequestHeaders', 'requestRoleplayChat', 'saveRoleplayChatRequest']);
    load(context, group ? 'scripts/group-chats.js' : 'script.js', group ? ['saveGroupChat', 'saveGroupChatImmediately'] : ['saveChat', 'saveChatImmediately']);
    return { account, source, acknowledge(init) {
        const request = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, integrity: 'saved', roleplay: {
            account, operationKey: request.roleplay.operationKey, changed: true,
            source: { ...request.roleplay.source, revision: request.roleplay.source.revision + 1,
                rawHash: createHash('sha256').update(init.body).digest('hex') },
        } }) };
    } };
}

describe('strict host chat saves', () => {
    test.each([false, true])('returns success and forwards strict options (group: %s)', async group => {
        const context = saveContext(group);
        const options = { throwOnError: true, deferBackup: true, allowShrink: true };
        await expect(context.saveMetadata(options)).resolves.toBe(true);
        const helper = group ? context.saveGroupChat : context.saveChat;
        expect(helper).toHaveBeenCalledWith(...(group ? ['group', true, false, true, options] : [options]));
        expect(context.saveItemizedPrompts).toHaveBeenCalledWith('story', { throwOnError: false });
        expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
    });

    test('strict prompt persistence reports failure while existing saves retain their default', async () => {
        const context = saveContext();
        const error = new Error('prompt storage unavailable');
        context.saveItemizedPrompts.mockImplementation(async (_id, { throwOnError }) => {
            if (throwOnError) throw error;
        });
        await expect(context.saveChatConditional({ throwOnError: true, throwOnPromptError: true })).rejects.toBe(error);
        await expect(context.saveMetadata({ throwOnError: true })).resolves.toBe(true);
        expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
    });

    test.each([false, undefined])('rejects a lower helper refusal (%s), while default callers receive false', async result => {
        for (const group of [false, true]) {
            const context = saveContext(group);
            const helper = group ? context.saveGroupChat : context.saveChat;
            helper.mockResolvedValue(result);
            await expect(context.saveChatConditional({ throwOnError: true })).rejects.toThrow('Chat was not saved');
            await expect(context.saveChatConditional()).resolves.toBe(false);
            expect(context.saveTokenCache).not.toHaveBeenCalled();
            expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
        }
    });

    test('preserves the original rejection and the default swallow behaviour', async () => {
        const context = saveContext();
        const error = new Error('network failure');
        context.saveChat.mockRejectedValue(error);
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toBe(error);
        await expect(context.saveMetadata()).resolves.toBe(false);
        expect(context.setChatSaveActive).toHaveBeenLastCalledWith(false);
    });

    test.each(['http', 'integrity', 'missing'])('executes the queued character save through a real %s refusal', async failure => {
        const context = saveContext();
        Object.assign(context, {
            structuredClone,
            chatSaveQueue: Promise.resolve(),
            chat: [{ mes: 'original', extra: {} }],
            chat_metadata: {},
            this_chid: 0,
            characters: [{ name: 'Story', avatar: 'story.png', chat: failure === 'missing' ? '' : 'story' }],
            name2: 'Story',
            neutralCharacterName: 'Assistant',
            cloneChatSavePayload: structuredClone,
            getQueuedChatIntegrityKey: () => 'key',
            applyQueuedChatIntegrity: jest.fn(),
            rememberQueuedChatIntegrity: jest.fn(),
            compressRequest: async value => value,
            getRequestHeaders: () => ({}),
            fetch: jest.fn(),
            Popup: { show: { input: async () => '' } },
            window: { location: { reload: jest.fn() } },
            toastr: { error: jest.fn() },
            t: strings => strings.join(''),
        });
        const { account, source } = loadQueuedSaveRuntime(context);
        context.fetch.mockResolvedValue({ ok: false, status: 400, statusText: 'failure', json: async () => ({ error: failure,
            roleplay: { account, source: { ...source, revision: 2, rawHash: 'b'.repeat(64) } } }) });
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toThrow();
        await expect(context.saveMetadata()).resolves.toBe(false);
        expect(context.saveTokenCache).not.toHaveBeenCalled();
        expect(context.fetch).toHaveBeenCalledTimes(failure === 'missing' ? 0 : 2);
    });

    test.each(['group', 123])('waits for group metadata and rejects its HTTP failure instead of scheduling success: %s', async id => {
        const context = saveContext(true);
        Object.assign(context, {
            structuredClone,
            groupChatSaveQueue: Promise.resolve(),
            groupMetadataSaveQueue: Promise.resolve(),
            pendingGroupMetadataSaves: new Map(),
            groupSaveStates: new Map(),
            groupBackgroundState: new WeakMap(), queuedGroupMetadataById: new Map(),
            clearTimeout,
            selected_group: String(id),
            groups: [{ id, chat_id: 'story', chats: ['story'] }],
            chat: [{ mes: 'original', extra: {} }],
            chat_metadata: {},
            cloneGroupChatSavePayload: structuredClone,
            applyQueuedGroupChatIntegrity: jest.fn(),
            rememberQueuedGroupChatIntegrity: jest.fn(),
            compressRequest: async value => value,
            getRequestHeaders: () => ({}),
            fetch: jest.fn(),
            saveGroupDebounced: jest.fn(),
        });
        const { acknowledge } = loadQueuedSaveRuntime(context, true);
        const beginChatSave = context.beginRoleplaySave;
        const sendChatSave = context.sendRoleplaySave;
        const finishChatSave = context.finishRoleplaySave;
        Object.assign(context, {
            markGroupSaveDirty: () => 1, groupReadEvidence: new WeakMap(),
            beginRoleplaySave: (locator, options) => locator.kind === 'group' ? { locator } : beginChatSave(locator, options),
            sendRoleplaySave: async (token, payload, send, vacancy) => {
                if (token.locator.kind !== 'group') return sendChatSave(token, payload, send, vacancy);
                const response = await send(JSON.stringify(payload), { owner: 'story-test' });
                return { ok: response.ok, data: { roleplay: { source: {} } } };
            },
            finishRoleplaySave: token => token?.locator.kind === 'group' ? Promise.resolve() : finishChatSave(token),
        });
        context.fetch.mockImplementation(async (url, init) => url === '/api/groups/edit' ? { ok: false } : acknowledge(init));
        load(context, 'scripts/group-chats.js', ['snapshotGroupMetadata', 'editGroup', '_save']);
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toThrow('Could not save group');
        expect(context.fetch).toHaveBeenCalledWith('/api/chats/group/save', expect.any(Object));
        expect(context.fetch).toHaveBeenCalledWith('/api/groups/edit', expect.any(Object));
        expect(context.saveGroupDebounced).not.toHaveBeenCalled();
        await expect(context.saveMetadata()).resolves.toBe(true);
        expect(context.saveGroupDebounced).toHaveBeenCalledTimes(typeof id === 'string' ? 1 : 0);
    });

    test('propagates an actual group integrity decline without saving metadata or caches', async () => {
        const context = saveContext(true);
        Object.assign(context, {
            structuredClone, groupChatSaveQueue: Promise.resolve(),
            groups: [{ id: 'group', chat_id: 'story', chats: ['story'] }],
            chat: [{ mes: 'original', extra: {} }], chat_metadata: {},
            cloneGroupChatSavePayload: structuredClone,
            applyQueuedGroupChatIntegrity: jest.fn(),
            fetch: jest.fn(),
            Popup: { show: { input: async () => '' } },
            window: { location: { reload: jest.fn() } },
            t: strings => strings.join(''), editGroup: jest.fn(),
        });
        const { account, source } = loadQueuedSaveRuntime(context, true);
        context.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'integrity',
            roleplay: { account, source: { ...source, revision: 2, rawHash: 'b'.repeat(64) } } }) });
        await expect(context.saveMetadata({ throwOnError: true })).rejects.toThrow('Chat was not saved');
        await expect(context.saveMetadata()).resolves.toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(2);
        expect(context.editGroup).not.toHaveBeenCalled();
        expect(context.saveTokenCache).not.toHaveBeenCalled();
        expect(context.saveItemizedPrompts).not.toHaveBeenCalled();
    });
});

function fieldContext() {
    const character = { avatar: 'story.png', data: { extensions: { story: { enabled: false }, other: 1 } } };
    character.json_data = JSON.stringify({ data: structuredClone(character.data) });
    const state = { characters: [character], characterId: 0 };
    const form = { val: jest.fn() };
    const context = vm.createContext({
        console: { error: jest.fn(), warn: jest.fn() },
        getContext: () => state,
        getRequestHeaders: () => ({}),
        UNSET_VALUE: '__@@UNSET@@__',
        $: () => form,
        fetch: jest.fn(async () => ({ ok: true })),
    });
    load(context, 'scripts/utils.js', ['setValueByPath', 'deleteValueByPath']);
    load(context, 'scripts/extensions.js', ['writeExtensionField']);
    return { context, state, character, form };
}

describe('strict host extension field writes', () => {
    test.each(['http', 'network'])('does not mutate the card, JSON or form on %s failure', async failure => {
        const { context, character, form } = fieldContext();
        const original = structuredClone(character);
        context.fetch.mockImplementation(async () => {
            character.data.extensions.other = 2;
            if (failure === 'network') throw new Error('network failure');
            return { ok: false, statusText: 'failure' };
        });
        await expect(context.writeExtensionField(0, 'story', { enabled: true }, { throwOnError: true })).rejects.toThrow();
        expect(character.data.extensions).toEqual({ story: { enabled: false }, other: 2 });
        expect(character.json_data).toBe(original.json_data);
        expect(form.val).not.toHaveBeenCalled();
    });

    test('commits the sent value only after success and keeps unrelated concurrent changes', async () => {
        const { context, state, character, form } = fieldContext();
        let respond;
        context.fetch.mockReturnValue(new Promise(resolve => { respond = resolve; }));
        const value = { enabled: true };
        const pending = context.writeExtensionField(0, 'story', value, { throwOnError: true });
        expect(character.data.extensions.story.enabled).toBe(false);
        expect(form.val).not.toHaveBeenCalled();

        value.enabled = false;
        character.data.extensions.other = 2;
        character.json_data = JSON.stringify({ data: { extensions: { ...character.data.extensions, newer: 3 } } });
        state.characters.unshift({ avatar: 'other.png' });
        state.characterId = 0;
        respond({ ok: true });
        await expect(pending).resolves.toBe(true);
        expect(character.data.extensions).toEqual({ story: { enabled: true }, other: 2 });
        expect(JSON.parse(character.json_data).data.extensions).toEqual({ story: { enabled: true }, other: 2, newer: 3 });
        expect(form.val).not.toHaveBeenCalled();
        expect(JSON.parse(context.fetch.mock.calls[0][1].body)).toEqual({ avatar: 'story.png', data: { extensions: { story: { enabled: true } } } });
    });

    test('updates the active form after strict success and keeps the UNSET request shape', async () => {
        const { context, character, form } = fieldContext();
        await expect(context.writeExtensionField('0', 'story', context.UNSET_VALUE, { throwOnError: true })).resolves.toBe(true);
        expect(character.data.extensions).toEqual({ other: 1 });
        expect(JSON.parse(character.json_data).data.extensions).toEqual({ other: 1 });
        expect(form.val).toHaveBeenCalledWith(character.json_data);
        expect(JSON.parse(context.fetch.mock.calls[0][1].body).data.extensions.story).toBe(context.UNSET_VALUE);
    });

    test('retains optimistic mutation and undefined return for default HTTP failures', async () => {
        const { context, character, form } = fieldContext();
        context.fetch.mockResolvedValue({ ok: false, statusText: 'failure' });
        await expect(context.writeExtensionField(0, 'story', true)).resolves.toBeUndefined();
        expect(character.data.extensions.story).toBe(true);
        expect(form.val).toHaveBeenCalledWith(character.json_data);
    });

    test('rejects a missing card or identity before sending a strict request', async () => {
        const { context, character } = fieldContext();
        await expect(context.writeExtensionField(5, 'story', true, { throwOnError: true })).rejects.toThrow('Character not found');
        delete character.avatar;
        await expect(context.writeExtensionField(0, 'story', true, { throwOnError: true })).rejects.toThrow('identity');
        expect(context.fetch).not.toHaveBeenCalled();
        await expect(context.writeExtensionField(5, 'story', true)).resolves.toBeUndefined();
    });

    test('does not commit to a different card if the target disappears during the request', async () => {
        const { context, state, character, form } = fieldContext();
        context.fetch.mockImplementation(async () => {
            state.characters = [{ avatar: 'replacement.png', data: { extensions: {} } }];
            return { ok: true };
        });
        await expect(context.writeExtensionField(0, 'story', true, { throwOnError: true })).rejects.toThrow('no longer available');
        expect(character.data.extensions.story.enabled).toBe(false);
        expect(state.characters[0].data.extensions).toEqual({});
        expect(form.val).not.toHaveBeenCalled();
    });
});

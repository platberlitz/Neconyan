import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';
import { getQueuedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';
import { getChatBackupSaveOptions } from '../public/scripts/chat-backup-sequence.js';
import { createHash, randomUUID } from 'node:crypto';
import { beginRoleplaySave, bindRoleplayAccount, confirmRoleplayOverwrite, finishRoleplaySave, parseRoleplayRead, rememberRoleplayRead, roleplayAccountStamp, sendRoleplaySave } from '../public/scripts/roleplay-save-chain.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function createSaveRuntime(group = false) {
    let releaseQueue;
    const account = { accountId: randomUUID(), dataEpoch: 1 };
    const savedSource = { instanceId: randomUUID(), revision: 1, rawHash: 'a'.repeat(64) };
    bindRoleplayAccount(randomUUID(), account);
    bindRoleplayAccount('alice', account);
    const locator = group ? { group: true, chat: 'original-chat' } : { group: false, avatar: 'bunny.png', chat: 'original-chat' };
    rememberRoleplayRead(locator, { account, source: savedSource });
    rememberRoleplayRead({ ...locator, chat: 'copy-chat' }, { account, vacancy: 0 });
    const runtime = vm.createContext({
        console: { trace: jest.fn(), warn: jest.fn(), error: jest.fn() },
        structuredClone,
        chatSaveQueue: new Promise(resolve => { releaseQueue = resolve; }),
        chat: [{ mes: 'queued message', extra: { value: 'queued' } }],
        chat_metadata: { integrity: 'original' },
        chatGeneration: 1,
        this_chid: 0,
        selected_group: null,
        characters: [{ name: 'Bunny', avatar: 'bunny.png', chat: 'original-chat' }],
        name2: 'Bunny', neutralCharacterName: 'Assistant',
        getQueuedChatSaveAbortReason,
        getChatBackupSaveOptions, uuidv4: randomUUID,
        beginRoleplaySave, confirmRoleplayOverwrite, finishRoleplaySave, parseRoleplayRead, roleplayAccountStamp, sendRoleplaySave,
        getCurrentChatId: () => runtime.characters[runtime.this_chid]?.chat,
        cloneChatSavePayload: structuredClone,
        setChatSaveActive: jest.fn(),
        getQueuedChatIntegrityKey: () => 'key',
        applyQueuedChatIntegrity: jest.fn(),
        rememberQueuedChatIntegrity: jest.fn(),
        compressRequest: async request => request,
        getRequestHeaders: () => ({}),
        account: 'alice',
        getCurrentUserHandle: () => runtime.account,
        fetch: jest.fn(async (_url, init) => {
            const request = JSON.parse(init.body);
            return { ok: true, status: 200, json: async () => ({ ok: true, integrity: 'saved', roleplay: {
                account, operationKey: request.roleplay.operationKey, changed: true,
                source: { instanceId: request.roleplay.source?.instanceId ?? savedSource.instanceId,
                    revision: (request.roleplay.source?.revision ?? 0) + 1, rawHash: createHash('sha256').update(init.body).digest('hex') },
            } }) };
        }),
        refreshCsrfToken: jest.fn(),
        fetchWithCsrfRetry: async (url, build) => runtime.fetch(url, await build()),
        toastr: { error: jest.fn() },
        Popup: { show: { input: jest.fn(async () => 'OVERWRITE') } },
        window: { location: { reload: jest.fn() } },
        t: strings => strings.join(''),
    });
    for (const name of ['roleplayRequestHeaders', 'requestRoleplayChat', 'saveRoleplayChatRequest']) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        vm.runInContext(source.slice(node.start, node.end), runtime);
    }
    let runtimeSource = source;
    let runtimeAst = ast;
    if (group) {
        Object.assign(runtime, {
            groups: [{ id: 'group', chat_id: 'original-chat', chats: ['original-chat'] }],
            selected_group: 'group', groupChatSaveQueue: runtime.chatSaveQueue,
            cloneGroupChatSavePayload: structuredClone, getChatGeneration: () => runtime.chatGeneration,
            applyQueuedGroupChatIntegrity: jest.fn(), rememberQueuedGroupChatIntegrity: jest.fn(),
            editGroup: jest.fn(), refreshCsrfToken: jest.fn(),
            fetchWithCsrfRetry: async (url, build) => runtime.fetch(url, await build()),
        });
        runtimeSource = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
        runtimeAst = parse(runtimeSource, { ecmaVersion: 'latest', sourceType: 'module' });
    }
    for (const name of group ? ['saveGroupChat', 'saveGroupChatImmediately'] : ['saveChat', 'saveChatImmediately']) {
        const node = runtimeAst.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        vm.runInContext(runtimeSource.slice(node.start, node.end), runtime);
    }
    return { runtime, releaseQueue, account, savedSource };
}

describe('real chat save queue', () => {
    test('copies the group owner before waiting and refuses a changed profile before either write', async () => {
        const first = createSaveRuntime(true);
        const options = { account: 'alice' };
        const saved = first.runtime.saveGroupChat('group', true, false, true, options);
        options.account = 'bob';
        first.releaseQueue();
        await expect(saved).resolves.toBe(true);
        expect(first.runtime.fetch.mock.calls[0][1].headers['X-Neconyan-Account']).toBe('alice');
        expect(first.runtime.editGroup).toHaveBeenCalledWith('group', true, false, 'alice');

        const second = createSaveRuntime(true);
        const declined = second.runtime.saveGroupChat('group', true, false, true, { account: 'alice' });
        second.runtime.account = 'bob';
        second.releaseQueue();
        await expect(declined).resolves.toBe(false);
        expect(second.runtime.fetch).not.toHaveBeenCalled();
        expect(second.runtime.editGroup).not.toHaveBeenCalled();
    });

    test('retains an aside owner through the queue and refuses a changed profile', async () => {
        const first = createSaveRuntime();
        const options = { account: 'alice' };
        const saved = first.runtime.saveChat(options);
        options.account = 'bob';
        first.releaseQueue();
        await expect(saved).resolves.toBe(true);
        expect(first.runtime.fetch.mock.calls[0][1].headers['X-Neconyan-Account']).toBe('alice');

        const second = createSaveRuntime();
        const declined = second.runtime.saveChat({ account: 'alice' });
        second.runtime.account = 'bob';
        second.releaseQueue();
        await expect(declined).resolves.toBe(false);
        expect(second.runtime.fetch).not.toHaveBeenCalled();
    });

    test('snapshots legacy positional saves before they wait in the queue', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat('copy-chat', { label: 'queued metadata' }, 0, false, true);
        runtime.chat[0].mes = 'later message';
        runtime.chat[0].extra.value = 'later';
        runtime.chat_metadata.label = 'later metadata';
        releaseQueue();

        await expect(save).resolves.toBe(true);
        const payload = JSON.parse(runtime.fetch.mock.calls[0][1].body);
        expect(payload).toMatchObject({
            file_name: 'copy-chat', avatar_url: 'bunny.png',
            chat: [{ chat_metadata: { label: 'queued metadata' } }, { mes: 'queued message', extra: { value: 'queued' } }],
        });
    });

    test('legacy callers can omit the filename and save the active chat', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat(undefined, { label: 'legacy' });
        releaseQueue();
        await expect(save).resolves.toBe(true);
        expect(JSON.parse(runtime.fetch.mock.calls[0][1].body).file_name).toBe('original-chat');
    });

    test('invalidates legacy positional saves after a swipe or chat reload', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat('original-chat', {}, undefined, false, true);
        runtime.chatGeneration++;
        releaseQueue();
        await expect(save).resolves.toBe(false);
        expect(runtime.fetch).not.toHaveBeenCalled();
    });

    test('invalidates object saves after a character switch without writing a new file', async () => {
        const { runtime, releaseQueue } = createSaveRuntime();
        const save = runtime.saveChat();
        runtime.characters.push({ name: 'Other', avatar: 'other.png', chat: 'other-chat' });
        runtime.this_chid = 1;
        releaseQueue();
        await expect(save).resolves.toBe(false);
        expect(runtime.fetch).not.toHaveBeenCalled();
    });

    for (const group of [false, true]) {
        const kind = group ? 'group' : 'solo';
        const enqueue = runtime => group ? runtime.saveGroupChat('group', false, false, true) : runtime.saveChat({ throwOnError: true });

        test(`${kind} queued successors use only their own predecessor acknowledgement`, async () => {
            const { runtime, releaseQueue, savedSource } = createSaveRuntime(group);
            const first = enqueue(runtime);
            runtime.chat[0].mes = 'second queued edit';
            const second = enqueue(runtime);
            runtime.chat[0].mes = 'later unsaved edit';
            releaseQueue();
            await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
            const bodies = runtime.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
            expect(bodies[0].roleplay.source).toEqual(savedSource);
            expect(bodies[1].roleplay.source).toMatchObject({ instanceId: savedSource.instanceId, revision: 2,
                rawHash: createHash('sha256').update(runtime.fetch.mock.calls[0][1].body).digest('hex') });
            expect(bodies[1].roleplay.operationKey).not.toBe(bodies[0].roleplay.operationKey);
            expect(bodies[0].chat[1].mes).toBe('queued message');
            expect(bodies[1].chat[1].mes).toBe('second queued edit');
        });

        test(`${kind} retries a lost response without rebuilding the edited payload`, async () => {
            const { runtime, releaseQueue } = createSaveRuntime(group);
            runtime.fetch.mockImplementationOnce(async () => {
                runtime.chat[0].mes = 'edit after dispatch';
                throw new Error('response lost');
            });
            const saved = enqueue(runtime);
            releaseQueue();
            await expect(saved).resolves.toBe(true);
            expect(runtime.fetch).toHaveBeenCalledTimes(2);
            expect(runtime.fetch.mock.calls[1][1].body).toBe(runtime.fetch.mock.calls[0][1].body);
            expect(JSON.parse(runtime.fetch.mock.calls[1][1].body).chat[1].mes).toBe('queued message');
        });

        test(`${kind} explicit overwrite changes the key while successors await the forced acknowledgement`, async () => {
            const { runtime, releaseQueue, account, savedSource } = createSaveRuntime(group);
            runtime.fetch.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({ error: 'integrity',
                roleplay: { account, source: { ...savedSource, revision: 10, rawHash: 'b'.repeat(64) } } }) }));
            const first = enqueue(runtime);
            const second = enqueue(runtime);
            releaseQueue();
            await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
            const bodies = runtime.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
            expect(bodies).toHaveLength(3);
            expect(runtime.Popup.show.input).toHaveBeenCalledTimes(1);
            expect(bodies[1].force).toBe(true);
            expect(bodies[1].roleplay.operationKey).not.toBe(bodies[0].roleplay.operationKey);
            expect(bodies[1].roleplay.source.revision).toBe(10);
            expect(bodies[2].roleplay.source.revision).toBe(11);
            expect(runtime.window.location.reload).not.toHaveBeenCalled();
        });
    }
});

for (const change of ['different chat in one group', 'superseding load of the same chat', 'account binding']) {
    test(`late group load cannot apply after ${change}`, async () => {
        const groupSource = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
        const groupAst = parse(groupSource, { ecmaVersion: 'latest', sourceType: 'module' });
        const account = { accountId: randomUUID(), dataEpoch: 1 };
        const owner = randomUUID();
        bindRoleplayAccount(owner, account);
        const group = { id: 'group', chat_id: 'First', chats: ['First', 'Other'], members: [] };
        let generation = 0;
        let loads = 0;
        let release;
        let signal;
        const paused = new Promise(resolve => { signal = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const runtime = vm.createContext({
            console, groups: [group], selected_group: 'group', chat: [], chat_metadata: {}, owner,
            roleplayAccountStamp, rememberRoleplayRead,
            getCurrentUserHandle: () => runtime.owner,
            getChatGeneration: () => generation, incrementChatGeneration: () => { generation++; },
            validateGroup: async () => {}, unshallowGroupMembers: async () => {},
            loadGroupChat: async chatId => {
                loads++;
                const text = loads === 1 ? 'Old records' : 'Current records';
                return { records: [{ chat_metadata: { tainted: true, integrity: text } }, { mes: text }],
                    evidence: { account, source: { instanceId: randomUUID(), revision: 1, rawHash: 'a'.repeat(64) } } };
            },
            loadItemizedPrompts: async () => { if (loads === 1) { signal(); await gate; } },
            chatElement: { find: () => ({ remove() {} }) }, ensureMessageMediaIsArray: () => {},
            printMessages: async () => {}, updateChatMetadata: metadata => { runtime.chat_metadata = metadata; },
            eventSource: { emit: async () => {} }, event_types: {}, getCurrentChatId: () => group.chat_id,
            toastr: { error: jest.fn() }, t: strings => strings.join(''),
        });
        const node = groupAst.body.map(row => row.declaration ?? row).find(row => row.id?.name === 'getGroupChat');
        vm.runInContext(groupSource.slice(node.start, node.end), runtime);
        const old = runtime.getGroupChat('group');
        await paused;
        if (change === 'account binding') {
            bindRoleplayAccount('another-owner', account);
        } else {
            if (change === 'different chat in one group') group.chat_id = 'Other';
            await runtime.getGroupChat('group');
        }
        release();
        await old;
        expect({ text: runtime.chat[0]?.mes, integrity: runtime.chat_metadata.integrity }).toEqual(
            change === 'account binding' ? { text: undefined, integrity: undefined }
                : { text: 'Current records', integrity: 'Current records' });
    });
}

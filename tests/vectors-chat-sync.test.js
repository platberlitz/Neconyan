import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const saveChatConditional = jest.fn(async () => true);
const run = jest.fn(async (_kind, input, { prepareInput }) => ({ result: { remaining: 0, input: await prepareInput(input) } }));
const context = {
    getCurrentChatId: () => 'Seraphina - 1',
    groupId: null,
    characterId: 0,
    characters: [{ avatar: 'seraphina.png' }],
    extensionSettings: { vectors: {} },
};

jest.unstable_mockModule('../public/script.js', () => ({
    getActiveGenerationAcknowledgement: () => null,
    saveChatConditional,
    saveSettings: jest.fn(async () => true),
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => context }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'default-user' }));
jest.unstable_mockModule('../public/scripts/operations-client.js', () => ({
    getOperationClient: async () => ({ run }),
    mountOperationRecovery: () => undefined,
}));
jest.unstable_mockModule('../public/scripts/extensions/shared.js', () => ({
    generateWebLlmChatPrompt: jest.fn(),
    isWebLlmSupported: () => false,
}));
jest.unstable_mockModule('../public/scripts/extensions/vectors/webllm.js', () => ({
    WebLlmVectorProvider: class {},
}));

const { runVectorWork } = await import('../public/scripts/extensions/vectors/native.js');

// The automatic sync is cut out of the extension as it stands and run against stand-ins.
const source = fs.readFileSync(new URL('../public/scripts/extensions/vectors/index.js', import.meta.url), 'utf8');
const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const cutFunction = name => {
    const found = syntax.body.find(row => row.id?.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};

function syncHost() {
    const timers = [];
    const host = {
        settings: { enabled_chats: true },
        chatId: 'Seraphina - 1',
        is_send_press: false,
        agentsWorking: false,
        console: { warn: jest.fn() },
        toastr: { error: jest.fn() },
        onChatEvent: jest.fn(),
        runVectorWork: jest.fn(async () => ({ remaining: 0 })),
        setTimeout: (callback, delay) => timers.push({ callback, delay }),
    };
    host.getCurrentChatId = () => host.chatId;
    host.isAgentWorkPending = () => host.agentsWorking;
    vm.createContext(host);
    vm.runInContext([
        'let syncBlocked = false; let deferredSyncChat = null; const SYNC_BUSY_POLL_MS = 1000;',
        cutFunction('isChatBusy'),
        cutFunction('deferChatSync'),
        cutFunction('synchronizeChat'),
        'globalThis.synchronizeChat = synchronizeChat;',
    ].join('\n'), host);
    const runTimer = () => timers.shift().callback();
    return { host, timers, runTimer };
}

describe('vector chat sync', () => {
    beforeEach(() => {
        saveChatConditional.mockClear();
        run.mockClear();
    });

    test('a sync that finds the chat busy saves nothing and sends nothing', async () => {
        const error = await runVectorWork('sync-chat', {}, { automatic: true, isBusy: () => true }).catch(value => value);

        expect(error).toMatchObject({ deferred: true });
        expect(saveChatConditional).not.toHaveBeenCalled();
    });

    test('an idle chat is saved and synced as before', async () => {
        await expect(runVectorWork('sync-chat', {}, { automatic: true, isBusy: () => false }))
            .resolves.toMatchObject({ remaining: 0 });

        expect(saveChatConditional).toHaveBeenCalledTimes(1);
    });

    test('a sync waits while Agents work on the chat, then runs once they finish', async () => {
        const { host, timers, runTimer } = syncHost();
        host.agentsWorking = true;

        await expect(host.synchronizeChat()).resolves.toBe(-1);
        await host.synchronizeChat();
        expect(host.runVectorWork).not.toHaveBeenCalled();
        // A burst of chat events leaves one waiter.
        expect(timers).toHaveLength(1);

        runTimer();
        expect(host.onChatEvent).not.toHaveBeenCalled();
        host.agentsWorking = false;
        runTimer();
        expect(host.onChatEvent).toHaveBeenCalledTimes(1);
        expect(timers).toHaveLength(0);

        await host.synchronizeChat();
        expect(host.runVectorWork).toHaveBeenCalledWith('sync-chat', {}, expect.objectContaining({ automatic: true, isBusy: expect.any(Function) }));
    });

    test('a sync waits for a reply or a server Roleplay job, and a chat switch drops the wait', async () => {
        const { host, timers, runTimer } = syncHost();
        host.is_send_press = true;

        await host.synchronizeChat();
        host.chatId = 'Other - 1';
        runTimer();

        expect(timers).toHaveLength(0);
        expect(host.onChatEvent).not.toHaveBeenCalled();
        expect(host.runVectorWork).not.toHaveBeenCalled();
    });

    test('work that became busy before it was sent waits quietly instead of reporting a failure', async () => {
        const { host, timers } = syncHost();
        host.runVectorWork.mockRejectedValueOnce(Object.assign(new Error('busy'), { deferred: true }));

        await expect(host.synchronizeChat()).resolves.toBe(-1);

        expect(host.toastr.error).not.toHaveBeenCalled();
        expect(host.console.warn).not.toHaveBeenCalled();
        expect(timers).toHaveLength(1);
    });

    test('a failed sync is logged as well as shown', async () => {
        const { host } = syncHost();
        const failure = new Error('Embedding provider unreachable');
        host.runVectorWork.mockRejectedValueOnce(failure);

        await expect(host.synchronizeChat()).resolves.toBeNull();

        expect(host.console.warn).toHaveBeenCalledWith('Vector chat sync failed; the search index was kept:', failure);
        expect(host.toastr.error).toHaveBeenCalledWith('Embedding provider unreachable', 'Search index kept', { preventDuplicates: true });
    });
});

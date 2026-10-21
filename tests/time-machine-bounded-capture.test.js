/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const storePath = '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/store.js';
const apiPath = '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/api.js';
const moduleName = 'NeconyanCardTimeMachine';
const attachmentKey = '__Neconyan-Card-Time-Machine__';

let account;
let settings;
let registered;
let resolveRun;
const saveSettings = jest.fn(async () => true);
const adoptServerSettingsWrite = jest.fn(() => true);
const registerSamePageServerWriteRecovery = jest.fn(({ account: owner, recover }) => {
    registered = { owner, recover, release: jest.fn() };
    return { release: registered.release };
});
const client = {
    run: jest.fn(),
    read: jest.fn(),
    request: jest.fn(),
    hasPending: jest.fn(),
    pendingKey: jest.fn(),
};
const getOperationClient = jest.fn(async () => client);
const withMutationLock = jest.fn(async action => action());

await jest.unstable_mockModule(storePath, () => ({
    withMutationLock,
    MODULE_NAME: moduleName,
    commitSettings: jest.fn(),
    getSettings: jest.fn(() => ({})),
    lastHashOf: jest.fn(),
    save: jest.fn(),
}));
await jest.unstable_mockModule('../public/script.js', () => ({
    saveSettings,
    adoptServerSettingsWrite,
    registerSamePageServerWriteRecovery,
}));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
await jest.unstable_mockModule('../public/scripts/operations-client.js', () => ({ getOperationClient }));

const { captureEverything } = await import(apiPath);

function result(overrides = {}) {
    return {
        taken: 1,
        skipped: 0,
        failed: 0,
        removed: 0,
        module: {
            snapshots: [{ id: 'new-row' }],
            lastCommit: 'server-job-1-123',
            captureCharacters: true,
            keepPerTarget: 1,
            quarantinedSnapshots: [],
        },
        attachments: [{ name: 'new-row' }],
        previousVersion: 3,
        previousSettingsRevision: 8,
        version: 4,
        settingsRevision: 9,
        ...overrides,
    };
}

beforeEach(() => {
    account = 'alice';
    settings = {
        [moduleName]: {
            snapshots: [{ id: 'old-row' }],
            lastCommit: 'local-token',
            captureCharacters: false,
            keepPerTarget: 7,
            maxTotalBytes: 1234,
            quarantinedSnapshots: [{ id: 'quarantined' }],
            localOnly: 'keep',
        },
        character_attachments: { other: 'keep', [attachmentKey]: [{ old: true }] },
        otherExtension: { enabled: true },
    };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: settings }) };
    registered = undefined;
    resolveRun = undefined;
    saveSettings.mockReset().mockResolvedValue(true);
    adoptServerSettingsWrite.mockReset().mockReturnValue(true);
    registerSamePageServerWriteRecovery.mockClear();
    client.run.mockReset();
    client.read.mockReset();
    client.request.mockReset();
    client.hasPending.mockReset();
    client.pendingKey.mockReset();
    withMutationLock.mockReset().mockImplementation(async action => action());
    getOperationClient.mockClear();
});

function completedRecord(captured = result()) {
    return { key: 'retained-key', kind: 'time-machine-capture', state: 'completed', jobId: 'job-1', result: captured };
}

describe('Time Machine capture application', () => {
    test('assigns only job-owned snapshot fields and preserves local Time Machine edits', async () => {
        adoptServerSettingsWrite.mockImplementation(() => {
            expect(settings[moduleName].snapshots).toEqual([{ id: 'old-row' }]);
            return true;
        });
        client.run.mockResolvedValue({ result: result() });

        await expect(captureEverything()).resolves.toEqual({ taken: 1, skipped: 0, failed: 0, removed: 0 });
        expect(withMutationLock).toHaveBeenCalledTimes(1);
        expect(adoptServerSettingsWrite).toHaveBeenCalledWith({
            account: 'alice', previousVersion: 3, previousSettingsRevision: 8, version: 4, settingsRevision: 9,
        });
        expect(settings[moduleName]).toEqual({
            snapshots: [{ id: 'new-row' }],
            lastCommit: 'server-job-1-123',
            captureCharacters: false,
            keepPerTarget: 7,
            maxTotalBytes: 1234,
            quarantinedSnapshots: [{ id: 'quarantined' }],
            localOnly: 'keep',
        });
        expect(settings.character_attachments).toEqual({
            other: 'keep',
            [attachmentKey]: [{ name: 'new-row' }],
        });
        expect(settings.otherExtension).toEqual({ enabled: true });
        expect(registered.owner).toBe('alice');
        expect(registered.release).toHaveBeenCalledTimes(1);
    });

    test('the recovery handle is released when the capture fails', async () => {
        client.run.mockRejectedValueOnce(new Error('capture failed'));
        await expect(captureEverything()).rejects.toThrow('capture failed');
        expect(registered.release).toHaveBeenCalledTimes(1);
        expect(adoptServerSettingsWrite).not.toHaveBeenCalled();
    });

    test('a failed adoption leaves every local Time Machine value untouched', async () => {
        adoptServerSettingsWrite.mockReturnValue(false);
        const before = structuredClone(settings);
        client.run.mockResolvedValue({ result: result() });

        await captureEverything();
        expect(settings).toEqual(before);
        expect(adoptServerSettingsWrite).toHaveBeenCalledTimes(1);
    });

    test('normal delivery then recovery applies exactly once', async () => {
        client.run.mockResolvedValue({ result: result() });
        await captureEverything();
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockResolvedValue(completedRecord());

        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        })).resolves.toBeNull();
        expect(adoptServerSettingsWrite).toHaveBeenCalledTimes(1);
    });

    test('recovery delivery then normal completion applies exactly once', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();

        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockResolvedValue(completedRecord());
        const proof = await registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        });
        expect(proof).toEqual({ account: 'alice', previousSettingsRevision: 8, version: 4, settingsRevision: 9 });
        expect(settings[moduleName].lastCommit).toBe('server-job-1-123');

        resolveRun({ result: result() });
        await capture;
        expect(adoptServerSettingsWrite).toHaveBeenCalledTimes(1);
    });

    test('a retained completed record already loaded is a no-op when adoption fails', async () => {
        adoptServerSettingsWrite.mockReturnValue(false);
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        const before = structuredClone(settings);
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockResolvedValue(completedRecord());

        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        })).resolves.toBeNull();
        expect(settings).toEqual(before);

        resolveRun({ result: result() });
        await capture;
        expect(settings).toEqual(before);
        expect(adoptServerSettingsWrite).toHaveBeenCalledTimes(1);
    });

    test('a completed record for another revision is ignored', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockResolvedValue(completedRecord(result({ previousSettingsRevision: 7 })));

        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        })).resolves.toBeNull();
        expect(adoptServerSettingsWrite).not.toHaveBeenCalled();

        resolveRun({ result: result() });
        await capture;
    });

    test('a nonterminal record polls only after this job published its index', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read
            .mockResolvedValueOnce({ key: 'retained-key', kind: 'time-machine-capture', state: 'accepted', jobId: 'job-1' })
            .mockResolvedValueOnce(completedRecord());
        client.request.mockResolvedValue({ extension_settings: { [moduleName]: { lastCommit: 'server-job-1-456' } } });

        const proof = await registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        });
        expect(proof).toEqual({ account: 'alice', previousSettingsRevision: 8, version: 4, settingsRevision: 9 });
        expect(client.request).toHaveBeenCalledWith('/api/settings/get', expect.objectContaining({ method: 'POST' }));
        expect(client.read).toHaveBeenCalledTimes(2);

        resolveRun({ result: result() });
        await capture;
    });

    test('a nonterminal record with another lastCommit is not polled', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockResolvedValue({ key: 'retained-key', kind: 'time-machine-capture', state: 'accepted', jobId: 'job-1' });
        client.request.mockResolvedValue({ extension_settings: { [moduleName]: { lastCommit: 'local-token' } } });

        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        })).resolves.toBeNull();
        expect(client.read).toHaveBeenCalledTimes(1);
        expect(adoptServerSettingsWrite).not.toHaveBeenCalled();

        resolveRun({ result: result() });
        await capture;
    });

    test('a missing or refused retained key is an immediate failure', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        client.hasPending.mockReturnValue(false);

        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        })).resolves.toBeNull();
        expect(client.read).not.toHaveBeenCalled();

        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockResolvedValue({ key: 'retained-key', kind: 'time-machine-capture', state: 'refused', error: 'refused' });
        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        })).resolves.toBeNull();
        expect(adoptServerSettingsWrite).not.toHaveBeenCalled();

        resolveRun({ result: result() });
        await capture;
    });

    test('a hanging retained read is released by the deadline signal', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');
        client.read.mockImplementation((_key, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
        const controller = new AbortController();

        const recovery = registered.recover({
            signal: controller.signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => true,
        });
        setTimeout(() => controller.abort(), 10);
        await expect(recovery).resolves.toBeNull();
        expect(adoptServerSettingsWrite).not.toHaveBeenCalled();

        resolveRun({ result: result() });
        await capture;
    });

    test('a blocked recovery checks its account/import guard before any read', async () => {
        client.run.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
        const capture = captureEverything();
        while (!registered) await Promise.resolve();
        client.hasPending.mockReturnValue(true);
        client.pendingKey.mockReturnValue('retained-key');

        await expect(registered.recover({
            signal: new AbortController().signal,
            deadline: Date.now() + 10000,
            rejectedSettingsRevision: 8,
            isAllowed: () => false,
        })).resolves.toBeNull();
        expect(client.read).not.toHaveBeenCalled();

        resolveRun({ result: result() });
        await capture;
    });

    test('a fresh submission runs prepareInput, while a retained request does not', async () => {
        client.run.mockImplementation(async (_kind, input, options) => {
            expect(saveSettings).not.toHaveBeenCalled();
            await options.prepareInput(input);
            return { result: result() };
        });
        await captureEverything();
        expect(saveSettings).toHaveBeenCalledWith(0, { returnResult: true });

        saveSettings.mockClear();
        adoptServerSettingsWrite.mockClear();
        settings = { [moduleName]: { snapshots: [], lastCommit: 'local' }, character_attachments: {}, otherExtension: {} };
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: settings }) };
        client.run.mockImplementation(async () => ({ result: result() }));
        await captureEverything();
        expect(saveSettings).not.toHaveBeenCalled();
    });
});

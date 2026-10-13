/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { createServerCrashObserver, initialiseCrashActivity } from '../public/scripts/crash-diagnostics-context.js';

const original = { document: globalThis.document, localStorage: globalThis.localStorage, diagnostics: globalThis.NeconyanCrashDiagnostics, performance: globalThis.performance };
let account, admin, storage;
beforeEach(() => {
    jest.useFakeTimers();
    account = 'alice'; admin = true; storage = new Map();
    globalThis.document = { visibilityState: 'visible', addEventListener() {}, getElementById: () => ({ childElementCount: 35 }) };
    globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
});
afterEach(() => {
    jest.useRealTimers();
    globalThis.document = original.document; globalThis.localStorage = original.localStorage;
    globalThis.NeconyanCrashDiagnostics = original.diagnostics;
});
const response = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const options = extra => ({ isAdmin: () => admin, getAccount: () => account, getRequestHeaders: () => ({}), refreshCsrfToken: async () => {}, ...extra });

test('authorised status reports once, polls every 30 seconds, and stores IDs only', async () => {
    const showNotice = jest.fn(() => ({ remove() {} }));
    const fetchFn = jest.fn(async () => response({ schema: 1, runId: 'run-one', latest: { id: 'report-one', at: '2026-10-13', errorPreview: 'Actual failure' } }));
    const observer = createServerCrashObserver(options({ fetchFn, showNotice })); observer.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(showNotice).toHaveBeenCalledTimes(1);
    expect(Array.from(storage.values()).join('')).not.toContain('Actual failure');
    await jest.advanceTimersByTimeAsync(29999); expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(showNotice).toHaveBeenCalledTimes(1); observer.stop();
});

test('an account change while reading prevents disclosure; non-admins never poll', async () => {
    let finish;
    const fetchFn = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const showNotice = jest.fn();
    const observer = createServerCrashObserver(options({ fetchFn, showNotice })); observer.start();
    await jest.advanceTimersByTimeAsync(0);
    account = 'bob'; finish(response({ latest: { id: 'secret-id', errorPreview: 'private failure' } }));
    await jest.advanceTimersByTimeAsync(0); expect(showNotice).not.toHaveBeenCalled(); observer.stop();
    admin = false; observer.start(); expect(fetchFn).toHaveBeenCalledTimes(1);
});

test('status failure backs off to 60 seconds without a diagnostic error notice', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('offline'); }), showNotice = jest.fn();
    const observer = createServerCrashObserver(options({ fetchFn, showNotice })); observer.start();
    await jest.advanceTimersByTimeAsync(59999); expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(showNotice).not.toHaveBeenCalled(); observer.stop();
});

test('application counts text without serialising messages and ignores auxiliary generation', async () => {
    const listeners = new Map(), updateActivity = jest.fn(), noteActivity = jest.fn();
    globalThis.NeconyanCrashDiagnostics = { updateActivity, noteActivity, getActivity: () => ({ snapshot: { mode: 'roleplay' } }) };
    const chat = [{ mes: 'hello', swipes: ['hello', 'other'], swipe_id: 0, extra: { reasoning: 'why' }, toJSON() { throw new Error('Must not serialise chat'); } }];
    const event_types = Object.fromEntries(['CHAT_LOADED', 'GENERATION_STARTED', 'GENERATION_ENDED'].map(name => [name, name]));
    initialiseCrashActivity({ eventSource: { on: (name, fn) => listeners.set(name, fn) }, event_types, getChat: () => chat, getExtensionCount: () => 2 });
    listeners.get('CHAT_LOADED')(); await jest.advanceTimersByTimeAsync(0);
    expect(updateActivity).toHaveBeenCalledWith(expect.objectContaining({ chat: expect.objectContaining({ messageCount: 1, estimatedTextBytes: 26 }) }));
    updateActivity.mockClear(); listeners.get('GENERATION_STARTED')('normal', { isAuxiliaryGeneration: true }, false);
    expect(updateActivity).not.toHaveBeenCalled();
    listeners.get('GENERATION_STARTED')('normal', {}, false);
    expect(noteActivity).toHaveBeenCalledWith('generation-start');
});

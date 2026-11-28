/* global globalThis */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// The Android and iPhone apps dispatch their lifecycle on the page's window.
const originalWindow = globalThis.window;
globalThis.window = new EventTarget();

const { createNativeAppLifecycle, getNativeAppLifecycle, isNativeAppBackgrounded, NATIVE_APP_LIFECYCLE_EVENT } = await import('../public/scripts/native-app-lifecycle.js');
const { fetchResumable } = await import('../public/scripts/resumable-generation.js');

const RESUME_URL = '/api/resumable-generations/resume';
const STATUS_URL = '/api/resumable-generations/status';
const encoder = new TextEncoder();

const sendLifecycle = (state, host = globalThis.window) => host.dispatchEvent(new CustomEvent(NATIVE_APP_LIFECYCLE_EVENT, { detail: { state } }));

afterAll(() => {
    getNativeAppLifecycle().dispose();
    globalThis.window = originalWindow;
});

describe('native app lifecycle', () => {
    test('a page that never hears from an app stays on screen', () => {
        const lifecycle = createNativeAppLifecycle({ host: new EventTarget() });
        expect(lifecycle.state).toBe('resumed');
        expect(lifecycle.isBackgrounded()).toBe(false);
        expect(createNativeAppLifecycle({ host: null }).isBackgrounded()).toBe(false);
    });

    test('follows the app off the screen and back, ignoring repeats and unknown states', () => {
        const host = new EventTarget();
        const lifecycle = createNativeAppLifecycle({ host });
        const changes = [];
        lifecycle.subscribe(change => changes.push(change));
        sendLifecycle('paused', host);
        expect(lifecycle.isBackgrounded()).toBe(false);
        sendLifecycle('stopped', host);
        sendLifecycle('stopped', host);
        sendLifecycle('frozen', host);
        host.dispatchEvent(new Event(NATIVE_APP_LIFECYCLE_EVENT));
        expect(lifecycle.isBackgrounded()).toBe(true);
        sendLifecycle('resumed', host);
        expect(changes).toEqual([
            { state: 'paused', previous: 'resumed' },
            { state: 'stopped', previous: 'paused' },
            { state: 'resumed', previous: 'stopped' },
        ]);
    });

    test('a failing listener does not stop the others, and dispose stops listening', () => {
        const host = new EventTarget();
        const lifecycle = createNativeAppLifecycle({ host });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const seen = [];
        lifecycle.subscribe(() => { throw new Error('broken'); });
        const unsubscribe = lifecycle.subscribe(({ state }) => seen.push(state));
        sendLifecycle('stopped', host);
        unsubscribe();
        sendLifecycle('resumed', host);
        expect(seen).toEqual(['stopped']);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        lifecycle.dispose();
        sendLifecycle('stopped', host);
        expect(lifecycle.state).toBe('resumed');
    });
});

describe('replies while the app is off the screen', () => {
    const originalFetch = globalThis.fetch;
    let fetchMock;

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        fetchMock = jest.fn();
        globalThis.fetch = fetchMock;
    });

    afterEach(() => {
        sendLifecycle('resumed');
        globalThis.fetch = originalFetch;
        jest.useRealTimers();
    });

    const callsTo = url => fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url);

    function hangingBody(parts, signal) {
        let index = 0;
        return new ReadableStream({
            pull(controller) {
                if (index < parts.length) {
                    controller.enqueue(encoder.encode(parts[index++]));
                    return;
                }
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        });
    }

    test('failed resume attempts while the app is stopped do not use up the limit', async () => {
        const failure = new TypeError('Load failed');
        fetchMock.mockImplementation(async () => {
            throw failure;
        });
        sendLifecycle('stopped');
        expect(isNativeAppBackgrounded()).toBe(true);
        let settled = false;
        const outcome = fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}' })
            .catch(error => error)
            .finally(() => { settled = true; });

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(settled).toBe(false);
        expect(callsTo(RESUME_URL).length).toBeGreaterThan(100);

        // Back on screen, the ordinary limit applies again.
        sendLifecycle('resumed');
        const before = callsTo(RESUME_URL).length;
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        const error = await outcome;
        expect(error.code).toBe('GENERATION_CONNECTION_LOST');
        expect(error.cause).toBe(failure);
        expect(callsTo(RESUME_URL).length - before).toBeLessThanOrEqual(20);
    });

    test('a stopped app gives up after the server would have dropped the reply anyway', async () => {
        fetchMock.mockImplementation(async () => {
            throw new TypeError('Load failed');
        });
        sendLifecycle('stopped');
        const outcome = fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}' }).catch(error => error);
        await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
        const error = await outcome;
        expect(error.code).toBe('GENERATION_CONNECTION_LOST');
        expect(callsTo(RESUME_URL)).toHaveLength(720);
    });

    test('a quiet reply is left alone while the app is stopped and picked up as soon as it is back', async () => {
        fetchMock.mockImplementation(async (url, init) => {
            if (url === STATUS_URL) return Response.json({ done: false, headersReady: true, size: 100 });
            if (url === RESUME_URL) {
                return new Response(hangingBody(['data: b\n\n'], init.signal), { status: 200, headers: { 'X-Generation-Status': '200' } });
            }
            return new Response(hangingBody(['data: a\n\n'], init.signal), { status: 200 });
        });
        const controller = new AbortController();
        try {
            const response = await fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}', signal: controller.signal });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            expect(decoder.decode((await reader.read()).value)).toBe('data: a\n\n');
            const next = reader.read();

            sendLifecycle('paused');
            sendLifecycle('stopped');
            await jest.advanceTimersByTimeAsync(60 * 1000);
            expect(callsTo(STATUS_URL)).toHaveLength(0);
            expect(callsTo(RESUME_URL)).toHaveLength(0);

            sendLifecycle('resumed');
            await jest.advanceTimersByTimeAsync(0);
            expect(callsTo(RESUME_URL)).toHaveLength(1);
            expect(JSON.parse(callsTo(RESUME_URL)[0][1].body).offset).toBe('data: a\n\n'.length);
            expect(decoder.decode((await next).value)).toBe('data: b\n\n');
        } finally {
            controller.abort();
        }
    });

    test('returning from a brief pause does not drop a live reply', async () => {
        fetchMock.mockImplementation(async (url, init) => {
            if (url === STATUS_URL) return Response.json({ done: false, headersReady: true, size: 'data: a\n\n'.length });
            return new Response(hangingBody(['data: a\n\n'], init.signal), { status: 200 });
        });
        const controller = new AbortController();
        try {
            const response = await fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}', signal: controller.signal });
            const reader = response.body.getReader();
            await reader.read();
            reader.read().catch(() => undefined);
            sendLifecycle('paused');
            await jest.advanceTimersByTimeAsync(6 * 1000);
            sendLifecycle('resumed');
            await jest.advanceTimersByTimeAsync(0);
            expect(callsTo(RESUME_URL)).toHaveLength(0);
        } finally {
            controller.abort();
        }
    });
});

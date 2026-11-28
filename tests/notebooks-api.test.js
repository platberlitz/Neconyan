/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();
globalThis.fetch = fetchMock;
jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }) }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'owner' }));
const { notesRequest, subscribeNotes } = await import('../public/scripts/notebooks/api.js');

beforeEach(() => fetchMock.mockReset());

test.each([
    { notebooks: [{ notebookId: 'book', name: 'Shared' }] },
    { results: [{ notebookId: 'book', noteId: 'note', title: 'Plan' }] },
    { notebookId: 'book', noteId: 'note', text: 'Shared words.', sections: [] },
])('successful assistant read data is retained without a server status field', async payload => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await expect(notesRequest('/assistant/tool', { tool: 'read-note' })).resolves.toEqual({ ...payload, status: 'success', http: 200 });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Neconyan-Account': 'owner', 'X-CSRF-Token': 'token' });
});

test('permission failures and unreadable responses remain failures', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: 'denied', message: 'Not shared.' }, { status: 403 }));
    await expect(notesRequest('/assistant/tool')).resolves.toMatchObject({ status: 'denied', http: 403, message: 'Not shared.' });
    fetchMock.mockResolvedValueOnce(new Response('bad response', { status: 503 }));
    await expect(notesRequest('/assistant/tool')).resolves.toMatchObject({ status: 'failure', http: 503 });
});

describe('the Notes change stream', () => {
    let sources;
    let delays;
    let pending;

    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.closed = false;
            sources.push(this);
        }
        close() { this.closed = true; }
    }

    beforeEach(() => {
        sources = [];
        delays = [];
        pending = [];
        globalThis.EventSource = FakeEventSource;
        globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
        globalThis.window = new EventTarget();
        jest.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
            delays.push(delay);
            pending.push(callback);
            return pending.length;
        });
        jest.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
        jest.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete globalThis.EventSource;
        delete globalThis.document;
        delete globalThis.window;
    });

    const fail = () => {
        sources.at(-1).onerror();
        pending.shift()?.();
    };

    test('a stream that keeps failing waits longer each time, up to five minutes', () => {
        const stop = subscribeNotes(() => {});
        for (let attempt = 0; attempt < 9; attempt += 1) fail();
        expect(delays).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
        expect(sources).toHaveLength(10);
        stop();
    });

    test('the waits are shortened at random, and a stream that opened starts again from 5 s', () => {
        Math.random.mockReturnValue(1);
        const stop = subscribeNotes(() => {});
        fail();
        fail();
        sources.at(-1).onopen();
        fail();
        expect(delays).toEqual([2500, 5000, 2500]);
        stop();
    });

    test('a hidden or offline page does not reconnect until it is shown or back online', () => {
        const stop = subscribeNotes(() => {});
        globalThis.document.visibilityState = 'hidden';
        fail();
        expect(sources).toHaveLength(1);
        globalThis.document.visibilityState = 'visible';
        globalThis.document.dispatchEvent(new Event('visibilitychange'));
        expect(sources).toHaveLength(2);

        globalThis.navigator ??= {};
        const online = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
        Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => false });
        try {
            fail();
            expect(sources).toHaveLength(2);
            Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true });
            globalThis.window.dispatchEvent(new Event('online'));
            expect(sources).toHaveLength(3);
        } finally {
            if (online) Object.defineProperty(globalThis.navigator, 'onLine', online);
            else delete globalThis.navigator.onLine;
        }
        stop();
    });

    test('a page that is shown again while a stream is open keeps that one stream', () => {
        const stop = subscribeNotes(() => {});
        globalThis.document.dispatchEvent(new Event('visibilitychange'));
        globalThis.window.dispatchEvent(new Event('online'));
        expect(sources).toHaveLength(1);
        stop();
        expect(sources[0].closed).toBe(true);
        globalThis.document.dispatchEvent(new Event('visibilitychange'));
        expect(sources).toHaveLength(1);
    });
});

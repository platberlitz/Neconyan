/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ReadableStream } from 'node:stream/web';

const CSRF_HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-value' };
// Restore the real fetch afterwards. Deleting it leaks into later test files,
// which made a sibling suite read a stale cache entry and fail intermittently.
const nativeFetch = globalThis.fetch;
let fetchCalls = [];
let account = 'alice';
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (body === null ? '' : JSON.stringify(body)),
    };
}

describe('browser jobs observer sends the CSRF header and keeps caller headers', () => {
    beforeEach(() => {
        jest.resetModules();
        fetchCalls = [];
        account = 'alice';
        jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: jest.fn(() => ({ ...CSRF_HEADERS })),
        }));
        globalThis.fetch = jest.fn(async (url, options = {}) => {
            fetchCalls.push({ url, options });
            return jsonResponse({ job: { id: 'job-1', state: 'queued' } }, 202);
        });
    });

    afterEach(() => {
        globalThis.fetch = nativeFetch;
    });

    test('submitJob sends the CSRF token and a JSON content type', async () => {
        const { submitJob } = await import('../public/scripts/jobs.js');
        await submitJob({ type: 'roleplay', intent: { a: 1 }, submissionKey: 'k1' });
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe('/api/jobs/submit');
        expect(fetchCalls[0].options.headers).toMatchObject(CSRF_HEADERS);
        expect(fetchCalls[0].options.headers['X-Neconyan-Account']).toBe('alice');
        expect(fetchCalls[0].options.credentials).toBe('same-origin');
        expect(JSON.parse(fetchCalls[0].options.body)).toMatchObject({ type: 'roleplay', submissionKey: 'k1' });
    });

    test('clearJobHistory posts to the account job history endpoint with the CSRF token', async () => {
        const { clearJobHistory } = await import('../public/scripts/jobs.js');
        await clearJobHistory();
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe('/api/jobs/clear-history');
        expect(fetchCalls[0].options.method).toBe('POST');
        expect(fetchCalls[0].options.headers).toMatchObject(CSRF_HEADERS);
        expect(fetchCalls[0].options.headers['X-Neconyan-Account']).toBe('alice');
    });

    test('a caller header spread cannot drop the CSRF token from a POST', async () => {
        const { cancelJob } = await import('../public/scripts/jobs.js');
        await cancelJob('job-1', { reason: 'changed my mind' });
        expect(fetchCalls[0].options.headers['X-CSRF-Token']).toBe('csrf-value');
        expect(fetchCalls[0].options.headers['Content-Type']).toBe('application/json');
        expect(fetchCalls[0].options.method).toBe('POST');
    });

    test('a non-success response surfaces the server error and status', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse({ error: 'The job ledger needs recovery.', code: 'JOB_STORE_RECOVERABLE' }, 409));
        const { submitJob } = await import('../public/scripts/jobs.js');
        await expect(submitJob({ type: 'roleplay', intent: { a: 1 }, submissionKey: 'k1' }))
            .rejects.toMatchObject({ status: 409, message: 'The job ledger needs recovery.' });
    });
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('browser jobs observer snapshot callbacks', () => {
    beforeEach(() => {
        jest.resetModules();
        fetchCalls = [];
        account = 'alice';
        jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: jest.fn(() => ({ ...CSRF_HEADERS })),
        }));
    });

    afterEach(() => {
        globalThis.fetch = nativeFetch;
    });

    test('onSnapshot runs on every poll while onUpdate runs only when the job JSON changes', async () => {
        let call = 0;
        globalThis.fetch = jest.fn(async url => {
            if (url.endsWith('/events')) return jsonResponse(null, 404);
            call += 1;
            return jsonResponse({ job: { id: 'job-1', state: call < 3 ? 'queued' : 'completed' } });
        });
        const { observeJob } = await import('../public/scripts/jobs.js');
        const updates = [];
        const snapshots = [];
        observeJob('job-1', {
            intervalMs: 1,
            onUpdate: job => updates.push(job.state),
            onSnapshot: job => snapshots.push(job.state),
        });
        await wait(60);
        // The root job JSON is unchanged across the first two polls, so onUpdate
        // sees one 'queued'; native child bubbles still need every poll, so
        // onSnapshot sees each one.
        expect(updates).toEqual(['queued', 'completed']);
        expect(snapshots.filter(state => state === 'queued').length).toBeGreaterThanOrEqual(2);
        expect(snapshots[snapshots.length - 1]).toBe('completed');
    });

    test('an already-aborted signal starts no polling', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse({ job: { id: 'job-1', state: 'queued' } }));
        const { observeJob } = await import('../public/scripts/jobs.js');
        const controller = new AbortController();
        controller.abort();
        observeJob('job-1', { intervalMs: 1, signal: controller.signal, onSnapshot: () => {} });
        await wait(30);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('observers share one change stream and read completed snapshots without advancing the polling clock', async () => {
        let feed;
        let state = 'running';
        let streamSignal;
        let streamHeaders;
        const body = new ReadableStream({ start(controller) { feed = controller; } });
        globalThis.fetch = jest.fn(async (url, options) => {
            if (url.endsWith('/events')) {
                streamSignal = options.signal;
                streamHeaders = options.headers;
                return { ok: true, headers: new Map([['content-type', 'text/event-stream']]), body };
            }
            return jsonResponse({ job: { id: url.split('/').pop(), state } });
        });
        const { observeJob } = await import('../public/scripts/jobs.js');
        const completed = [];
        const stops = ['first', 'second'].map(id => observeJob(id, {
            intervalMs: 60_000, onDone: job => completed.push(job.id),
        }));
        try {
            await wait(20);
            state = 'completed';
            feed.enqueue(new TextEncoder().encode('data: {}\n\n'));
            await wait(40);
            expect(completed.sort()).toEqual(['first', 'second']);
            expect(globalThis.fetch.mock.calls.filter(([url]) => url.endsWith('/events'))).toHaveLength(1);
            expect(streamHeaders['X-Neconyan-Account']).toBe('alice');
            expect(streamSignal.aborted).toBe(true);
        } finally { stops.forEach(stop => stop()); feed.close(); }
    });

    test('a failed terminal snapshot readback retries before signalling completion', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse({ job: { id: 'job-1', state: 'completed' } }));
        const { observeJob } = await import('../public/scripts/jobs.js');
        const onSnapshot = jest.fn().mockRejectedValueOnce(new Error('Readback unavailable')).mockResolvedValue(undefined);
        const onDone = jest.fn();
        const stop = observeJob('job-1', { intervalMs: 1, onSnapshot, onDone });
        try {
            await wait(40);
            expect(onSnapshot).toHaveBeenCalledTimes(2);
            expect(onDone).toHaveBeenCalledTimes(1);
        } finally { stop(); }
    });

    test('a completed job stops polling and does not read again', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse({ job: { id: 'job-1', state: 'completed' } }));
        const { observeJob } = await import('../public/scripts/jobs.js');
        observeJob('job-1', { intervalMs: 1, onSnapshot: () => {} });
        await wait(40);
        const reads = globalThis.fetch.mock.calls.length;
        await wait(40);
        expect(globalThis.fetch.mock.calls.length).toBe(reads);
    });

    test('a pruned job (404) stops polling instead of retrying forever', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse({ error: 'No such job.' }, 404));
        const { observeJob } = await import('../public/scripts/jobs.js');
        const onStop = jest.fn();
        observeJob('gone', { intervalMs: 1, onSnapshot: () => {}, onStop });
        await wait(40);
        expect(onStop).toHaveBeenCalledTimes(1);
        expect(onStop).toHaveBeenCalledWith('missing');
        const reads = globalThis.fetch.mock.calls.length;
        await wait(60);
        expect(globalThis.fetch.mock.calls.length).toBe(reads);
    });

    test.each(['cookie', 'local'])('an account change (%s) stops observation without late callbacks', async change => {
        let release;
        globalThis.fetch = jest.fn(() => new Promise(resolve => { release = resolve; }));
        const { observeJob } = await import('../public/scripts/jobs.js');
        const onSnapshot = jest.fn();
        const onDone = jest.fn();
        const onStop = jest.fn();
        observeJob('job-1', { intervalMs: 1, onSnapshot, onDone, onStop });
        expect(globalThis.fetch.mock.calls[0][1].headers['X-Neconyan-Account']).toBe('alice');
        if (change === 'local') account = 'bob';
        release(change === 'cookie' ? jsonResponse({ error: 'account_changed' }, 409) : jsonResponse({ job: { id: 'job-1', state: 'completed' } }));
        await wait(40);
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
        expect(onStop).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
});

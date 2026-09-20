/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

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
        globalThis.fetch = jest.fn(async () => {
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

    test('a completed job stops polling and does not read again', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse({ job: { id: 'job-1', state: 'completed' } }));
        const { observeJob } = await import('../public/scripts/jobs.js');
        observeJob('job-1', { intervalMs: 1, onSnapshot: () => {} });
        await wait(40);
        const reads = globalThis.fetch.mock.calls.length;
        await wait(40);
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

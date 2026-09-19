/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const CSRF_HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-value' };
let fetchCalls = [];

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
        jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: jest.fn(() => ({ ...CSRF_HEADERS })),
        }));
        globalThis.fetch = jest.fn(async (url, options = {}) => {
            fetchCalls.push({ url, options });
            return jsonResponse({ job: { id: 'job-1', state: 'queued' } }, 202);
        });
    });

    afterEach(() => {
        delete globalThis.fetch;
    });

    test('submitJob sends the CSRF token and a JSON content type', async () => {
        const { submitJob } = await import('../public/scripts/jobs.js');
        await submitJob({ type: 'roleplay', intent: { a: 1 }, submissionKey: 'k1' });
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe('/api/jobs/submit');
        expect(fetchCalls[0].options.headers).toMatchObject(CSRF_HEADERS);
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

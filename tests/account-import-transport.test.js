/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let owner, token, storage;
const refreshCsrfToken = jest.fn(async () => { token = 'fresh-token'; });
const resumeSettings = jest.fn();
const pauseSettingsForAccountImport = jest.fn(async () => resumeSettings);
jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentChatId: () => null,
    getRequestHeaders: () => ({ 'X-CSRF-Token': token }),
    pauseSettingsForAccountImport,
    saveChatConditional: jest.fn(), refreshCsrfToken,
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => owner }));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ observeJob: jest.fn() }));
const { importAccountData } = await import('../public/scripts/account-import.js');
const { getNativeOperationClient } = await import('../public/scripts/labs-client.js');
const originalFetch = globalThis.fetch;
const json = value => new Response(JSON.stringify(value));
const stale = () => new Response('ForbiddenError: Invalid CSRF token. Please refresh the page and try again.', { status: 403 });

beforeEach(() => {
    owner = 'alice'; token = 'old-token'; storage = new Map();
    refreshCsrfToken.mockClear(); resumeSettings.mockClear(); pauseSettingsForAccountImport.mockClear();
    refreshCsrfToken.mockImplementation(async () => { token = 'fresh-token'; });
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
    globalThis.fetch = jest.fn(async (url, options) => {
        if (url.includes('/import-input/')) return new Response('{}', { status: 404 });
        if (url.endsWith('/import-input')) return json({ inputId: 'a'.repeat(64) });
        return json({ record: { key: JSON.parse(options.body).key, state: 'completed' } });
    });
});
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.localStorage; });

test.each(['/import-input', '/submit'])('ZIP import refreshes stale CSRF once at %s without changing its request', async endpoint => {
    const send = fetch.getMockImplementation();
    let rejected = false;
    fetch.mockImplementation(async (url, options) => {
        if (url.endsWith(endpoint) && !rejected) { rejected = true; return stale(); }
        return send(url, options);
    });
    await importAccountData({ mode: 'zip' }, { file: new File(['zip bytes'], 'account.zip') });
    const attempts = fetch.mock.calls.filter(([url]) => url.endsWith(endpoint));
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1].body).toBe(attempts[1][1].body);
    expect(attempts.map(([, options]) => options.headers['X-CSRF-Token'])).toEqual(['old-token', 'fresh-token']);
    expect(refreshCsrfToken).toHaveBeenCalledTimes(1);
    expect(storage.size).toBe(0);
});

test('ZIP upload passes the server conflict code to replacement recovery', async () => {
    const send = fetch.getMockImplementation();
    let rejected = false;
    fetch.mockImplementation(async (url, options) => {
        if (url.endsWith('/import-input') && !rejected) {
            rejected = true;
            return new Response(JSON.stringify({ error: 'different upload', code: 'IMPORT_UPLOAD_CONFLICT' }), { status: 409 });
        }
        return send(url, options);
    });
    await importAccountData({ mode: 'zip' }, { file: new File(['replacement'], 'account.zip') });
    const attempts = fetch.mock.calls.filter(([url]) => url.endsWith('/import-input'));
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1].body.get('key')).not.toBe(attempts[1][1].body.get('key'));
    expect(refreshCsrfToken).not.toHaveBeenCalled();
});

test.each([false, true])('an account change during CSRF refresh blocks the retry (upload: %s)', async upload => {
    fetch.mockImplementation(async url => url.includes('/import-input/') ? new Response('{}', { status: 404 }) : stale());
    refreshCsrfToken.mockImplementation(async () => { owner = 'bob'; token = 'new-owner-token'; });
    const action = upload ? importAccountData({ mode: 'zip' }, { file: new File(['zip'], 'account.zip') })
        : (await getNativeOperationClient()).request('/api/labs/submit', { method: 'POST', body: '{}' });
    await expect(action).rejects.toThrow('account_changed');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

const nativeArchive = { name: 'account.zip', size: 13, lastModified: 1, nativeToken: '0123abcd-0000-4000-8000-0123456789ab' };
const handedOver = () => fetch.mock.calls.filter(([url]) => url.endsWith('/import-input-local'));

test('an iPhone-picked ZIP is handed over with the planned submission after settings pause', async () => {
    const send = fetch.getMockImplementation();
    let pausedBeforeHandOver;
    fetch.mockImplementation(async (url, options) => {
        if (url.endsWith('/import-input-local')) {
            pausedBeforeHandOver = pauseSettingsForAccountImport.mock.calls.length;
            return json({ inputId: 'b'.repeat(64), size: 13 });
        }
        return send(url, options);
    });
    await importAccountData({ mode: 'zip' }, { file: nativeArchive });
    expect(pausedBeforeHandOver).toBe(1);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/import-input'))).toBe(false);
    const [[, request]] = handedOver();
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ token: nativeArchive.nativeToken, submission: { kind: 'account-import', input: { mode: 'zip' } } });
    expect(request.headers['X-Neconyan-Account']).toBe('alice');
    const submitted = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/submit'))[1].body);
    expect(submitted).toMatchObject({ kind: 'account-import', key: body.submission.key, inputId: 'b'.repeat(64) });
    expect(pauseSettingsForAccountImport).toHaveBeenCalledTimes(1);
    expect(resumeSettings).not.toHaveBeenCalled();
});

test('a dropped hand-over asks again instead of failing the import', async () => {
    const send = fetch.getMockImplementation();
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => { callback(); return 0; };
    let dropped = false;
    fetch.mockImplementation(async (url, options) => {
        if (url.endsWith('/import-input-local')) {
            if (!dropped) { dropped = true; throw new TypeError('Load failed'); }
            return json({ inputId: 'c'.repeat(64), size: 13 });
        }
        return send(url, options);
    });
    try {
        await importAccountData({ mode: 'zip' }, { file: nativeArchive });
    } finally {
        globalThis.setTimeout = originalTimeout;
    }
    const attempts = handedOver();
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1].body).toBe(attempts[1][1].body);
});

test('a refused hand-over resumes settings saves', async () => {
    fetch.mockImplementation(async url => url.includes('/import-input/') ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ error: 'missing ZIP' }), { status: 400 }));
    await expect(importAccountData({ mode: 'zip' }, { file: nativeArchive })).rejects.toThrow('missing ZIP');
    expect(resumeSettings).toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/submit'))).toBe(false);
});

test.each([false, true])('native operations do not retry ordinary forbidden responses or loop on stale CSRF (stale: %s)', async invalidCsrf => {
    fetch.mockImplementation(async () => invalidCsrf ? stale() : new Response('{"error":"Access denied"}', { status: 403 }));
    const client = await getNativeOperationClient();
    await expect(client.request('/api/operations/submit', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(invalidCsrf ? 2 : 1);
    expect(refreshCsrfToken).toHaveBeenCalledTimes(invalidCsrf ? 1 : 0);
});

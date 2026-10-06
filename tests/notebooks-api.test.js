/* global globalThis */
import { beforeEach, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();
globalThis.fetch = fetchMock;
jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }) }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'owner' }));
const { notesRequest } = await import('../public/scripts/notebooks/api.js');

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

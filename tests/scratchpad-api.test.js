/* global globalThis */
import { beforeEach, expect, jest, test } from '@jest/globals';

let account = 'owner';
let sequence = 0;
const fetchMock = jest.fn();
globalThis.fetch = fetchMock;
jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
const { sendReply } = await import('../public/scripts/scratchpad/api.js');

function request() {
    return { submissionKey: `first-${++sequence}`, source: { kind: 'roleplay', key: `source-${sequence}` }, sessionId: 'session', text: 'A question.', context: 'Original context.' };
}

function receipt(body) {
    return { job: { id: 'saved-job' }, bucket: { source: body.source } };
}

beforeEach(() => {
    account = 'owner';
    fetchMock.mockReset();
});

test.each(['network', 'server', 'unreadable'])('a lost %s acceptance retries the original request rather than paying for another reply', async failure => {
    const body = request();
    fetchMock.mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('Connection lost after acceptance');
        return new Response(failure === 'server' ? '{}' : 'unreadable', { status: failure === 'server' ? 502 : 200 });
    });
    await expect(sendReply(body)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(Response.json(receipt(body)));
    await expect(sendReply({ ...body, submissionKey: 'new-key', context: 'Changed since the lost response.' })).resolves.toEqual(receipt(body));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(body);
});

test('a definite refusal allows corrected settings and a new submission', async () => {
    const body = request();
    fetchMock.mockResolvedValueOnce(Response.json({ message: 'Choose a profile.' }, { status: 400 }));
    await expect(sendReply(body)).rejects.toThrow('Choose a profile');
    const corrected = { ...body, submissionKey: 'corrected', chatProfileId: 'chosen' };
    fetchMock.mockResolvedValueOnce(Response.json(receipt(body)));
    await sendReply(corrected);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(corrected);
});

test('an unresolved request is not reused for a different account', async () => {
    const body = request();
    fetchMock.mockRejectedValueOnce(new Error('Offline'));
    await expect(sendReply(body)).rejects.toThrow();
    account = 'other';
    const other = { ...body, submissionKey: 'other-account' };
    fetchMock.mockResolvedValueOnce(Response.json(receipt(body)));
    await sendReply(other);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(other);
    expect(fetchMock.mock.calls[1][1].headers['X-Neconyan-Account']).toBe('other');
});

import { jest } from '@jest/globals';
import { createAccountResetClient } from '../public/scripts/account-reset-client.js';

function fixture() {
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const completed = { key: 'one', kind: 'account-reset', state: 'completed', result: { reset: true } };
    const client = { request: jest.fn(async () => ({ record: completed })), read: jest.fn(async () => completed), observe: jest.fn(async value => value) };
    return { values, client, completed, reset: createAccountResetClient({ client, owner: 'alice', storage, uuid: () => 'one' }) };
}

test('lost reset acknowledgement retains only the key and reads completion without submitting again', async () => {
    const f = fixture();
    f.client.request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(f.reset({ password: 'private password', code: '4321' })).rejects.toThrow('connection lost');
    expect([...f.values.values()]).toEqual(['one']);
    await expect(f.reset({ password: 'different', code: '9999' })).resolves.toEqual(f.completed);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect(f.values.size).toBe(0);
});

test('a request that was never accepted reuses its retained key after confirmation is entered again', async () => {
    const f = fixture();
    f.client.request.mockRejectedValueOnce(Object.assign(new Error('incorrect code'), { status: 400 }));
    await expect(f.reset({ password: '', code: 'bad' })).rejects.toThrow('incorrect code');
    f.client.read.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
    await f.reset({ password: '', code: 'correct' });
    expect(f.client.request.mock.calls.map(([, options]) => JSON.parse(options.body).key)).toEqual(['one', 'one']);
    expect(f.values.size).toBe(0);
});

test('closing observation retains the accepted reset key rather than sending another reset', async () => {
    const f = fixture();
    f.client.observe.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError', cancelled: false }));
    await expect(f.reset({ password: '', code: '4321' })).rejects.toThrow('closed');
    await f.reset({ password: '', code: '' });
    expect(f.client.request).toHaveBeenCalledTimes(1);
});

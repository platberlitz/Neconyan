import { jest } from '@jest/globals';
import { createAccountImportClient } from '../public/scripts/account-import-client.js';

function fixture() {
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const record = { key: 'import', kind: 'account-import', state: 'completed' };
    const client = { request: jest.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }); }),
        run: jest.fn(async (_kind, input, options) => { await options.prepareInput(input); return record; }) };
    const upload = jest.fn(async () => ({ inputId: 'a'.repeat(64) }));
    return { values, client, upload, record, file: { name: 'account.zip', size: 500, lastModified: 42 },
        run: createAccountImportClient({ client, owner: 'alice', storage, upload, uuid: () => 'upload-key' }) };
}

test('a lost upload acknowledgement reads its retained source without sending the ZIP again', async () => {
    const f = fixture(); f.upload.mockRejectedValueOnce(new Error('connection lost'));
    await expect(f.run({ mode: 'zip' }, { file: f.file })).rejects.toThrow('connection lost');
    expect([...f.values.values()]).toEqual([JSON.stringify({ key: 'upload-key', file: f.file })]);
    f.client.request.mockResolvedValueOnce({ inputId: 'a'.repeat(64) });
    await expect(f.run({ mode: 'zip' }, { file: f.file })).resolves.toEqual(f.record);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.client.request.mock.calls.map(([url]) => url)).toEqual(['/api/operations/import-input/upload-key', '/api/operations/import-input/upload-key']);
    expect(f.values.size).toBe(0);
});

test('a lost operation acknowledgement retains the uploaded source and refuses a different ZIP', async () => {
    const f = fixture();
    f.client.run.mockImplementationOnce(async (_kind, input, options) => { await options.prepareInput(input); throw new Error('acceptance lost'); });
    await expect(f.run({ mode: 'zip' }, { file: f.file })).rejects.toThrow('acceptance lost');
    await expect(f.run({ mode: 'zip' }, { file: { ...f.file, name: 'different.zip' } })).rejects.toThrow('different ZIP');
    await f.run({ mode: 'zip' }, { file: f.file });
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.values.size).toBe(0);
});

test('resuming an acknowledged import does not need the original file or rerun preparation', async () => {
    const f = fixture(); const prepareInput = jest.fn();
    f.client.run.mockResolvedValueOnce(f.record);
    await f.run({ mode: 'zip' }, { prepareInput });
    expect(prepareInput).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.client.request).not.toHaveBeenCalled();
});

test('an unreadable upload response keeps its original key and never starts publication', async () => {
    const f = fixture(); f.upload.mockResolvedValueOnce({ inputId: 'invalid' });
    await expect(f.run({ mode: 'zip' }, { file: f.file })).rejects.toThrow('unreadable');
    expect(JSON.parse([...f.values.values()][0]).key).toBe('upload-key');
    f.client.request.mockResolvedValueOnce({ inputId: 'b'.repeat(64) });
    await f.run({ mode: 'zip' }, { file: f.file });
    expect(f.upload).toHaveBeenCalledTimes(1);
});

test('the ZIP is retained before the final settings flush pauses background writes', async () => {
    const f = fixture(); const order = [];
    f.upload.mockImplementationOnce(async () => { order.push('upload'); return { inputId: 'a'.repeat(64) }; });
    const prepareInput = jest.fn(async input => { order.push('prepare'); return input; });
    await f.run({ mode: 'zip' }, { file: f.file, prepareInput });
    expect(order).toEqual(['upload', 'prepare']);
    expect(prepareInput).toHaveBeenCalledWith({ mode: 'zip', inputId: 'a'.repeat(64) });
});

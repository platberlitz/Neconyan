import { jest } from '@jest/globals';
import { accountImportScope, createAccountImportClient } from '../public/scripts/account-import-client.js';
import { createLabClient } from '../public/scripts/labs-client.js';

function fixture() {
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const record = { key: 'import', kind: 'account-import', state: 'completed' };
    const client = { request: jest.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }); }),
        run: jest.fn(async (_kind, input, options) => { await options.prepareInput(input); return record; }) };
    const upload = jest.fn(async () => ({ inputId: 'a'.repeat(64) }));
    const uuid = jest.fn(() => 'upload-key');
    return { values, storage, client, upload, uuid, record, file: { name: 'account.zip', size: 500, lastModified: 42 },
        run: createAccountImportClient({ client, owner: 'alice', storage, upload, uuid }) };
}

test('a lost upload acknowledgement reads its retained source without sending the ZIP again', async () => {
    const f = fixture(); f.upload.mockRejectedValueOnce(new Error('connection lost'));
    await expect(f.run({ mode: 'zip' }, { file: f.file })).rejects.toThrow('connection lost');
    expect([...f.values.values()]).toEqual([JSON.stringify({ key: 'upload-key', file: f.file })]);
    f.client.request.mockResolvedValueOnce({ inputId: 'a'.repeat(64) });
    await expect(f.run({ mode: 'zip' })).resolves.toEqual(f.record);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.client.request.mock.calls.map(([url]) => url)).toEqual(['/api/operations/import-input/upload-key', '/api/operations/import-input/upload-key']);
    expect(f.values.size).toBe(0);
});

test('a lost operation acknowledgement retries its original intent without uploading a selected replacement', async () => {
    const f = fixture();
    const request = jest.fn(async url => {
        if (url.endsWith('/submit')) return { record: f.record };
        throw Object.assign(new Error('not found'), { status: 404 });
    });
    const client = createLabClient({ request, observeJob: jest.fn(), account: 'alice', storage: f.storage,
        uuid: () => 'operation-key', basePath: '/api/operations' });
    const run = createAccountImportClient({ client, owner: 'alice', storage: f.storage, upload: f.upload, uuid: f.uuid });
    request.mockImplementationOnce(async () => { throw Object.assign(new Error('not found'), { status: 404 }); })
        .mockRejectedValueOnce(new Error('acceptance lost'));
    await expect(run({ mode: 'zip' }, { file: f.file })).rejects.toThrow('acceptance lost');
    await expect(run({ mode: 'zip' }, { file: { ...f.file, name: 'different.zip' } })).resolves.toEqual(f.record);
    const submissions = request.mock.calls.filter(([url]) => url.endsWith('/submit'));
    expect(submissions).toHaveLength(2);
    expect(submissions[0][1].body).toBe(submissions[1][1].body);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.values.size).toBe(0);
});

test.each([false, true])('a confirmed byte conflict starts a separate upload even with identical picker metadata (receipt: %s)', async retained => {
    const f = fixture();
    f.values.set('neconyan-account-import-upload:alice', JSON.stringify({ key: 'earlier-key', file: f.file }));
    if (retained) f.client.request.mockResolvedValue({ inputId: 'b'.repeat(64) });
    f.upload.mockRejectedValueOnce(Object.assign(new Error('different upload'), { status: 409, code: 'IMPORT_UPLOAD_CONFLICT' }));
    f.uuid.mockReturnValue('replacement-key');
    f.upload.mockImplementationOnce(async key => {
        expect(JSON.parse(f.values.get('neconyan-account-import-upload:alice'))).toEqual({ key, file: f.file });
        return { inputId: 'a'.repeat(64) };
    });
    const prepareInput = jest.fn(value => value);
    await expect(f.run({ mode: 'zip' }, { file: f.file, prepareInput })).resolves.toEqual(f.record);
    expect(f.upload.mock.calls).toEqual([['earlier-key', f.file], ['replacement-key', f.file]]);
    expect(prepareInput).toHaveBeenCalledWith({ mode: 'zip', inputId: 'a'.repeat(64) });
    expect(f.values.size).toBe(0);
});

test('a replacement upload with a lost acknowledgement keeps its new key for readback', async () => {
    const f = fixture();
    f.values.set('neconyan-account-import-upload:alice', JSON.stringify({ key: 'earlier-key', file: f.file }));
    f.upload.mockRejectedValueOnce(Object.assign(new Error('different upload'), { code: 'IMPORT_UPLOAD_CONFLICT' }))
        .mockRejectedValueOnce(new Error('offline'));
    await expect(f.run({ mode: 'zip' }, { file: f.file })).rejects.toThrow('offline');
    expect(JSON.parse(f.values.get('neconyan-account-import-upload:alice')).key).toBe('upload-key');
    f.client.request.mockResolvedValue({ inputId: 'a'.repeat(64) });
    await expect(f.run({ mode: 'zip' })).resolves.toEqual(f.record);
    expect(f.upload).toHaveBeenCalledTimes(2);
    expect(f.uuid).toHaveBeenCalledTimes(1);
});

test('a fresh installation accepts a ZIP despite an old browser upload receipt', async () => {
    const f = fixture();
    f.values.set('neconyan-account-import-upload:alice', JSON.stringify({ key: 'old-upload',
        file: { name: 'previous.zip', size: 100, lastModified: 1 }, inputId: 'b'.repeat(64) }));
    const prepareInput = jest.fn(value => value);
    await expect(f.run({ mode: 'zip' }, { file: f.file, prepareInput })).resolves.toEqual(f.record);
    expect(f.client.request).toHaveBeenCalledWith('/api/operations/import-input/old-upload');
    expect(f.upload).toHaveBeenCalledWith('old-upload', f.file);
    expect(prepareInput).toHaveBeenCalledWith({ mode: 'zip', inputId: 'a'.repeat(64) });
});

test('a changed Android file timestamp verifies the ZIP with the original upload key', async () => {
    const f = fixture();
    f.values.set('neconyan-account-import-upload:alice', JSON.stringify({ key: 'old-upload', file: f.file, inputId: 'a'.repeat(64) }));
    f.client.request.mockResolvedValue({ inputId: 'a'.repeat(64) });
    const selected = { ...f.file, lastModified: 999 };
    await expect(f.run({ mode: 'zip' }, { file: selected })).resolves.toEqual(f.record);
    expect(f.upload).toHaveBeenCalledWith('old-upload', selected);
});

test('a stale cached receipt for the same file is checked against the current installation', async () => {
    const f = fixture();
    f.values.set('neconyan-account-import-upload:alice', JSON.stringify({ key: 'old-upload', file: f.file, inputId: 'b'.repeat(64) }));
    const prepareInput = jest.fn(value => value);
    await f.run({ mode: 'zip' }, { file: f.file, prepareInput });
    expect(f.upload).toHaveBeenCalledWith('old-upload', f.file);
    expect(prepareInput).toHaveBeenCalledWith({ mode: 'zip', inputId: 'a'.repeat(64) });
});

test('an unavailable receipt check preserves the request without uploading or publishing', async () => {
    const f = fixture();
    const pending = JSON.stringify({ key: 'old-upload', file: f.file, inputId: 'b'.repeat(64) });
    f.values.set('neconyan-account-import-upload:alice', pending);
    f.client.request.mockRejectedValue(new Error('offline'));
    const prepareInput = jest.fn();
    await expect(f.run({ mode: 'zip' }, { file: { ...f.file, lastModified: 999 }, prepareInput })).rejects.toThrow('offline');
    expect(f.values.get('neconyan-account-import-upload:alice')).toBe(pending);
    expect(f.upload).not.toHaveBeenCalled();
    expect(prepareInput).not.toHaveBeenCalled();
});

test('an incomplete upload keeps its original key and file when the server refuses different bytes', async () => {
    const f = fixture();
    const pending = JSON.stringify({ key: 'partial-upload', file: f.file });
    f.values.set('neconyan-account-import-upload:alice', pending);
    f.upload.mockRejectedValue(new Error('This import key already belongs to a different upload. The earlier upload was kept.'));
    const selected = { ...f.file, lastModified: 999 };
    const prepareInput = jest.fn();
    await expect(f.run({ mode: 'zip' }, { file: selected, prepareInput })).rejects.toThrow('different upload');
    expect(f.upload).toHaveBeenCalledWith('partial-upload', selected);
    expect(f.values.get('neconyan-account-import-upload:alice')).toBe(pending);
    expect(prepareInput).not.toHaveBeenCalled();
});

test('a missing source requires the original file even when the browser has a cached receipt', async () => {
    const f = fixture();
    const pending = JSON.stringify({ key: 'old-upload', file: f.file, inputId: 'b'.repeat(64) });
    f.values.set('neconyan-account-import-upload:alice', pending);
    await expect(f.run({ mode: 'zip' })).rejects.toThrow('Select the original ZIP');
    expect(f.values.get('neconyan-account-import-upload:alice')).toBe(pending);
    expect(f.upload).not.toHaveBeenCalled();
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
    await f.run({ mode: 'zip' });
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

test('core ZIP preparation retains its content policy and cannot resume a legacy full import', async () => {
    const f = fixture(); const prepareInput = jest.fn(value => value);
    await f.run({ mode: 'zip', content: 'core' }, { file: f.file, prepareInput });
    expect(prepareInput).toHaveBeenCalledWith({ mode: 'zip', content: 'core', inputId: 'a'.repeat(64) });
    expect(f.client.run.mock.calls[0][2].scope).toBe('account-import:zip:core:chats+personas+characters+lorebooks');
    expect(accountImportScope({ mode: 'zip' })).toBe('account-import:zip');
    expect(accountImportScope({ mode: 'folder', content: 'core' })).toBe('account-import:folder:core:chats+personas+characters+lorebooks');
    expect(accountImportScope({ mode: 'extensions', content: 'core' })).toBe('account-import:extensions');
});

test('library choices reach ZIP preparation and resume only imports with the same choices', async () => {
    const f = fixture(); const prepareInput = jest.fn(value => value);
    await f.run({ mode: 'zip', content: 'core', parts: ['personas'] }, { file: f.file, prepareInput });
    expect(prepareInput).toHaveBeenCalledWith({ mode: 'zip', content: 'core', parts: ['personas'], inputId: 'a'.repeat(64) });
    expect(f.client.run.mock.calls[0][2].scope).toBe('account-import:zip:core:personas');
    expect(accountImportScope({ mode: 'zip', content: 'core', parts: ['characters', 'chats'] })).toBe('account-import:zip:core:chats+characters');
    expect(accountImportScope({ mode: 'zip', content: 'core', parts: ['characters', 'personas', 'chats'] })).toBe('account-import:zip:core');
    expect(accountImportScope({ mode: 'zip', content: 'core', parts: ['lorebooks'] })).toBe('account-import:zip:core:lorebooks');
    expect(accountImportScope({ mode: 'zip', content: 'core', parts: ['lorebooks', 'characters', 'personas', 'chats'] })).toBe(accountImportScope({ mode: 'zip', content: 'core' }));
    expect(accountImportScope({ mode: 'zip', content: 'core' })).not.toBe(accountImportScope({ mode: 'zip', content: 'core', parts: ['characters', 'personas', 'chats'] }));
    expect(accountImportScope({ mode: 'zip', content: 'core', parts: ['personas'] })).not.toBe(accountImportScope({ mode: 'zip', content: 'core', parts: ['chats'] }));
});

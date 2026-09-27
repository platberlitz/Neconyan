import { expect, jest, test } from '@jest/globals';
import { createLabClient } from '../public/scripts/labs-client.js';

function fixture() {
    const entries = new Map();
    let observer;
    const accepted = { key: 'one', kind: 'distill', state: 'accepted', jobId: 'job' };
    const completed = { ...accepted, state: 'completed', resultHash: 'hash', result: { proposals: ['saved'] } };
    const request = jest.fn(async url => url.endsWith('/submit') ? { record: accepted } : completed);
    const observeJob = jest.fn((_id, options) => {
        observer = options;
        options.signal?.addEventListener('abort', () => options.onStop('aborted'), { once: true });
    });
    const client = createLabClient({ request, observeJob, account: 'alice', uuid: () => 'one', storage: {
        getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key),
    } });
    return { client, request, observeJob, entries, accepted, completed, get observer() { return observer; } };
}
const observe = async f => { for (let index = 0; index < 12 && !f.observer; index++) await Promise.resolve(); };

test('listing all saved work does not send an undefined kind filter', async () => {
    const f = fixture();
    const records = [{ kind: 'distill', key: 'one' }, { kind: 'lorestitch', key: 'two' }];
    f.request.mockImplementation(async url => {
        const kind = new URL(url, 'http://fixture').searchParams.get('kind');
        return records.filter(record => !kind || record.kind === kind);
    });
    await expect(f.client.list()).resolves.toEqual(records);
    await expect(f.client.list('distill')).resolves.toEqual([records[0]]);
});

test('lost acceptance reuses the exact body and does not recapture changed controls', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error('offline'));
    await expect(f.client.run('distill', { book: 'Original' })).rejects.toThrow('offline');
    const prepareInput = jest.fn();
    const done = f.client.run('distill', { book: 'Changed' }, { prepareInput });
    await observe(f);
    expect(f.request.mock.calls[0][1].body).toBe(f.request.mock.calls[1][1].body);
    expect(prepareInput).not.toHaveBeenCalled();
    await f.observer.onSnapshot({ state: 'completed' });
    f.observer.onDone({ state: 'completed' });
    await expect(done).resolves.toEqual(f.completed);
    expect(f.entries.size).toBe(0);
});

test('closing observation retains accepted work for server readback after job pruning', async () => {
    const f = fixture();
    const controller = new AbortController();
    const done = f.client.run('distill', {}, { signal: controller.signal }).catch(error => error);
    await observe(f);
    controller.abort();
    expect(await done).toMatchObject({ name: 'AbortError' });
    expect(f.entries.size).toBe(1);
    await expect(f.client.run('distill', {})).resolves.toEqual(f.completed);
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
});

test('a lost terminal readback retries that read without resubmitting', async () => {
    const f = fixture();
    const done = f.client.run('distill', {});
    await observe(f);
    f.request.mockRejectedValueOnce(new Error('result offline'));
    await expect(f.observer.onSnapshot({ state: 'completed' })).rejects.toThrow('result offline');
    expect(f.entries.size).toBe(1);
    await f.observer.onSnapshot({ state: 'completed' });
    f.observer.onDone({ state: 'completed' });
    await expect(done).resolves.toEqual(f.completed);
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
});

test('unknown paid outcomes remain attached to the retained operation', async () => {
    const f = fixture();
    const done = f.client.run('distill', {}).catch(error => error);
    await observe(f);
    f.observer.onDone({ state: 'interrupted', error: { message: 'The provider result is unknown.' } });
    expect(await done).toMatchObject({ message: 'The provider result is unknown.' });
    expect(f.entries.size).toBe(1);
    expect(f.request).toHaveBeenCalledTimes(1);
});

test('Stop waits for saved cancellation before releasing the retained operation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const done = f.client.run('distill', {}, { signal: controller.signal }).catch(error => error);
    await observe(f);
    let confirm;
    f.request.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    controller.abort('user-stop');
    await Promise.resolve();
    expect(f.request.mock.calls.at(-1)[0]).toBe('/api/jobs/job/cancel');
    expect(f.entries.size).toBe(1);
    confirm({});
    expect(await done).toMatchObject({ name: 'AbortError', cancelled: true });
    expect(f.entries.size).toBe(0);
});

test('failed cancellation keeps the accepted request and reports that it may still run', async () => {
    const f = fixture();
    const controller = new AbortController();
    const done = f.client.run('distill', {}, { signal: controller.signal }).catch(error => error);
    await observe(f);
    f.request.mockRejectedValueOnce(new Error('offline'));
    controller.abort('user-stop');
    expect(await done).toMatchObject({ code: 'LABS_STOP_FAILED' });
    expect(f.entries.size).toBe(1);
});

test('Stop returns an already completed saved result instead of claiming it was cancelled', async () => {
    const f = fixture(), controller = new AbortController();
    const done = f.client.run('distill', {}, { signal: controller.signal });
    await observe(f);
    f.request.mockResolvedValueOnce({ job: { state: 'completed' } });
    controller.abort('user-stop');
    await expect(done).resolves.toEqual(f.completed);
    expect(f.entries.size).toBe(0);
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
});

test('Stop during a lost-latency acceptance cancels the acknowledged job', async () => {
    const f = fixture();
    const controller = new AbortController();
    let accept;
    f.request.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    const done = f.client.run('distill', {}, { signal: controller.signal }).catch(error => error);
    for (let index = 0; index < 12 && !accept; index++) await Promise.resolve();
    controller.abort('user-stop');
    accept({ record: f.accepted });
    expect(await done).toMatchObject({ cancelled: true });
    expect(f.observeJob).not.toHaveBeenCalled();
    expect(f.request.mock.calls.at(-1)[0]).toBe('/api/jobs/job/cancel');
});

test('an HTTP refusal without permanent non-acceptance evidence retains the exact request', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    await expect(f.client.run('distill', { book: 'Original' })).rejects.toThrow('conflict');
    expect(f.entries.size).toBe(1);
    const done = f.client.run('distill', { book: 'Changed' });
    await observe(f);
    expect(f.request.mock.calls[0][1].body).toBe(f.request.mock.calls[1][1].body);
    await f.observer.onSnapshot({ state: 'completed' });
    f.observer.onDone({ state: 'completed' });
    await expect(done).resolves.toEqual(f.completed);
});

test('a permanent refusal releases the old operation without automatically starting another', async () => {
    const f = fixture();
    const done = f.client.run('distill', {}).catch(error => error);
    await observe(f);
    f.request.mockResolvedValueOnce({ ...f.accepted, state: 'refused', error: 'The book changed.' });
    await f.observer.onSnapshot({ state: 'failed' });
    f.observer.onDone({ state: 'failed' });
    expect(await done).toMatchObject({ refused: true, message: 'The book changed.' });
    expect(f.entries.size).toBe(0);
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
});

test('a durably rejected submission can be released before job acceptance', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(Object.assign(new Error('missing book'), { notAccepted: true }));
    await expect(f.client.run('distill', {})).rejects.toThrow('missing book');
    expect(f.entries.size).toBe(0);
    expect(f.request).toHaveBeenCalledTimes(1);
});

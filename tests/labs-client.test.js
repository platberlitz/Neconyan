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
const observe = async f => { for (let index = 0; index < 40 && !f.observer; index++) await Promise.resolve(); };

test('progress includes the saved job stage alongside its file counts', async () => {
    const f = fixture(), onProgress = jest.fn();
    const done = f.client.run('account-import', {}, { onProgress });
    await observe(f);
    const job = { state: 'running', stage: 'Saving imported files', progress: { completed: 7, total: 20 } };
    await f.observer.onSnapshot(job);
    expect(onProgress).toHaveBeenCalledWith({ stage: job.stage, completed: 7, total: 20 }, job);
    await f.observer.onSnapshot({ state: 'completed' });
    f.observer.onDone({ state: 'completed' });
    await done;
});

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
    f.observer.onDone({ state: 'interrupted', error: { message: 'The result from the AI service is unknown after a restart.' } });
    expect(await done).toMatchObject({ message: 'The result from the AI service is unknown after a restart.' });
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

test('pendingKey exposes only its account scope key and read forwards abort options', async () => {
    const f = fixture();
    f.entries.set('neconyan-labs:alice:distill', JSON.stringify({ key: 'retained-key', body: { kind: 'distill' } }));
    expect(f.client.pendingKey('distill')).toBe('retained-key');
    expect(f.client.pendingKey('other')).toBeNull();

    const signal = new AbortController().signal;
    await f.client.read('retained-key', { signal });
    expect(f.request).toHaveBeenCalledWith('/api/labs/records/retained-key', { signal });
});

function retainDistill(f, key = 'earlier', extra = {}) {
    f.entries.set('neconyan-labs:alice:distill', JSON.stringify({ key, ...extra }));
}
const previousDistill = (uncertain = false) => ({ key: 'earlier', kind: 'distill', state: 'accepted', jobId: 'old-job',
    error: 'Bad Request', lifecycle: { revision: 1, retired: true, uncertain, reason: 'failed' } });
async function complete(f) {
    await observe(f);
    await f.observer.onSnapshot({ state: 'completed' });
    f.observer.onDone({ state: 'completed' });
}

test('Distiller known failure starts one replacement with current selections while shared run semantics stay opt-in', async () => {
    const f = fixture();
    retainDistill(f);
    f.request.mockImplementation(async url => url.endsWith('/earlier') ? previousDistill() : url.endsWith('/replace') ? { record: f.accepted } : f.completed);
    const done = f.client.runDistill({ book: 'Current', profileId: 'changed', locator: { chat: 'current' } });
    await observe(f);
    const submissions = f.request.mock.calls.filter(([url]) => url.endsWith('/replace'));
    expect(submissions).toHaveLength(1);
    expect(JSON.parse(submissions[0][1].body)).toMatchObject({ book: 'Current', profileId: 'changed', locator: { chat: 'current' }, previousKey: 'earlier', previousRevision: 1, consent: false });
    await complete(f);
    await expect(done).resolves.toEqual(f.completed);
    expect(f.entries.size).toBe(0);
});

test('uncertain Distiller work warns without submitting; explicit retry is the single affirmative action', async () => {
    const f = fixture();
    retainDistill(f);
    f.request.mockImplementation(async url => url.endsWith('/earlier') ? previousDistill(true) : url.endsWith('/replace') ? { record: f.accepted } : f.completed);
    await expect(f.client.runDistill({ book: 'Current' })).rejects.toMatchObject({ code: 'DISTILL_UNCERTAIN', uncertain: true });
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/replace') || url.endsWith('/submit'))).toHaveLength(0);
    expect(f.client.hasPending('distill')).toBe(false);
    const done = f.client.runDistill({ book: 'Current' }, { retryUncertain: true });
    await observe(f);
    expect(JSON.parse(f.request.mock.calls.find(([url]) => url.endsWith('/replace'))[1].body)).toMatchObject({ book: 'Current', consent: true });
    await complete(f);
    await done;
});

test('lost Distiller replacement acknowledgement reuses the exact attempt body and double clicks share one submission', async () => {
    const f = fixture();
    retainDistill(f);
    let lost = true;
    f.request.mockImplementation(async url => {
        if (url.endsWith('/earlier')) return previousDistill(true);
        if (url.endsWith('/one')) {
            if (lost) throw Object.assign(new Error('not found'), { status: 404 });
            return f.completed;
        }
        if (url.endsWith('/replace')) {
            if (lost) { lost = false; throw new Error('lost acknowledgement'); }
            return { record: f.accepted };
        }
        return f.completed;
    });
    await expect(f.client.runDistill({ book: 'Original' }, { retryUncertain: true })).rejects.toThrow('lost acknowledgement');
    // A status read can also remain missing while an earlier POST is delayed.
    f.request.mockImplementationOnce(async () => { throw Object.assign(new Error('not found'), { status: 404 }); });
    const prepareInput = jest.fn();
    const first = f.client.runDistill({ book: 'Changed' }, { prepareInput });
    const second = f.client.runDistill({ book: 'Changed again' });
    expect(second).toBe(first);
    await observe(f);
    const attempts = f.request.mock.calls.filter(([url]) => url.endsWith('/replace'));
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1].body).toBe(attempts[1][1].body);
    expect(prepareInput).not.toHaveBeenCalled();
    await complete(f);
    await first;
});

test('temporary Distiller read error retains identity and is never reported as deletion', async () => {
    const f = fixture();
    retainDistill(f);
    f.request.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 }));
    await expect(f.client.runDistill({ book: 'Current' })).rejects.toMatchObject({ phase: 'observation', message: 'offline' });
    expect(f.client.pendingKey('distill')).toBe('earlier');
    expect(f.request).toHaveBeenCalledTimes(1);
});

test('legacy missing Distiller history stays uncertain and can be explicitly replaced', async () => {
    const f = fixture();
    retainDistill(f);
    f.request.mockImplementation(async url => {
        if (url.endsWith('/earlier')) throw Object.assign(new Error('missing'), { status: 404 });
        return url.endsWith('/replace') ? { record: f.accepted } : f.completed;
    });
    await expect(f.client.runDistill({ book: 'Current' })).rejects.toMatchObject({ code: 'DISTILL_UNCERTAIN' });
    const done = f.client.runDistill({ book: 'Current' }, { retryUncertain: true });
    await complete(f);
    await done;
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/replace'))).toHaveLength(1);
});

test('a stale Distiller completion cannot clear a newer tab retained key', async () => {
    const f = fixture();
    const done = f.client.runDistill({ book: 'Original' });
    await observe(f);
    retainDistill(f, 'newer-tab');
    await complete(f);
    await done;
    expect(f.client.pendingKey('distill')).toBe('newer-tab');
});

test('stale uncertain consent follows another tab winning replacement without replacing it again', async () => {
    const f = fixture();
    retainDistill(f);
    f.request.mockImplementation(async url => url.endsWith('/earlier')
        ? { ...previousDistill(true), lifecycle: { ...previousDistill(true).lifecycle, replacement: { key: 'one' } } }
        : f.completed);
    await expect(f.client.runDistill({ book: 'Current' }, { retryUncertain: true, expectedPreviousKey: 'earlier' })).resolves.toEqual(f.completed);
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/replace') || url.endsWith('/submit'))).toHaveLength(0);
});

test('a deferred previous read cannot clear another tab replacement installed before that read resolves', async () => {
    const f = fixture();
    retainDistill(f, 'old');
    let finishRead;
    f.request.mockImplementation(async url => {
        if (url.endsWith('/old')) return new Promise(resolve => { finishRead = resolve; });
        if (url.endsWith('/newer')) return { ...f.accepted, key: 'newer', jobId: 'new-job' };
        return f.completed;
    });
    const controller = new AbortController();
    const done = f.client.runDistill({}, { signal: controller.signal }).catch(error => error);
    for (let index = 0; index < 20 && !finishRead; index++) await Promise.resolve();
    retainDistill(f, 'newer');
    finishRead({ ...f.completed, key: 'old' });
    await observe(f);
    expect(f.client.pendingKey('distill')).toBe('newer');
    expect(f.observeJob).toHaveBeenCalledWith('new-job', expect.anything());
    controller.abort();
    expect(await done).toMatchObject({ name: 'AbortError' });
    expect(f.client.pendingKey('distill')).toBe('newer');
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/replace') || url.endsWith('/submit'))).toHaveLength(0);
});

test('a second tab follows a durable preparing replacement and resumes its captured input without recapture', async () => {
    const f = fixture();
    retainDistill(f);
    let admitted = false;
    f.request.mockImplementation(async url => {
        if (url.endsWith('/earlier')) return { ...previousDistill(true), lifecycle: { ...previousDistill(true).lifecycle, replacement: { key: 'one' } } };
        if (url.endsWith('/one/resume')) { admitted = true; return { record: f.accepted }; }
        if (!admitted) return { ...f.accepted, state: 'preparing', jobId: null };
        return f.completed;
    });
    expect((await f.client.distillStatus()).key).toBe('one');
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(0);
    const prepareInput = jest.fn();
    const done = f.client.runDistill({ book: 'Different controls' }, { prepareInput });
    await complete(f);
    await done;
    expect(prepareInput).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([url]) => url.endsWith('/one/resume'))).toHaveLength(1);
});

test('a definite refusal while resuming a preparing successor preserves the old fence and permits corrected current controls', async () => {
    const f = fixture();
    retainDistill(f);
    let rejected = false;
    f.request.mockImplementation(async url => {
        if (url.endsWith('/earlier')) return { ...previousDistill(), lifecycle: { ...previousDistill().lifecycle, replacement: { key: 'rejected' } } };
        if (url.endsWith('/rejected/resume')) {
            rejected = true;
            throw Object.assign(new Error('Job storage full'), { code: 'JOB_STORE_FULL', status: 413, notAccepted: true });
        }
        if (url.endsWith('/rejected')) return { key: 'rejected', kind: 'distill', state: rejected ? 'refused' : 'preparing', jobId: null };
        return url.endsWith('/replace') ? { record: f.accepted } : f.completed;
    });
    await f.client.distillStatus();
    await expect(f.client.runDistill({ book: 'Old controls' })).rejects.toMatchObject({ notAccepted: true });
    expect(f.client.pendingKey('distill')).toBe('earlier');
    const done = f.client.runDistill({ book: 'Corrected controls' });
    await complete(f);
    await done;
    expect(JSON.parse(f.request.mock.calls.find(([url]) => url.endsWith('/replace'))[1].body).book).toBe('Corrected controls');
});

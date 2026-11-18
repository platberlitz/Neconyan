import { describe, expect, jest, test } from '@jest/globals';
import { createMeowerJobClient } from '../public/scripts/extensions/third-party/Neconyan-Hopper/src/native-jobs.js';

function fixture() {
    const entries = new Map();
    let observer;
    const pendingStorage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
    const request = jest.fn(async route => route.endsWith('/submit') ? { job: { id: 'one', state: 'queued' } } : { posts: ['saved'] });
    const listJobs = jest.fn(async () => []);
    const cancelJob = jest.fn(async () => {});
    const observeJob = jest.fn((_id, options) => {
        observer = options;
        options.signal?.addEventListener('abort', () => options.onStop('aborted'), { once: true });
    });
    let key = 0;
    const run = createMeowerJobClient({ request, listJobs, observeJob, cancelJob, account: 'alice', uuid: () => `key-${++key}`, pendingStorage });
    return { run, request, listJobs, cancelJob, entries, get observer() { return observer; } };
}

const untilObserved = async f => { for (let i = 0; i < 10 && !f.observer; i++) await Promise.resolve(); };

describe('Meower native observation', () => {
    const failed = { id: 'one', type: 'meower.refresh', target: { id: 's' }, state: 'failed', recoverability: 'settled',
        resume: null, recoveryStep: null, recoverySteps: [], error: { message: 'Reduce the output budget.', status: 400, code: 'PROVIDER_REFUSED' } };

    async function failOnce(f, job = failed) {
        const first = f.run('refresh', { sessionId: 's', topic: 'old' });
        const rejected = first.catch(error => error);
        await untilObserved(f);
        await f.observer.onDone(job);
        f.listJobs.mockResolvedValue([job]);
        return rejected;
    }

    test('failed work retains its identity and useful recovery fields', async () => {
        const f = fixture();
        expect(await failOnce(f)).toMatchObject({ jobId: 'one', state: 'failed', recoverability: 'settled', status: 400, code: 'PROVIDER_REFUSED' });
        expect(JSON.parse([...f.entries.values()][0])).toEqual({ jobId: 'one' });
    });

    test('automatic catch-up reattaches a failed job while the next manual action replaces it', async () => {
        const f = fixture();
        await failOnce(f);
        const automatic = f.run('refresh', { sessionId: 's', topic: 'automatic' }).catch(error => error);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await f.observer.onDone(failed);
        await automatic;
        expect(f.request.mock.calls.filter(([route]) => route.endsWith('/submit'))).toHaveLength(1);
        const manual = f.run('refresh', { sessionId: 's', topic: 'new' }, { manual: true });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(JSON.parse(f.request.mock.calls.at(-1)[1].body)).toMatchObject({ submissionKey: 'key-2', previousJobId: 'one', topic: 'new' });
        await f.observer.onDone({ state: 'completed' });
        await manual;
    });

    test('lost manual replacement acceptance keeps its exact body and old identity for reconnect', async () => {
        const f = fixture();
        await failOnce(f);
        f.request.mockRejectedValueOnce(new Error('lost replacement reply'));
        await expect(f.run('refresh', { sessionId: 's', topic: 'new' }, { manual: true })).rejects.toThrow('lost replacement reply');
        const retained = JSON.parse([...f.entries.values()][0]);
        expect(retained).toMatchObject({ previousJobId: 'one', submissionKey: 'key-2', topic: 'new' });
        const reconnect = f.run('refresh', { sessionId: 's', topic: 'ignored' });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(f.request.mock.calls.at(-1)[1].body).toBe(f.request.mock.calls.at(-2)[1].body);
        await f.observer.onDone({ state: 'completed' });
        await reconnect;
    });

    test('replacement rejection restores the old binding and automatic reopen submits nothing', async () => {
        const f = fixture();
        await failOnce(f);
        f.request.mockRejectedValueOnce(Object.assign(new Error('Review this operation in Jobs.'), { status: 409 }));
        await expect(f.run('refresh', { sessionId: 's' }, { manual: true })).rejects.toThrow('Review this operation');
        expect(JSON.parse([...f.entries.values()][0])).toEqual({ jobId: 'one' });
        const reopened = f.run('refresh', { sessionId: 's' }).catch(error => error);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await f.observer.onDone(failed);
        await reopened;
        expect(f.request.mock.calls.filter(([route]) => route.endsWith('/submit'))).toHaveLength(2);
    });

    for (const state of ['interrupted', 'waiting', 'running']) test(`manual action retains ${state} work`, async () => {
        const f = fixture();
        const job = { ...failed, state, recoverability: 'unknown-outcome' };
        await failOnce(f, job);
        const again = f.run('refresh', { sessionId: 's' }, { manual: true }).catch(error => error);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await f.observer.onDone(job);
        await again;
        expect(f.request.mock.calls.filter(([route]) => route.endsWith('/submit'))).toHaveLength(1);
    });
    test('lost acceptance replies reuse the exact saved submission', async () => {
        const f = fixture();
        f.request.mockRejectedValueOnce(new Error('connection lost'));
        await expect(f.run('refresh', { sessionId: 's', topic: 'original' })).rejects.toThrow('connection lost');
        const done = f.run('refresh', { sessionId: 's', topic: 'changed' });
        await untilObserved(f);
        expect(f.request.mock.calls[1][1].body).toBe(f.request.mock.calls[0][1].body);
        await f.observer.onDone({ state: 'completed' });
        await expect(done).resolves.toEqual({ posts: ['saved'] });
        expect(f.entries.size).toBe(0);
    });

    for (const reason of [undefined, 'user-stop']) test(`only an explicit Stop cancels accepted work (${reason})`, async () => {
        const f = fixture();
        const controller = new AbortController();
        const done = f.run('refresh', { sessionId: 's' }, { signal: controller.signal });
        const rejected = done.catch(error => error);
        await untilObserved(f);
        controller.abort(reason);
        expect(await rejected).toBeDefined();
        expect(f.cancelJob).toHaveBeenCalledTimes(reason === 'user-stop' ? 1 : 0);
    });

    test('reopening an active job observes without submitting another', async () => {
        const f = fixture();
        f.listJobs.mockResolvedValue([{ id: 'one', type: 'meower.refresh', target: { id: 's' }, state: 'running' }]);
        const onSnapshot = jest.fn();
        const done = f.run('refresh', { sessionId: 's' }, { onSnapshot });
        await untilObserved(f);
        expect(f.request).not.toHaveBeenCalled();
        await f.observer.onSnapshot({ state: 'running' });
        expect(onSnapshot).toHaveBeenCalledTimes(1);
        await f.observer.onDone({ state: 'completed' });
        await expect(done).resolves.toEqual({ posts: ['saved'] });
    });

    test('a lost result is read again without submitting paid work', async () => {
        const f = fixture();
        const job = { id: 'one', type: 'meower.refresh', target: { id: 's' }, state: 'completed' };
        const first = f.run('refresh', { sessionId: 's' });
        const rejected = first.catch(error => error);
        await untilObserved(f);
        f.request.mockRejectedValueOnce(new Error('result lost'));
        await f.observer.onDone(job);
        expect(await rejected).toMatchObject({ message: 'result lost' });
        f.listJobs.mockResolvedValue([job]);
        const second = f.run('refresh', { sessionId: 's' });
        // Allow the second observation to replace the first callback.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        await f.observer.onDone(job);
        await expect(second).resolves.toEqual({ posts: ['saved'] });
        expect(f.request.mock.calls.filter(([route]) => route.endsWith('/submit'))).toHaveLength(1);
    });

    test('profile observations distinguish the chosen character', async () => {
        const f = fixture();
        f.listJobs.mockResolvedValue([{ id: 'other', type: 'meower.profile', target: { id: 's' }, state: 'running',
            intent: { plan: { input: { mode: 'character', accountKey: 'character:other.png' } } } }]);
        const done = f.run('profile', { sessionId: 's', mode: 'character', accountKey: 'character:nova.png' });
        await untilObserved(f);
        expect(f.request.mock.calls[0][0]).toBe('/api/meower/profile/submit');
        await f.observer.onDone({ state: 'completed' });
        await done;
    });

    test('a failed Stop remains recoverable and does not claim cancellation', async () => {
        const f = fixture();
        f.cancelJob.mockRejectedValue(new Error('offline'));
        const controller = new AbortController();
        const done = f.run('refresh', { sessionId: 's' }, { signal: controller.signal });
        const rejected = done.catch(error => error);
        await untilObserved(f);
        controller.abort('user-stop');
        expect(await rejected).toMatchObject({ code: 'MEOWER_STOP_FAILED' });
        expect(f.entries.size).toBe(1);
    });
});

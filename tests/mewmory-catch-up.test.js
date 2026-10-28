import { expect, jest, test } from '@jest/globals';
import { observeMewmoryCatchUp } from '../public/scripts/mewmory/catch-up.js';

const snapshot = { refs: ['chat:one@2'], policy: 'current', source: 'chat-a' };

test('ready snapshots do not start memory processing', async () => {
    const start = jest.fn();
    const result = await observeMewmoryCatchUp({ snapshot, deadline: 100, now: () => 0,
        check: async value => ({ ready: value.refs[0] === 'chat:one@2' }), start });
    expect(result.ready).toBe(true);
    expect(start).not.toHaveBeenCalled();
});

test('one checkpoint worker runs while the observer waits only for its captured refs', async () => {
    let clock = 0;
    let checks = 0;
    const events = [];
    const start = jest.fn(async () => { events.push('start'); });
    const onInitiated = jest.fn(async state => { events.push('persist'); expect(state.deadline).toBe(100); });
    const onProgress = jest.fn();
    const result = await observeMewmoryCatchUp({ snapshot, deadline: 100, now: () => clock,
        check: async value => {
            expect(value).toBe(snapshot);
            return { ready: ++checks === 3, pending: 1, processing: { status: 'running' } };
        }, start, onInitiated, onProgress, pollMs: 10, sleep: async ms => { clock += ms; } });
    expect(result.initiated).toBe(true);
    expect(events).toEqual(['persist', 'start']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(2);
});

test('a resumed attempt keeps its deadline and never starts another worker', async () => {
    let clock = 90;
    const start = jest.fn();
    await expect(observeMewmoryCatchUp({ snapshot, deadline: 100, initiated: true, now: () => clock,
        check: async () => ({ ready: false, processing: { status: 'running' } }), start,
        sleep: async ms => { clock += ms; } })).rejects.toMatchObject({ code: 'MEWMORY_WAIT_TIMEOUT' });
    expect(clock).toBe(100);
    expect(start).not.toHaveBeenCalled();
});

test('stale state, worker failure and cancellation never send the waiting reply', async () => {
    const start = jest.fn();
    const base = { snapshot, deadline: 100, initiated: true, now: () => 0, start };
    await expect(observeMewmoryCatchUp({ ...base, check: async () => ({ stale: true }) }))
        .rejects.toMatchObject({ code: 'MEWMORY_WAIT_STALE' });
    await expect(observeMewmoryCatchUp({ ...base, check: async () => ({ ready: false, processing: { status: 'failed', error: 'Connection failed' } }) }))
        .rejects.toMatchObject({ code: 'MEWMORY_WAIT_FAILED', message: 'Connection failed' });
    const controller = new AbortController();
    controller.abort();
    await expect(observeMewmoryCatchUp({ ...base, signal: controller.signal, check: async () => ({ ready: true }) }))
        .rejects.toMatchObject({ code: 'MEWMORY_WAIT_ABORTED' });
    expect(start).not.toHaveBeenCalled();
});

test('Stop interrupts a stalled status request without starting another worker', async () => {
    const controller = new AbortController();
    const start = jest.fn();
    let statusStarted;
    const entered = new Promise(resolve => { statusStarted = resolve; });
    const waiting = observeMewmoryCatchUp({ snapshot, deadline: Date.now() + 300_000, signal: controller.signal, start,
        check: async (_snapshot, { signal }) => {
            expect(signal).toBe(controller.signal);
            statusStarted();
            return new Promise(() => {});
        } });
    await entered;
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'MEWMORY_WAIT_ABORTED' });
    expect(start).not.toHaveBeenCalled();
});

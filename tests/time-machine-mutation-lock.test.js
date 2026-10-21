import { expect, test } from '@jest/globals';
import { withMutationLock } from '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/store.js';

test('withMutationLock serializes Time Machine work until the first action settles', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const order = [];
    const capture = withMutationLock(async () => {
        order.push('capture-start');
        await gate;
        order.push('capture-end');
    });
    const next = withMutationLock(async () => { order.push('next'); });

    await Promise.resolve();
    expect(order).toEqual(['capture-start']);
    release();
    await Promise.all([capture, next]);
    expect(order).toEqual(['capture-start', 'capture-end', 'next']);
});

test('withMutationLock lets queued work see the value the capture adopted', async () => {
    const module = { lastCommit: 'local-token' };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let seen;
    const capture = withMutationLock(async () => {
        await gate;
        module.lastCommit = 'server-job-1-123';
    });
    const snapshot = withMutationLock(async () => { seen = module.lastCommit; });
    release();
    await Promise.all([capture, snapshot]);
    expect(seen).toBe('server-job-1-123');
});

test('withMutationLock releases the queue after a rejected action', async () => {
    const order = [];
    await expect(withMutationLock(async () => {
        order.push('failed');
        throw new Error('snapshot failed');
    })).rejects.toThrow('snapshot failed');
    await withMutationLock(async () => { order.push('next'); });
    expect(order).toEqual(['failed', 'next']);
});

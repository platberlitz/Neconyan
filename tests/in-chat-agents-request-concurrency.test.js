import { describe, expect, test } from '@jest/globals';
import { mapWithConcurrency, PARALLEL_AGENT_REQUEST_LIMIT } from '../public/scripts/extensions/in-chat-agents/request-concurrency.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function heldWorker() {
    const started = [];
    const releases = new Map();
    let active = 0;
    let peak = 0;
    const worker = (item) => new Promise((resolve, reject) => {
        started.push(item);
        active++;
        peak = Math.max(peak, active);
        releases.set(item, {
            resolve: value => { active--; resolve(value); },
            reject: error => { active--; reject(error); },
        });
    });
    return { worker, started, releases, peak: () => peak };
}

describe('parallel Agent request limit', () => {
    test('allows four requests at a time', () => {
        expect(PARALLEL_AGENT_REQUEST_LIMIT).toBe(4);
    });

    test('starts the next item as soon as one finishes and keeps the input order', async () => {
        const held = heldWorker();
        const running = mapWithConcurrency(['a', 'b', 'c', 'd', 'e', 'f'], 4, held.worker);
        await settle();
        expect(held.started).toEqual(['a', 'b', 'c', 'd']);
        held.releases.get('c').resolve('C');
        await settle();
        expect(held.started).toEqual(['a', 'b', 'c', 'd', 'e']);
        for (const item of ['a', 'b', 'd', 'e']) held.releases.get(item).resolve(item.toUpperCase());
        await settle();
        held.releases.get('f').resolve('F');
        await expect(running).resolves.toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
        expect(held.peak()).toBe(4);
    });

    test('rejects like Promise.all and starts nothing after a failure', async () => {
        const held = heldWorker();
        const running = mapWithConcurrency(['a', 'b', 'c'], 2, held.worker);
        await settle();
        held.releases.get('a').reject(new Error('Provider is busy'));
        await expect(running).rejects.toThrow('Provider is busy');
        held.releases.get('b').resolve('B');
        await settle();
        expect(held.started).toEqual(['a', 'b']);
    });

    test('runs short lists and odd limits without stalling', async () => {
        await expect(mapWithConcurrency([], 4, async item => item)).resolves.toEqual([]);
        await expect(mapWithConcurrency([1, 2], 0, async item => item * 2)).resolves.toEqual([2, 4]);
        await expect(mapWithConcurrency(new Set([1, 2, 3]), 10, (item, index) => item + index)).resolves.toEqual([1, 3, 5]);
    });
});

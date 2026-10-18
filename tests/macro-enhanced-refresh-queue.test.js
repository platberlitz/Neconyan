import { describe, expect, test } from '@jest/globals';
import { createRefreshQueue } from '../public/scripts/extensions/third-party/MacroEnhanced/src/ui/refresh-queue.js';

function fakeFrames() {
    const frames = new Map();
    let next = 0;
    return {
        requestFrame: callback => {
            const handle = ++next;
            frames.set(handle, callback);
            return handle;
        },
        cancelFrame: handle => frames.delete(handle),
        runNext() {
            const [handle, callback] = frames.entries().next().value ?? [];
            if (handle === undefined) {
                return false;
            }
            frames.delete(handle);
            callback();
            return true;
        },
        get size() {
            return frames.size;
        },
    };
}

describe('Macro Enhanced refresh queue', () => {
    test('merges several data changes into one animation frame', () => {
        const frames = fakeFrames();
        const runs = [];
        const queue = createRefreshQueue(kind => runs.push(kind), frames);

        queue.push('values');
        queue.push('pronouns');
        queue.push('macros');
        expect(frames.size).toBe(1);
        expect(runs).toEqual([]);

        expect(frames.runNext()).toBe(true);
        expect(runs).toEqual(['values', 'pronouns', 'macros']);
        expect(frames.size).toBe(0);
    });

    test('a later change schedules a new frame after the first has run', () => {
        const frames = fakeFrames();
        const runs = [];
        const queue = createRefreshQueue(kind => runs.push(kind), frames);

        queue.push('values');
        frames.runNext();
        queue.push('macros');

        expect(frames.size).toBe(1);
        frames.runNext();
        expect(runs).toEqual(['values', 'macros']);
    });

    test('clear drops pending kinds and cancels the scheduled frame', () => {
        const frames = fakeFrames();
        const runs = [];
        const queue = createRefreshQueue(kind => runs.push(kind), frames);

        queue.push('values');
        queue.push('pronouns');
        queue.clear();

        expect(frames.size).toBe(0);
        queue.push('macros');
        frames.runNext();
        expect(runs).toEqual(['macros']);
    });
});

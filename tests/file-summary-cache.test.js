import { describe, expect, test } from '@jest/globals';

import { createFileSummaryCache, createLimiter, sameFileStatIdentity } from '../src/file-summary-cache.js';

function statIdentity(overrides = {}) {
    return { dev: 1, ino: 2, size: 100, mtimeMs: 1000, ctimeMs: 1000, ...overrides };
}

describe('file summary cache', () => {
    test('reuses a value only while every identity field matches', () => {
        const cache = createFileSummaryCache({ maxBytes: 1024, maxEntries: 10 });
        const identity = statIdentity();
        cache.set('card', identity, { name: 'Nova' });

        expect(cache.get('card', statIdentity())).toEqual({ name: 'Nova' });
        expect(cache.get('card', statIdentity({ size: 101 }))).toBeUndefined();
        expect(cache.get('card', statIdentity({ mtimeMs: 1001 }))).toBeUndefined();
        expect(cache.get('card', statIdentity({ ctimeMs: 1001 }))).toBeUndefined();
        expect(cache.get('card', statIdentity({ ino: 3 }))).toBeUndefined();
        expect(cache.get('card', statIdentity({ dev: 9 }))).toBeUndefined();
    });

    test('returns and stores private copies so caller mutation cannot leak', () => {
        const cache = createFileSummaryCache({ maxBytes: 1024, maxEntries: 10 });
        const identity = statIdentity();
        const original = { name: 'Nova', tags: ['one'] };
        cache.set('card', identity, original);

        original.tags.push('mutated after set');
        const first = cache.get('card', identity);
        first.tags.push('mutated after get');
        first.name = 'Changed';

        const second = cache.get('card', identity);
        expect(second).toEqual({ name: 'Nova', tags: ['one'] });
        expect(first).not.toBe(second);
    });

    test('evicts the least recently used entry when the entry limit is reached', () => {
        const cache = createFileSummaryCache({ maxBytes: 1024, maxEntries: 2 });
        const identity = statIdentity();
        cache.set('first', identity, { value: 'first' });
        cache.set('second', identity, { value: 'second' });

        expect(cache.get('first', identity)).toEqual({ value: 'first' });
        cache.set('third', identity, { value: 'third' });

        expect(cache.get('first', identity)).toEqual({ value: 'first' });
        expect(cache.get('second', identity)).toBeUndefined();
        expect(cache.get('third', identity)).toEqual({ value: 'third' });
        expect(cache.size).toBe(2);
    });

    test('stays inside its byte bound even for one oversized value', () => {
        const cache = createFileSummaryCache({ maxBytes: 120, maxEntries: 10 });
        const identity = statIdentity();
        cache.set('small', identity, { text: 'x'.repeat(40) });
        expect(cache.byteSize).toBeGreaterThan(0);
        expect(cache.byteSize).toBeLessThanOrEqual(120);

        cache.set('huge', identity, { text: 'x'.repeat(500) });
        expect(cache.byteSize).toBeLessThanOrEqual(120);
        expect(cache.get('huge', identity)).toBeUndefined();
        // The oversized value is refused without evicting the useful entry.
        expect(cache.get('small', identity)).toEqual({ text: 'x'.repeat(40) });
    });

    test('keeps entries at different paths independent', () => {
        const cache = createFileSummaryCache({ maxBytes: 1024, maxEntries: 10 });
        const identity = statIdentity();
        cache.set('/users/one/characters/Nova.png', identity, { owner: 'one' });
        cache.set('/users/two/characters/Nova.png', identity, { owner: 'two' });

        expect(cache.get('/users/one/characters/Nova.png', identity)).toEqual({ owner: 'one' });
        expect(cache.get('/users/two/characters/Nova.png', identity)).toEqual({ owner: 'two' });
    });

    test('compares identity objects field by field', () => {
        expect(sameFileStatIdentity(statIdentity(), statIdentity())).toBe(true);
        expect(sameFileStatIdentity(statIdentity(), statIdentity({ ctimeMs: 2 }))).toBe(false);
        expect(sameFileStatIdentity(undefined, statIdentity())).toBe(false);
    });

    test('limiter bounds concurrency and runs every task', async () => {
        const run = createLimiter(3);
        let active = 0;
        let maximum = 0;
        let completed = 0;
        const tasks = Array.from({ length: 12 }, (_, index) => run(async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 2));
            active--;
            completed++;
            return index;
        }));

        await expect(Promise.all(tasks)).resolves.toEqual(Array.from({ length: 12 }, (_, index) => index));
        expect(maximum).toBeLessThanOrEqual(3);
        expect(completed).toBe(12);
    });
});

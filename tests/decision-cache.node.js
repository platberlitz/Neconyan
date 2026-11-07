/* eslint playwright/expect-expect: off -- Native Node tests use strict assertions. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionCache } from '../src/decision-cache.js';

test('decision cache expires without extending TTL on reads and isolates returned objects', () => {
    let now = 0;
    const cache = new DecisionCache({ ttlMs: 100, now: () => now });
    const key = cache.key(['account', 'endpoint', 'secret', { state: 'scene' }]);
    assert.match(key, /^[a-f0-9]{64}$/);
    cache.set(key, { answers: [0.9] });
    cache.get(key).answers[0] = 0;
    now = 99;
    assert.deepEqual(cache.get(key), { answers: [0.9] });
    now = 100;
    assert.equal(cache.get(key), undefined);
    assert.equal(cache.bytes, 0);
});

test('decision cache evicts least recently used results and bounds stored response bytes', () => {
    const cache = new DecisionCache({ maxEntries: 2, maxBytes: 12 });
    cache.set('a', [1]);
    cache.set('b', [2]);
    cache.get('a');
    cache.set('c', [3]);
    assert.equal(cache.get('b'), undefined);
    assert.deepEqual(cache.get('a'), [1]);
    cache.set('d', '123456789');
    assert.equal(cache.entries.size, 1);
    assert.ok(cache.bytes <= 12);
    cache.set('large', '1234567890123');
    assert.equal(cache.get('large'), undefined);
    cache.set('d', [0]);
    assert.equal(cache.bytes, 3);
});

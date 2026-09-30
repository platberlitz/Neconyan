/* eslint playwright/expect-expect: off -- Node assertions exercise exact token counting. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTextTokenCache } from '../src/generation/token-count-cache.js';

test('repeated fields are encoded once and edits are counted independently', () => {
    let calls = 0;
    const tokenizer = { encode: text => { calls++; return [...text]; } };
    const count = createTextTokenCache();
    assert.equal(count('hello', tokenizer), 5);
    assert.equal(count('hello', tokenizer), 5);
    assert.equal(calls, 1);
    assert.equal(count('hello!', tokenizer), 6);
    assert.equal(calls, 2);
});

test('source size and entry limits bound retention without approximating counts', () => {
    let calls = 0;
    const tokenizer = { encode: text => { calls++; return [...text]; } };
    const count = createTextTokenCache({ maxCharacters: 6, maxEntries: 2 });
    for (const text of ['aaa', 'bbb', 'ccc', 'ccc', 'aaa', 'oversized', 'oversized']) {
        assert.equal(count(text, tokenizer), text.length);
    }
    assert.equal(calls, 6);
    const emptyCount = createTextTokenCache({ maxCharacters: 6, maxEntries: 1 });
    emptyCount('', tokenizer);
    emptyCount('a', tokenizer);
    emptyCount('', tokenizer);
    assert.equal(calls, 9);
});

test('encoding failures are never cached', () => {
    let calls = 0;
    const count = createTextTokenCache();
    const tokenizer = { encode: () => { calls++; throw new Error('Unavailable'); } };
    assert.throws(() => count('retry', tokenizer), /Unavailable/);
    assert.throws(() => count('retry', tokenizer), /Unavailable/);
    assert.equal(calls, 2);
});

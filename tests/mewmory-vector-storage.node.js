/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosine, createVectorEncoder, createVectorReader } from '../src/mewmory/vector-storage.js';

function fromDoubles(values) {
    const bytes = new ArrayBuffer(values.length * 4);
    const floats = new DataView(bytes);
    values.forEach((value, index) => floats.setFloat32(index * 4, Math.fround(value), true));
    return { vectorF32LE: Buffer.from(bytes).toString('base64') };
}

function referenceCosine(left, right) {
    const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
    const squareSum = values => values.reduce((sum, value) => sum + value * value, 0);
    return dot / Math.sqrt(squareSum(left) * squareSum(right));
}

test('compact vectors decode independent little-endian Float32 bits and preserve provider-double queries', () => {
    const reader = createVectorReader();
    const values = [1 + 2 ** -26, -0.333333333333, -2.25, 0.2, 0.0102398481, 120.0191, 0.00037];
    const encoded = fromDoubles(values);
    const rounded = values.map(Math.fround);
    const query = [0.24, -0.110015, 0.7, -0.1009161, 0.3583, 0.4018271, 0.91271];
    assert.equal(reader.dimension(encoded), values.length);
    assert.equal(reader.dimension(encoded, values.length - 1), 0);
    assert.equal(reader.similarity(encoded, query), referenceCosine(query, rounded));
    assert.notEqual(reader.similarity(encoded, query), referenceCosine(query.map(Math.fround), rounded));
    for (let i = 0; i < values.length; i++) {
        const basis = values.map((_, index) => Number(i === index));
        assert.equal(reader.similarity(encoded, basis), referenceCosine(basis, rounded));
    }
    const littleEndian = { vectorF32LE: 'AACAPwAAAMA=' }; // +1.0 then -2.0, in that byte order.
    assert.equal(reader.dimension(littleEndian), 2);
    assert.equal(reader.similarity(littleEndian, [1, 0]), 1 / Math.sqrt(5));
    assert.equal(reader.similarity(littleEndian, [0, 1]), -2 / Math.sqrt(5));
});

test('legacy arrays still support independently finite double values and their original dimension', () => {
    const reader = createVectorReader();
    const legacy = { vector: [0.1234567890111, -3.1, 1.611161111] };
    const query = [0.8, -0.77, 0.321];
    assert.equal(reader.dimension(legacy), 3);
    assert.equal(reader.similarity(legacy, query), referenceCosine(query, legacy.vector));
    assert.equal(reader.similarity(fromDoubles([1]), [1]), 1);
    assert.equal(reader.similarity(legacy, query), cosine(query, legacy.vector));
    assert.equal(reader.similarity(legacy, [1, 1]), null);

    const largeLegacy = { vector: Array(32_769).fill(1e80) };
    assert.equal(reader.dimension(largeLegacy), 32_769);
    assert.equal(reader.dimension(fromDoubles(Array(32_768).fill(1))), 32_768);
    assert.equal(reader.dimension(fromDoubles(Array(32_769).fill(1))), 0);
});

test('missing or ambiguous fields and invalid legacy shapes are missing embeddings', () => {
    const reader = createVectorReader();
    const encoded = fromDoubles([1]);
    const missing = [null, {}, { vectorF32LE: null }, { vector: null }, { vector: [] }, { vector: '1' },
        { ...encoded, vector: [1] }, { ...encoded, vector: undefined }];
    for (const entry of missing) {
        assert.equal(reader.dimension(entry), 0);
        assert.equal(reader.similarity(entry, [1]), null);
    }
});

test('legacy lookup trusts the array shape and uses the original cosine', () => {
    const reader = createVectorReader();
    for (const vector of [[NaN], [Infinity], Array(1), ['1']]) {
        const entry = { vector };
        assert.equal(reader.dimension(entry, 1), 1);
        assert.equal(reader.similarity(entry, [1]), cosine([1], vector));
        assert.equal(reader.similarity(entry, [1], 1), cosine([1], vector));
    }
});

test('wrong decoded widths, truncated payloads and nonfinite compact values are missing embeddings', () => {
    const reader = createVectorReader();
    const malformed = ['', '____', 'AA A', 'AAAAA===', 'AAAAAAA\n', 'AA==AA==', 'AA!A', 'AAAA===A', 'AACAPw', 'AAC Pw==',
        'AAAA', Buffer.alloc(5).toString('base64'), Buffer.alloc(6).toString('base64')];
    for (const bits of [0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001, 0xff800001]) {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32LE(bits);
        malformed.push(bytes.toString('base64'));
    }
    for (const value of malformed) {
        assert.equal(reader.dimension({ vectorF32LE: value }), 0, value);
        assert.equal(reader.similarity({ vectorF32LE: value }, [1]), null, value);
    }
    assert.equal(reader.similarity(fromDoubles([1]), [1]), 1);
});

test('compact decoding accepts equivalent alphabet and unused-bit aliases at the exact stored width', () => {
    const reader = createVectorReader();
    const query = [0.25, 1];
    const values = [1 - 2 ** -24, -0.5];
    const canonical = fromDoubles(values).vectorF32LE;
    const urlSafe = canonical.replaceAll('+', '-').replaceAll('/', '_');
    assert.notEqual(urlSafe, canonical);
    const vectors = [
        [urlSafe, values, query],
        ['AACAPx==', [1], [1]], // Same four bytes as AACAPw==.
        ['AACAPwAAAMB=', [1, -2], query], // Same eight bytes as AACAPwAAAMA=.
    ];
    for (const [vectorF32LE, expected, input] of vectors) {
        const entry = { vectorF32LE };
        assert.equal(reader.dimension(entry), expected.length);
        assert.equal(reader.similarity(entry, input), referenceCosine(input, expected));
    }
});

test('compact scoring and dimension lookup reject nonfinite components in reused scratch', () => {
    const reader = createVectorReader();
    const query = [0.25, -0.125, 1];
    const encoded = fromDoubles(query);
    assert.equal(reader.similarity(encoded, query), 1);
    for (const [index, bits] of [0x7f800000, 0xff800000, 0x7fc00000].entries()) {
        const bytes = Buffer.from(encoded.vectorF32LE, 'base64');
        bytes.writeUInt32LE(bits, index * 4);
        const invalid = { vectorF32LE: bytes.toString('base64') };
        assert.equal(reader.similarity(invalid, query), null);
        assert.equal(reader.similarity(invalid, [0, 0, 0]), null);
        assert.equal(reader.dimension(invalid), 0);
    }
    assert.equal(reader.similarity(fromDoubles([1, 2]), [1, 2]), 1);
    assert.equal(reader.similarity(fromDoubles([0, 0]), [1, 2]), -1);
});

test('the largest finite Float32 components do not overflow the stored sum of squares', () => {
    const reader = createVectorReader();
    const maxFloat32 = (2 - 2 ** -23) * 2 ** 127;
    const stored = Array(32_768).fill(maxFloat32);
    const query = stored.map((_, i) => i % 2 ? 0.5 : 1);
    assert.equal(reader.similarity(fromDoubles(stored), query), referenceCosine(query, stored));
});

test('encoding matches independently rounded little-endian bits across numeric boundaries', () => {
    const encode = createVectorEncoder();
    const shortest = 2 ** -149, highest = 3.4028234663852886e38;
    const values = Object.freeze([0, -0, -0.25, 0.1, 1 + 2 ** -25, 120.0191, shortest, -shortest,
        Number.MIN_VALUE, -Number.MIN_VALUE, highest, -highest]);
    const encoded = encode(values);
    assert.equal(encoded, fromDoubles(values).vectorF32LE);
    assert.equal(encode([1]), 'AACAPw==');
    assert.equal(encode(values), encoded);
    assert.equal(encode(Array(32_768).fill(1)).length, Math.ceil((128 * 1024) / 3) * 4);
    for (const invalid of [null, [], [NaN], [Infinity], [Number.MAX_VALUE], Array(32_769).fill(1),
        [{ valueOf: 1, toString: 2 }], [undefined]]) assert.equal(encode(invalid), null);
    const strict = createVectorEncoder({ requireNonzero: true });
    assert.equal(strict([1e-100, -1e-100]), null);
    assert.equal(encode([1e-100, -1e-100]), fromDoubles([1e-100, -1e-100]).vectorF32LE);
});

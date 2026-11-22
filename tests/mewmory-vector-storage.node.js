/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosine, createVectorReader } from '../src/mewmory/vector-storage.js';

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
    }
});

test('invalid padded bytes, noncanonical bit spellings and nonfinite compact values are missing embeddings', () => {
    const reader = createVectorReader();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const noncanonical = values => {
        const value = fromDoubles(values).vectorF32LE;
        const paddingIndex = value.indexOf('=');
        const lastSymbol = alphabet.indexOf(value[paddingIndex - 1]);
        return value.slice(0, paddingIndex - 1) + alphabet[lastSymbol | 1] + value.slice(paddingIndex);
    };
    const malformed = ['', '____', 'AA A', 'AAAAA===', 'AAAAAAA\n', 'AA==AA==', 'AA!A', 'AAAA===A', 'AACAPw', 'AAAA',
        noncanonical([1]), noncanonical([1, 2]), Buffer.alloc(5).toString('base64')];
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

test('compact scoring and dimension lookup both reject a nonfinite tail in reused scratch', () => {
    const reader = createVectorReader();
    const query = [0.25, -0.125, 1];
    const encoded = fromDoubles(query);
    assert.equal(reader.similarity(encoded, query), 1);
    const bytes = Buffer.from(encoded.vectorF32LE, 'base64');
    bytes.writeUInt32LE(0x7fc00000, bytes.length - 4);
    const invalid = { vectorF32LE: bytes.toString('base64') };
    assert.equal(reader.similarity(invalid, query), null);
    assert.equal(reader.dimension(invalid), 0);
    assert.equal(reader.similarity(fromDoubles([1, 2]), [1, 2]), 1);
});

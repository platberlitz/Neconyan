import { endianness } from 'node:os';

// Mewmory's embedding provider path accepts at most 32,768 components.
const MAX_COMPACT_BYTES = 128 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_COMPACT_BYTES / 3) * 4;
const FLOAT32_BYTES = 4;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const NON_BASE64_CHARACTER = /[^A-Za-z0-9+/]/;
const LITTLE_ENDIAN = endianness() === 'LE';

function compactByteLength(value) {
    if (typeof value !== 'string' || !value.length || value.length > MAX_BASE64_CHARS || value.length % 4) return 0;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const end = value.length - padding;
    if (NON_BASE64_CHARACTER.test(padding ? value.slice(0, end) : value)) return 0;
    if (padding) {
        // The decoder accepts noncanonical final characters. Unused bits must be zero.
        const lastSymbol = BASE64_ALPHABET.indexOf(value[end - 1]);
        if (lastSymbol & (padding === 2 ? 15 : 3)) return 0;
    }
    const length = value.length / 4 * 3 - padding;
    return length % FLOAT32_BYTES === 0 && length <= MAX_COMPACT_BYTES ? length : 0;
}

function representation(entry) {
    if (!entry) return null;
    const legacy = Object.hasOwn(entry, 'vector');
    const compact = Object.hasOwn(entry, 'vectorF32LE');
    if (legacy === compact) return null;
    return legacy ? 'vector' : 'vectorF32LE';
}

function legacyDimension(vector, expectedDimension) {
    if (!Array.isArray(vector) || !vector.length
        || (expectedDimension !== undefined && vector.length !== expectedDimension)) return 0;
    return vector.length;
}

export function cosine(left, right) {
    if (left.length !== right.length) return -1;
    let dot = 0, a = 0, b = 0;
    for (let index = 0; index < left.length; index++) {
        dot += left[index] * right[index];
        a += left[index] ** 2;
        b += right[index] ** 2;
    }
    return a && b ? dot / Math.sqrt(a * b) : -1;
}

/** Read dimensions or score saved vectors without retaining their decoded components. */
export function createVectorReader() {
    let scratch, floats;

    function decode(value, expectedDimension) {
        const bytes = compactByteLength(value);
        const length = bytes / FLOAT32_BYTES;
        if (!length || (expectedDimension !== undefined && length !== expectedDimension)) return 0;
        if (!scratch || scratch.length < bytes) {
            // The Buffer and float view share one aligned, unpooled allocation.
            const storage = new ArrayBuffer(bytes);
            scratch = Buffer.from(storage);
            if (LITTLE_ENDIAN) floats = new Float32Array(storage);
        }
        return scratch.write(value, 0, bytes, 'base64') === bytes ? length : 0;
    }

    return {
        dimension(entry, expectedDimension) {
            const stored = representation(entry);
            if (stored === 'vector') return legacyDimension(entry.vector, expectedDimension);
            if (stored !== 'vectorF32LE') return 0;
            const length = decode(entry.vectorF32LE, expectedDimension);
            for (let index = 0; index < length; index++) {
                const value = floats ? floats[index] : scratch.readFloatLE(index * FLOAT32_BYTES);
                if (!Number.isFinite(value)) return 0;
            }
            return length;
        },
        similarity(entry, query) {
            const stored = representation(entry);
            if (stored === 'vector') return legacyDimension(entry.vector, query.length) ? cosine(query, entry.vector) : null;
            if (stored !== 'vectorF32LE' || !decode(entry.vectorF32LE, query.length)) return null;
            let dot = 0, a = 0, b = 0;
            for (let index = 0; index < query.length; index++) {
                const right = floats ? floats[index] : scratch.readFloatLE(index * FLOAT32_BYTES);
                if (!Number.isFinite(right)) return null;
                dot += query[index] * right;
                a += query[index] ** 2;
                b += right ** 2;
            }
            return a && b ? dot / Math.sqrt(a * b) : -1;
        },
    };
}

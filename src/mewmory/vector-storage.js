import { endianness } from 'node:os';

// Mewmory's embedding provider path accepts at most 32,768 components.
const MAX_COMPACT_BYTES = 128 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_COMPACT_BYTES / 3) * 4;
const FLOAT32_BYTES = 4;
const LITTLE_ENDIAN = endianness() === 'LE';

function compactByteLength(value) {
    if (typeof value !== 'string' || !value.length || value.length > MAX_BASE64_CHARS || value.length % 4) return 0;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
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

export function querySumOfSquares(query) {
    let sum = 0;
    for (let index = 0; index < query.length; index++) sum += query[index] ** 2;
    return sum;
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
        // The writer emits canonical base64. Readers require the exact decoded width.
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
        similarity(entry, query, querySquares) {
            const stored = representation(entry);
            if (stored === 'vector') {
                const values = entry.vector;
                if (!legacyDimension(values, query.length)) return null;
                if (querySquares === undefined) return cosine(query, values);
                let dot = 0, storedSquares = 0;
                for (let index = 0; index < query.length; index++) {
                    const value = values[index];
                    dot += query[index] * value;
                    storedSquares += value ** 2;
                }
                return querySquares && storedSquares ? dot / Math.sqrt(querySquares * storedSquares) : -1;
            }
            if (stored !== 'vectorF32LE' || !decode(entry.vectorF32LE, query.length)) return null;
            querySquares ??= querySumOfSquares(query);
            let dot = 0, storedSquares = 0;
            const values = floats;
            if (values) {
                for (let index = 0; index < query.length; index++) {
                    const value = values[index];
                    dot += query[index] * value;
                    storedSquares += value ** 2;
                }
            } else {
                for (let index = 0; index < query.length; index++) {
                    const value = scratch.readFloatLE(index * FLOAT32_BYTES);
                    dot += query[index] * value;
                    storedSquares += value ** 2;
                }
            }
            // Finite Float32 components cannot overflow this Float64 sum at the supported width.
            if (!Number.isFinite(storedSquares)) return null;
            return querySquares && storedSquares ? dot / Math.sqrt(querySquares * storedSquares) : -1;
        },
    };
}

/** Encode owned provider arrays using a single reusable buffer. */
export function createVectorEncoder({ requireNonzero = false } = {}) {
    let scratch;
    return vector => {
        if (!Array.isArray(vector) || !vector.length || vector.length > MAX_COMPACT_BYTES / FLOAT32_BYTES) return null;
        const bytes = vector.length * FLOAT32_BYTES;
        if (!scratch || scratch.length < bytes) scratch = Buffer.allocUnsafe(bytes);
        let nonzero = false;
        for (let index = 0; index < vector.length; index++) {
            const component = vector[index];
            if (!Number.isFinite(component)) return null;
            const value = Math.fround(component);
            if (!Number.isFinite(value)) return null;
            nonzero ||= value !== 0;
            scratch.writeFloatLE(value, index * FLOAT32_BYTES);
        }
        if (requireNonzero && !nonzero) return null;
        return scratch.toString('base64', 0, bytes);
    };
}

function compactEntry(entry, encode, inPlace) {
    if (!entry || typeof entry !== 'object') return entry;
    const legacy = Object.hasOwn(entry, 'vector');
    const compact = Object.hasOwn(entry, 'vectorF32LE');
    if (!legacy && (!compact || (typeof entry.vectorF32LE === 'string' && Object.keys(entry).at(-1) === 'vectorF32LE'))) return entry;

    // Ambiguous or unencodable saved embeddings become missing. The entry metadata survives.
    const encoded = legacy ? (compact ? null : encode(entry.vector)) : entry.vectorF32LE;
    const result = inPlace ? entry : { ...entry };
    delete result.vector;
    delete result.vectorF32LE;
    // The canonical field position keeps representation-only edits equal during JSON comparison.
    if (typeof encoded === 'string') result.vectorF32LE = encoded;
    return result;
}

function compactMap(vectors, encode, inPlace) {
    let result = vectors;
    for (const key of Object.keys(vectors ?? {})) {
        const entry = vectors[key];
        const normalized = compactEntry(entry, encode, inPlace);
        if (entry === normalized) continue;
        if (result === vectors) result = Array.isArray(vectors) ? vectors.slice() : { ...vectors };
        result[key] = normalized;
    }
    return result;
}

/** Parsed archives are owned. Mutation results can contain caller-owned maps or entries. */
export function compactArchiveVectors(state, { inPlace = false } = {}) {
    const { index } = state;
    if (!index) return state;
    const encode = createVectorEncoder();
    const published = compactMap(index.vectors, encode, inPlace);
    const staged = compactMap(index.build?.vectors, encode, inPlace);
    if (published === index.vectors && staged === index.build?.vectors) return state;
    const normalized = { ...index };
    if (published !== index.vectors) normalized.vectors = published;
    if (staged !== index.build?.vectors) normalized.build = { ...index.build, vectors: staged };
    return { ...state, index: normalized };
}

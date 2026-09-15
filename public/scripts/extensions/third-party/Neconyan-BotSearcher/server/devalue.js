/**
 * Minimal reader for SvelteKit's `__data.json` payloads.
 *
 * SvelteKit serialises with devalue: one flat array where every value that is
 * not a primitive is an integer index into that same array. Objects map keys to
 * indices, arrays hold indices, and a handful of negative indices stand for
 * values JSON cannot express.
 *
 *   [{"cards":1,"page":20}, [2,23,34], {"name":3,...}, "The Great Emergence", ...]
 *
 * This exists because RisuRealm has no JSON API — its site data endpoint is the
 * only way in. That makes it structurally fragile: a SvelteKit upgrade can
 * change this encoding with no warning and no version marker. The circuit
 * breaker is what turns that into "RisuRealm is unavailable" rather than a
 * stream of errors.
 */

/** Devalue's sentinel indices for values JSON has no literal for. */
const HOLE = -2;
const UNDEFINED = -1;
const NAN = -3;
const POSITIVE_INFINITY = -4;
const NEGATIVE_INFINITY = -5;
const NEGATIVE_ZERO = -6;

/** Deep enough for any card payload, shallow enough to bound the recursion. */
const MAX_DEPTH = 24;

/** Bounds expansion when a compact graph repeatedly references the same child. */
const MAX_RESOLVED_SLOTS = 100_000;
const MAX_RESOLVED_STRING_BYTES = 8 * 1024 * 1024;

function reserve(state, slots, stringBytes = 0) {
    if (state.slots + slots > state.maxSlots || state.stringBytes + stringBytes > state.maxStringBytes) {
        state.exhausted = true;
        return false;
    }
    state.slots += slots;
    state.stringBytes += stringBytes;
    return true;
}

/**
 * @param {unknown[]} flat
 * @param {unknown} index
 * @param {number} depth
 * @param {Set<number>} seen indices on the current path, so a cycle cannot loop
 * @param {{ slots: number, stringBytes: number, maxSlots: number, maxStringBytes: number, exhausted: boolean, cycles: number }} state
 * @param {Map<number, Map<number, unknown>>} memo resolved containers keyed by depth
 */
function resolve(flat, index, depth, seen, state, memo) {
    if (typeof index !== 'number' || !Number.isInteger(index)) {
        return null;
    }

    switch (index) {
        case UNDEFINED: return undefined;
        case HOLE: return undefined;
        case NAN: return null;                 // NaN has no place in our records
        case POSITIVE_INFINITY: return null;
        case NEGATIVE_INFINITY: return null;
        case NEGATIVE_ZERO: return 0;
        default: break;
    }

    if (index < 0 || index >= flat.length || depth > MAX_DEPTH) {
        return null;
    }
    if (seen.has(index)) {
        state.cycles++;
        return null;
    }

    if (!reserve(state, 1)) {
        return null;
    }

    const cached = memo.get(depth)?.get(index);
    if (cached !== undefined) {
        return cached;
    }

    const node = flat[index];

    if (node === null || typeof node !== 'object') {
        if (typeof node === 'string' && !reserve(state, 0, Buffer.byteLength(node))) {
            return null;
        }
        return node ?? null;
    }

    const keys = Array.isArray(node) ? null : Object.getOwnPropertyNames(node);
    const width = Array.isArray(node) ? node.length : keys.length;
    if (!reserve(state, width)) {
        return null;
    }

    const cyclesBefore = state.cycles;
    seen.add(index);
    try {
        if (Array.isArray(node)) {
            const out = new Array(node.length);
            for (let childIndex = 0; childIndex < node.length; childIndex++) {
                out[childIndex] = resolve(flat, node[childIndex], depth + 1, seen, state, memo);
                if (state.exhausted) {
                    return null;
                }
            }
            if (state.cycles === cyclesBefore) {
                let level = memo.get(depth);
                if (!level) {
                    level = new Map();
                    memo.set(depth, level);
                }
                level.set(index, out);
            }
            return out;
        }

        // Own keys only, and never a poisoning key — this builds a real object.
        const out = {};
        for (const key of keys) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                continue;
            }
            out[key] = resolve(flat, node[key], depth + 1, seen, state, memo);
            if (state.exhausted) {
                return null;
            }
        }
        if (state.cycles === cyclesBefore) {
            let level = memo.get(depth);
            if (!level) {
                level = new Map();
                memo.set(depth, level);
            }
            level.set(index, out);
        }
        return out;
    } finally {
        seen.delete(index);
    }
}

/**
 * Extracts the decoded root object from a SvelteKit data response.
 *
 * @param {unknown} payload the parsed __data.json body
 * @returns {Record<string, unknown> | null}
 */
export function readSvelteKitData(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const nodes = payload.nodes;
    if (!Array.isArray(nodes)) {
        return null;
    }

    // Layout nodes are {"type":"skip"}; the page's own node carries the data.
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (!node || typeof node !== 'object' || node.type !== 'data' || !Array.isArray(node.data)) {
            continue;
        }
        const state = {
            slots: 0,
            stringBytes: 0,
            maxSlots: MAX_RESOLVED_SLOTS,
            maxStringBytes: MAX_RESOLVED_STRING_BYTES,
            exhausted: false,
            cycles: 0,
        };
        const root = resolve(node.data, 0, 0, new Set(), state, new Map());
        if (!state.exhausted && root && typeof root === 'object' && !Array.isArray(root)) {
            return root;
        }
    }

    return null;
}

/**
 * Request-shape validation and the guards applied to parsed upstream JSON.
 *
 * Nothing here trusts a key name. Every lookup driven by client or upstream data
 * goes through hasOwnProperty, and every object we build starts from
 * Object.create(null), so a "__proto__" key is inert data rather than a write
 * to Object.prototype.
 */

import { FILTER_LIMITS } from '../shared/schema.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} value
 * @returns {boolean} true for a plain object (not an array, not null)
 */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clamps to an integer inside [min, max], falling back for anything unusable.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
    const type = typeof value;
    if (type !== 'number' && type !== 'string') {
        return fallback;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * Returns `value` only if it is one of `allowed`. Never returns caller input
 * that was not explicitly permitted.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
export function pick(value, allowed, fallback) {
    if (typeof value === 'string' && allowed.includes(value)) {
        return value;
    }
    return fallback;
}

/**
 * How deep a legitimate upstream payload may nest.
 *
 * This started at 6 and rejected Chub's own character responses, which reach 7
 * (node/definition/extensions/chub/extensions/0/is_editing) with no poisoning
 * keys at all — a guard that quietly killed a working source. Real card JSON
 * nests: a card holds a definition, which holds extensions and an embedded
 * lorebook, whose entries hold their own arrays. 32 is far above anything
 * observed and still bounds the recursion.
 */
const MAX_SCAN_DEPTH = 32;

/**
 * Scans for prototype-poisoning keys, and bounds its own recursion.
 *
 * Two jobs in one pass, and the distinction matters: a forbidden key is
 * evidence of an attack, whereas exceeding the depth limit only means the
 * payload is too unusual to vouch for. Both are refused, but the limit is set
 * so that no real card ever trips it.
 *
 * @param {unknown} value
 * @param {number} [maxDepth]
 * @returns {boolean} true if the value is unsafe to process
 */
export function hasForbiddenKey(value, maxDepth = MAX_SCAN_DEPTH) {
    return scan(value, maxDepth, 0);
}

function scan(value, maxDepth, depth) {
    if (depth > maxDepth) {
        return true; // Too deep to validate; treat as hostile.
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            if (scan(item, maxDepth, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    if (!isPlainObject(value)) {
        return false;
    }

    // Own keys only, and getOwnPropertyNames also catches a non-enumerable
    // "__proto__" that a plain for..in would miss.
    for (const key of Object.getOwnPropertyNames(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            return true;
        }
        if (scan(value[key], maxDepth, depth + 1)) {
            return true;
        }
    }

    return false;
}

/**
 * Reads a property without touching the prototype chain.
 * @param {unknown} object
 * @param {string} key
 */
export function own(object, key) {
    if (!isPlainObject(object) && !Array.isArray(object)) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
        return undefined;
    }
    return object[key];
}

/**
 * Accepts an upstream-supplied URL only if it is https and its host is an exact
 * member of `hosts`.
 *
 * Most adapters rebuild their URLs from a fixed base and never need this. It
 * exists for the sources where a URL genuinely cannot be reconstructed — for
 * example Pygmalion's avatars, which live under an asset id unrelated to the
 * character id. Those still get host-checked before they go anywhere near a
 * response.
 *
 * @param {unknown} raw
 * @param {readonly string[]} hosts
 * @returns {URL | null}
 */
export function hostCheckedUrl(raw, hosts) {
    if (typeof raw !== 'string' || raw === '' || raw.length > 2048) {
        return null;
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    if (url.protocol !== 'https:') {
        return null;
    }
    if ((url.port !== '' && url.port !== '443') || url.username !== '' || url.password !== '') {
        return null;
    }
    if (!Array.isArray(hosts) || !hosts.includes(url.hostname.toLowerCase())) {
        return null;
    }

    return url;
}

/**
 * Reads the filter values a source has declared it can apply, and nothing else.
 *
 * The adapter's `capabilities.filters` list is the whitelist. A key the source
 * did not declare is dropped rather than forwarded, so the UI can never imply a
 * filter that is not happening — the same rule that already governs the SFW and
 * hide-AI toggles.
 *
 * @param {unknown} raw the client's `filters` object
 * @param {readonly {key: string, type: string}[]} declared
 * @returns {Record<string, string[] | string | number | boolean>} own-keys-only, null prototype
 */
export function readFilters(raw, declared) {
    const out = Object.create(null);
    if (!Array.isArray(declared)) {
        return out;
    }

    for (const spec of declared) {
        const value = own(raw, spec?.key);
        if (value === undefined || value === null) {
            continue;
        }

        if (spec.type === 'tags') {
            const tags = (Array.isArray(value) ? value : [value])
                .filter((tag) => typeof tag === 'string')
                .map((tag) => tag.trim().slice(0, FILTER_LIMITS.tagLength))
                .filter((tag) => tag !== '')
                .slice(0, FILTER_LIMITS.tagCount);
            if (tags.length > 0) {
                out[spec.key] = tags;
            }
            continue;
        }

        if (spec.type === 'text') {
            if (typeof value === 'string') {
                const text = value.trim().slice(0, FILTER_LIMITS.textLength);
                if (text !== '') {
                    out[spec.key] = text;
                }
            }
            continue;
        }

        if (spec.type === 'number') {
            const parsed = typeof value === 'number' ? value : Number(value);
            if (Number.isFinite(parsed)) {
                out[spec.key] = Math.min(
                    FILTER_LIMITS.numberMax,
                    Math.max(FILTER_LIMITS.numberMin, Math.floor(parsed)),
                );
            }
            continue;
        }

        if (spec.type === 'boolean') {
            if (value === true) {
                out[spec.key] = true;
            }
            continue;
        }

        if (spec.type === 'date' && validCalendarDate(value)) {
            out[spec.key] = value;
        }
    }

    return out;
}

function validCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validates the common `{ source, ... }` request envelope.
 * @param {unknown} body
 * @returns {{ ok: true, source: string } | { ok: false, code: string }}
 */
export function readSourceId(body) {
    if (!isPlainObject(body)) {
        return { ok: false, code: 'bad_request' };
    }

    const source = own(body, 'source');
    if (typeof source !== 'string' || source === '' || source.length > 64) {
        return { ok: false, code: 'bad_source' };
    }

    return { ok: true, source };
}

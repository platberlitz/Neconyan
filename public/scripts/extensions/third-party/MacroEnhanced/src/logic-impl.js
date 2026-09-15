/**
 * Pure implementations for the language-toolkit macros (comparisons, switch,
 * list ops, text ops, JSON writes). No Neconyan imports. everything in this
 * file is directly testable under `node --test`.
 */
import { JsonPathError, parseJsonPath } from './utility-impl.js';
import { fnv1a, mulberry32 } from './state-impl.js';

export const PAD_MAX = 500;
export const REGEX_PATTERN_MAX = 200;
export const REGEX_TEXT_MAX = 100000;
export const JSON_PATH_MAX_DEPTH = 16;

// ---------- truthiness & comparison ----------

/**
 * Mirrors the engine's {{if}} semantics exactly: falsy iff the value is the
 * empty string, or trims to "off"/"false"/"0" (isFalseBoolean in the fork's
 * public/scripts/utils.js). Deliberately NOT imported. a parity test guards
 * against upstream drift. Note whitespace-only strings are truthy, like core.
 */
export function isFalsyText(value) {
    const s = String(value ?? '');
    if (s === '') {
        return true;
    }
    return ['off', 'false', '0'].includes(s.trim().toLowerCase());
}

export function isTruthyText(value) {
    return !isFalsyText(value);
}

export function boolString(bool) {
    return bool ? 'true' : 'false';
}

function asNumber(value) {
    const s = String(value ?? '').trim();
    if (!s) {
        return NaN;
    }
    const n = Number(s);
    return Number.isNaN(n) ? NaN : n;
}

/**
 * Numeric-first comparison: if both sides parse as numbers they compare
 * numerically ("5" equals "5.0"), otherwise as trimmed strings.
 *
 * @returns {-1|0|1}
 */
export function compareValues(a, b) {
    const na = asNumber(a);
    const nb = asNumber(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
        return na < nb ? -1 : na > nb ? 1 : 0;
    }
    const sa = String(a ?? '').trim();
    const sb = String(b ?? '').trim();
    if (sa === sb) {
        return 0;
    }
    return sa.localeCompare(sb) < 0 ? -1 : 1;
}

/** Splits a raw {{switch}} branch on the FIRST "=". Null when there is none. */
export function splitSwitchPair(rawPair) {
    const s = String(rawPair ?? '');
    const index = s.indexOf('=');
    if (index === -1) {
        return null;
    }
    return { rawKey: s.slice(0, index), rawResult: s.slice(index + 1) };
}

// ---------- list math & ops ----------

/** Sums numeric items; non-numeric items are skipped and reported. */
export function sumList(items) {
    let total = 0;
    let used = 0;
    const skipped = [];
    for (const item of items) {
        const n = asNumber(item);
        if (Number.isNaN(n)) {
            skipped.push(item);
        } else {
            total += n;
            used++;
        }
    }
    return { total, used, skipped };
}

export function uniqueList(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!seen.has(item)) {
            seen.add(item);
            result.push(item);
        }
    }
    return result;
}

export function sliceList(items, start, end) {
    return end === undefined || end === null ? items.slice(start) : items.slice(start, end);
}

/** Membership with the same numeric-first semantics as {{eq}}. */
export function listContains(items, needle) {
    return items.some(item => compareValues(item, needle) === 0);
}

/**
 * Fisher-Yates shuffle. With a seed the order is deterministic (cache-friendly);
 * without one it re-shuffles every call.
 */
export function shuffleList(items, seedText = null) {
    const result = [...items];
    const random = seedText === null || seedText === '' ? Math.random : mulberry32(fnv1a(seedText));
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

// ---------- text ----------

export function padText(text, length, pad = ' ', side = 'start') {
    const s = String(text);
    const target = Math.min(Math.max(0, Math.trunc(length)), PAD_MAX);
    const filler = String(pad ?? ' ') || ' ';
    return side === 'end' ? s.padEnd(target, filler) : s.padStart(target, filler);
}

/** Uppercases the first character of every word; the rest is left as typed. */
export function titleCaseText(text) {
    return String(text).replace(/\S+/g, word => word[0].toUpperCase() + word.slice(1));
}

export function countWords(text) {
    return (String(text).match(/\S+/g) ?? []).length;
}

export class RegexError extends Error {}

/**
 * Guarded regex replace: bounded pattern/input sizes, whitelisted flags, and
 * replacement references limited to $1-$9 ($10+ and $<name> become literal).
 * Throws RegexError on any violation or an invalid pattern.
 */
export function regexReplaceText(text, pattern, replacement, flags = 'g') {
    const s = String(text ?? '');
    const p = String(pattern ?? '');
    const f = String(flags ?? 'g');
    if (p.length > REGEX_PATTERN_MAX) {
        throw new RegexError(`Pattern is longer than ${REGEX_PATTERN_MAX} characters`);
    }
    if (s.length > REGEX_TEXT_MAX) {
        throw new RegexError(`Input is longer than ${REGEX_TEXT_MAX} characters`);
    }
    if (!/^[gimsu]*$/.test(f)) {
        throw new RegexError(`Flags may only contain g, i, m, s, u (got "${f}")`);
    }
    const safeReplacement = String(replacement ?? '')
        .replace(/\$(?=<)/g, '$$$$')
        .replace(/\$(?=\d\d)/g, '$$$$');
    let regex;
    try {
        regex = new RegExp(p, f);
    } catch (error) {
        throw new RegexError(`Invalid pattern: ${error.message}`);
    }
    return s.replace(regex, safeReplacement);
}

// ---------- JSON ----------

function walkPath(value, segments) {
    for (const segment of segments) {
        if (value === null || typeof value !== 'object') {
            return undefined;
        }
        const key = typeof segment === 'number' && Array.isArray(value) && segment < 0
            ? value.length + segment
            : segment;
        value = value[key];
    }
    return value;
}

/** Parses JSON and returns the raw value at the path (any type; undefined if absent). */
export function jsonValueAt(jsonText, path) {
    let value;
    try {
        value = JSON.parse(String(jsonText));
    } catch {
        throw new JsonPathError('Input is not valid JSON');
    }
    return walkPath(value, parseJsonPath(path));
}

/**
 * Sets a string value at a path inside a JSON document, creating intermediate
 * objects/arrays as needed (numeric segment -> array). Invalid or empty input
 * starts from {}. Returns the updated JSON text.
 */
export function jsonSetValue(jsonText, path, value) {
    const segments = parseJsonPath(path);
    if (!segments.length) {
        throw new JsonPathError('The path cannot be empty');
    }
    if (segments.length > JSON_PATH_MAX_DEPTH) {
        throw new JsonPathError(`The path is deeper than ${JSON_PATH_MAX_DEPTH} levels`);
    }

    let root;
    try {
        root = JSON.parse(String(jsonText));
    } catch {
        root = undefined;
    }
    const wantArray = typeof segments[0] === 'number';
    if (root === null || typeof root !== 'object' || Array.isArray(root) !== wantArray) {
        root = wantArray ? [] : {};
    }

    let node = root;
    for (let i = 0; i < segments.length; i++) {
        let key = segments[i];
        if (typeof key === 'number' && Array.isArray(node) && key < 0) {
            key = Math.max(0, node.length + key);
        }
        if (i === segments.length - 1) {
            node[key] = String(value ?? '');
            break;
        }
        const nextIsIndex = typeof segments[i + 1] === 'number';
        const child = node[key];
        if (child === null || typeof child !== 'object' || Array.isArray(child) !== nextIsIndex) {
            node[key] = nextIsIndex ? [] : {};
        }
        node = node[key];
    }
    return JSON.stringify(root);
}

/**
 * Pure implementations for the chat-state macro pack (freeze/sticky/daily/rollonce,
 * coarse time, deterministic picks). No Neconyan imports. everything in this
 * file is directly testable under `node --test`.
 */

// Keys for stored values: a word character first, then word chars, dots, colons or hyphens.
export const STATE_KEY_PATTERN = /^[\w][\w.:-]{0,63}$/;
export const FROZEN_VALUE_MAX_CHARS = 65536;
export const FROZEN_ENTRIES_WARN_AT = 200;

export function isValidStateKey(key) {
    return STATE_KEY_PATTERN.test(String(key ?? ''));
}

/** 32-bit FNV-1a. a stable tiny hash for deterministic seeding. */
export function fnv1a(text) {
    let hash = 0x811c9dc5;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** Deterministic PRNG over a 32-bit seed, returning floats in [0, 1). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Parses "2d6", "d20", "3d6+2", "3d6-1" or a plain number of sides ("20" = 1d20).
 *
 * @returns {{count: number, sides: number, modifier: number}|null}
 */
export function parseDiceFormula(text) {
    const s = String(text ?? '').trim();
    if (/^\d{1,4}$/.test(s)) {
        const sides = Number(s);
        return sides >= 1 ? { count: 1, sides, modifier: 0 } : null;
    }
    const match = /^(\d{1,3})?[dD](\d{1,4})([+-]\d{1,4})?$/.exec(s);
    if (!match) {
        return null;
    }
    const count = match[1] ? Number(match[1]) : 1;
    const sides = Number(match[2]);
    if (count < 1 || sides < 1) {
        return null;
    }
    return { count, sides, modifier: match[3] ? Number(match[3]) : 0 };
}

export function rollDice({ count, sides, modifier = 0 }, random = Math.random) {
    let total = modifier;
    for (let i = 0; i < count; i++) {
        total += 1 + Math.floor(random() * sides);
    }
    return total;
}

/** Coarse time bucket for an hour of day (0-23). */
export function timeOfDay(hour) {
    const h = Number(hour);
    if (h >= 5 && h <= 11) {
        return 'morning';
    }
    if (h >= 12 && h <= 16) {
        return 'afternoon';
    }
    if (h >= 17 && h <= 21) {
        return 'evening';
    }
    return 'night';
}

const NORTH_SEASONS = [
    'winter', 'winter', 'spring', 'spring', 'spring', 'summer',
    'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter',
];
const OPPOSITE_SEASON = { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' };

/** Season for a 0-based month index; 'south' flips the hemisphere. */
export function seasonOf(monthIndex, hemisphere = 'north') {
    const season = NORTH_SEASONS[((Math.trunc(monthIndex) % 12) + 12) % 12];
    return String(hemisphere).trim().toLowerCase() === 'south' ? OPPOSITE_SEASON[season] : season;
}

/** Local-time YYYY-MM-DD stamp, for {{daily}} refresh checks. */
export function dayStamp(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Whether a {{sticky}} entry is due for re-evaluation. */
export function stickyNeedsRefresh(entry, currentUserCount, period) {
    if (!entry || typeof entry.atUserCount !== 'number') {
        return true;
    }
    return currentUserCount - entry.atUserCount >= period;
}

/** Deterministic index into a list of the given length; -1 when empty. */
export function pickIndex(seedText, length) {
    if (!length) {
        return -1;
    }
    return fnv1a(seedText) % length;
}

/**
 * Best-effort timestamp parse for message send_date values: epoch numbers,
 * numeric strings, ISO dates, and the host's humanized "June 19, 2023 2:20pm"
 * format (Date.parse needs a space before am/pm).
 *
 * @returns {number} epoch ms, or NaN when unparseable
 */
export function parseTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const s = String(value ?? '').trim();
    if (!s) {
        return NaN;
    }
    if (/^\d+$/.test(s)) {
        return Number(s);
    }
    const direct = Date.parse(s);
    if (Number.isFinite(direct)) {
        return direct;
    }
    return Date.parse(s.replace(/(\d)\s*(am|pm)\b/i, '$1 $2'));
}

/** Whole days between two epoch-ms timestamps, never negative. */
export function daysBetween(fromMs, toMs) {
    const DAY_MS = 86400000;
    return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

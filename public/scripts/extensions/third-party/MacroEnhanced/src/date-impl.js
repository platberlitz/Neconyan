/**
 * Pure calendar helpers for the date macros. Implemented locally (instead of the
 * host's bundled moment) so the logic is testable under `node --test` and has no
 * host coupling. No Neconyan imports.
 */
import { parseTimestamp } from './state-impl.js';

export class DateError extends Error {}

const UNIT_ALIASES = new Map(Object.entries({
    y: 'years', yr: 'years', year: 'years', years: 'years',
    mo: 'months', month: 'months', months: 'months',
    w: 'weeks', week: 'weeks', weeks: 'weeks',
    d: 'days', day: 'days', days: 'days',
    h: 'hours', hr: 'hours', hour: 'hours', hours: 'hours',
    min: 'minutes', minute: 'minutes', minutes: 'minutes',
    s: 'seconds', sec: 'seconds', second: 'seconds', seconds: 'seconds',
}));

const UNIT_MS = { weeks: 604800000, days: 86400000, hours: 3600000, minutes: 60000, seconds: 1000 };

/** Wall-clock epoch (local fields read as UTC). keeps day math DST-neutral. */
function wallClockMs(date) {
    return Date.UTC(
        date.getFullYear(), date.getMonth(), date.getDate(),
        date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

/**
 * Normalizes a unit name. Single letters "M" (months) and "m" (minutes) are
 * case-sensitive, like moment; everything longer is case-insensitive.
 */
export function normalizeUnit(unit) {
    const raw = String(unit ?? '').trim();
    if (raw === 'M') {
        return 'months';
    }
    if (raw === 'm') {
        return 'minutes';
    }
    return UNIT_ALIASES.get(raw.toLowerCase()) ?? null;
}

/** Parses a date input; empty means "now". Returns a Date or null. */
export function parseDateInput(value, now = () => new Date()) {
    const s = String(value ?? '').trim();
    if (!s) {
        return now();
    }
    const ms = parseTimestamp(s);
    return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Adds calendar months, clamping the day-of-month (Jan 31 + 1mo = Feb 28). */
export function addMonthsClamped(date, months) {
    const result = new Date(date);
    const day = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + months);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, lastDay));
    return result;
}

/** Component-based add, so wall-clock times survive DST transitions. */
export function addToDate(date, amount, unit) {
    const n = Math.trunc(amount);
    if (unit === 'years') {
        return addMonthsClamped(date, n * 12);
    }
    if (unit === 'months') {
        return addMonthsClamped(date, n);
    }
    const result = new Date(date);
    switch (unit) {
        case 'weeks': result.setDate(result.getDate() + n * 7); break;
        case 'days': result.setDate(result.getDate() + n); break;
        case 'hours': result.setHours(result.getHours() + n); break;
        case 'minutes': result.setMinutes(result.getMinutes() + n); break;
        case 'seconds': result.setSeconds(result.getSeconds() + n); break;
    }
    return result;
}

/** Whole calendar months from a to b, truncated toward zero. */
function monthDiff(a, b) {
    let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    const adjusted = addMonthsClamped(a, months);
    if (months > 0 && adjusted > b) {
        months--;
    } else if (months < 0 && adjusted < b) {
        months++;
    }
    return months;
}

/** Whole units from a to b, truncated toward zero. Negative when b is earlier. */
export function diffDates(a, b, unit) {
    if (unit === 'years') {
        return Math.trunc(monthDiff(a, b) / 12);
    }
    if (unit === 'months') {
        return monthDiff(a, b);
    }
    return Math.trunc((wallClockMs(b) - wallClockMs(a)) / UNIT_MS[unit]);
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FORMAT_TOKEN = /YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|hh|H|h|mm|m|ss|s|A|a/g;

function formatToken(date, token) {
    const pad = (n) => String(n).padStart(2, '0');
    const hour12 = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12;
    switch (token) {
        case 'YYYY': return String(date.getFullYear());
        case 'YY': return pad(date.getFullYear() % 100);
        case 'MMMM': return MONTH_NAMES[date.getMonth()];
        case 'MMM': return MONTH_NAMES[date.getMonth()].slice(0, 3);
        case 'MM': return pad(date.getMonth() + 1);
        case 'M': return String(date.getMonth() + 1);
        case 'dddd': return WEEKDAY_NAMES[date.getDay()];
        case 'ddd': return WEEKDAY_NAMES[date.getDay()].slice(0, 3);
        case 'DD': return pad(date.getDate());
        case 'D': return String(date.getDate());
        case 'HH': return pad(date.getHours());
        case 'H': return String(date.getHours());
        case 'hh': return pad(hour12);
        case 'h': return String(hour12);
        case 'mm': return pad(date.getMinutes());
        case 'm': return String(date.getMinutes());
        case 'ss': return pad(date.getSeconds());
        case 's': return String(date.getSeconds());
        case 'A': return date.getHours() < 12 ? 'AM' : 'PM';
        case 'a': return date.getHours() < 12 ? 'am' : 'pm';
        default: return token;
    }
}

/**
 * Formats with the common moment tokens (YYYY, MM, DD, HH, mm, ss, dddd, A, ...).
 * [Bracketed] text is emitted literally without the brackets.
 */
export function formatDate(date, format) {
    const pattern = String(format ?? '');
    let result = '';
    for (const part of pattern.split(/(\[[^\]]*\])/)) {
        if (part.startsWith('[') && part.endsWith(']')) {
            result += part.slice(1, -1);
        } else {
            result += part.replace(FORMAT_TOKEN, token => formatToken(date, token));
        }
    }
    return result;
}

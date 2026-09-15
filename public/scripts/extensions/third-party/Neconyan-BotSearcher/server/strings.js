/**
 * Text coercion for anything that came off a card site.
 *
 * This does NOT HTML-escape. Escaping is the DOM's job (the client writes with
 * textContent), and escaping here too would surface as literal "&amp;lt;" in the
 * UI. What it does is remove characters that let a string lie about what it is:
 * control codes, zero-width joiners used to smuggle text past a reader, and
 * bidi overrides that can visually reverse a name or a URL.
 */

/** C0/C1 controls, keeping tab and newline. CR is normalized away first. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Zero-width and bidi-override characters.
 * U+200B-200F  zero width space/joiners, LTR/RTL marks
 * U+202A-202E  embedding and override
 * U+2060-2064  invisible operators / word joiner
 * U+2066-2069  isolates
 * U+FEFF       BOM used mid-string
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string} always a string, never longer than maxLength
 */
export function str(value, maxLength) {
    if (value === null || value === undefined) {
        return '';
    }

    // Only coerce primitives. An object with a hostile toString/valueOf must not
    // get to run it, and "[object Object]" is not useful anyway.
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        return '';
    }
    if (type === 'number' && !Number.isFinite(value)) {
        return '';
    }

    let text = String(value);

    text = text.replace(/\r\n?/g, '\n');
    text = text.replace(CONTROL_CHARS, '');
    text = text.replace(INVISIBLE_CHARS, '');

    // Canonical composition, so visually identical strings compare equal.
    try {
        text = text.normalize('NFC');
    } catch {
        // Malformed surrogate pairs: keep the stripped form.
    }

    text = text.trim();

    if (typeof maxLength === 'number' && maxLength > 0 && text.length > maxLength) {
        text = text.slice(0, maxLength);
    }

    return text;
}

/**
 * A finite, non-negative integer, or null. Rejects Infinity, NaN, '1e309',
 * negatives and anything non-numeric rather than letting them reach the UI.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {number | null}
 */
export function intOrNull(value, max = Number.MAX_SAFE_INTEGER) {
    const type = typeof value;
    if (type !== 'number' && type !== 'string') {
        return null;
    }

    if (type === 'string' && !/^(?:0|[1-9]\d*)$/.test(value)) {
        return null;
    }

    const parsed = type === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return null;
    }

    return Math.min(parsed, max);
}

/**
 * A date-time with no trailing "Z" and no "+hh:mm" offset. ECMAScript says such
 * a string is LOCAL time, but the card sites emit UTC from Python's
 * datetime.isoformat(), which omits the designator. Parsing it as local shifts
 * every timestamp by the viewer's UTC offset.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * An ISO-8601 timestamp in UTC, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function isoOrNull(value) {
    if (typeof value !== 'string' || value === '') {
        return null;
    }

    const normalized = NAIVE_DATETIME.test(value)
        ? `${value.replace(' ', 'T')}Z`
        : value;

    const time = Date.parse(normalized);
    if (!Number.isFinite(time)) {
        return null;
    }

    return new Date(time).toISOString();
}

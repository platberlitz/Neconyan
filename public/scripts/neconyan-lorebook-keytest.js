import { parseWorldInfoKeyRegex } from './world-info-scan-core.js';

export const KEY_TEST_SAMPLE_LIMIT = 5000;
export const KEY_TEST_HIGHLIGHT_LIMIT = 200;
const MAX_RANGES_PER_KEY = 500;
const EXCERPT_RADIUS = 30;
const REGEX_SHAPE = /^\/([\w\W]+?)\/([gimsuy]*)$/;

export const SELECTIVE_LOGIC_LABELS = Object.freeze({ 0: 'AND ANY', 1: 'NOT ALL', 2: 'NOT ANY', 3: 'AND ALL' });

/**
 * Sorts a key the way SillyTavern does: a valid slash regex, a regex-shaped key that fails to compile, or plain text.
 * @param {unknown} key Raw key
 * @returns {'regex'|'invalid-regex'|'text'}
 */
export function classifyKey(key) {
    const text = typeof key === 'string' ? key.trim() : '';
    if (!REGEX_SHAPE.test(text)) return 'text';
    return parseWorldInfoKeyRegex(text) ? 'regex' : 'invalid-regex';
}

function escapeRegex(value) {
    return value.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function substringRanges(haystack, needle) {
    const ranges = [];
    if (!needle) return ranges;
    let from = 0;
    while (ranges.length < MAX_RANGES_PER_KEY) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) break;
        ranges.push({ start: index, end: index + needle.length });
        from = index + Math.max(needle.length, 1);
    }
    return ranges;
}

/**
 * Finds every place a plain-text key matches, honouring SillyTavern's case and whole-word rules.
 * @param {string} key Trimmed key
 * @param {string} text Text to search
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} options Matching options
 * @returns {{start: number, end: number}[]}
 */
export function findPlaintextRanges(key, text, { caseSensitive = false, matchWholeWords = false } = {}) {
    if (!key) return [];
    const haystack = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? key : key.toLowerCase();
    if (!matchWholeWords || needle.split(/\s+/).length > 1) return substringRanges(haystack, needle);
    const ranges = [];
    const boundary = new RegExp(`(?:^|(\\W))(${escapeRegex(needle)})(?:$|\\W)`, 'g');
    let match;
    while (ranges.length < MAX_RANGES_PER_KEY && (match = boundary.exec(haystack))) {
        const start = match.index + (match[1] !== undefined ? match[1].length : 0);
        ranges.push({ start, end: start + needle.length });
        boundary.lastIndex = start + Math.max(needle.length, 1);
    }
    return ranges;
}

/**
 * Finds where one key matches a sample, the way SillyTavern's keyword scan reads it.
 * Invalid regex keys fall back to plain text, as SillyTavern does.
 * @param {unknown} rawKey Key from the entry
 * @param {string} sample Sample text
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} options Matching options
 * @returns {{key: string, kind: 'regex'|'invalid-regex'|'text', ranges: {start: number, end: number}[]}}
 */
export function findKeyMatches(rawKey, sample, options = {}) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const text = String(sample ?? '').slice(0, KEY_TEST_SAMPLE_LIMIT);
    const kind = classifyKey(key);
    if (!key) return { key, kind, ranges: [] };
    if (kind !== 'regex') return { key, kind, ranges: findPlaintextRanges(key, text, options) };
    const parsed = parseWorldInfoKeyRegex(key);
    const ranges = [];
    try {
        if (parsed.global) {
            parsed.lastIndex = 0;
            let match;
            while (ranges.length < MAX_RANGES_PER_KEY && (match = parsed.exec(text))) {
                if (!match[0].length) {
                    parsed.lastIndex += 1;
                    continue;
                }
                ranges.push({ start: match.index, end: match.index + match[0].length });
            }
        } else {
            const match = parsed.exec(text);
            if (match && match[0].length) ranges.push({ start: match.index, end: match.index + match[0].length });
        }
    } catch {
        return { key, kind, ranges: [] };
    }
    return { key, kind, ranges };
}

function usableKeys(keys) {
    return Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.trim()) : [];
}

function secondaryGate(logic, matched) {
    switch (logic) {
        case 0: return matched.some(Boolean);
        case 1: return matched.some(hit => !hit);
        case 2: return matched.every(hit => !hit);
        case 3: return matched.every(Boolean);
        default: return false;
    }
}

function probabilityVerdict(entry) {
    const raw = Number(entry.probability ?? entry.extensions?.probability);
    const probability = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 100;
    const useProbability = (entry.useProbability ?? entry.extensions?.useProbability) !== false;
    return useProbability && probability < 100
        ? { outlook: 'probabilistic', reason: 'probability-roll', probability }
        : { outlook: 'inserted', reason: 'always', probability };
}

/**
 * Decides whether SillyTavern's keyword scan would insert an entry, given which keys matched.
 * @param {object} entry Native World Info entry
 * @param {{anyPrimaryMatched: boolean, secondaryMatched: boolean[]}} hits Key results
 * @returns {{outlook: string, reason: string, probability?: number}}
 */
export function evaluateTrigger(entry, { anyPrimaryMatched, secondaryMatched }) {
    if (entry.disable) return { outlook: 'blocked', reason: 'disabled' };
    if (entry.constant) return probabilityVerdict(entry);
    const silent = reason => entry.vectorized
        ? { outlook: 'inconclusive', reason: 'vector-similarity-only' }
        : { outlook: 'blocked', reason };
    if (!usableKeys(entry.key).length) return silent('no-keys');
    if (!anyPrimaryMatched) return silent('no-key-matched');
    if (entry.selective && secondaryMatched.length && !secondaryGate(Number(entry.selectiveLogic ?? 0), secondaryMatched)) {
        return { outlook: 'blocked', reason: 'secondary-logic-denied' };
    }
    return probabilityVerdict(entry);
}

function excerpt(text, range) {
    if (!range) return '';
    const start = Math.max(0, range.start - EXCERPT_RADIUS);
    const end = Math.min(text.length, range.end + EXCERPT_RADIUS);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Splits a sample into plain and highlighted runs. Longer matches win overlaps, then earlier ones, then primary keys.
 * @param {string} text Sample text
 * @param {{start: number, end: number, tone: 'primary'|'secondary', order: number}[]} ranges Match ranges
 * @returns {{segments: {text: string, tone: 'none'|'primary'|'secondary'}[], clamped: boolean}}
 */
export function highlightSegments(text, ranges) {
    const clamped = ranges.length > KEY_TEST_HIGHLIGHT_LIMIT;
    const candidates = [...ranges]
        .sort((a, b) => (b.end - b.start) - (a.end - a.start)
            || a.start - b.start
            || (a.tone === b.tone ? 0 : a.tone === 'primary' ? -1 : 1)
            || a.order - b.order)
        .slice(0, KEY_TEST_HIGHLIGHT_LIMIT);
    const paint = new Array(text.length).fill('none');
    for (const range of candidates) {
        for (let index = range.start; index < range.end && index < text.length; index++) {
            if (paint[index] === 'none') paint[index] = range.tone;
        }
    }
    const segments = [];
    for (let index = 0; index < text.length; index++) {
        const last = segments.at(-1);
        if (last && last.tone === paint[index]) last.text += text[index];
        else segments.push({ text: text[index], tone: paint[index] });
    }
    return { segments, clamped };
}

/**
 * Whether the Test keys panel has anything to test for this entry.
 * @param {object} entry Native World Info entry
 * @returns {boolean}
 */
export function canTestEntryKeys(entry) {
    if (!entry || entry.constant) return false;
    return usableKeys(entry.key).length > 0 || (Boolean(entry.selective) && usableKeys(entry.keysecondary).length > 0);
}

/**
 * Tests every key of an entry against a sample text and returns the verdict SillyTavern's keyword scan would reach.
 * @param {object} entry Native World Info entry
 * @param {string} sample Sample text
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} defaults Global World Info matching settings for unset entry options
 */
export function testEntryKeys(entry, sample, defaults = {}) {
    const text = String(sample ?? '').slice(0, KEY_TEST_SAMPLE_LIMIT);
    const options = {
        caseSensitive: Boolean(entry.caseSensitive ?? defaults.caseSensitive ?? false),
        matchWholeWords: Boolean(entry.matchWholeWords ?? defaults.matchWholeWords ?? false),
    };
    const logic = Number(entry.selectiveLogic ?? 0);
    const row = (key, group, order) => {
        const result = findKeyMatches(key, text, options);
        return { ...result, group, order, matched: result.ranges.length > 0, excerpt: excerpt(text, result.ranges[0]) };
    };
    const primary = usableKeys(entry.key).map((key, index) => row(key, 'primary', index));
    const secondary = entry.selective ? usableKeys(entry.keysecondary).map((key, index) => row(key, 'secondary', index)) : [];
    const verdict = evaluateTrigger(entry, {
        anyPrimaryMatched: primary.some(item => item.matched),
        secondaryMatched: secondary.map(item => item.matched),
    });
    if (verdict.reason === 'secondary-logic-denied' && (logic === 1 || logic === 2)) {
        for (const item of secondary) item.blocks = item.matched;
    }
    const ranges = [...primary, ...secondary].flatMap(item => item.ranges.map(range => ({ ...range, tone: item.group, order: item.order })));
    return {
        text,
        options,
        logic,
        logicLabel: SELECTIVE_LOGIC_LABELS[logic] ?? String(logic),
        primary,
        secondary,
        verdict,
        ...highlightSegments(text, ranges),
    };
}

/**
 * Plain-language sentence for a Test keys verdict.
 * @param {{verdict: {reason: string, probability?: number}, logic: number, logicLabel: string}} result Result from testEntryKeys
 * @returns {string}
 */
export function keyTestVerdictText({ verdict, logic, logicLabel }) {
    const blocked = 'Would not be inserted';
    switch (verdict.reason) {
        case 'disabled': return `${blocked} - the entry is disabled.`;
        case 'no-keys': return `${blocked} - the entry has no primary keys, so the keyword scan skips it.`;
        case 'no-key-matched': return `${blocked} - no primary key matches this sample.`;
        case 'secondary-logic-denied':
            if (logic === 1 || logic === 2) return `${blocked} - the matched "${logicLabel}" secondary keys block activation.`;
            if (logic === 0) return `${blocked} - no "${logicLabel}" secondary key matches this sample.`;
            if (logic === 3) return `${blocked} - not every "${logicLabel}" secondary key matches this sample.`;
            return `${blocked} - the entry's secondary-key logic denies activation.`;
        case 'probability-roll': return `Depends on a roll - inserted ${verdict.probability}% of the time.`;
        case 'vector-similarity-only': return 'Keys stayed silent - Vector Storage may still insert this by similarity, which cannot be tested here.';
        default: return 'Would be inserted into the context for this sample.';
    }
}

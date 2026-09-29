/**
 * Content delimiter rules, ported from LoreStitch 1.8 (src/app/core/models/delimiters.ts).
 *
 *   tag:       <London>\ncontent\n</London>
 *   bracket:   [London=\ncontent]
 *   markdown:  ## London\n\ncontent          (optional trailing ---)
 *   separator: content\n\n---
 *
 * Every function is pure and never throws. Wrapping then unwrapping a non-blank payload
 * returns it byte for byte, and blank payloads are never wrapped.
 */

export const DELIMITER_STYLES = Object.freeze(['tag', 'bracket', 'markdown', 'separator', 'none']);

const TAG_RE = /^\s*<([^<>\n]{1,80})>\r?\n?([\s\S]*?)\r?\n?<\/\1>\s*$/;
const BRACKET_RE = /^\s*\[([^\]\n=]{1,80})=\r?\n?([\s\S]*?)\r?\n?\]\s*$/;
const SEPARATOR_RE = /^([\s\S]+?)\r?\n(?:\r?\n)?[ \t]*-{3,}[ \t]*$/;
const BARE_SEPARATOR_RE = /^\s*-{3,}\s*$/;
const MARKDOWN_RE = /^[ \t]*(#{1,6})[ \t]+([^\r\n]*)\r?\n(?:\r?\n)?([\s\S]*)$/;

function stripTrailingSeparatorRun(text) {
    if (BARE_SEPARATOR_RE.test(text)) return '';
    const run = /\r?\n(?:\r?\n)?[ \t]*-{3,}[ \t]*$/.exec(text);
    return run ? text.slice(0, run.index) : text;
}

function matchMarkdownShape(text) {
    const match = MARKDOWN_RE.exec(text);
    if (!match) return null;
    const name = (match[2] ?? '').trim();
    const payload = match[3] ?? '';
    if (name === '' || [...name].length > 80) return null;
    if (stripTrailingSeparatorRun(payload).trim() === '') return null;
    return { level: match[1].length, name, payload };
}

/** @returns {{ style: string, name: string, level?: number }} */
export function detectDelimiter(content) {
    const text = String(content ?? '');
    const tag = TAG_RE.exec(text);
    if (tag) return { style: 'tag', name: tag[1]?.trim() ?? '' };
    const bracket = BRACKET_RE.exec(text);
    if (bracket) return { style: 'bracket', name: bracket[1]?.trim() ?? '' };
    const markdown = matchMarkdownShape(text);
    if (markdown) return { style: 'markdown', name: markdown.name, level: markdown.level };
    if (SEPARATOR_RE.test(text)) return { style: 'separator', name: '' };
    return { style: 'none', name: '' };
}

export function sanitizeDelimiterName(name) {
    const collapsed = String(name ?? '').replace(/[<>=[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
    return [...collapsed].slice(0, 80).join('');
}

export function delimiterNameMatches(name, expectedNames) {
    const normalized = sanitizeDelimiterName(name).toLowerCase();
    return expectedNames.some(expected => sanitizeDelimiterName(expected).toLowerCase() === normalized);
}

/** Wraps delimiter-free content. `options` only affects markdown: `{ level = 2, trailingSeparator }`. */
export function wrapContent(content, style, name = '', options = {}) {
    const body = String(content ?? '');
    if (body.trim() === '') return body;
    const safeName = sanitizeDelimiterName(name) || 'entry';
    switch (style) {
        case 'tag': return `<${safeName}>\n${body}\n</${safeName}>`;
        case 'bracket': return `[${safeName}=\n${body}]`;
        case 'markdown': {
            if (BARE_SEPARATOR_RE.test(body)) return body;
            const level = normalizeHeadingLevel(options.level);
            return `${'#'.repeat(level)} ${safeName}\n\n${body}${options.trailingSeparator ? '\n\n---' : ''}`;
        }
        case 'separator': return BARE_SEPARATOR_RE.test(body) ? body : `${body}\n\n---`;
        default: return body;
    }
}

export function normalizeHeadingLevel(level) {
    const value = Number(level);
    return Number.isInteger(value) && value >= 1 && value <= 6 ? value : 2;
}

/**
 * Strips a recognised wrapper. With `expectedNames`, wrappers whose name matches none of them stay
 * as content, and a trailing `---` is only stripped when `stripSeparator` is set.
 */
export function unwrapContent(content, { expectedNames, stripSeparator = expectedNames === undefined } = {}) {
    const text = String(content ?? '');
    const detected = detectDelimiter(text);
    switch (detected.style) {
        case 'tag':
            if (expectedNames && !delimiterNameMatches(detected.name, expectedNames)) return text;
            return TAG_RE.exec(text)?.[2] ?? text;
        case 'bracket':
            if (expectedNames && !delimiterNameMatches(detected.name, expectedNames)) return text;
            return BRACKET_RE.exec(text)?.[2] ?? text;
        case 'markdown': {
            const markdown = matchMarkdownShape(text);
            if (!markdown) return text;
            if (expectedNames && !delimiterNameMatches(markdown.name, expectedNames)) {
                return stripSeparator ? (SEPARATOR_RE.exec(text)?.[1] ?? text) : text;
            }
            const inner = markdown.payload;
            return stripSeparator ? (SEPARATOR_RE.exec(inner)?.[1] ?? inner) : inner;
        }
        case 'separator':
            return stripSeparator ? (SEPARATOR_RE.exec(text)?.[1] ?? text) : text;
        default:
            return text;
    }
}

/**
 * Applies `style` to content that may already carry a delimiter. A trailing `---` is treated as
 * the old delimiter and replaced; a `---` scene break inside a tag or bracket wrapper survives.
 */
export function rewrapContent(content, style, name = '', expectedNames, options = {}) {
    let inner = unwrapContent(content, { expectedNames, stripSeparator: true });
    if (style === 'markdown') inner = stripTrailingSeparatorRun(inner);
    return style === 'none' ? inner : wrapContent(inner, style, name, options);
}

const MALFORMED_TAG_RE = /^\s*<([^<>\n]{1,80})>\r?\n?([\s\S]*?)\r?\n?<\/([^<>\n]{1,80})>\s*$/;
const ORPHAN_OPEN_TAG_RE = /^\s*<([^<>\n]{1,80})>[ \t]*(?:\r\n|\n|\r)([\s\S]*)$/;
const ORPHAN_OPEN_BRACKET_RE = /^\s*\[([^\]\n=]{1,80})=[ \t]*(?:\r\n|\n|\r)([\s\S]*)$/;
const ORPHAN_CLOSE_TAG_RE = /^([\s\S]*?)(?:\r\n|\n|\r)[ \t]*<\/([^<>\n]{1,80})>\s*$/;
const EMPTY_HEADER_RE = /^[ \t]*(#{1,6})[ \t]*\r?\n(?:\r?\n)?([\s\S]*)$/;
const NO_SPACE_HEADER_RE = /^[ \t]*(#{1,6})([^#\s][^\r\n]*)\r?\n(?:\r?\n)?([\s\S]*)$/;
const OPENER_LINE_PREFIX_RE = /^\s*<[^<>\n]*>[ \t]*(?:\r\n|\n|\r)/;
const CLOSER_LINE_RE = /^[ \t]*<\/[^<>\n]*>[ \t]*\r?$/;

function endsWithCloserLine(text) {
    return CLOSER_LINE_RE.test(text.replace(/\s+$/, '').split(/\r\n|\n|\r/).pop() ?? '');
}

function matchMalformedShape(text) {
    const mismatched = MALFORMED_TAG_RE.exec(text);
    if (mismatched) {
        const [, openingName = '', payload = '', closingName = ''] = mismatched;
        if (openingName !== closingName && payload.trim() !== ''
            && sanitizeDelimiterName(openingName) !== '' && sanitizeDelimiterName(closingName) !== '') {
            return { malformed: { kind: 'mismatched', openingName, closingName }, payload };
        }
        return null;
    }
    const orphanOpenTag = ORPHAN_OPEN_TAG_RE.exec(text);
    if (orphanOpenTag) {
        const [, name = '', payload = ''] = orphanOpenTag;
        if (payload.trim() !== '' && sanitizeDelimiterName(name) !== '' && !endsWithCloserLine(text)) {
            return { malformed: { kind: 'orphan-open', name }, payload };
        }
        return null;
    }
    const orphanOpenBracket = ORPHAN_OPEN_BRACKET_RE.exec(text);
    if (orphanOpenBracket) {
        const [, name = '', payload = ''] = orphanOpenBracket;
        if (payload.trim() !== '' && sanitizeDelimiterName(name) !== '' && !/\]\s*$/.test(text)) {
            return { malformed: { kind: 'orphan-open', name }, payload };
        }
        return null;
    }
    const orphanClose = ORPHAN_CLOSE_TAG_RE.exec(text);
    if (orphanClose) {
        const [, payload = '', name = ''] = orphanClose;
        if (payload.trim() !== '' && sanitizeDelimiterName(name) !== '' && !OPENER_LINE_PREFIX_RE.test(text)) {
            return { malformed: { kind: 'orphan-close', name }, payload };
        }
        return null;
    }
    const emptyHeader = EMPTY_HEADER_RE.exec(text);
    if (emptyHeader) {
        const [, hashes = '', payload = ''] = emptyHeader;
        if (stripTrailingSeparatorRun(payload).trim() !== '') {
            return { malformed: { kind: 'empty-header', level: hashes.length }, payload };
        }
        return null;
    }
    const noSpaceHeader = NO_SPACE_HEADER_RE.exec(text);
    if (noSpaceHeader) {
        const name = (noSpaceHeader[2] ?? '').trim();
        const payload = noSpaceHeader[3] ?? '';
        if (name !== '' && [...name].length <= 80 && stripTrailingSeparatorRun(payload).trim() !== '') {
            return { malformed: { kind: 'no-space-header', name }, payload };
        }
    }
    return null;
}

/**
 * Classifies a broken whole-content wrapper, or returns null. Mismatched pairs and empty headings
 * always count; unclosed tags and `#Name` headings only count when their name is in `hints`.
 */
export function detectMalformedWrapper(content, hints = []) {
    const text = String(content ?? '');
    if (detectDelimiter(text).style !== 'none') return null;
    const shape = matchMalformedShape(text);
    if (!shape) return null;
    if (shape.malformed.kind === 'mismatched' || shape.malformed.kind === 'empty-header') return shape.malformed;
    return delimiterNameMatches(shape.malformed.name, hints ?? []) ? shape.malformed : null;
}

export function malformedWrapperLabel(malformed) {
    switch (malformed?.kind) {
        case 'mismatched': return `<${malformed.openingName}> ? </${malformed.closingName}>`;
        case 'orphan-open': return `<${malformed.name}> ?`;
        case 'orphan-close': return `? </${malformed.name}>`;
        case 'empty-header': return `${'#'.repeat(malformed.level)} ?`;
        case 'no-space-header': return `#${malformed.name} ?`;
        default: return '';
    }
}

/** Short word for the chip on a broken wrapper row. */
export function malformedWrapperChip(malformed) {
    if (malformed?.kind === 'mismatched') return 'mismatched';
    if (malformed?.kind === 'empty-header' || malformed?.kind === 'no-space-header') return 'broken heading';
    return malformed ? 'unclosed' : '';
}

/** Removes one broken outer wrapper and returns the payload untouched. */
export function stripMalformedWrapper(content) {
    const text = String(content ?? '');
    if (detectDelimiter(text).style !== 'none') return text;
    return matchMalformedShape(text)?.payload ?? text;
}

export function delimiterLabel(detected) {
    switch (detected?.style) {
        case 'tag': return `<${detected.name}>`;
        case 'bracket': return `[${detected.name}=…]`;
        case 'markdown': return `${'#'.repeat(detected.level ?? 2)} ${detected.name}`;
        case 'separator': return '---';
        default: return '';
    }
}

/** Default wrapper name for a native World Info entry: title, then name, then first key. */
export function entryDelimiterName(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    const raw = String(entry?.comment ?? '').trim() || String(entry?.name ?? '').trim()
        || String(keys.find(key => String(key).trim()) ?? '').trim();
    return sanitizeDelimiterName(raw) || 'entry';
}

export function entryDelimiterNameFromKey(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    return sanitizeDelimiterName(keys.find(key => String(key).trim()) ?? '') || entryDelimiterName(entry);
}

function isNamedWrapper(detected) {
    return (detected.style === 'tag' || detected.style === 'bracket') && sanitizeDelimiterName(detected.name) !== '';
}

/**
 * Plans one entry's delimiter change the way LoreStitch's delimiter pane does: the wrapper it
 * already has (whatever its name) is replaced rather than nested, and a broken wrapper is removed
 * before the new one is added.
 */
export function planEntryDelimiter(entry, { style, name, level, trailingSeparator } = {}) {
    const current = String(entry?.content ?? '');
    const detected = detectDelimiter(current);
    const expectedNames = [...new Set([
        name, entryDelimiterName(entry), entryDelimiterNameFromKey(entry), isNamedWrapper(detected) ? detected.name : '',
    ].map(item => String(item ?? '').trim()).filter(Boolean))];
    const malformed = detectMalformedWrapper(current, expectedNames);
    const source = malformed ? stripMalformedWrapper(current) : current;
    const next = rewrapContent(source, style, name, expectedNames, { level, trailingSeparator });
    const stripped = isNamedWrapper(detected) || detected.style === 'separator'
        || (detected.style === 'markdown' && delimiterNameMatches(detected.name, expectedNames));
    return {
        current,
        next,
        changed: next !== current,
        replaced: stripped && next !== current ? delimiterLabel(detected) : null,
        malformed,
    };
}

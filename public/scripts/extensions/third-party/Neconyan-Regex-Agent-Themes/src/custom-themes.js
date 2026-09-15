/**
 * Strict validation for the public custom-theme format. Custom themes keep the safe,
 * composable token groups and deliberately exclude the bundled themes' trusted raw HTML
 * and CSS escape hatches.
 */

import { HOST } from './tokens.js';
import { THEME_BY_SLUG } from './themes/index.js';
import { STOCK_THEME } from './constants.js';

// This is a persisted format identifier, not a display name.
export const CUSTOM_THEME_FORMAT = 'sillybunny-regex-agent-themes';
export const CUSTOM_THEME_VERSION = 1;
export const CUSTOM_THEME_LIMITS = Object.freeze({
    fileBytes: 256 * 1024,
    themes: 64,
    themeBytes: 8 * 1024,
});

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_SLUGS = new Set([STOCK_THEME, ...DANGEROUS_KEYS]);
const MODES = new Set(['light', 'dark', 'adaptive']);
const FRAMES = new Set(['brackets', 'rivets', 'ticks', 'halftone', 'diecut', 'bevel']);
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double']);
const EDGE_SIDES = new Set(['left', 'top', 'none']);
const TEXT_CASES = new Set(['none', 'uppercase', 'lowercase', 'capitalize']);
const HOST_COLORS = new Set([HOST.body, HOST.tint, HOST.quote, HOST.em, HOST.shadow]);
const ROOT_KEYS = new Set([
    'slug', 'name', 'family', 'mode', 'surface', 'ink', 'line', 'shadow', 'accents',
    'radius', 'space', 'type', 'glyph', 'frame', 'scan', 'term', 'speakerHue',
]);
const EXPORT_KEYS = new Set(['format', 'version', 'themes']);

const GROUPS = Object.freeze({
    surface: {
        headFrom: 'color', headTo: 'color', bodyFrom: 'color', bodyTo: 'color',
        row: 'color', rowAlt: 'color', inset: 'color', chip: 'color',
    },
    ink: {
        head: 'color', body: 'color', label: 'color', muted: 'color',
        strong: 'color', warm: 'color', cool: 'color',
    },
    line: {
        head: 'color', body: 'color', row: 'color', width: 'length1',
        style: 'borderStyle', edge: 'length1', edgeSide: 'edgeSide',
    },
    shadow: { head: 'shadow', body: 'shadow', chip: 'shadow' },
    radius: {
        head: 'length4', body: 'length4', row: 'length4', slot: 'length4',
        pill: 'length4', chip: 'length4',
    },
    space: {
        outer: 'length1', headPadY: 'length1', headPadX: 'length1', bodyPad: 'length4',
        rowPadY: 'length1', rowPadX: 'length1', slotPadY: 'length1', slotPadX: 'length1',
        gap: 'length1', rowGap: 'length1', pillPad: 'length4', pillMarginTop: 'length1',
        chipPad: 'length4', chipMargin: 'length4',
    },
    type: {
        family: 'font', bodyFamily: 'font', headSize: 'size', bodySize: 'size',
        labelSize: 'size', valueSize: 'size', chipSize: 'size', lineHeight: 'lineHeight',
        headWeight: 'weight', labelWeight: 'weight', valueWeight: 'weight',
        headCase: 'textCase', headTracking: 'tracking', labelCase: 'textCase',
    },
    glyph: {
        section: 'glyph', sectionAlt: 'glyph', bullet: 'glyph', sep: 'glyph',
        chipSep: 'glyph', chevron: 'glyph', arrow: 'glyph', pairSep: 'glyph',
    },
});

const TERM_KEYS = Object.freeze({
    bg: 'color', panel: 'color', accent: 'color', accentDim: 'color', text: 'color',
    muted: 'color', border: 'color', glow: 'color', gold: 'color', font: 'font',
});

const CONTROL_OR_INTERPOLATION = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\{\{|\$[0-9]|\$</u;
const CSS_ESCAPE = /[;{}<>\\]|\/\*|\*\/|url\s*\(|@import|(?:https?|data|javascript)\s*:/iu;
const NUMBER = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const LENGTH = new RegExp(`^(-?${NUMBER})(px|em|rem)$`);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

class ThemeValidationError extends Error {
    constructor(path, message) {
        super(`${path} ${message}`);
    }
}

function byteLength(value) {
    return new TextEncoder().encode(value).length;
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, path) {
    if (!isPlainRecord(value)) {
        throw new ThemeValidationError(path, 'must be a plain object.');
    }
}

function assertSafeTree(value, path = 'theme', depth = 0, ancestors = new WeakSet()) {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (depth > 4) {
        throw new ThemeValidationError(path, 'is nested too deeply.');
    }
    if (ancestors.has(value)) {
        throw new ThemeValidationError(path, 'must not contain a cycle.');
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new ThemeValidationError(path, 'must contain only plain objects and arrays.');
    }
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) {
            throw new ThemeValidationError(path, 'contains a forbidden property name.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new ThemeValidationError(`${path}.${key}`, 'must be a data property.');
        }
        assertSafeTree(descriptor.value, `${path}.${key}`, depth + 1, ancestors);
    }
    ancestors.delete(value);
}

function rejectUnknownKeys(value, allowed, path) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new ThemeValidationError(`${path}.${key}`, 'is not supported.');
        }
    }
}

function requireString(value, path, maxLength) {
    if (typeof value !== 'string' || value.length > maxLength) {
        throw new ThemeValidationError(path, `must be a string no longer than ${maxLength} characters.`);
    }
    if (CONTROL_OR_INTERPOLATION.test(value)) {
        throw new ThemeValidationError(path, 'contains a control character, macro, or replacement placeholder.');
    }
    return value.trim();
}

function safeCssString(value, path, maxLength = 256) {
    const clean = requireString(value, path, maxLength);
    if (!clean || CSS_ESCAPE.test(clean)) {
        throw new ThemeValidationError(path, 'contains unsafe or unsupported CSS syntax.');
    }
    return clean;
}

function splitTopLevel(value, delimiter) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth < 0) return null;
        } else if (char === delimiter && depth === 0) {
            out.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    if (depth !== 0) return null;
    out.push(value.slice(start).trim());
    return out;
}

function splitTopLevelWhitespace(value) {
    const out = [];
    let depth = 0;
    let start = -1;
    for (let index = 0; index <= value.length; index++) {
        const char = value[index] ?? ' ';
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (/\s/u.test(char) && depth === 0) {
            if (start >= 0) out.push(value.slice(start, index));
            start = -1;
        } else if (start < 0) {
            start = index;
        }
    }
    return out;
}

function validRgb(value) {
    const match = /^(rgb|rgba)\((.*)\)$/iu.exec(value);
    if (!match) return false;
    const parts = match[2].split(',').map(part => part.trim());
    const expected = match[1].toLowerCase() === 'rgba' ? 4 : 3;
    if (parts.length !== expected) return false;
    if (!parts.slice(0, 3).every(part => /^\d{1,3}$/u.test(part)
        && Number(part) >= 0 && Number(part) <= 255)) {
        return false;
    }
    return expected === 3 || new RegExp(`^${NUMBER}$`).test(parts[3])
        && Number(parts[3]) >= 0 && Number(parts[3]) <= 1;
}

function validOklch(value) {
    const match = new RegExp(
        `^oklch\\(\\s*(${NUMBER})%\\s+(${NUMBER})\\s+(-?${NUMBER})(?:deg)?`
        + `(?:\\s*\\/\\s*(${NUMBER})(%)?)?\\s*\\)$`,
        'iu',
    ).exec(value);
    if (!match) return false;
    const lightness = Number(match[1]);
    const chroma = Number(match[2]);
    const hue = Number(match[3]);
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    return lightness >= 0 && lightness <= 100
        && chroma >= 0 && chroma <= 0.5
        && hue >= -360 && hue <= 360
        && alpha >= 0 && alpha <= (match[5] ? 100 : 1);
}

function parseColorStop(value) {
    const match = /^(.*\S)\s+([0-9]+(?:\.[0-9]+)?)%$/u.exec(value);
    if (!match) return { color: value, percent: null };
    return { color: match[1], percent: Number(match[2]) };
}

function validColor(value, mode, depth = 0) {
    if (depth > 4 || typeof value !== 'string') return false;
    const clean = value.trim();
    if (!clean || clean.length > 160 || CONTROL_OR_INTERPOLATION.test(clean) || CSS_ESCAPE.test(clean)) {
        return false;
    }
    if (clean === 'transparent' || HEX.test(clean) || validRgb(clean) || validOklch(clean)) {
        return true;
    }
    if (mode !== 'adaptive') return false;
    if (HOST_COLORS.has(clean)) return true;
    if (!clean.startsWith('color-mix(') || !clean.endsWith(')')) return false;
    const parts = splitTopLevel(clean.slice(10, -1), ',');
    if (!parts || parts.length !== 3 || parts[0].toLowerCase() !== 'in srgb') return false;
    for (const rawStop of parts.slice(1)) {
        const stop = parseColorStop(rawStop);
        if (stop.percent !== null && (stop.percent < 0 || stop.percent > 100)) return false;
        if (!validColor(stop.color, mode, depth + 1)) return false;
    }
    return true;
}

function validateColor(value, path, mode) {
    const clean = requireString(value, path, 160);
    if (!validColor(clean, mode)) {
        throw new ThemeValidationError(path, 'must be a supported literal color or adaptive host color.');
    }
    return clean;
}

function parseLength(value, { allowNegative = false, allowZero = true } = {}) {
    if (value === '0') return allowZero ? 0 : null;
    const match = LENGTH.exec(value);
    if (!match) return null;
    const number = Number(match[1]);
    if (!allowNegative && number < 0) return null;
    if (Math.abs(number) > 1000) return null;
    return number;
}

function validateLengths(value, path, maxParts, options = {}) {
    const clean = safeCssString(value, path, 64);
    const parts = clean.split(/\s+/u);
    if (parts.length < 1 || parts.length > maxParts
        || parts.some(part => parseLength(part, options) === null)) {
        throw new ThemeValidationError(path, `must contain 1-${maxParts} bounded px, em, or rem values.`);
    }
    return clean;
}

function validateShadow(value, path, mode) {
    const clean = safeCssString(value, path, 256);
    if (clean === 'none' || clean === '') return clean;
    const layers = splitTopLevel(clean, ',');
    if (!layers || layers.length > 4) {
        throw new ThemeValidationError(path, 'must contain at most four box-shadow layers.');
    }
    for (const layer of layers) {
        const tokens = splitTopLevelWhitespace(layer);
        if (tokens[0] === 'inset') tokens.shift();
        const lengths = [];
        while (tokens.length && parseLength(tokens[0], { allowNegative: true }) !== null) {
            lengths.push(tokens.shift());
        }
        if (lengths.length < 2 || lengths.length > 4 || tokens.length !== 1
            || !validColor(tokens[0], mode)) {
            throw new ThemeValidationError(path, 'must use bounded lengths followed by a supported color.');
        }
    }
    return clean;
}

function validateFont(value, path, mode) {
    const clean = safeCssString(value, path, 128);
    if (clean === 'inherit' || mode === 'adaptive' && clean === HOST.font) {
        return clean;
    }
    const families = clean.split(',').map(part => part.trim());
    if (!families.length || families.length > 8 || families.some((family) => {
        const quoted = /^(['"])([A-Za-z0-9 ._-]{1,64})\1$/u.test(family);
        const bare = /^[A-Za-z][A-Za-z0-9 -]{0,63}$/u.test(family);
        return !quoted && !bare;
    })) {
        throw new ThemeValidationError(path, 'must be a local font-family stack.');
    }
    return clean;
}

function validateGlyph(value, path) {
    const clean = requireString(value, path, 32);
    if ([...clean].length > 16 || /[<>&]/u.test(clean)) {
        throw new ThemeValidationError(path, 'must be at most 16 printable characters without HTML syntax.');
    }
    return clean;
}

function validateKind(kind, value, path, mode) {
    switch (kind) {
        case 'color': return validateColor(value, path, mode);
        case 'length1': return validateLengths(value, path, 1);
        case 'length4': return validateLengths(value, path, 4);
        case 'size': return validateLengths(value, path, 1, { allowZero: false });
        case 'shadow': return validateShadow(value, path, mode);
        case 'font': return validateFont(value, path, mode);
        case 'glyph': return validateGlyph(value, path);
        case 'borderStyle': {
            if (!BORDER_STYLES.has(value)) throw new ThemeValidationError(path, 'uses an unsupported border style.');
            return value;
        }
        case 'edgeSide': {
            if (!EDGE_SIDES.has(value)) throw new ThemeValidationError(path, 'must be left, top, or none.');
            return value;
        }
        case 'textCase': {
            if (!TEXT_CASES.has(value)) throw new ThemeValidationError(path, 'uses an unsupported text transform.');
            return value;
        }
        case 'weight': {
            if (typeof value !== 'string' || !/^[1-9]00$/u.test(value)) {
                throw new ThemeValidationError(path, 'must be a weight from 100 through 900.');
            }
            return value;
        }
        case 'tracking': {
            if (value === 'normal') return value;
            return validateLengths(value, path, 1, { allowNegative: true });
        }
        case 'lineHeight': {
            const clean = safeCssString(value, path, 16);
            const number = Number(clean);
            if (!new RegExp(`^${NUMBER}$`).test(clean) || number < 0.8 || number > 3) {
                throw new ThemeValidationError(path, 'must be a unitless value from 0.8 through 3.');
            }
            return clean;
        }
        default: throw new ThemeValidationError(path, 'uses an unknown token type.');
    }
}

function validateGroup(value, path, schema, mode, { complete = false } = {}) {
    requireRecord(value, path);
    const allowed = new Set(Object.keys(schema));
    rejectUnknownKeys(value, allowed, path);
    if (complete) {
        for (const key of allowed) {
            if (!Object.hasOwn(value, key)) {
                throw new ThemeValidationError(`${path}.${key}`, 'is required.');
            }
        }
    }
    const clean = {};
    for (const [key, raw] of Object.entries(value)) {
        clean[key] = validateKind(schema[key], raw, `${path}.${key}`, mode);
    }
    return clean;
}

/** Validates and canonicalizes one partial custom theme. */
export function validateCustomTheme(slug, raw) {
    try {
        if (typeof slug !== 'string' || slug.length < 2 || slug.length > 48 || !SLUG.test(slug)) {
            throw new ThemeValidationError('slug', 'must be 2-48 lowercase letters, numbers, and single hyphens.');
        }
        if (RESERVED_SLUGS.has(slug) || THEME_BY_SLUG.has(slug)) {
            throw new ThemeValidationError('slug', 'is reserved or already used by a bundled theme.');
        }
        requireRecord(raw, 'theme');
        assertSafeTree(raw);
        let serialized;
        try {
            serialized = JSON.stringify(raw);
        } catch {
            throw new ThemeValidationError('theme', 'must be serializable JSON.');
        }
        if (byteLength(serialized) > CUSTOM_THEME_LIMITS.themeBytes) {
            throw new ThemeValidationError('theme', `must be smaller than ${CUSTOM_THEME_LIMITS.themeBytes} bytes.`);
        }
        rejectUnknownKeys(raw, ROOT_KEYS, 'theme');
        if (Object.hasOwn(raw, 'slug') && raw.slug !== slug) {
            throw new ThemeValidationError('theme.slug', 'must match its map key.');
        }
        if (Object.hasOwn(raw, 'family') && raw.family !== 'custom') {
            throw new ThemeValidationError('theme.family', 'must be custom when provided.');
        }
        const mode = raw.mode ?? 'dark';
        if (!MODES.has(mode)) {
            throw new ThemeValidationError('theme.mode', 'must be light, dark, or adaptive.');
        }
        const name = Object.hasOwn(raw, 'name') ? requireString(raw.name, 'theme.name', 80) : slug;
        if (!name || /[<>&]/u.test(name)) {
            throw new ThemeValidationError('theme.name', 'must be printable text without HTML syntax.');
        }

        const clean = { slug, name, family: 'custom', mode };
        for (const [group, schema] of Object.entries(GROUPS)) {
            if (Object.hasOwn(raw, group)) {
                clean[group] = validateGroup(raw[group], `theme.${group}`, schema, mode);
            }
        }
        if (Object.hasOwn(raw, 'accents')) {
            if (!Array.isArray(raw.accents) || raw.accents.length !== 7) {
                throw new ThemeValidationError('theme.accents', 'must contain exactly seven colors.');
            }
            clean.accents = raw.accents.map((color, index) => validateColor(
                color,
                `theme.accents[${index}]`,
                mode,
            ));
        }
        if (Object.hasOwn(raw, 'frame')) {
            if (raw.frame !== null && !FRAMES.has(raw.frame)) {
                throw new ThemeValidationError('theme.frame', 'uses an unsupported frame.');
            }
            clean.frame = raw.frame;
        }
        if (Object.hasOwn(raw, 'scan')) {
            if (raw.scan === null) {
                clean.scan = null;
            } else {
                requireRecord(raw.scan, 'theme.scan');
                rejectUnknownKeys(raw.scan, new Set(['color', 'size']), 'theme.scan');
                if (!Object.hasOwn(raw.scan, 'color') || !Object.hasOwn(raw.scan, 'size')) {
                    throw new ThemeValidationError('theme.scan', 'requires color and size.');
                }
                clean.scan = {
                    color: validateColor(raw.scan.color, 'theme.scan.color', mode),
                    size: validateLengths(raw.scan.size, 'theme.scan.size', 1, { allowZero: false }),
                };
            }
        }
        if (Object.hasOwn(raw, 'term')) {
            if (raw.term === null) {
                clean.term = null;
            } else {
                clean.term = validateGroup(raw.term, 'theme.term', TERM_KEYS, mode, { complete: true });
            }
        }
        if (Object.hasOwn(raw, 'speakerHue')) {
            if (typeof raw.speakerHue !== 'boolean') {
                throw new ThemeValidationError('theme.speakerHue', 'must be true or false.');
            }
            clean.speakerHue = raw.speakerHue;
        }
        return { ok: true, theme: clean };
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof ThemeValidationError ? error.message : 'theme could not be validated.',
        };
    }
}

/** Validates a slug-keyed map, retaining diagnostics for import previews. */
export function validateCustomThemeMap(raw) {
    const themes = {};
    const accepted = [];
    const rejected = [];
    if (!isPlainRecord(raw)) {
        return { themes, accepted, rejected: [{ slug: 'themes', reason: 'must be a plain object.' }] };
    }
    let index = 0;
    for (const [slug, theme] of Object.entries(raw)) {
        index++;
        if (index > CUSTOM_THEME_LIMITS.themes) {
            rejected.push({ slug, reason: `exceeds the ${CUSTOM_THEME_LIMITS.themes}-theme limit.` });
            continue;
        }
        const result = validateCustomTheme(slug, theme);
        if (!result.ok) {
            rejected.push({ slug, reason: result.reason });
            continue;
        }
        themes[slug] = result.theme;
        accepted.push(slug);
    }
    return { themes, accepted, rejected };
}

/** Builds a validated, versioned export payload. */
export function createCustomThemeExport(rawThemes) {
    const { themes } = validateCustomThemeMap(rawThemes);
    return { format: CUSTOM_THEME_FORMAT, version: CUSTOM_THEME_VERSION, themes };
}

/**
 * Validates an import and returns its complete post-import theme map without mutating
 * settings. Existing slugs are listed as overwrites so the UI can confirm them by name.
 */
export function prepareCustomThemeImport(payload, rawExisting = {}) {
    try {
        requireRecord(payload, 'export');
        assertSafeTree(payload, 'export');
        rejectUnknownKeys(payload, EXPORT_KEYS, 'export');
        const serialized = JSON.stringify(payload);
        if (byteLength(serialized) > CUSTOM_THEME_LIMITS.fileBytes) {
            throw new ThemeValidationError('export', `must be smaller than ${CUSTOM_THEME_LIMITS.fileBytes} bytes.`);
        }
        if (![CUSTOM_THEME_FORMAT, 'neconyan-regex-agent-themes'].includes(payload.format) || payload.version !== CUSTOM_THEME_VERSION) {
            throw new ThemeValidationError('export', 'uses an unsupported format or version.');
        }
        const existing = validateCustomThemeMap(rawExisting).themes;
        const incoming = validateCustomThemeMap(payload.themes);
        const themes = { ...existing };
        const accepted = [];
        const overwritten = [];
        const rejected = [...incoming.rejected];
        for (const slug of incoming.accepted) {
            if (Object.hasOwn(themes, slug)) {
                overwritten.push(slug);
            } else if (Object.keys(themes).length >= CUSTOM_THEME_LIMITS.themes) {
                rejected.push({ slug, reason: `would exceed the ${CUSTOM_THEME_LIMITS.themes}-theme limit.` });
                continue;
            }
            themes[slug] = incoming.themes[slug];
            accepted.push(slug);
        }
        return { ok: true, themes, accepted, overwritten, rejected };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof ThemeValidationError ? error.message : 'The import could not be validated.',
            themes: validateCustomThemeMap(rawExisting).themes,
            accepted: [],
            overwritten: [],
            rejected: [],
        };
    }
}

/** Parses bounded JSON before running the same import validation used for persisted data. */
export function parseCustomThemeImport(text, existing = {}) {
    if (typeof text !== 'string' || byteLength(text) > CUSTOM_THEME_LIMITS.fileBytes) {
        return {
            ok: false,
            error: `The import must be JSON smaller than ${CUSTOM_THEME_LIMITS.fileBytes} bytes.`,
            themes: validateCustomThemeMap(existing).themes,
            accepted: [],
            overwritten: [],
            rejected: [],
        };
    }
    try {
        return prepareCustomThemeImport(JSON.parse(text), existing);
    } catch {
        return {
            ok: false,
            error: 'The import is not valid JSON.',
            themes: validateCustomThemeMap(existing).themes,
            accepted: [],
            overwritten: [],
            rejected: [],
        };
    }
}

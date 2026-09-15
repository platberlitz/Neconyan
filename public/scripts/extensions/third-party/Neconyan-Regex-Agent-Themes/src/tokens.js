/**
 * The design-token contract every theme fills in, plus the merge/scale helpers the
 * renderers use.
 *
 * Constraints that come from how Neconyan renders message HTML:
 *  - Colours must be literal (`#rrggbb`, `rgba()`, `oklch()`). `color-mix()` is allowed
 *    only where deriving from host theme variables is the point (adaptive themes).
 *  - No token value may contain `$` followed by a digit or `<`: the regex interpolator
 *    (in-chat-agents/regex-scripts.js:235) eats those before the string reaches the DOM.
 *  - No token value may contain `{{`: the output passes through substituteParams.
 */

import {
    DARK_CANVAS, LIGHT_CANVAS, composite, contrastRatio, flattenColor,
    gradientSamples, parseColor, readableColor,
} from './color.js';

export const DENSITY = Object.freeze({ compact: 0.85, normal: 1, roomy: 1.18 });
const RESOLVED_CACHE = new WeakMap();

/** Named tones a chip field or stat can ask for, resolved against the palette. */
export const TONES = Object.freeze(['body', 'strong', 'label', 'muted', 'warm', 'cool', 'accent']);

export const BASE_TOKENS = Object.freeze({
    slug: 'base',
    name: 'Base',
    family: 'base',
    mode: 'dark',

    surface: {
        headFrom: 'rgba(24,26,32,0.97)',
        headTo: 'rgba(83,52,134,0.66)',
        bodyFrom: 'rgba(20,22,28,0.97)',
        bodyTo: 'rgba(34,37,46,0.96)',
        row: 'rgba(255,255,255,0.04)',
        rowAlt: 'rgba(255,255,255,0.07)',
        inset: 'rgba(255,255,255,0.06)',
        chip: 'rgba(52,58,78,0.85)',
    },

    ink: {
        head: '#d6b8ff',
        body: '#f8f8f2',
        label: '#d6b8ff',
        muted: '#9aa0b5',
        strong: '#ffffff',
        warm: '#ffd099',
        cool: '#a7f3ff',
    },

    line: {
        head: 'rgba(189,147,249,0.52)',
        body: 'rgba(189,147,249,0.34)',
        row: 'transparent',
        width: '1px',
        style: 'solid',
        edge: '3px',
        edgeSide: 'left',
    },

    shadow: {
        head: '0 10px 24px rgba(0,0,0,0.28)',
        body: 'none',
        chip: 'none',
    },

    accents: ['#bd93f9', '#8be9fd', '#f1fa8c', '#ffb86c', '#50fa7b', '#9fc3ef', '#ff79c6'],

    radius: {
        head: '12px',
        body: '12px',
        row: '8px',
        slot: '7px',
        pill: '999px',
        chip: '999px',
    },

    space: {
        outer: '10px',
        headPadY: '10px',
        headPadX: '13px',
        bodyPad: '13px',
        rowPadY: '9px',
        rowPadX: '11px',
        slotPadY: '7px',
        slotPadX: '9px',
        gap: '9px',
        rowGap: '5px',
        pillPad: '3px 8px',
        pillMarginTop: '4px',
        chipPad: '4px 9px',
        chipMargin: '2px 4px 2px 0',
    },

    type: {
        family: 'monospace',
        bodyFamily: 'inherit',
        headSize: '11px',
        bodySize: '11px',
        labelSize: '10px',
        valueSize: '12px',
        chipSize: '9px',
        lineHeight: '1.68',
        headWeight: '400',
        labelWeight: '700',
        valueWeight: '700',
        headCase: 'none',
        headTracking: 'normal',
        labelCase: 'none',
    },

    glyph: {
        section: '⬢',
        sectionAlt: '⬡',
        bullet: '◦',
        sep: '·',
        chipSep: '›',
        chevron: '▼',
        arrow: '→',
        pairSep: ':',
    },

    /** Structural decoration the renderers know how to apply. */
    frame: null,
    /** Extra background layer, e.g. scanlines or a grid. */
    scan: null,
    /** Safe bundled motion identifier for optional stylesheet effects. */
    motion: null,
    /** Terminal archetype palette. Derived from the tokens above when absent. */
    term: null,
    /** Raw HTML injected at named anchors. Escape hatch for ornament-heavy themes. */
    ornament: null,
    /** Verbatim declaration appendices per named part. */
    extra: null,
});

const NUMERIC = /^(-?\d*\.?\d+)(px|em|rem)$/;

function scaleLength(value, factor) {
    if (factor === 1 || typeof value !== 'string') {
        return value;
    }
    const match = NUMERIC.exec(value.trim());
    if (!match) {
        return value;
    }
    const scaled = Math.round(Number(match[1]) * factor * 100) / 100;
    return `${scaled}${match[2]}`;
}

function scaleLengthList(value, factor) {
    if (factor === 1 || typeof value !== 'string') return value;
    return value.split(/\s+/).map(part => scaleLength(part, factor)).join(' ');
}

function scaleGroup(group, factor, skip = []) {
    const out = {};
    for (const [key, value] of Object.entries(group)) {
        out[key] = skip.includes(key) ? value : scaleLengthList(value, factor);
    }
    return out;
}

function mergeGroup(base, override) {
    return override ? { ...base, ...override } : { ...base };
}

/**
 * Derives the terminal-archetype palette from the general tokens, unless the theme
 * supplied its own.
 */
function deriveTerm(tokens) {
    if (tokens.term) {
        return { ...tokens.term };
    }
    const accent = tokens.accents[0];
    return {
        bg: tokens.surface.bodyFrom,
        panel: tokens.surface.bodyTo,
        accent,
        accentDim: tokens.accents[1] ?? accent,
        text: tokens.ink.body,
        muted: tokens.ink.muted,
        border: tokens.line.head,
        glow: tokens.mode === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
        gold: tokens.ink.warm,
        font: tokens.type.family === 'inherit'
            ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
            : tokens.type.family,
    };
}

const TYPE_FLOORS = Object.freeze({
    headSize: 0.8,
    bodySize: 0.8,
    labelSize: 0.75,
    valueSize: 0.8,
    chipSize: 0.75,
});

function readableSize(value, floorRem) {
    const match = /^(\d*\.?\d+)(px|rem|em)$/.exec(String(value).trim());
    if (!match) return `${floorRem}rem`;
    const rem = match[2] === 'px' ? Number(match[1]) / 16 : Number(match[1]);
    return rem < floorRem ? `${floorRem}rem` : value;
}

function opaqueCanvas(mode) {
    return mode === 'light' ? LIGHT_CANVAS : DARK_CANVAS;
}

function resolvedGradient(from, to, canvas) {
    const first = flattenColor(from, [canvas])[0];
    const second = flattenColor(to, [canvas])[0];
    return first && second ? gradientSamples(first, second) : [];
}

function overEach(value, backgrounds) {
    return flattenColor(value, backgrounds);
}

function safetyBackgrounds(mode) {
    const scrim = parseColor(mode === 'light' ? 'rgba(255,255,255,0.52)' : 'rgba(0,0,0,0.58)');
    return [parseColor('#000000'), parseColor('#ffffff')].map(background => composite(scrim, background));
}

function deriveReadableTokens(tokens, forceSafety = false) {
    const canvasCss = opaqueCanvas(tokens.mode);
    const canvas = parseColor(canvasCss);
    const backgroundValues = [
        ...Object.values(tokens.surface),
        ...tokens.accents,
        tokens.term.bg,
        tokens.term.panel,
    ];
    const safety = forceSafety
        || tokens.mode === 'adaptive'
        || backgroundValues.some(value => !parseColor(value));
    const safetySurfaces = safetyBackgrounds(tokens.mode);
    const safeSurfaces = safety ? safetyBackgrounds(tokens.mode) : null;
    const head = safeSurfaces ?? resolvedGradient(tokens.surface.headFrom, tokens.surface.headTo, canvas);
    const body = safeSurfaces ?? resolvedGradient(tokens.surface.bodyFrom, tokens.surface.bodyTo, canvas);
    const row = safeSurfaces ?? overEach(tokens.surface.row, body);
    const rowAlt = safeSurfaces ?? overEach(tokens.surface.rowAlt, body);
    const accentWashes = tokens.accents.map(accent => safeSurfaces ?? [0.07, 0.1, 0.12]
        .flatMap(opacity => overEach(alpha(accent, opacity), body)));
    const content = [...body, ...row, ...rowAlt, ...accentWashes.flat(), canvas];
    const chipByAccent = tokens.accents.map(accent => {
        if (safeSurfaces) return safeSurfaces;
        const first = flattenColor(tokens.surface.chip, [canvas])[0];
        const second = flattenColor(alpha(accent, 0.1), [canvas])[0];
        return first && second ? gradientSamples(first, second) : [canvas];
    });
    const chip = chipByAccent.flat();
    const pill = safeSurfaces ?? tokens.accents.flatMap(accent => overEach(alpha(accent, 0.18), row));
    const strongSurfaces = [...content, ...chip, ...pill];
    const termBody = safeSurfaces ?? overEach(tokens.term.bg, [canvas]);
    const termPanel = safeSurfaces ?? overEach(tokens.term.panel, [canvas]);
    const accents = tokens.accents.map((accent, index) => readableColor(accent, accentWashes[index]));
    const chipInk = {
        body: readableColor(tokens.ink.body, chip),
        strong: readableColor(tokens.ink.strong, chip),
        label: readableColor(tokens.ink.label, chip),
        muted: readableColor(tokens.ink.muted, chip),
        warm: readableColor(tokens.ink.warm, chip),
        cool: readableColor(tokens.ink.cool, chip),
        accents: tokens.accents.map((accent, index) => readableColor(accent, chipByAccent[index])),
    };
    const statSix = accentWashes[6] ?? content;
    const meterTrack = safeSurfaces ?? overEach(alpha(tokens.accents[6], 0.18), statSix);

    const on = {
        head: readableColor(tokens.ink.head, head),
        body: readableColor(tokens.ink.body, content),
        label: readableColor(tokens.ink.label, content),
        muted: readableColor(tokens.ink.muted, content),
        strong: readableColor(tokens.ink.strong, strongSurfaces),
        warm: readableColor(tokens.ink.warm, content),
        cool: readableColor(tokens.ink.cool, content),
        accents,
        chip: chipInk,
        safety: readableColor(tokens.ink.strong, safetySurfaces),
        meterFill: readableColor(tokens.accents[6], meterTrack, 3),
        term: {
            text: readableColor(tokens.term.text, termBody),
            prompt: readableColor(tokens.term.accentDim, termBody),
            badge: readableColor(tokens.term.gold, termBody),
            accent: readableColor(tokens.term.accent, termPanel),
            muted: readableColor(tokens.term.muted, termPanel),
        },
    };

    const checks = [
        { role: 'head', foreground: on.head, backgrounds: head, minimum: 4.5 },
        { role: 'body', foreground: on.body, backgrounds: content, minimum: 4.5 },
        { role: 'label', foreground: on.label, backgrounds: content, minimum: 4.5 },
        { role: 'muted', foreground: on.muted, backgrounds: content, minimum: 4.5 },
        { role: 'strong', foreground: on.strong, backgrounds: strongSurfaces, minimum: 4.5 },
        { role: 'warm', foreground: on.warm, backgrounds: content, minimum: 4.5 },
        { role: 'cool', foreground: on.cool, backgrounds: content, minimum: 4.5 },
        { role: 'chip-body', foreground: chipInk.body, backgrounds: chip, minimum: 4.5 },
        { role: 'chip-strong', foreground: chipInk.strong, backgrounds: chip, minimum: 4.5 },
        { role: 'chip-label', foreground: chipInk.label, backgrounds: chip, minimum: 4.5 },
        { role: 'chip-muted', foreground: chipInk.muted, backgrounds: chip, minimum: 4.5 },
        { role: 'chip-warm', foreground: chipInk.warm, backgrounds: chip, minimum: 4.5 },
        { role: 'chip-cool', foreground: chipInk.cool, backgrounds: chip, minimum: 4.5 },
        { role: 'safety', foreground: on.safety, backgrounds: safetySurfaces, minimum: 4.5 },
        { role: 'terminal-text', foreground: on.term.text, backgrounds: termBody, minimum: 4.5 },
        { role: 'terminal-accent', foreground: on.term.accent, backgrounds: termPanel, minimum: 4.5 },
        { role: 'terminal-prompt', foreground: on.term.prompt, backgrounds: termBody, minimum: 4.5 },
        { role: 'terminal-badge', foreground: on.term.badge, backgrounds: termBody, minimum: 4.5 },
        { role: 'terminal-muted', foreground: on.term.muted, backgrounds: termPanel, minimum: 4.5 },
        { role: 'meter-fill', foreground: on.meterFill, backgrounds: meterTrack, minimum: 3 },
        ...accents.map((foreground, index) => ({
            role: `accent-${index}`, foreground, backgrounds: accentWashes[index], minimum: 4.5,
        })),
    ];

    if (!safety && checks.some(check => {
        const foreground = parseColor(check.foreground);
        return !foreground || check.backgrounds.some(background => (
            contrastRatio(foreground, background) < check.minimum
        ));
    })) {
        return deriveReadableTokens(tokens, true);
    }

    return {
        on,
        a11y: {
            canvas: canvasCss,
            scrim: safety
                ? (tokens.mode === 'light' ? 'rgba(255,255,255,0.52)' : 'rgba(0,0,0,0.58)')
                : null,
            safetyScrim: tokens.mode === 'light'
                ? 'rgba(255,255,255,0.52)'
                : 'rgba(0,0,0,0.58)',
            checks,
        },
    };
}

/** Host theme variables the adaptive remap borrows, each with a literal fallback. */
export const HOST = Object.freeze({
    body: 'var(--SmartThemeBodyColor, #f8f8f2)',
    tint: 'var(--SmartThemeBlurTintColor, #1b1d24)',
    quote: 'var(--SmartThemeQuoteColor, #bd93f9)',
    em: 'var(--SmartThemeEmColor, #8be9fd)',
    shadow: 'var(--SmartThemeShadowColor, #000000)',
    font: 'var(--mainFontFamily, system-ui, sans-serif)',
});

export function mix(color, base, percent) {
    return `color-mix(in srgb, ${color} ${percent}%, ${base})`;
}

/** Repaints surfaces, ink and lines onto the host theme, keeping accents/geometry/type. */
function applyAdaptiveNeutrals(tokens) {
    return {
        ...tokens,
        surface: {
            ...tokens.surface,
            headFrom: mix(HOST.tint, 'transparent', 94),
            headTo: mix(HOST.quote, HOST.tint, 18),
            bodyFrom: mix(HOST.tint, 'transparent', 92),
            bodyTo: mix(HOST.body, HOST.tint, 6),
            row: mix(HOST.body, 'transparent', 6),
            rowAlt: mix(HOST.quote, 'transparent', 10),
            inset: mix(HOST.body, 'transparent', 9),
            chip: mix(HOST.quote, 'transparent', 20),
        },
        ink: {
            ...tokens.ink,
            head: HOST.body,
            body: HOST.body,
            label: mix(HOST.quote, HOST.body, 60),
            muted: mix(HOST.body, 'transparent', 62),
            strong: HOST.body,
        },
        line: {
            ...tokens.line,
            head: mix(HOST.quote, 'transparent', 34),
            body: mix(HOST.quote, 'transparent', 22),
        },
        shadow: {
            ...tokens.shadow,
            head: `0 10px 24px ${mix(HOST.shadow, 'transparent', 26)}`,
        },
    };
}

/**
 * Produces the effective token set for one render.
 * @param {object} theme A theme's partial token object.
 * @param {object} [options] `{ density, adaptiveNeutrals, glyphs }`.
 */
export function resolveTheme(theme, options = {}) {
    const density = DENSITY[options.density] ?? DENSITY.normal;
    const cacheKey = `${density}|${Boolean(options.adaptiveNeutrals)}|${options.glyphs ?? 'theme'}`;
    const cached = theme && typeof theme === 'object' ? RESOLVED_CACHE.get(theme)?.get(cacheKey) : null;
    if (cached) return cached;

    let tokens = {
        ...BASE_TOKENS,
        ...theme,
        surface: mergeGroup(BASE_TOKENS.surface, theme.surface),
        ink: mergeGroup(BASE_TOKENS.ink, theme.ink),
        line: mergeGroup(BASE_TOKENS.line, theme.line),
        shadow: mergeGroup(BASE_TOKENS.shadow, theme.shadow),
        radius: mergeGroup(BASE_TOKENS.radius, theme.radius),
        space: mergeGroup(BASE_TOKENS.space, theme.space),
        type: mergeGroup(BASE_TOKENS.type, theme.type),
        glyph: mergeGroup(BASE_TOKENS.glyph, theme.glyph),
        accents: Array.isArray(theme.accents) && theme.accents.length >= 7
            ? [...theme.accents]
            : [...BASE_TOKENS.accents],
        ornament: mergeGroup({}, theme.ornament),
        extra: mergeGroup({}, theme.extra),
    };

    if (options.adaptiveNeutrals && tokens.mode !== 'adaptive') {
        tokens = applyAdaptiveNeutrals(tokens);
    }

    tokens.space = scaleGroup(tokens.space, density);
    const typeDensity = options.density === 'roomy' ? 1.08 : 1;
    tokens.type = scaleGroup(tokens.type, typeDensity, [
        'family', 'bodyFamily', 'lineHeight', 'headWeight', 'labelWeight',
        'valueWeight', 'headCase', 'headTracking', 'labelCase',
    ]);
    tokens.radius = scaleGroup(tokens.radius, density, ['pill', 'chip']);

    for (const [key, floor] of Object.entries(TYPE_FLOORS)) {
        tokens.type[key] = readableSize(tokens.type[key], floor);
    }

    if (options.glyphs === 'none') {
        tokens.glyph = {
            ...tokens.glyph,
            section: '', sectionAlt: '', bullet: '', sep: '', chipSep: '',
            chevron: '', arrow: '', pairSep: ':',
        };
    }

    tokens.glyphMode = options.glyphs;
    tokens.term = deriveTerm(tokens);
    const readable = deriveReadableTokens(tokens);
    tokens.on = readable.on;
    tokens.a11y = readable.a11y;
    if (theme && typeof theme === 'object') {
        const cache = RESOLVED_CACHE.get(theme) ?? new Map();
        cache.set(cacheKey, tokens);
        RESOLVED_CACHE.set(theme, cache);
    }
    return tokens;
}

/** Accent at an index, wrapping so a spec can ask for more than the ramp holds. */
export function accentAt(tokens, index) {
    const ramp = tokens.accents;
    return ramp[((index % ramp.length) + ramp.length) % ramp.length];
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses `#rgb`/`#rrggbb` into `[r,g,b]`, or null for any other colour form. */
export function parseHex(color) {
    if (typeof color !== 'string' || !HEX.test(color.trim())) {
        return null;
    }
    let hex = color.trim().slice(1);
    if (hex.length === 3 || hex.length === 4) {
        hex = [...hex].map(char => char + char).join('');
    }
    return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
    ];
}

/**
 * Literal `rgba()` from a hex colour, so themes never need `color-mix()` for their own
 * palette. Non-hex input (a host `var()` or an `oklch()`) is returned unchanged.
 */
export function alpha(color, value) {
    const clamped = Math.max(0, Math.min(1, value));
    const parsed = parseColor(color);
    if (!parsed) {
        return `color-mix(in srgb, ${color} ${Math.round(clamped * 1000) / 10}%, transparent)`;
    }
    const opacity = Math.round(parsed.a * clamped * 1000) / 1000;
    return `rgba(${Math.round(parsed.r)},${Math.round(parsed.g)},${Math.round(parsed.b)},${opacity})`;
}

/** Mixes a hex colour toward white (positive ratio) or black (negative) by 0..1. */
export function shade(color, ratio) {
    const rgb = parseHex(color);
    if (!rgb) {
        return color;
    }
    const target = ratio >= 0 ? 255 : 0;
    const amount = Math.abs(ratio);
    const mixed = rgb.map(channel => Math.round(channel + (target - channel) * amount));
    return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolves a named tone to a colour for the current tokens. */
export function toneColor(tokens, tone, accentIndex = 0) {
    const ink = tokens.on?.chip ?? tokens.ink;
    switch (tone) {
        case 'strong': return ink.strong;
        case 'label': return ink.label;
        case 'muted': return ink.muted;
        case 'warm': return ink.warm;
        case 'cool': return ink.cool;
        case 'accent': return ink.accents?.[accentIndex] ?? accentAt(tokens, accentIndex);
        default: return ink.body;
    }
}

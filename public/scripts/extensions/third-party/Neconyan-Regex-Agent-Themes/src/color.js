/** Pure colour math used to derive readable ink without changing authored accents. */

export const DARK_INK = '#111318';
export const LIGHT_INK = '#fbfbfd';
export const LIGHT_CANVAS = '#fbfafc';
export const DARK_CANVAS = '#17181d';

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^(rgb|rgba)\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(\d*\.?\d+))?\s*\)$/i;
const OKLCH = /^oklch\(\s*(\d*\.?\d+)%\s+(\d*\.?\d+)\s+(-?\d*\.?\d+)(?:deg)?(?:\s*\/\s*(\d*\.?\d+)(%)?)?\s*\)$/i;

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function srgbFromLinear(value) {
    const encoded = value <= 0.0031308
        ? 12.92 * value
        : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
    return clamp(encoded) * 255;
}

function parseHex(match) {
    let value = match[1];
    if (value.length <= 4) {
        value = [...value].map(char => char + char).join('');
    }
    return {
        r: Number.parseInt(value.slice(0, 2), 16),
        g: Number.parseInt(value.slice(2, 4), 16),
        b: Number.parseInt(value.slice(4, 6), 16),
        a: value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) / 255 : 1,
    };
}

function parseOklch(match) {
    const lightness = clamp(Number(match[1]) / 100);
    const chroma = Number(match[2]);
    const hue = Number(match[3]) * Math.PI / 180;
    const alpha = match[4] === undefined
        ? 1
        : clamp(Number(match[4]) / (match[5] ? 100 : 1));
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);

    const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
    const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
    const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
    const l = lRoot ** 3;
    const m = mRoot ** 3;
    const s = sRoot ** 3;

    return {
        r: srgbFromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        g: srgbFromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        b: srgbFromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        a: alpha,
    };
}

/** Parses the literal colour forms accepted by the public custom-theme schema. */
export function parseColor(value) {
    if (typeof value !== 'string') return null;
    const clean = value.trim();
    if (clean.toLowerCase() === 'transparent') {
        return { r: 0, g: 0, b: 0, a: 0 };
    }
    const hex = HEX.exec(clean);
    if (hex) return parseHex(hex);

    const rgb = RGB.exec(clean);
    if (rgb) {
        const channels = rgb.slice(2, 5).map(Number);
        if (channels.some(channel => channel > 255)) return null;
        const alpha = rgb[1].toLowerCase() === 'rgba' ? Number(rgb[5]) : 1;
        if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
        return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
    }

    const oklch = OKLCH.exec(clean);
    return oklch ? parseOklch(oklch) : null;
}

export function colorToCss(color) {
    const r = Math.round(clamp(color.r, 0, 255));
    const g = Math.round(clamp(color.g, 0, 255));
    const b = Math.round(clamp(color.b, 0, 255));
    const alpha = Math.round(clamp(color.a) * 1000) / 1000;
    return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Alpha-composites foreground over an opaque or translucent background. */
export function composite(foreground, background) {
    const alpha = foreground.a + background.a * (1 - foreground.a);
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = key => (foreground[key] * foreground.a
        + background[key] * background.a * (1 - foreground.a)) / alpha;
    return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
}

function linearChannel(value) {
    const channel = clamp(value / 255);
    return channel <= 0.04045
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color) {
    return 0.2126 * linearChannel(color.r)
        + 0.7152 * linearChannel(color.g)
        + 0.0722 * linearChannel(color.b);
}

export function contrastRatio(first, second) {
    const a = typeof first === 'string' ? parseColor(first) : first;
    const b = typeof second === 'string' ? parseColor(second) : second;
    if (!a || !b || a.a < 0.999 || b.a < 0.999) return 0;
    const firstLuminance = relativeLuminance(a);
    const secondLuminance = relativeLuminance(b);
    return (Math.max(firstLuminance, secondLuminance) + 0.05)
        / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

export function mixColors(first, second, amount) {
    const ratio = clamp(amount);
    return {
        r: first.r + (second.r - first.r) * ratio,
        g: first.g + (second.g - first.g) * ratio,
        b: first.b + (second.b - first.b) * ratio,
        a: first.a + (second.a - first.a) * ratio,
    };
}

/** Samples an sRGB gradient densely enough to catch a mid-gradient contrast minimum. */
export function gradientSamples(first, second, count = 17) {
    const out = [];
    for (let index = 0; index < count; index++) {
        out.push(mixColors(first, second, index / (count - 1)));
    }
    return out;
}

export function flattenColor(value, backgrounds) {
    const foreground = typeof value === 'string' ? parseColor(value) : value;
    if (!foreground) return [];
    return backgrounds.map(background => composite(foreground, background));
}

function minimumContrast(foreground, backgrounds) {
    return Math.min(...backgrounds.map(background => contrastRatio(foreground, background)));
}

/** Keeps the preferred ink when possible, otherwise chooses the safest neutral ink. */
export function readableColor(preferred, backgrounds, minimum = 4.5) {
    const preferredColor = parseColor(preferred);
    const candidates = [];
    if (preferredColor) {
        candidates.push({ css: preferredColor.a >= 0.999 ? preferred : colorToCss({ ...preferredColor, a: 1 }), color: { ...preferredColor, a: 1 } });
    }
    for (const css of [DARK_INK, LIGHT_INK]) {
        candidates.push({ css, color: parseColor(css) });
    }

    const scored = candidates.map(candidate => ({
        ...candidate,
        score: minimumContrast(candidate.color, backgrounds),
    }));
    return (scored.find(candidate => candidate.score >= minimum)
        ?? scored.sort((a, b) => b.score - a.score)[0]).css;
}

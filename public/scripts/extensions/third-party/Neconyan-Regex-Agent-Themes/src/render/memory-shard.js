/**
 * Theme renderer for the Memory Shard companion (`tpl-memory-shard-companion`).
 *
 * Stock Memory Shard uses 31 regex scripts: one fence stripper (passthrough),
 * 29 structural HTML emitters (`.ms-*`), and a single `<style>` injector
 * (`memory-shard-styles`) that styles the emitted markup plus the adjacent
 * markdown `<ul>`, `<ol>`, and `<p>` siblings produced after regexes run.
 *
 * To keep themed shards completely isolated from stock rules and from shards
 * rendered under another theme in the same chat or preview:
 *   - Every emitted element class and CSS custom property is namespaced with
 *     `ratms-<slug>-*`.
 *   - Tag spans keep `ms-tag` first inside `class="ms-tag ratms-<slug>-tag ..."`
 *     with no extra attributes, because stock script 28 (`memory-shard-thread-row`)
 *     matches `(<span class="ms-tag [^"]+">[^<]+<\/span>)` in its `findRegex`.
 *   - `memory-shard-styles` targets only `.ratms-<slug>-*` (and `span.ratms-<slug>-tag`
 *     for higher specificity than stock `.ms-tag`), uses `surfaceBackground` /
 *     `layeredBackground` so every top-level surface stays legible regardless of
 *     host light/dark polarity, and overrides Echo/Whisper/Hush/Ripple/Tide
 *     paragraph custom properties so welded subcards never split apart.
 *   - Only hero banners carry `rootAttrs` + `data-rat-part="root"` (enabling
 *     animated themes and ownership recognition); secondary scripts including
 *     `memory-shard-styles` rely on the ledger so manual user CSS edits classify
 *     as `FOREIGN` and are preserved.
 */

import {
    DARK_CANVAS, DARK_INK, LIGHT_CANVAS, LIGHT_INK, colorToCss, composite, contrastRatio,
    flattenColor, mixColors, parseColor, readableColor, relativeLuminance,
} from '../color.js';
import { accentAt, alpha } from '../tokens.js';
import {
    decorative, frameDecoration, layeredBackground, part, rootAttrs, safeValue,
    surfaceBackground, surfaceFill,
} from './parts.js';

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const BLACK = parseColor('#000000');
const WHITE = parseColor('#ffffff');
const DARK_INK_COLOR = parseColor(DARK_INK);
const LIGHT_INK_COLOR = parseColor(LIGHT_INK);

function roundColor(color) {
    return {
        r: Math.round(color.r),
        g: Math.round(color.g),
        b: Math.round(color.b),
        a: color.a,
    };
}

const SECTION_DEFS = Object.freeze([
    { suffix: 'sec-snapshot', kind: 'snapshot', icon: 'fa-compass', hue: 215, slot: 0 },
    { suffix: 'sec-tone',     kind: 'tone',     icon: 'fa-feather-pointed', hue: 270, slot: 3 },
    { suffix: 'sec-chars',    kind: 'chars',    icon: 'fa-users', hue: 195, slot: 1 },
    { suffix: 'sec-rels',     kind: 'rels',     icon: 'fa-heart-pulse', hue: 345, slot: 2 },
    { suffix: 'sec-world',    kind: 'world',    icon: 'fa-globe', hue: 155, slot: 4 },
    { suffix: 'sec-events',   kind: 'events',   icon: 'fa-clock-rotate-left', hue: 35, slot: 0 },
    { suffix: 'sec-scenes',   kind: 'scenes',   icon: 'fa-clapperboard', hue: 300, slot: 5 },
    { suffix: 'sec-quotes',   kind: 'quotes',   icon: 'fa-quote-left', hue: 48, slot: 6 },
    { suffix: 'sec-sensory',  kind: 'sensory',  icon: 'fa-eye', hue: 175, slot: 3 },
    { suffix: 'sec-threads',  kind: 'threads',  icon: 'fa-link', hue: 15, slot: 2 },
    { suffix: 'sec-intimate', kind: 'intimate', icon: 'fa-fire', hue: 350, slot: 5 },
    { suffix: 'sec-key',      kind: 'key',      icon: 'fa-key', hue: 235, slot: 1 },
    { suffix: 'sec-custom',   kind: 'custom',   icon: 'fa-bookmark', hue: null, slot: 0 },
]);

const SECTION_BY_SUFFIX = new Map(SECTION_DEFS.map(def => [def.suffix, def]));

const TAG_DEFS = Object.freeze([
    { suffix: 'tag-critical', kind: 'critical', label: 'Critical', hue: 4,    slot: 2 },
    { suffix: 'tag-major',    kind: 'major',    label: 'Major',    hue: 36,   slot: 0 },
    { suffix: 'tag-moderate', kind: 'moderate', label: 'Moderate', hue: 205,  slot: 1 },
    { suffix: 'tag-minor',    kind: 'minor',    label: '$1',       hue: null, slot: null },
    { suffix: 'tag-open',     kind: 'open',     label: '$1',       hue: 152,  slot: 3 },
    { suffix: 'tag-planted',  kind: 'planted',  label: '$1',       hue: 272,  slot: 4 },
    { suffix: 'tag-resolved', kind: 'resolved', label: '$1',       hue: null, slot: null },
]);

const TAG_BY_SUFFIX = new Map(TAG_DEFS.map(def => [def.suffix, def]));

/** Class prefix that isolates one theme's Memory Shard markup and CSS. */
export function memoryShardPrefix(tokens) {
    return `ratms-${tokens.slug}`;
}

function hueOf(color) {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma === 0) return { hue: 0, chroma };
    let hue;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    return { hue: (hue * 60 + 360) % 360, chroma };
}

function applyScrim(colors, scrim) {
    return scrim ? colors.map(color => composite(scrim, color)) : colors;
}

function applyScan(colors, scan) {
    if (!scan?.color || !colors.length) return colors;
    const parsed = parseColor(scan.color);
    if (!parsed || parsed.a <= 0) return colors;
    return [...colors, ...colors.map(color => composite(parsed, color))];
}

function flattenSurfaces(values, canvas, scrim, scan = null) {
    const out = [];
    for (const value of values) {
        const flattened = flattenColor(value, [canvas]);
        if (!flattened.length) return [];
        out.push(...applyScrim(applyScan(flattened, scan), scrim));
    }
    return out;
}

function isLightGrounds(grounds) {
    if (!grounds.length) return false;
    return grounds.reduce((sum, color) => sum + relativeLuminance(color), 0) / grounds.length > 0.35;
}

function buildPalette(tokens) {
    const canvas = parseColor(tokens.a11y?.canvas ?? (tokens.mode === 'light' ? LIGHT_CANVAS : DARK_CANVAS));
    const scrim = tokens.a11y?.scrim ? parseColor(tokens.a11y.scrim) : null;

    const headGrounds = canvas
        ? flattenSurfaces([tokens.surface.headFrom, tokens.surface.headTo], canvas, scrim, tokens.scan)
        : [];
    const bodyBase = canvas
        ? flattenSurfaces([tokens.surface.bodyFrom, tokens.surface.bodyTo], canvas, scrim, tokens.scan)
        : [];
    const bodyGrounds = bodyBase.length
        ? [
            ...bodyBase,
            ...applyScrim(flattenColor(tokens.surface.row, bodyBase), scrim),
            ...applyScrim(flattenColor(tokens.surface.rowAlt, bodyBase), scrim),
            ...applyScrim(flattenColor(tokens.surface.inset, bodyBase), scrim),
        ]
        : [];

    const headLight = isLightGrounds(headGrounds);
    const bodyLight = isLightGrounds(bodyGrounds);

    const parsedAccents = tokens.accents.map((value, index) => {
        const color = parseColor(value);
        return color && color.a >= 0.999 ? { index, color, ...hueOf(color) } : { index, color: null };
    });

    function pickAccent(targetHue, fallbackSlot) {
        if (targetHue === null) return accentAt(tokens, fallbackSlot);
        let best = null;
        for (const item of parsedAccents) {
            if (!item.color || item.chroma < 0.12) continue;
            const gap = Math.abs(item.hue - targetHue);
            const distance = Math.min(gap, 360 - gap);
            if (distance <= 55 && (!best || distance < best.distance)) {
                best = { index: item.index, distance };
            }
        }
        return accentAt(tokens, best ? best.index : fallbackSlot);
    }

    function legible(preferred, fallback, grounds, minimum = 4.65) {
        if (!grounds.length) return fallback;
        const color = parseColor(preferred);
        if (!color || color.a < 0.999) return readableColor(fallback, grounds, minimum);
        const passes = candidate => {
            const rounded = roundColor(candidate);
            return grounds.every(ground => contrastRatio(rounded, ground) >= minimum);
        };
        if (passes(color)) return colorToCss(color);
        const towards = isLightGrounds(grounds) ? BLACK : WHITE;
        for (let step = 1; step <= 16; step++) {
            const nudged = mixColors(color, towards, (step * 0.95) / 16);
            if (passes(nudged)) return colorToCss(nudged);
        }
        return readableColor(fallback, grounds, minimum);
    }

    function tintedChip(accentCss, grounds, fallbackInk, light) {
        const color = parseColor(accentCss);
        if (grounds.length && color && color.a >= 0.999) {
            const weight = light ? 0.14 : 0.22;
            const overlay = { r: color.r, g: color.g, b: color.b, a: weight };
            const actualGrounds = grounds.map(ground => composite(overlay, ground));
            const ink = legible(accentCss, fallbackInk, actualGrounds, 4.65);
            const inkColor = parseColor(ink);
            if (!inkColor || actualGrounds.every(ground => contrastRatio(inkColor, ground) >= 4.5)) {
                return {
                    bg: alpha(accentCss, weight),
                    ink,
                    border: alpha(accentCss, light ? 0.36 : 0.44),
                };
            }
            const uniformGrounds = canvas ? applyScrim([composite(overlay, canvas)], scrim) : [composite(overlay, LIGHT_INK_COLOR)];
            const uniformInk = legible(accentCss, fallbackInk, uniformGrounds, 4.65);
            return {
                bg: layeredBackground(tokens, [alpha(accentCss, weight)], { canvas: true }),
                ink: uniformInk,
                border: alpha(accentCss, light ? 0.36 : 0.44),
            };
        }
        const bg = layeredBackground(tokens, [alpha(accentCss, 0.24)], { canvas: true });
        return {
            bg,
            ink: fallbackInk,
            border: alpha(accentCss, 0.48),
        };
    }

    function neutralChip(grounds, fallbackInk) {
        if (grounds.length) {
            const actualGrounds = applyScrim(flattenColor(tokens.surface.chip, grounds), scrim);
            const checkGrounds = actualGrounds.length ? actualGrounds : grounds;
            const ink = readableColor(fallbackInk, checkGrounds, 4.65);
            return {
                bg: surfaceFill(tokens, tokens.surface.chip),
                ink,
                border: tokens.line.body === 'transparent' ? alpha(ink, 0.24) : tokens.line.body,
                grounds: checkGrounds,
            };
        }
        const bg = layeredBackground(tokens, [tokens.surface.chip], { canvas: true });
        return {
            bg,
            ink: fallbackInk,
            border: tokens.line.body === 'transparent' ? alpha(fallbackInk, 0.28) : tokens.line.body,
            grounds: [],
        };
    }

    function solidBadge(accentCss, fallbackInk) {
        const color = parseColor(accentCss);
        if (color && color.a >= 0.999) {
            let bgColor = roundColor(color);
            const darkRatio = contrastRatio(DARK_INK_COLOR, bgColor);
            const lightRatio = contrastRatio(LIGHT_INK_COLOR, bgColor);
            if (Math.max(darkRatio, lightRatio) < 4.65) {
                const useLightInk = lightRatio >= darkRatio;
                const targetInk = useLightInk ? LIGHT_INK_COLOR : DARK_INK_COLOR;
                const towards = useLightInk ? BLACK : WHITE;
                for (let step = 1; step <= 20; step++) {
                    const candidate = roundColor(mixColors(color, towards, (step * 0.55) / 20));
                    if (contrastRatio(targetInk, candidate) >= 4.65) {
                        bgColor = candidate;
                        break;
                    }
                }
            }
            const bgCss = colorToCss(bgColor);
            return {
                bg: bgCss,
                ink: readableColor(fallbackInk, [bgColor], 4.65),
                border: alpha(bgCss, 0.48),
            };
        }
        return {
            bg: layeredBackground(tokens, [alpha(accentCss, 0.3)], { canvas: true }),
            ink: fallbackInk,
            border: alpha(accentCss, 0.55),
        };
    }

    return {
        headGrounds,
        bodyGrounds,
        headLight,
        bodyLight,
        pickAccent,
        legible,
        tintedChip,
        neutralChip,
        solidBadge,
    };
}

function renderHero(spec, tokens, { master = false, custom = false }) {
    const p = memoryShardPrefix(tokens);
    const accent = accentAt(tokens, master ? 2 : 0);
    const frame = frameDecoration(tokens, accent);
    const glyph = decorative(tokens.glyph.section, tokens, { 'margin-right': '5px', opacity: '0.85' });
    const classes = master ? [`${p}-hero`, `${p}-hero-master`] : [`${p}-hero`];
    const icon = master ? 'fa-layer-group' : 'fa-book-open';
    const eyebrow = master ? 'Consolidated Chronicle' : (custom ? 'Memory Shard' : 'Story Chronicle');
    const title = master ? 'Master Memory Shard' : (custom ? '$1' : 'Memory Shard');
    const code = custom ? '' : `<span class="${p}-hero-code">$1</span>`;
    return `<div${rootAttrs(spec, tokens, classes)}${part('root')}>${frame}<div class="${p}-hero-row"><span class="${p}-hero-ico"><i class="fa-solid ${icon}" style="color:inherit"></i></span><div class="${p}-hero-copy"><span class="${p}-hero-eyebrow">${glyph}${eyebrow}</span><span class="${p}-hero-title">${title}</span></div>${code}</div></div>`;
}

function renderSection(def, tokens) {
    const p = memoryShardPrefix(tokens);
    return `<div class="${p}-sec ${p}-sec-${def.kind}"><span class="${p}-ico"><i class="fa-solid ${def.icon}" style="color:inherit"></i></span><span class="${p}-sec-title">$1</span><span class="${p}-sec-rule"></span></div>`;
}

function renderTag(def, tokens) {
    const p = memoryShardPrefix(tokens);
    // Keep `ms-tag` first inside `class="..."` with no extra attributes so
    // `memory-shard-thread-row`'s stock `findRegex` continues to match.
    return `<span class="ms-tag ${p}-tag ${p}-tag-${def.kind}">${def.label}</span>`;
}

function buildStyles(tokens) {
    const p = memoryShardPrefix(tokens);
    const pal = buildPalette(tokens);

    const headFamily = safeValue(tokens.type.family);
    const bodyFamily = safeValue(tokens.type.bodyFamily);
    const headBg = surfaceBackground(tokens, tokens.surface.headFrom, tokens.surface.headTo, '135deg');
    const secBg = surfaceBackground(tokens, tokens.surface.headFrom, tokens.surface.headTo, '90deg');
    const bodyBg = surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo, '180deg');
    const tileBg = layeredBackground(
        tokens,
        [tokens.surface.row, `linear-gradient(180deg,${tokens.surface.bodyFrom},${tokens.surface.bodyTo})`],
        { canvas: true },
    );
    const insetBg = layeredBackground(
        tokens,
        [tokens.surface.inset, `linear-gradient(180deg,${tokens.surface.bodyFrom},${tokens.surface.bodyTo})`],
        { canvas: true },
    );

    const primaryAccent = accentAt(tokens, 0);
    const masterAccent = accentAt(tokens, 2);
    const quoteAccent = pal.pickAccent(48, 6);
    const borderWidth = tokens.line.width;
    const borderStyle = tokens.line.style;
    const bodyLine = tokens.line.body === 'transparent' ? alpha(tokens.on.body, 0.16) : tokens.line.body;
    const headLine = tokens.line.head === 'transparent' ? alpha(tokens.on.head, 0.22) : tokens.line.head;
    const cardRadius = tokens.radius.body;
    const headRadius = tokens.radius.head;
    const tileRadius = tokens.radius.row;
    const chipRadius = tokens.radius.chip;
    const pillRadius = tokens.radius.pill;
    const accentStripe = tokens.line.edge === '0' ? '3px' : tokens.line.edge;
    const pairSep = tokens.glyphMode === 'none' ? ':' : safeValue(tokens.glyph.pairSep || ':');

    const heroIco = pal.tintedChip(primaryAccent, pal.headGrounds, tokens.on.head, pal.headLight);
    const masterIco = pal.tintedChip(masterAccent, pal.headGrounds, tokens.on.head, pal.headLight);
    const heroEyebrowInk = pal.legible(primaryAccent, tokens.on.head, pal.headGrounds);
    const masterEyebrowInk = pal.legible(masterAccent, tokens.on.head, pal.headGrounds);
    const heroCode = pal.neutralChip(pal.headGrounds, tokens.on.head);
    const evLoc = pal.neutralChip(pal.headGrounds, tokens.on.head);
    const evNum = pal.solidBadge(primaryAccent, tokens.on.head);

    const bodyEmInk = pal.legible(tokens.ink.muted, tokens.on.muted, pal.bodyGrounds);
    const bodyCode = pal.neutralChip(pal.bodyGrounds, tokens.on.chip.strong);
    const relPair = pal.neutralChip(pal.bodyGrounds, tokens.on.strong);
    const relArrInk = pal.legible(primaryAccent, relPair.ink, relPair.grounds);
    const relNote = pal.neutralChip(pal.bodyGrounds, tokens.on.muted);
    const kvKeyInk = pal.legible(tokens.on.label, tokens.on.strong, pal.bodyGrounds);
    const linkInk = pal.legible(primaryAccent, tokens.on.strong, pal.bodyGrounds);

    const sectionRules = SECTION_DEFS.map(def => {
        const accent = pal.pickAccent(def.hue, def.slot);
        const ico = pal.tintedChip(accent, pal.headGrounds, tokens.on.head, pal.headLight);
        return `.${p}-sec-${def.kind}{--${p}-sa:${accent};--${p}-sib:${ico.bg};--${p}-sii:${ico.ink};--${p}-sid:${ico.border};}`;
    }).join('');

    const tagRules = TAG_DEFS.map(def => {
        if (def.slot === null) {
            const chip = pal.neutralChip(pal.bodyGrounds, tokens.on.muted);
            if (def.kind === 'resolved') {
                const resolvedInk = pal.legible(tokens.on.muted, tokens.on.body, pal.bodyGrounds);
                return `span.${p}-tag-${def.kind}{background:${insetBg};color:${resolvedInk};border-color:${chip.border};border-style:dashed;}`;
            }
            return `span.${p}-tag-${def.kind}{background:${chip.bg};color:${chip.ink};border-color:${chip.border};}`;
        }
        const accent = pal.pickAccent(def.hue, def.slot);
        const chip = pal.tintedChip(accent, pal.bodyGrounds, tokens.on.strong, pal.bodyLight);
        return `span.${p}-tag-${def.kind}{background:${chip.bg};color:${chip.ink};border-color:${chip.border};}`;
    }).join('');

    const css = [
        /* Hero banner */
        `.${p}-hero{position:relative;overflow:hidden;box-sizing:border-box;max-width:100%;margin:4px 0 14px;padding:${tokens.space.headPadY} ${tokens.space.headPadX};border-radius:${headRadius};border:${borderWidth} ${borderStyle} ${headLine};background:${headBg};color:${tokens.on.head};box-shadow:${tokens.shadow.head};font-family:${bodyFamily};}`,
        `.${p}-hero::before{content:'';position:absolute;left:0;top:0;bottom:0;width:${accentStripe};background:${primaryAccent};pointer-events:none;}`,
        `.${p}-hero-master{border-color:${masterIco.border};}`,
        `.${p}-hero-master::before{background:${masterAccent};}`,
        `.${p}-hero-row{display:flex;align-items:center;gap:${tokens.space.gap};flex-wrap:wrap;min-width:0;}`,
        `.${p}-hero-ico{flex:0 0 34px;width:34px;height:34px;border-radius:${chipRadius};display:inline-flex;align-items:center;justify-content:center;background:${heroIco.bg};border:1px solid ${heroIco.border};color:${heroIco.ink};font-size:0.9rem;}`,
        `.${p}-hero-master .${p}-hero-ico{background:${masterIco.bg};border-color:${masterIco.border};color:${masterIco.ink};}`,
        `.${p}-hero-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;}`,
        `.${p}-hero-eyebrow{font-family:${bodyFamily};font-size:${tokens.type.labelSize};font-weight:${tokens.type.labelWeight};text-transform:${tokens.type.labelCase};letter-spacing:0.1em;color:${heroEyebrowInk};line-height:1.25;}`,
        `.${p}-hero-master .${p}-hero-eyebrow{color:${masterEyebrowInk};}`,
        `.${p}-hero-title{font-family:${headFamily};font-size:1.05em;font-weight:${tokens.type.headWeight};text-transform:${tokens.type.headCase};letter-spacing:${tokens.type.headTracking};color:${tokens.on.head};line-height:1.25;overflow-wrap:anywhere;}`,
        `.${p}-hero-code{display:inline-flex;align-items:center;max-width:100%;font-family:${MONO};font-size:${tokens.type.chipSize};font-weight:700;padding:${tokens.space.pillPad};border-radius:${pillRadius};background:${heroCode.bg};border:1px solid ${heroCode.border};color:${heroCode.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:${tokens.shadow.chip};}`,

        /* Section headers (opaque themed strip so headers remain legible on opposing hosts) */
        `.${p}-sec{--${p}-sa:${primaryAccent};--${p}-sib:${heroIco.bg};--${p}-sii:${heroIco.ink};--${p}-sid:${heroIco.border};display:flex;align-items:center;gap:${tokens.space.gap};box-sizing:border-box;max-width:100%;margin:16px 0 8px;padding:6px ${tokens.space.rowPadX};border-radius:${tileRadius};border:${borderWidth} ${borderStyle} ${headLine};border-left:${accentStripe} solid var(--${p}-sa);background:${secBg};color:${tokens.on.head};}`,
        sectionRules,
        `.${p}-ico{flex:0 0 24px;width:24px;height:24px;border-radius:${chipRadius};display:inline-flex;align-items:center;justify-content:center;font-size:0.74rem;background:var(--${p}-sib);color:var(--${p}-sii);border:1px solid var(--${p}-sid);}`,
        `.${p}-sec-title{font-family:${headFamily};font-size:${tokens.type.headSize};font-weight:${tokens.type.headWeight};text-transform:${tokens.type.headCase};letter-spacing:${tokens.type.headTracking};color:${tokens.on.head};line-height:1.25;min-width:0;overflow-wrap:anywhere;}`,
        `.${p}-sec-rule{flex:1 1 16px;height:1px;min-width:12px;background:linear-gradient(90deg,var(--${p}-sa),transparent);opacity:0.55;}`,

        /* Snapshot grid */
        `.${p}-sec-snapshot + ul{list-style:none !important;margin:0 0 12px !important;padding:0 !important;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:${tokens.space.gap};font-family:${bodyFamily};font-size:${tokens.type.bodySize};line-height:${tokens.type.lineHeight};}`,
        `.${p}-sec-snapshot + ul > li{box-sizing:border-box;min-width:0;margin:0;padding:${tokens.space.rowPadY} ${tokens.space.rowPadX};border-radius:${tileRadius};background:${tileBg};border:${borderWidth} ${borderStyle} ${bodyLine};color:${tokens.on.body};box-shadow:${tokens.shadow.body};display:flex;flex-direction:column;gap:3px;transition:border-color 0.15s ease;}`,
        `.${p}-sec-snapshot + ul > li:hover{border-color:${primaryAccent};}`,
        `.${p}-sec-snapshot + ul > li .${p}-kv-k{font-size:${tokens.type.labelSize};font-weight:${tokens.type.labelWeight};text-transform:${tokens.type.labelCase};letter-spacing:0.06em;color:${kvKeyInk};margin-right:0;}`,
        `.${p}-sec-snapshot + ul > li .${p}-kv-k::after{content:none;}`,
        `.${p}-sec-snapshot + ul > li .${p}-kv-v{font-size:${tokens.type.valueSize};font-weight:500;color:${tokens.on.strong};line-height:1.45;overflow-wrap:anywhere;}`,

        /* General section lists & prose */
        `.${p}-sec:not(.${p}-sec-snapshot) + ul,.${p}-sec + ol{list-style:none !important;box-sizing:border-box;max-width:100%;margin:0 0 12px !important;padding:${tokens.space.rowPadY} ${tokens.space.rowPadX} !important;border-radius:${cardRadius};background:${bodyBg};border:${borderWidth} ${borderStyle} ${bodyLine};color:${tokens.on.body};box-shadow:${tokens.shadow.body};font-family:${bodyFamily};font-size:${tokens.type.bodySize};line-height:${tokens.type.lineHeight};}`,
        `.${p}-sec:not(.${p}-sec-snapshot) + ul > li,.${p}-sec + ol > li{padding:5px 0;margin:0;border-bottom:1px solid ${bodyLine};color:${tokens.on.body};overflow-wrap:anywhere;}`,
        `.${p}-sec:not(.${p}-sec-snapshot) + ul > li:last-child,.${p}-sec + ol > li:last-child{border-bottom:none;padding-bottom:1px;}`,
        `.${p}-sec:not(.${p}-sec-snapshot) + ul > li:first-child,.${p}-sec + ol > li:first-child{padding-top:1px;}`,

        /* Quote list callouts */
        `.${p}-sec.${p}-sec-quotes + ul{padding:0 !important;background:transparent !important;border:none !important;box-shadow:none !important;display:flex;flex-direction:column;gap:${tokens.space.rowGap};}`,
        `.${p}-sec.${p}-sec-quotes + ul > li{padding:${tokens.space.rowPadY} ${tokens.space.rowPadX};border-radius:${tileRadius};border:${borderWidth} ${borderStyle} ${bodyLine};border-left:${accentStripe} solid ${quoteAccent};background:${tileBg};color:${tokens.on.body};font-style:italic;line-height:${tokens.type.lineHeight};box-shadow:${tokens.shadow.body};}`,
        `.${p}-sec.${p}-sec-quotes + ul > li:first-child,.${p}-sec.${p}-sec-quotes + ul > li:last-child{padding:${tokens.space.rowPadY} ${tokens.space.rowPadX};border-bottom:${borderWidth} ${borderStyle} ${bodyLine};}`,

        /* Section prose paragraphs (also pin Echo/Whisper/Hush/Ripple/Tide vars) */
        `.${p}-sec + p{box-sizing:border-box;max-width:100%;margin:0 0 12px !important;padding:${tokens.space.rowPadY} ${tokens.space.rowPadX} !important;border-radius:${cardRadius};background:${bodyBg};border:${borderWidth} ${borderStyle} ${bodyLine};color:${tokens.on.body};box-shadow:${tokens.shadow.body};font-family:${bodyFamily};font-size:${tokens.type.bodySize};line-height:${tokens.type.lineHeight};overflow-wrap:anywhere;--messageTextFontSize:${tokens.type.bodySize};--messageLineHeight:${tokens.type.lineHeight};--messageTextLetterSpacing:0em;--mesParagraphSpacingTop:0px;--mesParagraphSpacingBottom:12px;}`,

        /* Subcards (Characters, Events, Key Scenes, Intimate) */
        `.${p}-sub{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;box-sizing:border-box;max-width:100%;margin:10px 0 0;padding:${tokens.space.rowPadY} ${tokens.space.rowPadX};border-radius:${cardRadius} ${cardRadius} 0 0;background:${secBg};border:${borderWidth} ${borderStyle} ${headLine};border-bottom:1px solid ${bodyLine};color:${tokens.on.head};}`,
        `.${p}-sub-dot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;background:${primaryAccent};}`,
        `.${p}-sub-title{font-family:${headFamily};font-size:0.94em;font-weight:${tokens.type.headWeight};letter-spacing:0.02em;color:${tokens.on.head};min-width:0;overflow-wrap:anywhere;}`,
        `.${p}-ev-num{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:${chipRadius};background:${evNum.bg};border:1px solid ${evNum.border};color:${evNum.ink};font-family:${MONO};font-size:${tokens.type.chipSize};font-weight:700;line-height:1;}`,
        `.${p}-ev-title{font-family:${headFamily};font-size:0.94em;font-weight:${tokens.type.headWeight};color:${tokens.on.head};min-width:0;overflow-wrap:anywhere;}`,
        `.${p}-ev-loc{margin-left:auto;display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:2px 8px;border-radius:${pillRadius};background:${evLoc.bg};border:1px solid ${evLoc.border};color:${evLoc.ink};font-family:${bodyFamily};font-size:${tokens.type.chipSize};font-weight:500;overflow-wrap:anywhere;}`,
        `.${p}-ico-sm{font-size:0.85em;color:inherit;flex:0 0 auto;}`,

        /* Welded subcard bodies (ul, ol, p, consecutive p) */
        `.${p}-sub + ul,.${p}-sub + ol{list-style:none !important;box-sizing:border-box;max-width:100%;margin:0 0 10px !important;padding:${tokens.space.rowPadY} ${tokens.space.rowPadX} !important;border-radius:0 0 ${cardRadius} ${cardRadius};background:${bodyBg};border:${borderWidth} ${borderStyle} ${bodyLine};border-top:none;color:${tokens.on.body};box-shadow:${tokens.shadow.body};font-family:${bodyFamily};font-size:${tokens.type.bodySize};line-height:${tokens.type.lineHeight};}`,
        `.${p}-sub + ul > li,.${p}-sub + ol > li{padding:4px 0;margin:0;border-bottom:1px solid ${bodyLine};color:${tokens.on.body};overflow-wrap:anywhere;}`,
        `.${p}-sub + ul > li:last-child,.${p}-sub + ol > li:last-child{border-bottom:none;padding-bottom:1px;}`,
        `.${p}-sub + ul > li:first-child,.${p}-sub + ol > li:first-child{padding-top:1px;}`,
        `.${p}-sub + p{box-sizing:border-box;max-width:100%;margin:0 0 10px !important;padding:${tokens.space.rowPadY} ${tokens.space.rowPadX} !important;border-radius:0 0 ${cardRadius} ${cardRadius};background:${bodyBg};border:${borderWidth} ${borderStyle} ${bodyLine};border-top:none;color:${tokens.on.body};box-shadow:${tokens.shadow.body};font-family:${bodyFamily};font-size:${tokens.type.bodySize};line-height:${tokens.type.lineHeight};overflow-wrap:anywhere;--messageTextFontSize:${tokens.type.bodySize};--messageLineHeight:${tokens.type.lineHeight};--messageTextLetterSpacing:0em;--mesParagraphSpacingTop:0px;--mesParagraphSpacingBottom:10px;}`,
        `.${p}-sub + p:has(+ p),.${p}-sub + p + p:has(+ p){margin-bottom:0 !important;border-bottom:none;border-radius:0;padding-bottom:5px !important;box-shadow:none;--mesParagraphSpacingBottom:0px;}`,
        `.${p}-sub + p + p,.${p}-sub + p + p + p{box-sizing:border-box;max-width:100%;margin:0 0 10px !important;padding:4px ${tokens.space.rowPadX} ${tokens.space.rowPadY} !important;border-radius:0 0 ${cardRadius} ${cardRadius};background:${bodyBg};border:${borderWidth} ${borderStyle} ${bodyLine};border-top:none;color:${tokens.on.body};box-shadow:${tokens.shadow.body};font-family:${bodyFamily};font-size:${tokens.type.bodySize};line-height:${tokens.type.lineHeight};overflow-wrap:anywhere;--messageTextFontSize:${tokens.type.bodySize};--messageLineHeight:${tokens.type.lineHeight};--messageTextLetterSpacing:0em;--mesParagraphSpacingTop:0px;--mesParagraphSpacingBottom:10px;}`,

        /* Inline markdown protection (prevent host em/i/strong/code/a bleed on opposing themes) */
        `.${p}-sec + ul strong,.${p}-sec + ul b,.${p}-sec + ol strong,.${p}-sec + ol b,.${p}-sec + p strong,.${p}-sec + p b,.${p}-sub + ul strong,.${p}-sub + ul b,.${p}-sub + ol strong,.${p}-sub + ol b,.${p}-sub + p strong,.${p}-sub + p b,.${p}-sub + p + p strong,.${p}-sub + p + p b{color:${tokens.on.strong};}`,
        `.${p}-sec + ul em,.${p}-sec + ul i,.${p}-sec + ol em,.${p}-sec + ol i,.${p}-sec + p em,.${p}-sec + p i,.${p}-sub + ul em,.${p}-sub + ul i,.${p}-sub + ol em,.${p}-sub + ol i,.${p}-sub + p em,.${p}-sub + p i,.${p}-sub + p + p em,.${p}-sub + p + p i{color:${bodyEmInk};}`,
        `.${p}-sec + ul code,.${p}-sec + ol code,.${p}-sec + p code,.${p}-sub + ul code,.${p}-sub + ol code,.${p}-sub + p code{background:${bodyCode.bg};color:${bodyCode.ink};border:1px solid ${bodyCode.border};padding:1px 5px;border-radius:4px;font-family:${MONO};font-size:0.9em;}`,
        `.${p}-sec + ul a,.${p}-sec + p a,.${p}-sub + ul a,.${p}-sub + p a{color:${linkInk};}`,

        /* KV rows */
        `.${p}-kv-k{font-weight:${tokens.type.labelWeight};color:${kvKeyInk};margin-right:4px;}`,
        `.${p}-kv-k::after{content:'${pairSep}';}`,
        `.${p}-kv-v{color:${tokens.on.body};}`,

        /* Relationship rows */
        `.${p}-rel-pair{display:inline-flex;align-items:center;flex-wrap:wrap;gap:5px;max-width:100%;padding:2px 8px;margin-right:6px;border-radius:${chipRadius};background:${relPair.bg};border:1px solid ${relPair.border};color:${relPair.ink};vertical-align:baseline;}`,
        `.${p}-rel-a,.${p}-rel-b{font-weight:700;color:${relPair.ink};}`,
        `.${p}-rel-arr{color:${relArrInk};font-size:0.78em;}`,
        `.${p}-rel-note{display:inline-flex;align-items:center;padding:1px 8px;border-radius:${pillRadius};background:${relNote.bg};border:1px solid ${relNote.border};color:${relNote.ink};font-style:italic;font-size:${tokens.type.chipSize};font-weight:500;margin-right:6px;vertical-align:baseline;}`,
        `.${p}-rel-note:empty{display:none;}`,
        `.${p}-rel-body{display:block;margin-top:4px;color:${tokens.on.body};overflow-wrap:anywhere;}`,

        /* Tagged thread rows */
        `.${p}-thread-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:3px;}`,
        `.${p}-thread-title{font-weight:700;color:${tokens.on.strong};overflow-wrap:anywhere;}`,
        `.${p}-thread-body{display:block;color:${tokens.on.body};overflow-wrap:anywhere;}`,

        /* Semantic priority & status tags (span.ratms-* beats stock .ms-tag) */
        `span.${p}-tag{display:inline-flex;align-items:center;vertical-align:baseline;margin-right:5px;padding:1px 7px;border-radius:${pillRadius};font-family:${bodyFamily};font-size:${tokens.type.chipSize};font-weight:700;letter-spacing:0.06em;text-transform:uppercase;line-height:1.45;white-space:nowrap;border:1px solid ${bodyLine};box-shadow:${tokens.shadow.chip};}`,
        tagRules,

        /* Responsive phone & narrow containers */
        `@media (max-width: 768px){.${p}-sec-snapshot + ul{grid-template-columns:1fr;}.${p}-hero{padding:${tokens.space.rowPadY} ${tokens.space.rowPadX};}.${p}-ev-loc{margin-left:0;}}`,
        `@media (prefers-reduced-motion: reduce){.${p}-sec-snapshot + ul > li{transition:none;}}`,
    ].join('');

    return `<style>${css}</style>`;
}

/**
 * Renders one Memory Shard regex script's `replaceString` for the given theme tokens.
 */
export function renderMemoryShard(spec, tokens) {
    const suffix = spec.scriptId.replace(/^memory-shard-/, '');

    if (suffix === 'master-hero') return renderHero(spec, tokens, { master: true });
    if (suffix === 'hero') return renderHero(spec, tokens, {});
    if (suffix === 'custom-hero') return renderHero(spec, tokens, { custom: true });

    const section = SECTION_BY_SUFFIX.get(suffix);
    if (section) return renderSection(section, tokens);

    const tag = TAG_BY_SUFFIX.get(suffix);
    if (tag) return renderTag(tag, tokens);

    const p = memoryShardPrefix(tokens);
    if (suffix === 'event-loc') {
        return `<div class="${p}-sub ${p}-ev"><span class="${p}-ev-num">$1</span><span class="${p}-ev-title">$2</span><span class="${p}-ev-loc"><span class="${p}-ico-sm"><i class="fa-solid fa-location-dot" style="color:inherit"></i></span>$3</span></div>`;
    }
    if (suffix === 'event') {
        return `<div class="${p}-sub ${p}-ev"><span class="${p}-ev-num">$1</span><span class="${p}-ev-title">$2</span></div>`;
    }
    if (suffix === 'subheading') {
        return `<div class="${p}-sub"><span class="${p}-sub-dot"></span><span class="${p}-sub-title">$1</span></div>`;
    }
    if (suffix === 'rel-row') {
        return `$1<span class="${p}-rel-pair"><span class="${p}-rel-a">$2</span><span class="${p}-rel-arr"><i class="fa-solid fa-arrow-right" style="color:inherit"></i></span><span class="${p}-rel-b">$3</span></span><span class="${p}-rel-note">$4</span><span class="${p}-rel-body">$5</span>`;
    }
    if (suffix === 'thread-row') {
        return `$1<span class="${p}-thread-head">$2<span class="${p}-thread-title">$3</span></span><span class="${p}-thread-body">$4</span>`;
    }
    if (suffix === 'kv-row') {
        return `$1<span class="${p}-kv-k">$2</span> <span class="${p}-kv-v">$3</span>`;
    }
    if (suffix === 'styles') {
        return buildStyles(tokens);
    }

    return null;
}

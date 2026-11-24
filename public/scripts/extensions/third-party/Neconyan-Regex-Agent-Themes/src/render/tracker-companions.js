/** Repaint the bundled multi-script cards without changing their display protocol. */
import { colorToCss, composite, flattenColor, parseColor, readableColor } from '../color.js';
import { getStock } from '../stock.js';
import { accentAt } from '../tokens.js';
import { part, rootAttrs, safeValue, surfaceBackground } from './parts.js';

// The labels and icons still carry the meaning when a theme uses a monochrome palette.
const SEMANTIC_ACCENTS = Object.freeze({
    'oklch(74% .15 152)': 4,
    'oklch(80% .14 78)': 3,
    'oklch(72% .12 245)': 5,
    'oklch(64% .2 25)': 6,
    'oklch(76% .15 62)': 3,
    'oklch(80% .14 100)': 2,
});

/** Use an opaque version of the body surface for map elements that mix colours. */
function mapPaper(tokens) {
    const canvas = parseColor(tokens.a11y.canvas);
    let paper = flattenColor(tokens.surface.bodyFrom, [canvas])[0] ?? canvas;
    const scrim = parseColor(tokens.a11y.scrim);
    if (scrim) paper = composite(scrim, paper);
    return colorToCss(paper);
}

function repaint(stock, tokens) {
    let markup = stock;
    // Stock derives text from a mixture of accent and host ink. Use resolved readable ink
    // instead, including for badges and numbers on the theme's body surface.
    markup = markup.replace(/color:color-mix\(in oklch,[^;"<>]+/g, `color:${tokens.on.body}`);
    markup = markup.replace(/color:oklch\([^)]*\)/g, `color:${tokens.on.body}`);
    for (const [colour, index] of Object.entries(SEMANTIC_ACCENTS)) {
        markup = markup.replaceAll(colour, accentAt(tokens, index));
    }
    return markup
        .replaceAll('var(--SmartThemeQuoteColor)', tokens.on.label)
        .replaceAll('var(--SmartThemeBodyColor)', tokens.on.body)
        .replaceAll('var(--SmartThemeBlurTintColor)', tokens.surface.bodyFrom)
        .replaceAll('var(--SmartThemeShadowColor)', '#000000')
        .replaceAll('var(--mainFontFamily, system-ui, sans-serif)', safeValue(tokens.type.bodyFamily))
        .replaceAll('var(--mainFontFamily,system-ui,sans-serif)', safeValue(tokens.type.bodyFamily));
}

// The host chat styles colour <small> and <i> directly, overriding the card's ink.
// Keep explicit stock colours, but let the remaining elements inherit their card's.
function protectInheritedInk(markup, spec, tokens) {
    return markup.replace(/<(small|i)\b[^>]*>/g, tag => {
        const colour = spec.scriptId === 'visual-map-trail-open' && tag.startsWith('<i ')
            ? safeValue(tokens.on.label)
            : 'inherit';
        if (/\sstyle="[^"]*"/.test(tag)) {
            return tag.replace(/\sstyle="([^"]*)"/, (attribute, style) => {
                if (/(?:^|;)\s*color\s*:/.test(style)) return attribute;
                return ` style="color:${colour};${style}"`;
            });
        }
        return tag.replace(/>$/, ` style="color:${colour}">`);
    });
}

function decorateInlineRoot(markup, spec, tokens) {
    return markup.replace(/^<div style="([^"]*)"/, (_, original) => {
        const style = original
            .replace(/background:[^;]+/, `background:${safeValue(surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo))}`)
            .replace(/border-radius:[^;]+/, `border-radius:${safeValue(tokens.radius.body)}`)
            .replace(/font-family:[^;]+/, `font-family:${safeValue(tokens.type.bodyFamily)}`);
        return `<div${rootAttrs(spec, tokens)}${part('root')} style="${style}"`;
    });
}

function repaintMap(markup, spec, tokens) {
    const namespace = `ratvm-${tokens.slug}`;
    const paper = mapPaper(tokens);
    // A chat can contain maps from different themes. Scope both the classes and the
    // direction/type selectors so one card's embedded stylesheet cannot recolour another.
    markup = markup
        .replaceAll(/\.vm(?=[\w-]|[\s,{:.>#])/g, `.${namespace}`)
        .replaceAll(/\[data-vm-([dk])=/g, `.${namespace}-place[data-vm-$1=`)
        .replaceAll(/class="([^"]*)"/g, (_, classes) => `class="${classes.replace(/\bvm(?=-|\b)/g, namespace)}"`)
        .replace(`<div class="${namespace}">`, `<div${rootAttrs(spec, tokens, [namespace])}${part('root')}>`)
        .replace(/--vm-paper:[^;]+/, `--vm-paper:${paper}`)
        .replace(/--vm-card:[^;]+/, `--vm-card:${paper}`)
        .replace(/--vm-serif:[^;]+/, `--vm-serif:${safeValue(tokens.type.family)}`);

    // The type-specific tints are decorative, not status colours. Give each location
    // kind a place in the theme palette while preserving its icon and position.
    let index = 0;
    return markup.replace(/--vm-tint:oklch\([^)]*\)/g, () => `--vm-tint:${accentAt(tokens, index++ % tokens.accents.length)}`);
}

function opaqueOver(value, baseCss) {
    const base = parseColor(baseCss);
    const flat = base ? flattenColor(value, [base])[0] : null;
    return flat ? colorToCss(flat) : baseCss;
}

function repaintPlotCompass(markup, spec, tokens) {
    const namespace = `ratpc-${tokens.slug}`;
    const paper = mapPaper(tokens);
    const raised = opaqueOver(tokens.surface.row, paper);
    const accent = accentAt(tokens, 0);
    const accentColor = parseColor(accent);
    const onAccent = accentColor
        ? readableColor(tokens.mode === 'light' ? '#ffffff' : '#111318', [accentColor], 4.5)
        : 'var(--neco-on-accent,#ffffff)';
    const headInk = safeValue(tokens.on.head);
    return markup
        .replaceAll(/\.pc(?=[\w-]|[\s,{:.>#\[])/g, `.${namespace}`)
        .replaceAll(/class="([^"]*)"/g, (_, classes) => `class="${classes.replace(/\bpc(?=-|\b)/g, namespace)}"`)
        .replace(`<div class="${namespace}" data-pc-card="1">`, `<div${rootAttrs(spec, tokens, [namespace])}${part('root')} data-pc-card="1">`)
        .replace(/--pc-accent:[^;]+/, `--pc-accent:${accent}`)
        .replace(/--pc-on-accent:[^;]+/, `--pc-on-accent:${onAccent}`)
        .replace(/--pc-ink:[^;]+/, `--pc-ink:${tokens.on.body}`)
        .replace(/--pc-muted:[^;]+/, `--pc-muted:${tokens.on.muted}`)
        .replace(/--pc-paper:[^;]+/, `--pc-paper:${paper}`)
        .replace(/--pc-raised:[^;]+/, `--pc-raised:${raised}`)
        .replace(/--pc-line:[^;]+/, `--pc-line:${tokens.line.body}`)
        .replace(/--pc-label:[^;]+/, `--pc-label:${tokens.on.label}`)
        .replace(/--pc-accent-line:[^;]+/, `--pc-accent-line:${accent}`)
        .replace(/--pc-head-from:[^;]+/, `--pc-head-from:${tokens.surface.headFrom}`)
        .replace(/--pc-head-to:[^;]+/, `--pc-head-to:${tokens.surface.headTo}`)
        .replace(/--pc-head-ink:[^;]+/, `--pc-head-ink:${headInk}`)
        .replace(/--pc-head-sub:[^;]+/, `--pc-head-sub:${headInk}`)
        .replace(/--pc-head-pill-bg:[^;]+/, `--pc-head-pill-bg:color-mix(in oklch,${headInk} 14%,transparent)`)
        .replace(/--pc-head-pill-ink:[^;]+/, `--pc-head-pill-ink:${headInk}`)
        .replace(/--pc-head-pill-line:[^;]+/, `--pc-head-pill-line:color-mix(in oklch,${headInk} 30%,transparent)`)
        .replace(/--pc-radius:[^;]+/, `--pc-radius:${safeValue(tokens.radius.body)}`)
        .replace(/--pc-head-font:[^;]+/, `--pc-head-font:${safeValue(tokens.type.family)}`)
        .replace(/--pc-head-weight:[^;]+/, '--pc-head-weight:700')
        .replace(/--pc-body-font:[^;]+/, `--pc-body-font:${safeValue(tokens.type.bodyFamily)}`);
}

export function renderTrackerCompanion(spec, tokens) {
    const stock = getStock(spec.templateId, spec.scriptId);
    if (!stock) throw new Error(`Missing stock script for ${spec.templateId}/${spec.scriptId}`);
    if (spec.key === 'plot-compass') {
        return repaintPlotCompass(protectInheritedInk(stock.replaceString, spec, tokens), spec, tokens);
    }
    let markup = protectInheritedInk(repaint(stock.replaceString, tokens), spec, tokens);
    if (spec.key === 'visual-map') return repaintMap(markup, spec, tokens);
    if (['position-tracker-map-open', 'clothing-open', 'vitals-open', 'vitals-none'].includes(spec.scriptId)) {
        markup = decorateInlineRoot(markup, spec, tokens);
    }
    return markup;
}

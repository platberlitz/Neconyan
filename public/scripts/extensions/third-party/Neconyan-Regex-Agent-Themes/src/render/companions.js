/**
 * Renderers for the companion archetypes: terminal, stream, transcript, bold.
 *
 * The terminal archetype is the one place that ships an inline `<style>` block, because
 * stock does and because its panel needs rules inline styles cannot express. Note the
 * class-name pairing that makes it work: markup uses `rat-tw…` and the `<style>` block
 * also uses `.rat-tw…`. Both get rewritten to `custom-rat-tw…`, the markup by the
 * DOMPurify hook (chats.js:1916) and the selector by decodeStyleTags (chats.js:592), so
 * they still match. Prefixing either side by hand would break the pair.
 */

import { accentAt, alpha } from '../tokens.js';
import {
    decl, dynamicBackground, layeredBackground, part, radiusCorners, rootAttrs,
    surfaceBackground, surfaceFill,
} from './parts.js';

const PROMPT_USER = '{{user}}@st:~$';

/** Archetype G: a framed terminal window wrapping the model's raw block. */
export function renderTerminal(spec, tokens, options) {
    const term = tokens.term;
    const scopeClass = `rat-tw-${spec.ns}-${tokens.slug}`;
    const scope = `.${scopeClass}`;
    const scanline = tokens.scan
        ? `repeating-linear-gradient(0deg,${tokens.scan.color} 0,${tokens.scan.color} 1px,transparent 1px,transparent ${tokens.scan.size})`
        : 'linear-gradient(rgba(255,255,255,0.025) 50%,rgba(0,0,0,0.035) 50%)';
    const background = layeredBackground(tokens, [scanline, term.bg], { canvas: true });
    const panel = layeredBackground(tokens, [term.panel], { canvas: true });
    const cursorCss = tokens.glyphMode === 'none'
        ? ''
        : `${scope} .rat-tw-cursor::after { content: "\\258e"; opacity: 0.8; }`;

    const css = `
${scope}.rat-tw {
  max-width: 760px;
  margin: 1em auto;
  border: 1px solid ${term.border};
  border-radius: ${tokens.radius.body};
  background: ${background};
  color: ${tokens.on.term.text};
  font-family: ${term.font};
  font-size: ${tokens.type.bodySize};
  line-height: ${tokens.type.lineHeight};
  box-shadow: 0 0 22px ${term.glow}, inset 0 0 30px rgba(0,0,0,0.35);
  overflow: hidden;
}
${scope} .rat-tw-head {
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.65em 0.85em;
  background: ${panel};
  border-bottom: 1px solid ${term.border};
  color: ${tokens.on.term.accent};
  font-size: ${tokens.type.headSize};
  letter-spacing: 0.04em;
  font-weight: 700;
  list-style: none;
}
${scope} summary.rat-tw-head { cursor: pointer; }
${scope} .rat-tw-dot {
  width: 0.72em;
  height: 0.72em;
  border-radius: 50%;
  display: inline-block;
  opacity: 0.9;
}
${scope} .rat-tw-dot-r { background: #ff5f56; }
${scope} .rat-tw-dot-y { background: #ffbd2e; }
${scope} .rat-tw-dot-g { background: #27c93f; }
${scope} .rat-tw-title { margin-left: 0.35em; }
${scope} .rat-tw-status {
  margin-left: auto;
  font-weight: 400;
  font-size: ${tokens.type.labelSize};
  color: ${tokens.on.term.muted};
}
${scope} .rat-tw-body { padding: 0.85em; }
${scope} .rat-tw-body > details > summary {
  cursor: pointer;
  color: ${tokens.on.term.prompt};
  font-size: ${tokens.type.headSize};
  letter-spacing: 0.04em;
  margin-bottom: 0.6em;
}
${scope} .rat-tw-out {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
  color: ${tokens.on.term.text};
}
${scope} .rat-tw-prompt { color: ${tokens.on.term.prompt}; }
${scope} .rat-tw-badge {
  display: inline-block;
  padding: 0.15em 0.6em;
  border: 1px solid ${term.border};
  border-radius: ${tokens.radius.slot};
  color: ${tokens.on.term.badge};
  font-weight: 700;
}
${cursorCss}`;

    const dots = tokens.glyphMode === 'none' ? '' : '<span aria-hidden="true">'
        + '<span class="rat-tw-dot rat-tw-dot-r"></span>'
        + '<span class="rat-tw-dot rat-tw-dot-y"></span>'
        + '<span class="rat-tw-dot rat-tw-dot-g"></span></span>';
    const status = spec.status ? `<span class="rat-tw-status">${spec.status}</span>` : '';
    const titleRow = `${dots}<span class="rat-tw-title">${spec.title}</span>${status}`;
    const badge = spec.badge ? `<span class="rat-tw-badge">${spec.badge}</span>\n` : '';
    const expanded = options.openDefaults === 'all-open'
        || (options.openDefaults !== 'all-closed' && spec.open);
    const open = expanded ? ' open' : '';
    const cursor = tokens.glyphMode === 'none'
        ? ''
        : '<span aria-hidden="true" class="rat-tw-cursor"></span>';

    const output = `<div class="rat-tw-out"${part('terminal-output')}>`
        + `<span class="rat-tw-prompt">${PROMPT_USER} ${spec.prompt}</span>\n`
        + badge
        + `\n$${spec.body.g}\n\n`
        + `<span class="rat-tw-prompt">${PROMPT_USER} </span>${cursor}</div>`;

    // With a summary label the window chrome stays static and only the report collapses;
    // without one the whole window collapses from its title bar, as the stock CYOA does.
    const inner = spec.summary
        ? `<div class="rat-tw-head"${part('chrome')}>${titleRow}</div>`
            + `<div class="rat-tw-body"><details${open}><summary${part('header')}>${spec.summary}</summary>${output}</details></div>`
        : `<details${open}><summary class="rat-tw-head"${part('header')}>${titleRow}</summary>`
            + `<div class="rat-tw-body">${output}</div></details>`;

    return `<style>${css}\n</style><div${rootAttrs(spec, tokens, ['rat-tw', scopeClass])}${part('root')}>${inner}</div>`;
}

/** Archetype H: shell / row / close triples that bracket a run of message rows. */
export function renderStream(spec, tokens, options) {
    switch (spec.role) {
        case 'open': return streamShell(spec, tokens);
        case 'close': return '</div>'.repeat(spec.depth);
        default: return streamRow(spec, tokens, options);
    }
}

function streamShell(spec, tokens) {
    const accent = accentAt(tokens, spec.accent);

    const outer = decl({
        margin: spec.set === 'phone' ? `${tokens.space.outer} auto` : `${tokens.space.outer} 0`,
        'max-width': spec.set === 'phone' ? '360px' : '',
        padding: tokens.space.bodyPad,
        'border-radius': spec.set === 'phone' ? '30px' : tokens.radius.body,
        border: `${tokens.line.width} ${tokens.line.style} ${tokens.line.head}`,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo, '145deg'),
        'box-shadow': tokens.shadow.head,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        color: tokens.on.body,
        'line-height': tokens.type.lineHeight,
        position: spec.chrome === 'texture' ? 'relative' : '',
        overflow: spec.chrome === 'texture' ? 'hidden' : '',
        'container-type': 'inline-size',
    });

    const notch = spec.chrome === 'notch'
        ? `<div aria-hidden="true"${decl({
            width: '84px', height: '14px', 'border-radius': tokens.radius.pill,
            margin: `0 auto ${tokens.space.gap}`,
            background: tokens.surface.inset,
            border: `1px solid ${alpha(accent, 0.18)}`,
        })}></div>`
        : '';

    const texture = spec.chrome === 'texture'
        ? `<div aria-hidden="true"${decl({
            position: 'absolute', inset: '0', 'pointer-events': 'none',
            background: `radial-gradient(circle at 15% 20%,${alpha(accent, 0.14)},transparent 32%),`
                + `radial-gradient(circle at 90% 5%,${alpha(accent, 0.08)},transparent 28%)`,
        })}></div>`
        : '';

    // The title is a capture for the inbox sets and static text for the chatroom.
    const titleText = typeof spec.title === 'object' ? `$${spec.title.g}` : spec.title;
    const metaText = spec.meta?.label
        ? `${spec.meta.label}: $${spec.meta.g}`
        : (spec.meta ? `$${spec.meta.g}` : '');
    const badge = spec.badge
        ? `<span${decl({
            'font-size': tokens.type.labelSize, 'font-weight': '700', padding: tokens.space.pillPad,
            'border-radius': tokens.radius.pill,
            background: surfaceFill(tokens, alpha(accent, 0.22)), color: tokens.on.strong,
        })}>${spec.badge}</span>`
        : '';

    const header = `<div${part('chrome')}${decl({
        display: 'flex', 'align-items': 'center', 'justify-content': 'space-between',
        gap: tokens.space.gap, 'margin-bottom': tokens.space.gap,
        position: spec.chrome === 'texture' ? 'relative' : '',
        'padding-bottom': spec.chrome === 'texture' ? tokens.space.rowPadY : '',
        'border-bottom': spec.chrome === 'texture' ? `1px solid ${alpha(accent, 0.28)}` : '',
    })}>`
        + `<div${decl({ 'font-weight': '700', 'letter-spacing': '0.02em', 'min-width': '0' })}>${titleText}</div>`
        + `<div${decl({ display: 'flex', gap: '6px', 'align-items': 'center', 'flex-wrap': 'wrap' })}>`
        + (metaText ? `<span${decl({ 'font-size': tokens.type.labelSize, color: tokens.on.muted })}>${metaText}</span>` : '')
        + badge
        + '</div></div>';

    const screenOpen = spec.set === 'phone'
        ? `<div${decl({
            padding: tokens.space.bodyPad,
            'border-radius': '23px',
            background: surfaceFill(tokens, tokens.surface.row),
            border: `1px solid ${alpha(accent, 0.12)}`,
        })}>`
        : '';

    const column = `<div role="feed"${part('stream-body')}${decl({
        display: 'flex', 'flex-direction': 'column', gap: tokens.space.gap,
        position: spec.chrome === 'texture' ? 'relative' : '',
    })}>`;

    return `<div${rootAttrs(spec, tokens)}${part('root')}${outer}>`
        + notch + texture + screenOpen + header + column;
}

function streamRow(spec, tokens, options) {
    const accent = accentAt(tokens, spec.accent);
    const useHue = spec.hue && (tokens.speakerHue ?? true);

    // Per-speaker colour: the pattern captures a 0-360 hue as a literal number, which is
    // valid inside oklch() once interpolated. Themes that are deliberately monochrome
    // opt out via speakerHue and fall back to the accent ramp.
    const nameBackground = useHue
        ? `linear-gradient(135deg,oklch(66% .15 $${spec.hue.g} / .32),oklch(48% .12 $${spec.hue.g} / .18))`
        : `linear-gradient(135deg,${alpha(accent, 0.28)},${alpha(accent, 0.16)})`;
    const nameBorder = useHue
        ? `1px solid oklch(70% .14 $${spec.hue.g} / .52)`
        : `1px solid ${alpha(accent, 0.4)}`;

    const isGreen = spec.tone === 'green';
    const [bubbleTopLeft, bubbleTopRight, bubbleBottomRight] = radiusCorners(tokens.radius.body);
    const bubbleRadius = spec.variant === 'bubble'
        ? `${bubbleTopLeft} ${bubbleTopRight} ${bubbleBottomRight} 6px`
        : tokens.radius.row;

    const bodyStyle = decl({
        display: 'block',
        'max-width': '100%',
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        'border-radius': spec.variant === 'block' ? tokens.radius.row : bubbleRadius,
        background: surfaceFill(tokens, isGreen || spec.variant === 'bubble'
            ? tokens.surface.rowAlt
            : tokens.surface.row),
        border: `1px solid ${isGreen ? 'rgba(120,220,150,0.42)' : alpha(accent, 0.2)}`,
        color: tokens.on.body,
        'font-family': isGreen ? 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' : tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'white-space': 'pre-wrap',
        'overflow-wrap': 'anywhere',
        'box-shadow': spec.variant === 'bubble' && tokens.shadow.chip !== 'none' ? tokens.shadow.chip : '',
    });

    const bodySpan = `<span${part('stream-text')}${bodyStyle}>$${spec.body.g}</span>`;

    if (!spec.speaker) {
        return `<article${rootAttrs(spec, tokens)}${part('stream-row')}${decl({
            display: 'flex', 'flex-direction': 'column', gap: tokens.space.rowGap,
            'align-items': 'flex-start', 'max-width': '100%',
        })}>${bodySpan}</article>`;
    }

    const name = `<b${part('stream-name')}${decl({
        display: 'inline-block',
        'max-width': '170px',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
        padding: tokens.space.chipPad,
        'border-radius': tokens.radius.pill,
        background: dynamicBackground(tokens, [nameBackground]),
        border: nameBorder,
        color: tokens.on.safety,
    })}>$${spec.speaker.g}</b>`;

    const meta = spec.meta
        ? `<small${part('stream-meta')}${decl({
            color: tokens.on.muted, 'font-size': tokens.type.labelSize, overflow: 'hidden',
            'text-overflow': 'ellipsis', 'white-space': 'nowrap',
        })}>$${spec.meta.g}</small>`
        : '';

    // The parchment variant sets its byline as a baseline-aligned row rather than a pill.
    if (spec.variant === 'block') {
        return `<article${rootAttrs(spec, tokens)}${part('stream-row')}${decl({ padding: '3px 0 0' })}>`
            + `<div${decl({
                display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between',
                gap: tokens.space.gap, 'margin-bottom': '4px', color: tokens.on.label,
            })}><b${part('stream-name')}>$${spec.speaker.g}</b>${meta}</div>`
            + bodySpan + '</article>';
    }

    return `<article${rootAttrs(spec, tokens)}${part('stream-row')}${decl({
        display: 'flex', 'flex-direction': 'column', gap: tokens.space.rowGap,
        'align-items': 'flex-start', 'max-width': '100%',
    })}>`
        + `<div${decl({ display: 'flex', 'align-items': 'center', gap: '6px', 'max-width': '100%', 'min-width': '0' })}>`
        + name + meta + '</div>'
        + bodySpan + '</article>';
}

/** Archetype I: one speaker-labelled turn in a plain transcript. */
export function renderTranscript(spec, tokens) {
    const accent = accentAt(tokens, spec.accent);
    const nameBackground = dynamicBackground(tokens, [alpha(accent, 0.24)]);
    return `<article${rootAttrs(spec, tokens)}${part('root')}${decl({
        display: 'flex', 'flex-direction': 'column', gap: tokens.space.rowGap,
        margin: `0 0 ${tokens.space.gap}`, 'max-width': '100%',
        padding: tokens.space.rowPadY,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'border-radius': tokens.radius.body,
    })}>`
        + `<div${decl({ display: 'flex', 'align-items': 'center', gap: '7px', 'min-width': '0' })}>`
        + `<b${part('stream-name')}${decl({
            display: 'inline-block', 'max-width': '180px', overflow: 'hidden',
            'text-overflow': 'ellipsis', 'white-space': 'nowrap',
            padding: tokens.space.pillPad, 'border-radius': tokens.radius.pill,
            background: nameBackground,
            border: `1px solid ${alpha(accent, 0.32)}`,
            color: tokens.on.safety,
        })}>$${spec.speaker.g}</b></div>`
        + `<div${part('stream-text')}${decl({
            padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            'border-radius': tokens.radius.row,
            background: surfaceFill(tokens, tokens.surface.row),
            border: `1px solid ${alpha(accent, 0.16)}`,
            color: tokens.on.body,
            'line-height': tokens.type.lineHeight,
            'white-space': 'pre-wrap',
            'overflow-wrap': 'anywhere',
        })}>$${spec.body.g}</div>`
        + '</article>';
}

/**
 * Archetype J: the shared bold-markdown helper. Left as stock unless the user opts into
 * restyling, since it applies to all prose in the message, not just tracker output.
 */
export function renderBold(spec, tokens, options) {
    if (!options.restyleBold) {
        return '<strong>$1</strong>';
    }
    return `<strong${rootAttrs(spec, tokens)}${part('root')}${decl({
        color: 'inherit',
        'font-weight': tokens.type.valueWeight,
        'text-decoration': 'underline',
        'text-decoration-color': accentAt(tokens, spec.accent),
        'text-decoration-thickness': '2px',
        'text-underline-offset': '2px',
    })}>$1</strong>`;
}

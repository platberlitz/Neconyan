/**
 * Platform looks for the themed Chatroom feed.
 *
 * The stock Chatroom shell ships a `<style>` block keyed on `data-chatroom-style`, so a
 * feed written as `thread-board/4chan` reads like a board and `twitter/x` like a timeline.
 * This module rebuilds those rules for a theme: the platform's layout, markers and
 * signature type stay, and every colour comes from the theme's palette with a contrast
 * check against the theme's own surfaces.
 *
 * The rules are scoped to a per-theme class rather than `.chatroom-feed`, so the stock
 * block (which may also be on the page, in a preview or an older message) can't reach a
 * themed feed. Every declaration is `!important` because it has to beat the inline styles
 * on the themed rows, exactly as the stock rules beat the stock inline styles.
 */

import {
    DARK_CANVAS, LIGHT_CANVAS, colorToCss, contrastRatio, flattenColor, mixColors, parseColor,
    readableColor, relativeLuminance,
} from '../color.js';
import { accentAt, alpha } from '../tokens.js';

/** The platforms the stock shell styles, in the stock block's order. */
export const CHATROOM_PLATFORMS = Object.freeze(['4chan', 'reddit', 'twitter', 'discord', 'ao3', 'newsroom', 'infomercial']);

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const GEORGIA = 'Georgia,\'Times New Roman\',serif';
const IMPACT = 'Impact,\'Arial Black\',sans-serif';
const BLACK = parseColor('#000000');
const WHITE = parseColor('#ffffff');

/** The class that scopes one theme's chatroom rules. */
export function chatroomScopeClass(spec, tokens) {
    return `rat-cr-${spec.key}-${tokens.slug}`;
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

/** Composited backdrops the feed's text can land on: shell gradient ends and rows. */
function backdrops(tokens) {
    const canvas = parseColor(tokens.a11y?.canvas ?? (tokens.mode === 'light' ? LIGHT_CANVAS : DARK_CANVAS));
    if (!canvas) return [];
    const shell = [tokens.surface.bodyFrom, tokens.surface.bodyTo]
        .flatMap(value => flattenColor(value, [canvas]));
    if (shell.length < 2) return [];
    const rows = [tokens.surface.row, tokens.surface.rowAlt]
        .flatMap(value => flattenColor(value, shell));
    if (rows.length < 4) return [];
    return [...shell, ...rows];
}

/**
 * Builds the colour helpers for one theme. Every helper degrades to the theme's own
 * pre-checked inks when the palette can't be measured (the adaptive themes use host
 * variables), so the worst case is the theme's ordinary text colour.
 */
function palette(tokens) {
    const grounds = backdrops(tokens);
    const measurable = grounds.length > 0;
    const lightGround = measurable
        && grounds.reduce((sum, color) => sum + relativeLuminance(color), 0) / grounds.length > 0.35;

    const accents = tokens.accents.map((value, index) => {
        const color = parseColor(value);
        return color && color.a >= 0.999 ? { index, color, ...hueOf(color) } : { index, color: null };
    });

    /** The theme accent closest to a platform's signature hue, or the fallback slot. */
    function nearest(target, spread, fallback, avoid = -1) {
        let best = null;
        for (const accent of accents) {
            if (!accent.color || accent.chroma < 0.12 || accent.index === avoid) continue;
            const gap = Math.abs(accent.hue - target);
            const distance = Math.min(gap, 360 - gap);
            if (distance <= spread && (!best || distance < best.distance)) {
                best = { index: accent.index, distance };
            }
        }
        if (best) return best.index;
        if (fallback < 0) return fallback;
        return fallback === avoid ? (fallback + 1) % tokens.accents.length : fallback;
    }

    /** A colour as text: kept when it reads, nudged lighter or darker when it doesn't. */
    function legible(value, fallback, on = grounds) {
        const color = parseColor(value);
        if (!color || color.a < 0.999 || !on.length) return fallback;
        const passes = candidate => on.every(ground => contrastRatio(candidate, ground) >= 4.5);
        if (passes(color)) return value;
        const towards = on.every(ground => relativeLuminance(ground) > 0.35) ? BLACK : WHITE;
        for (let step = 1; step <= 8; step++) {
            const nudged = mixColors(color, towards, step / 10);
            if (passes(nudged)) return colorToCss(nudged);
        }
        return fallback;
    }

    /** Accent text over the feed's surfaces. */
    function accentText(index) {
        return legible(accentAt(tokens, index), tokens.on.accents?.[index] ?? tokens.on.label);
    }

    /** A solid accent fill with readable ink, or a wash when the accent can't be measured. */
    function solid(index) {
        const value = accentAt(tokens, index);
        const color = parseColor(value);
        if (!color || color.a < 0.999) {
            return { background: alpha(value, 0.22), ink: tokens.on.strong, color: null };
        }
        return { background: value, ink: readableColor('#ffffff', [color]), color };
    }

    /** Inverse card: the theme's strong ink as the fill, the shell colour as the text. */
    function inverse() {
        const fill = parseColor(tokens.on.strong);
        if (!fill || fill.a < 0.999 || !measurable) {
            return { background: tokens.surface.rowAlt, ink: tokens.on.body, color: null };
        }
        return { background: tokens.on.strong, ink: readableColor(colorToCss(grounds[0]), [fill]), color: fill };
    }

    /** Greentext stays green: the nearest green accent, else a stock-like green. */
    function green(on = grounds) {
        const index = nearest(100, 60, -1);
        if (index >= 0) {
            const kept = legible(accentAt(tokens, index), null, on);
            if (kept) return kept;
        }
        const onLight = on.length > 0 && on.every(ground => relativeLuminance(ground) > 0.35);
        return legible(onLight ? '#4d7a12' : '#a6d96a', tokens.on.label, on);
    }

    return { measurable, lightGround, nearest, legible, accentText, solid, inverse, green };
}

function rule(selectors, declarations) {
    const body = Object.entries(declarations)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([property, value]) => `${property}:${value}!important`)
        .join(';');
    return body ? `${selectors.join(',')}{${body}}` : '';
}

const RESET_PILL = { padding: '0', background: 'none', border: 'none', 'border-radius': '0', 'box-shadow': 'none' };
const RESET_BODY = { 'max-width': 'none', padding: '0', background: 'none', border: 'none', 'border-radius': '0', 'box-shadow': 'none', 'font-family': 'inherit' };
const STRETCH_EVENT = { 'align-self': 'stretch', 'max-width': 'none', 'text-align': 'left', opacity: '1' };

/**
 * Builds the minified, single-line stylesheet for one theme's chatroom feed.
 * `scope` is the selector for the feed root, e.g. `.rat-cr-chatroom-marshmallow`.
 */
export function chatroomPlatformCss(scope, tokens) {
    const p = palette(tokens);
    const on = tokens.on;
    const line = tokens.line.head;
    const box = tokens.surface.rowAlt;
    const useHue = (tokens.speakerHue ?? true) && p.measurable;
    const out = [];

    const add = (platform, suffixes, declarations) => {
        const list = Array.isArray(suffixes) ? suffixes : [suffixes];
        out.push(rule(list.map(suffix => `${scope}[data-chatroom-style*="${platform}" i]${suffix}`), declarations));
    };

    // Base: greentext stays green and monospace in the plain feed.
    const baseGreen = p.green();
    out.push(rule([`${scope} .chatroom-greentext`, `${scope} .chatroom-post--green .chatroom-body`], { color: baseGreen }));
    out.push(rule([`${scope} .chatroom-post--green .chatroom-body`], { 'font-family': MONO }));
    // Platform titles grow (Impact caps, r/, 𝕏, #); on a narrow message the style label
    // wraps under the title instead of the title breaking mid-word.
    out.push(rule([`${scope} .chatroom-header`], { 'flex-wrap': 'wrap' }));
    out.push(rule([`${scope} .chatroom-title`], { 'flex-shrink': '0', 'min-width': 'auto', 'overflow-wrap': 'normal', 'word-break': 'normal' }));

    // 4chan: square reply boxes on the board colour, >> markers, OP unboxed, (You).
    {
        const red = p.nearest(355, 40, 0);
        const name = p.nearest(150, 45, 1, red);
        const title = p.accentText(red);
        const live = p.solid(red);
        const quote = p.green();
        add('4chan', '', { 'border-radius': '0', 'box-shadow': 'none' });
        add('4chan', ' .chatroom-header', { 'border-bottom': `1px solid ${line}`, 'padding-bottom': '6px' });
        add('4chan', ' .chatroom-title', { color: title, 'font-family': 'Tahoma,sans-serif', 'font-size': '1.15em' });
        add('4chan', ' .chatroom-style-label', { color: on.muted });
        add('4chan', ' .chatroom-live', { background: live.background, color: live.ink, 'border-radius': '0' });
        add('4chan', ' .chatroom-posts', { gap: '4px' });
        add('4chan', ' .chatroom-post', {
            display: 'block', position: 'relative', width: 'fit-content', 'max-width': 'calc(100% - 18px)',
            margin: '0 0 0 18px', padding: '4px 8px', background: box, border: `1px solid ${line}`,
            'border-top': 'none', 'border-left': 'none', 'border-radius': '0', color: on.body,
        });
        add('4chan', ' .chatroom-post::before', {
            content: '">>"', position: 'absolute', left: '-17px', top: '4px', color: on.muted, 'font-size': '.85em',
        });
        add('4chan', ' .chatroom-posts>.chatroom-post:first-child', {
            'max-width': '100%', margin: '0 0 4px', padding: '0 0 6px', background: 'none', border: 'none',
            'border-bottom': `1px solid ${line}`,
        });
        add('4chan', [' .chatroom-posts>.chatroom-post:first-child::before', ' .chatroom-post--cont::before'], { content: 'none' });
        add('4chan', ' .chatroom-head', { display: 'flex', 'flex-wrap': 'wrap', gap: '5px' });
        add('4chan', ' .chatroom-name', { ...RESET_PILL, color: p.accentText(name), 'font-weight': '700', 'max-width': 'none' });
        add('4chan', ' .chatroom-meta', { color: on.body, 'font-size': '1em', opacity: '1' });
        add('4chan', ' .chatroom-body', { ...RESET_BODY, display: 'block', padding: '3px 0 0', color: on.body });
        add('4chan', [' .chatroom-post--green .chatroom-body', ' .chatroom-greentext'], { color: quote });
        add('4chan', ' .chatroom-post--cont', { background: 'none', border: 'none', padding: '0 8px' });
        add('4chan', ' .chatroom-replyto', {
            display: 'block', color: on.body, opacity: '1', 'font-size': '1em', overflow: 'visible', 'padding-top': '3px',
        });
        add('4chan', [' .chatroom-replyto-label', ' .chatroom-replyto-at', ' .chatroom-post--viewer .chatroom-meta', ' .chatroom-event-icon'], { display: 'none' });
        add('4chan', ' .chatroom-replyto-target', { color: title, 'text-decoration': 'underline', 'font-weight': '400' });
        add('4chan', ' .chatroom-replyto-target::before', { content: '">>"' });
        add('4chan', ' .chatroom-post--viewer .chatroom-name::after', { content: '" (You)"', 'font-weight': '400', color: on.body });
        add('4chan', ' .chatroom-event', {
            'align-self': 'flex-start', 'margin-left': '18px', padding: '0', border: 'none', 'border-radius': '0',
            background: 'none', color: title, 'font-weight': '700', 'text-transform': 'uppercase',
            'font-size': '.85em', 'text-align': 'left', opacity: '1',
        });
        add('4chan', ' .chatroom-event::before', { content: '"("' });
        add('4chan', ' .chatroom-event::after', { content: '")"' });
        add('4chan', [' .chatroom-poll', ' .chatroom-poll-option'], { 'border-radius': '0', color: on.body, 'border-color': line });
        add('4chan', ' .chatroom-poll', { background: box });
    }

    // Reddit: r/ and u/ prefixes, thread lines, nested replies, the vote row.
    {
        const brand = p.nearest(16, 30, 0);
        const link = p.nearest(204, 40, 1, brand);
        const pin = p.nearest(130, 50, 2, brand);
        const live = p.solid(brand);
        add('reddit', '', { 'border-radius': '8px', 'box-shadow': 'none' });
        add('reddit', ' .chatroom-title::before', { content: '"r/"', color: p.accentText(brand) });
        add('reddit', ' .chatroom-style-label', { color: on.muted });
        add('reddit', ' .chatroom-live', { background: live.background, color: live.ink });
        add('reddit', ' .chatroom-posts', { gap: '12px' });
        add('reddit', ' .chatroom-post', {
            'align-items': 'flex-start', gap: '3px', 'max-width': 'none', 'margin-left': '0', 'padding-left': '10px',
            'border-left': `2px solid ${line}`,
        });
        add('reddit', ' .chatroom-post--reply', { 'margin-left': '16px' });
        add('reddit', ' .chatroom-post--viewer', { 'border-left-color': accentAt(tokens, brand) });
        add('reddit', ' .chatroom-post--viewer .chatroom-head', { 'flex-direction': 'row-reverse' });
        add('reddit', ' .chatroom-name', { ...RESET_PILL, color: on.strong, 'font-size': '.85em', 'font-weight': '600', 'max-width': 'none' });
        add('reddit', ' .chatroom-name::before', { content: '"u/"', color: on.muted, 'font-weight': '400' });
        add('reddit', ' .chatroom-meta', { color: on.muted, opacity: '1', 'font-size': '.78em' });
        add('reddit', ' .chatroom-meta:not(:empty)::before', { content: '"· "' });
        add('reddit', ' .chatroom-body', { ...RESET_BODY, 'max-width': '100%', color: on.body });
        add('reddit', ' .chatroom-post--green .chatroom-body', { 'padding-left': '8px', 'border-left': `3px solid ${line}` });
        add('reddit', [' .chatroom-greentext', ' .chatroom-post--green .chatroom-body'], { color: on.muted, 'font-family': 'inherit' });
        add('reddit', ' .chatroom-post:not(.chatroom-post--cont)::after', {
            content: '"⇧ Vote ⇩     Reply     Share"', 'white-space': 'pre', color: on.muted, 'font-size': '.72em', 'font-weight': '700',
        });
        add('reddit', ' .chatroom-replyto', { color: on.muted, opacity: '1' });
        add('reddit', [' .chatroom-replyto-label', ' .chatroom-replyto-at', ' .chatroom-event-icon'], { display: 'none' });
        add('reddit', ' .chatroom-replyto::before', { content: '"↳ "' });
        add('reddit', ' .chatroom-replyto-target', { color: p.accentText(link), 'font-weight': '400' });
        add('reddit', ' .chatroom-replyto-target::before', { content: '"u/"' });
        add('reddit', ' .chatroom-event', {
            ...STRETCH_EVENT, border: `1px solid ${line}`, 'border-radius': '4px', background: box, color: on.body,
        });
        add('reddit', ' .chatroom-event::before', { content: '"📌 Pinned by mods · "', color: p.accentText(pin), 'font-weight': '700' });
        add('reddit', ' .chatroom-poll', { background: box, 'border-color': line, 'border-radius': '8px' });
        add('reddit', ' .chatroom-poll-option', { color: on.body, 'border-color': line });
    }

    // Twitter / X: edge-to-edge timeline, round avatars, divider rows, the action row.
    {
        const brand = p.nearest(204, 40, 0);
        const live = p.solid(brand);
        const avatar = useHue ? 'oklch(62% .15 var(--chatroom-hue,205))' : accentAt(tokens, brand === 1 ? 2 : 1);
        add('twitter', '', { padding: '0', overflow: 'hidden', 'border-radius': '16px', 'box-shadow': 'none' });
        add('twitter', ' .chatroom-header', { margin: '0', padding: '12px 16px' });
        add('twitter', ' .chatroom-title', { 'font-weight': '800' });
        add('twitter', ' .chatroom-title::before', { content: '"𝕏  "' });
        add('twitter', ' .chatroom-style-label', { color: on.muted });
        add('twitter', ' .chatroom-live', { background: live.background, color: live.ink });
        add('twitter', ' .chatroom-posts', { gap: '0' });
        add('twitter', ' .chatroom-post', {
            display: 'grid', 'grid-template-columns': '40px minmax(0,1fr)', 'column-gap': '10px', 'row-gap': '2px',
            'align-items': 'start', 'align-self': 'stretch', 'max-width': 'none', margin: '0', padding: '12px 16px',
            border: 'none', 'border-top': `1px solid ${line}`,
        });
        add('twitter', ' .chatroom-post::before', {
            content: '""', 'grid-column': '1', 'grid-row': '1/span 4', width: '40px', height: '40px',
            'border-radius': '50%', background: avatar,
        });
        add('twitter', ' .chatroom-post--viewer::before', { background: accentAt(tokens, brand) });
        add('twitter', ' .chatroom-post--cont', { 'padding-top': '0', 'border-top': 'none' });
        add('twitter', ' .chatroom-post--cont::before', { height: '0' });
        add('twitter', ' .chatroom-post>*', { 'grid-column': '2' });
        add('twitter', ' .chatroom-head', { 'flex-wrap': 'wrap', gap: '4px' });
        add('twitter', ' .chatroom-post--viewer .chatroom-head', { 'flex-direction': 'row-reverse', 'justify-content': 'flex-end' });
        add('twitter', ' .chatroom-name', { ...RESET_PILL, color: on.strong, 'font-weight': '700', 'max-width': '65%' });
        add('twitter', ' .chatroom-meta', { color: on.muted, opacity: '1', 'font-size': '.9em' });
        add('twitter', ' .chatroom-body', { ...RESET_BODY, color: on.body });
        add('twitter', [' .chatroom-greentext', ' .chatroom-post--green .chatroom-body'], { color: on.body, 'font-family': 'inherit' });
        add('twitter', ' .chatroom-post:not(.chatroom-post--cont)::after', {
            content: '"↩     ⇄     ♡     ⇪"', 'grid-column': '2', 'white-space': 'pre', color: on.muted,
            'font-size': '.85em', 'padding-top': '4px',
        });
        add('twitter', ' .chatroom-replyto', { color: on.muted, opacity: '1', 'font-size': '.9em' });
        add('twitter', [' .chatroom-replyto-label', ' .chatroom-event-icon'], { display: 'none' });
        add('twitter', ' .chatroom-replyto::before', { content: '"Replying to "' });
        add('twitter', ' .chatroom-replyto-target', { color: p.accentText(brand), 'font-weight': '400' });
        add('twitter', ' .chatroom-event', {
            ...STRETCH_EVENT, padding: '10px 16px', border: 'none', 'border-top': `1px solid ${line}`,
            'border-radius': '0', background: 'none', color: on.body, 'font-size': '.85em',
        });
        add('twitter', ' .chatroom-event::before', { content: '"Trending · "', color: on.muted });
        add('twitter', ' .chatroom-poll', { margin: '0 16px 0 66px', padding: '6px 0', background: 'none', border: 'none' });
        add('twitter', ' .chatroom-poll-option', { width: 'auto', margin: '0 16px 6px 66px', border: 'none', 'border-radius': '4px', color: on.body });
    }

    // Discord: # channel, avatars, coloured names, the reply line above the message.
    {
        const mention = p.nearest(235, 40, 0);
        const red = p.nearest(358, 30, 0, mention);
        const join = p.nearest(145, 50, 2, red);
        const live = p.solid(red);
        const avatar = useHue ? 'oklch(60% .14 var(--chatroom-hue,265))' : accentAt(tokens, mention);
        const nameInk = useHue ? `oklch(${p.lightGround ? '42%' : '80%'} .14 var(--chatroom-hue,265))` : on.label;
        add('discord', '', { 'border-radius': '8px', 'box-shadow': 'none' });
        add('discord', ' .chatroom-title', { color: on.strong });
        add('discord', ' .chatroom-title::before', { content: '"# "', color: on.muted });
        add('discord', ' .chatroom-style-label', { color: on.muted });
        add('discord', ' .chatroom-live', { background: live.background, color: live.ink, 'border-radius': '4px' });
        add('discord', ' .chatroom-posts', { gap: '14px' });
        add('discord', ' .chatroom-post', {
            display: 'grid', 'grid-template-columns': '36px minmax(0,1fr)', 'column-gap': '12px', 'row-gap': '2px',
            'align-items': 'start', 'align-self': 'stretch', 'max-width': 'none', margin: '0', padding: '0', border: 'none',
            background: 'none',
        });
        add('discord', ' .chatroom-post::before', {
            content: '""', 'grid-column': '1', 'grid-row': '1/span 3', width: '36px', height: '36px',
            'border-radius': '50%', background: avatar,
        });
        add('discord', ' .chatroom-post--viewer::before', { background: accentAt(tokens, 2) });
        add('discord', ' .chatroom-post--cont::before', { height: '0' });
        add('discord', ' .chatroom-post>*', { 'grid-column': '2' });
        add('discord', ' .chatroom-post--reply::before', { 'grid-row': '2/span 2' });
        add('discord', ' .chatroom-post--reply .chatroom-replyto', { 'grid-row': '1' });
        add('discord', ' .chatroom-post--reply .chatroom-head', { 'grid-row': '2' });
        add('discord', ' .chatroom-post--reply .chatroom-body', { 'grid-row': '3' });
        add('discord', ' .chatroom-post--viewer .chatroom-head', { 'flex-direction': 'row-reverse', 'justify-content': 'flex-end' });
        add('discord', ' .chatroom-name', { ...RESET_PILL, color: nameInk, 'font-weight': '600' });
        add('discord', ' .chatroom-post--viewer .chatroom-name', { color: p.accentText(2) });
        add('discord', ' .chatroom-meta', { color: on.muted, opacity: '1', 'font-size': '.72em' });
        add('discord', ' .chatroom-body', { ...RESET_BODY, color: on.body });
        add('discord', ' .chatroom-post--green .chatroom-body', { 'padding-left': '10px', 'border-left': `4px solid ${line}` });
        add('discord', [' .chatroom-greentext', ' .chatroom-post--green .chatroom-body'], { color: on.body, 'font-family': 'inherit' });
        add('discord', ' .chatroom-replyto', { color: on.muted, opacity: '1' });
        add('discord', [' .chatroom-replyto-label', ' .chatroom-event-icon'], { display: 'none' });
        add('discord', ' .chatroom-replyto::before', { content: '"╭ "', color: on.muted });
        add('discord', ' .chatroom-replyto-target', {
            padding: '0 3px', 'border-radius': '3px', background: alpha(accentAt(tokens, mention), 0.3),
            color: on.strong, 'font-weight': '500',
        });
        add('discord', ' .chatroom-event', {
            ...STRETCH_EVENT, padding: '0 0 0 48px', border: 'none', background: 'none', color: on.muted, 'font-size': '.85em',
        });
        add('discord', ' .chatroom-event::before', { content: '"→  "', color: p.accentText(join), 'font-weight': '700' });
        add('discord', ' .chatroom-poll', { 'margin-left': '48px', background: box, 'border-color': line, 'border-radius': '8px' });
        add('discord', ' .chatroom-poll-option', { width: 'auto', 'margin-left': '48px', color: on.body, 'border-color': line });
    }

    // AO3: boxed comments with a byline bar, serif text, Reply · Thread · Parent.
    {
        const red = p.nearest(0, 35, 0);
        const ink = p.accentText(red);
        const live = p.solid(red);
        add('ao3', '', { 'border-radius': '0', 'box-shadow': 'none' });
        add('ao3', ' .chatroom-header', { 'padding-bottom': '6px', 'border-bottom': `1px solid ${accentAt(tokens, red)}` });
        add('ao3', ' .chatroom-title', { color: ink, 'font-family': GEORGIA, 'font-weight': '400', 'font-size': '1.2em' });
        add('ao3', ' .chatroom-style-label', { color: on.muted });
        add('ao3', ' .chatroom-live', { background: live.background, color: live.ink, 'border-radius': '0' });
        add('ao3', ' .chatroom-posts', { gap: '10px' });
        add('ao3', ' .chatroom-post', {
            'align-items': 'stretch', 'align-self': 'stretch', gap: '0', 'max-width': 'none', margin: '0', padding: '0',
            background: tokens.surface.row, border: `1px solid ${line}`, 'border-radius': '0',
        });
        add('ao3', ' .chatroom-post--reply', { 'margin-left': '22px' });
        add('ao3', ' .chatroom-post--cont', { border: 'none', background: 'none' });
        add('ao3', ' .chatroom-head', { 'max-width': 'none', padding: '5px 8px', background: box, 'border-bottom': `1px solid ${line}` });
        add('ao3', ' .chatroom-post--viewer .chatroom-head', { 'flex-direction': 'row-reverse', 'justify-content': 'flex-end' });
        add('ao3', ' .chatroom-name', { ...RESET_PILL, color: ink, 'font-weight': '700' });
        add('ao3', ' .chatroom-meta', { color: on.muted, opacity: '1', 'font-style': 'italic', 'font-size': '.8em' });
        add('ao3', ' .chatroom-body', { ...RESET_BODY, padding: '8px', color: on.body, 'font-family': GEORGIA });
        add('ao3', ' .chatroom-post--green .chatroom-body', { margin: '8px', padding: '0 8px', 'border-left': `3px solid ${line}`, 'font-style': 'italic' });
        add('ao3', [' .chatroom-greentext', ' .chatroom-post--green .chatroom-body'], { color: on.muted, 'font-family': GEORGIA });
        add('ao3', ' .chatroom-greentext', { 'font-style': 'italic' });
        add('ao3', ' .chatroom-post:not(.chatroom-post--cont)::after', {
            content: '"Reply · Thread · Parent"', 'align-self': 'flex-end', padding: '0 8px 6px', color: ink, 'font-size': '.72em',
        });
        add('ao3', ' .chatroom-replyto', { padding: '5px 8px 0', color: on.muted, opacity: '1' });
        add('ao3', ' .chatroom-replyto-target', { color: ink });
        add('ao3', ' .chatroom-event-icon', { display: 'none' });
        add('ao3', ' .chatroom-event', { ...STRETCH_EVENT, border: `1px solid ${line}`, 'border-radius': '0', background: box, color: ink });
        add('ao3', [' .chatroom-poll', ' .chatroom-poll-option'], { 'border-radius': '0', 'border-color': line, color: on.body });
        add('ao3', ' .chatroom-poll', { background: box });
    }

    // Newsroom: tracked caps, chyron name plates, the Breaking bar.
    {
        const red = p.nearest(352, 35, 0);
        const yellow = p.nearest(50, 30, 2, red);
        const plate = p.solid(red);
        const card = p.inverse();
        const breaking = plate.color ? p.legible(accentAt(tokens, yellow), plate.ink, [plate.color]) : plate.ink;
        add('newsroom', '', { 'border-radius': '6px' });
        add('newsroom', ' .chatroom-title', { 'text-transform': 'uppercase', 'letter-spacing': '.12em', 'font-weight': '800' });
        add('newsroom', ' .chatroom-title::before', { content: '"● "', color: p.accentText(red) });
        add('newsroom', ' .chatroom-style-label', { color: on.muted });
        add('newsroom', ' .chatroom-live', { background: plate.background, color: plate.ink, 'border-radius': '2px', 'letter-spacing': '.08em' });
        add('newsroom', ' .chatroom-post', {
            'align-items': 'stretch', 'align-self': 'stretch', gap: '0', 'max-width': 'none', margin: '0', padding: '0',
            border: 'none', background: 'none',
        });
        add('newsroom', ' .chatroom-head', { gap: '0' });
        add('newsroom', ' .chatroom-name', {
            padding: '3px 8px', background: plate.background, border: 'none', 'border-radius': '0', color: plate.ink,
            'text-transform': 'uppercase', 'letter-spacing': '.04em', 'font-size': '.8em',
        });
        add('newsroom', ' .chatroom-meta', {
            padding: '4px 8px', background: card.background, color: card.ink, opacity: '1', 'font-weight': '700',
            'text-transform': 'uppercase', 'letter-spacing': '.05em', 'font-size': '.7em',
        });
        add('newsroom', ' .chatroom-meta:empty', { display: 'none' });
        add('newsroom', ' .chatroom-body', {
            ...RESET_BODY, padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            background: alpha(on.strong, 0.08), 'border-left': `3px solid ${accentAt(tokens, red)}`, color: on.body,
        });
        add('newsroom', [' .chatroom-greentext', ' .chatroom-post--green .chatroom-body'], { color: on.body, 'font-family': 'inherit', 'font-style': 'italic' });
        add('newsroom', ' .chatroom-replyto', { padding: '4px 0', color: on.muted, opacity: '1', 'text-transform': 'uppercase', 'font-size': '.7em' });
        add('newsroom', [' .chatroom-replyto-label', ' .chatroom-event-icon'], { display: 'none' });
        add('newsroom', ' .chatroom-replyto::before', { content: '"Re: "' });
        add('newsroom', ' .chatroom-replyto-target', { color: on.strong });
        add('newsroom', ' .chatroom-event', {
            ...STRETCH_EVENT, border: 'none', 'border-radius': '0', background: plate.background, color: plate.ink,
            'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '.03em',
        });
        add('newsroom', ' .chatroom-event::before', { content: '"Breaking · "', color: breaking });
        add('newsroom', [' .chatroom-poll', ' .chatroom-poll-option'], { 'border-radius': '0', 'border-color': line, color: on.body });
        add('newsroom', ' .chatroom-poll', { background: alpha(on.strong, 0.06) });
    }

    // Infomercial: loud yellow frame, Impact caps, name plates and a phone-in banner.
    {
        const yellow = p.nearest(52, 30, 0);
        const red = p.nearest(358, 35, 1, yellow);
        const yellowFill = p.solid(yellow);
        const redFill = p.solid(red);
        const card = p.inverse();
        const shout = p.accentText(yellow);
        const banner = redFill.color ? p.legible(accentAt(tokens, yellow), redFill.ink, [redFill.color]) : redFill.ink;
        const cardGreen = card.color ? p.green([card.color]) : baseGreen;
        add('infomercial', '', { border: `3px solid ${accentAt(tokens, yellow)}`, 'border-radius': '6px' });
        // Yellow darkened enough to read on a light shell turns beige, so light themes swap
        // the pair: red lettering with the yellow drop shadow.
        const [titleInk, titleShadow] = p.lightGround ? [p.accentText(red), yellow] : [shout, red];
        add('infomercial', ' .chatroom-title', {
            'font-family': IMPACT, 'font-weight': '400', 'font-size': '1.3em', 'letter-spacing': '.04em',
            'text-transform': 'uppercase', color: titleInk, 'text-shadow': `2px 2px 0 ${accentAt(tokens, titleShadow)}`,
        });
        add('infomercial', ' .chatroom-style-label', { color: shout });
        add('infomercial', ' .chatroom-live', { background: redFill.background, color: redFill.ink, 'border-radius': '2px' });
        add('infomercial', ' .chatroom-name', {
            padding: '2px 8px', background: yellowFill.background, border: `2px solid ${accentAt(tokens, red)}`,
            'border-radius': '3px', color: yellowFill.ink, 'font-family': IMPACT, 'font-weight': '400',
            'letter-spacing': '.03em', 'text-transform': 'uppercase', 'max-width': '100%',
        });
        add('infomercial', ' .chatroom-meta', { color: shout, opacity: '1', 'font-weight': '700', 'text-transform': 'uppercase' });
        add('infomercial', ' .chatroom-body', {
            background: card.background, border: 'none', 'border-radius': '4px',
            'box-shadow': `3px 3px 0 ${accentAt(tokens, red)}`, color: card.ink, 'font-family': 'inherit', 'font-weight': '700',
        });
        add('infomercial', [' .chatroom-greentext', ' .chatroom-post--green .chatroom-body'], { color: cardGreen, 'font-family': 'inherit' });
        add('infomercial', ' .chatroom-replyto', { color: shout, opacity: '1' });
        add('infomercial', ' .chatroom-event-icon', { display: 'none' });
        add('infomercial', ' .chatroom-event', {
            ...STRETCH_EVENT, 'text-align': 'center', background: redFill.background,
            border: `2px solid ${accentAt(tokens, yellow)}`, 'border-radius': '4px', color: banner,
            'font-family': IMPACT, 'font-size': '1.05em', 'letter-spacing': '.04em', 'text-transform': 'uppercase',
        });
        add('infomercial', [' .chatroom-event::before', ' .chatroom-event::after'], { content: '" ☎ "' });
        add('infomercial', ' .chatroom-poll', { background: alpha(accentAt(tokens, yellow), 0.12), 'border-color': accentAt(tokens, yellow) });
        add('infomercial', ' .chatroom-poll-option', { 'border-color': accentAt(tokens, yellow), color: on.body });
    }

    return out.filter(Boolean).join('');
}

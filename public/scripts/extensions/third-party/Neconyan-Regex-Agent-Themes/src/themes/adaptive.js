/**
 * Themes that take their palette from the active Neconyan theme instead of hardcoding
 * one. These are the only themes that use `color-mix()` and `var(--SmartTheme*)`, because
 * deriving from the host is the entire point. Every `var()` carries a literal fallback so
 * a host theme missing a variable still renders.
 *
 * The companion templates already work this way in stock, so the mechanism is proven.
 */

import { HOST, mix } from '../tokens.js';

const quoteRamp = [
    mix(HOST.quote, HOST.body, 88),
    mix(HOST.em, HOST.body, 80),
    mix(HOST.quote, HOST.body, 62),
    mix(HOST.em, HOST.body, 58),
    mix(HOST.quote, HOST.body, 44),
    mix(HOST.em, HOST.body, 38),
    mix(HOST.quote, HOST.body, 74),
];

const hostSurfaces = {
    headFrom: mix(HOST.tint, 'transparent', 94),
    headTo: mix(HOST.quote, HOST.tint, 20),
    bodyFrom: mix(HOST.tint, 'transparent', 92),
    bodyTo: mix(HOST.body, HOST.tint, 6),
    row: mix(HOST.body, 'transparent', 6),
    rowAlt: mix(HOST.quote, 'transparent', 12),
    inset: mix(HOST.body, 'transparent', 9),
    chip: mix(HOST.quote, 'transparent', 18),
};

const hostInk = {
    head: HOST.body,
    body: HOST.body,
    label: mix(HOST.quote, HOST.body, 62),
    muted: mix(HOST.body, 'transparent', 60),
    strong: HOST.body,
    warm: mix(HOST.em, HOST.body, 70),
    cool: mix(HOST.quote, HOST.body, 70),
};

export const ADAPTIVE = [
    {
        slug: 'adaptive-native',
        name: 'Adaptive Native',
        family: 'adaptive',
        mode: 'adaptive',
        surface: hostSurfaces,
        ink: hostInk,
        line: {
            head: mix(HOST.quote, 'transparent', 32),
            body: mix(HOST.quote, 'transparent', 20),
            width: '1px', edge: '3px',
        },
        shadow: { head: `0 10px 24px ${mix(HOST.shadow, 'transparent', 24)}`, body: 'none' },
        accents: quoteRamp,
        radius: { head: '12px', body: '12px', row: '9px', slot: '8px' },
        type: { family: HOST.font, bodyFamily: HOST.font, headSize: '11px' },
        glyph: { section: '▪', sectionAlt: '▫', bullet: '·', sep: '·', chevron: '▾' },
    },
    {
        slug: 'adaptive-accent',
        name: 'Adaptive Accent',
        family: 'adaptive',
        mode: 'adaptive',
        surface: {
            ...hostSurfaces,
            headTo: mix(HOST.quote, HOST.tint, 34),
            rowAlt: mix(HOST.quote, 'transparent', 18),
        },
        ink: { ...hostInk, head: mix(HOST.quote, HOST.body, 34) },
        line: {
            head: mix(HOST.quote, 'transparent', 46),
            body: mix(HOST.quote, 'transparent', 26),
            width: '1px', edge: '4px',
        },
        shadow: { head: `0 8px 20px ${mix(HOST.shadow, 'transparent', 28)}`, body: 'none' },
        accents: [
            mix(HOST.quote, HOST.body, 94),
            mix(HOST.quote, HOST.body, 82),
            mix(HOST.quote, HOST.body, 70),
            mix(HOST.quote, HOST.body, 58),
            mix(HOST.quote, HOST.body, 46),
            mix(HOST.quote, HOST.body, 34),
            mix(HOST.quote, HOST.body, 88),
        ],
        radius: { head: '10px', body: '10px', row: '8px', slot: '7px' },
        type: { family: HOST.font, bodyFamily: HOST.font, headSize: '11px', labelCase: 'uppercase', labelSize: '9px' },
        glyph: { section: '●', sectionAlt: '○', bullet: '·', sep: '·', chevron: '▾' },
    },
    {
        slug: 'adaptive-ink',
        name: 'Adaptive Ink',
        family: 'adaptive',
        mode: 'adaptive',
        surface: {
            ...hostSurfaces,
            headFrom: 'transparent', headTo: 'transparent',
            bodyFrom: 'transparent', bodyTo: 'transparent',
            row: 'transparent',
            rowAlt: mix(HOST.quote, 'transparent', 10),
        },
        ink: hostInk,
        line: {
            head: mix(HOST.body, 'transparent', 48),
            body: 'transparent',
            width: '0', edge: '0', edgeSide: 'none',
        },
        shadow: { head: 'none', body: 'none' },
        accents: quoteRamp,
        radius: { head: '0', body: '0', row: '0', slot: '0', pill: '999px', chip: '999px' },
        space: { headPadY: '6px', headPadX: '0', bodyPad: '4px 0 12px', rowPadY: '7px', rowPadX: '0', gap: '8px' },
        type: {
            family: HOST.font, bodyFamily: HOST.font, headSize: '11px',
            headCase: 'uppercase', headTracking: '0.14em', headWeight: '700',
            labelCase: 'uppercase', labelSize: '9px',
        },
        glyph: { section: '', sectionAlt: '', bullet: '·', sep: '·', chevron: '▾' },
        extra: {
            header: `border-bottom:2px solid ${mix(HOST.body, 'transparent', 46)}`,
            row: `border-bottom:1px solid ${mix(HOST.body, 'transparent', 14)}`,
        },
    },
];

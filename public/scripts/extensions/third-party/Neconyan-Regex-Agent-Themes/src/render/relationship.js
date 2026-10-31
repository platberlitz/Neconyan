/**
 * Faithful, theme-aware renderers for the Relationship Bond (`tpl-relationship-tracker`,
 * 21 capture groups) and classic Relationship Tracker (6 capture groups).
 *
 * Preserves the original Dating Sim visual hierarchy (full-bleed route banner, dual conic
 * ring portraits, 3-step route progress stepper, 2x2 Heart/Trust/Wants/Guard stat grid,
 * 2-column Likes/Dislikes cards, Tell quote bar, concealed Unsaid spoiler drawer, tilted
 * Keepsake Memory card, Would Say Yes To invitation card, and Turning Point / Next
 * Threshold footer grid) while binding every surface, border, typography and text token
 * to the active Regex Agent Theme and its contrast guarantees.
 */

import { accentAt, alpha } from '../tokens.js';
import {
    borderValue, collapsible, decl, decorative, layeredBackground,
    needsPositioning, ornament, part, pill, statTile, surfaceBackground,
    surfaceFill, weldedRadius, withExtra,
} from './parts.js';
import { resolveOpen } from './trackers.js';

function ringPortrait(initialGroup, nameGroup, tokens, { size = '30px', ringPadding = '2px', fontSize = '12px' } = {}) {
    const primary = accentAt(tokens, 6);
    const secondary = accentAt(tokens, 2);
    const tertiary = accentAt(tokens, 4);
    return `<span${part('portrait')}${decl({
        position: 'relative',
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: size,
        height: size,
        'min-width': size,
        'border-radius': '50%',
        padding: ringPadding,
        background: `conic-gradient(from 180deg,${primary},${secondary},${tertiary},${primary})`,
        'box-shadow': `0 2px 8px ${alpha(primary, 0.28)}`,
        'vertical-align': 'middle',
        'flex-shrink': '0',
    })}><span${decl({
        position: 'relative',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: '100%',
        height: '100%',
        'border-radius': '50%',
        overflow: 'hidden',
        background: surfaceFill(tokens, tokens.surface.row),
        color: tokens.on.strong,
        'font-weight': '700',
        'font-size': fontSize,
    })}>$${initialGroup}<span${decl({
        position: 'absolute',
        inset: '0',
        'border-radius': '50%',
        background: `url(&quot;/thumbnail/portrait?name=$${nameGroup}&amp;char={{char}}&quot;) center 18%/cover no-repeat`,
    })}></span></span></span>`;
}

function smallBadge(text, tokens, accentIndex, { icon = '' } = {}) {
    const accent = accentAt(tokens, accentIndex);
    const glyph = icon ? decorative(icon, tokens) : '';
    const prefix = glyph ? `${glyph} ` : '';
    return `<span${part('pill')}${decl({
        display: 'inline-flex',
        'align-items': 'center',
        gap: '3px',
        padding: '2px 8px',
        'border-radius': tokens.radius.pill,
        background: surfaceFill(tokens, alpha(accent, 0.14)),
        border: `1px solid ${alpha(accent, 0.28)}`,
        color: tokens.on.accents[accentIndex],
        'font-size': tokens.type.labelSize,
        'font-weight': tokens.type.labelWeight,
    })}>${prefix}${text}</span>`;
}

function microHeader(label, icon, tokens, accentIndex) {
    const glyph = icon ? decorative(icon, tokens) : '';
    const prefix = glyph ? `${glyph} ` : '';
    return `<div${part('row-label')}${decl({
        color: tokens.on.accents[accentIndex],
        'font-size': tokens.type.labelSize,
        'font-weight': tokens.type.labelWeight,
        'letter-spacing': '0.08em',
        'text-transform': 'uppercase',
        'margin-bottom': '4px',
    })}>${prefix}${label}</div>`;
}

/**
 * Full 21-group Dating Sim Relationship Bond card (`tpl-relationship-tracker`).
 */
export function renderRelationshipBond(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const primary = accentAt(tokens, 6);
    const secondary = accentAt(tokens, 5);
    const warmAccent = accentAt(tokens, 2);
    const goldAccent = accentAt(tokens, 3);
    const posAccent = accentAt(tokens, 4);

    // 1. Summary bar: 30x30 ring portrait + name/stage stack + right status pill & chevron
    const summaryStyle = withExtra(decl({
        display: 'flex',
        'align-items': 'center',
        gap: '10px',
        padding: `${tokens.space.headPadY} ${tokens.space.headPadX}`,
        background: surfaceBackground(tokens, tokens.surface.headFrom, tokens.surface.headTo, '135deg'),
        'border-radius': weldedRadius(tokens.radius.head, 'top'),
        border: borderValue(tokens, tokens.line.head),
        'box-shadow': tokens.shadow.head,
        color: tokens.on.head,
        'font-family': tokens.type.family,
        'font-size': tokens.type.headSize,
        cursor: 'pointer',
        position: needsPositioning(tokens) ? 'relative' : '',
        'list-style': 'none',
    }), tokens, 'header');

    const heartIcon = decorative(spec.icon || '💞', tokens);
    const chevronGlyph = tokens.glyph.chevron
        ? ` <span aria-hidden="true"${part('chevron')}${decl({ opacity: '0.65', display: 'inline-block' })}>${tokens.glyph.chevron}</span>`
        : '';

    const summaryInner = ornament(tokens, 'headerBefore')
        + ringPortrait(1, 2, tokens, { size: '30px', ringPadding: '2px', fontSize: '12px' })
        + `<span${decl({ flex: '1', 'min-width': '0', 'line-height': '1.25' })}>`
        + `<b${decl({ color: tokens.on.head, 'font-weight': tokens.type.headWeight })}>${heartIcon ? `${heartIcon} ` : ''}$2</b>`
        + `<span${decl({ display: 'block', color: tokens.on.muted, 'font-size': tokens.type.labelSize })}>$3 · $4</span>`
        + '</span>'
        + `<span${decl({
            color: tokens.on.accents[6],
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
            'margin-left': 'auto',
            'white-space': 'nowrap',
        })}>$5${chevronGlyph}</span>`
        + ornament(tokens, 'headerAfter');

    const header = `<summary${part('header')}${summaryStyle}>${summaryInner}</summary>`;

    // 2. Top full-bleed route banner
    const routeBanner = `<div${part('row')}${decl({
        margin: `-${tokens.space.bodyPad} -${tokens.space.bodyPad} ${tokens.space.gap}`,
        padding: `6px ${tokens.space.bodyPad}`,
        background: surfaceFill(tokens, alpha(primary, 0.14)),
        'border-bottom': `1px solid ${alpha(primary, 0.24)}`,
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        gap: '8px',
        'flex-wrap': 'wrap',
    })}>`
        + `<span${part('row-label')}${decl({
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
            'letter-spacing': '0.12em',
            'text-transform': 'uppercase',
            color: tokens.on.accents[6],
        })}>${decorative('✦', tokens)}${tokens.glyphMode === 'none' ? '' : ' '}Route</span>`
        + `<b${part('row-value')}${decl({
            color: tokens.on.strong,
            'font-size': tokens.type.bodySize,
            'font-weight': tokens.type.valueWeight,
        })}>$6</b>`
        + '</div>';

    // 3. Hero identity row (64x64 conic-ring portrait + display name + 3 stage/archetype/status pills)
    const heroIdentity = `<div${part('hero')}${decl({
        display: 'flex',
        'align-items': 'center',
        gap: '14px',
        'margin-bottom': tokens.space.gap,
        'flex-wrap': 'wrap',
    })}>`
        + ringPortrait(1, 2, tokens, { size: '64px', ringPadding: '3px', fontSize: '22px' })
        + `<div${decl({ flex: '1', 'min-width': '150px' })}>`
        + `<div${decl({
            'font-size': tokens.type.valueSize,
            'font-weight': '700',
            color: tokens.on.strong,
            'letter-spacing': '0.01em',
            'margin-bottom': '6px',
        })}>$2</div>`
        + `<div${decl({ display: 'flex', 'flex-wrap': 'wrap', gap: '5px' })}>`
        + smallBadge('$3', tokens, 6, { icon: '🪜' })
        + smallBadge('$4', tokens, 5)
        + smallBadge('$5', tokens, 2)
        + '</div></div></div>';

    // 4. Route progress 3-step horizontal stepper ($7 -> $8 -> $9)
    const routeStepper = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        border: `1px solid ${alpha(primary, 0.2)}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.gap,
    })}>`
        + microHeader('Route Progress', '💘', tokens, 6)
        + `<div${part('stepper')}${decl({
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'flex-wrap': 'wrap',
            'font-size': tokens.type.labelSize,
        })}>`
        + `<span${part('step-past')}${decl({
            padding: '4px 9px',
            'border-radius': tokens.radius.pill,
            background: surfaceFill(tokens, alpha(primary, 0.08)),
            border: `1px solid ${alpha(primary, 0.2)}`,
            color: tokens.on.muted,
            'overflow-wrap': 'anywhere',
        })}>$7</span>`
        + `<span aria-hidden="true"${part('step-line')}${decl({
            flex: '1',
            'min-width': '10px',
            height: '2px',
            background: `linear-gradient(90deg,${alpha(primary, 0.25)},${primary})`,
        })}></span>`
        + `<span${part('step-current')}${decl({
            padding: '5px 11px',
            'border-radius': tokens.radius.pill,
            background: surfaceFill(tokens, alpha(primary, 0.2)),
            border: `1px solid ${alpha(primary, 0.55)}`,
            color: tokens.on.strong,
            'font-weight': '700',
            'box-shadow': `0 2px 10px ${alpha(primary, 0.22)}`,
            'overflow-wrap': 'anywhere',
        })}>${decorative('♥', tokens)}${tokens.glyphMode === 'none' ? '' : ' '}$8</span>`
        + `<span aria-hidden="true"${part('step-line')}${decl({
            flex: '1',
            'min-width': '10px',
            height: '0',
            'border-top': `2px dashed ${alpha(primary, 0.35)}`,
        })}></span>`
        + `<span${part('step-next')}${decl({
            padding: '4px 9px',
            'border-radius': tokens.radius.pill,
            background: surfaceFill(tokens, tokens.surface.rowAlt),
            border: `1px dashed ${alpha(secondary, 0.38)}`,
            color: tokens.on.body,
            'overflow-wrap': 'anywhere',
        })}>${decorative('🔒', tokens)}${tokens.glyphMode === 'none' ? '' : ' '}$9</span>`
        + '</div></div>';

    // 5. 2x2 stat grid (Heart $10, Trust $11, Wants $12, Guard $13)
    const statGrid = `<dl${part('grid')}${decl({
        display: 'grid',
        'grid-template-columns': 'repeat(auto-fit,minmax(135px,1fr))',
        gap: tokens.space.gap,
        margin: `0 0 ${tokens.space.gap}`,
    })}>${spec.stats.map(statSpec => statTile(statSpec, tokens, options)).join('')}</dl>`;

    // 6. 2-column Likes ($14) / Dislikes ($15) cards
    const affinityGrid = `<div${part('grid')}${decl({
        display: 'grid',
        'grid-template-columns': 'repeat(auto-fit,minmax(140px,1fr))',
        gap: tokens.space.gap,
        'margin-bottom': tokens.space.gap,
    })}>`
        + `<div${part('row')}${decl({
            padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            background: surfaceFill(tokens, alpha(posAccent, 0.1)),
            border: `1px solid ${alpha(posAccent, 0.24)}`,
            'border-radius': tokens.radius.row,
            'overflow-wrap': 'anywhere',
        })}>${microHeader('Likes', '🎁', tokens, 4)}<span${part('row-value')}>$14</span></div>`
        + `<div${part('row')}${decl({
            padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            background: surfaceFill(tokens, alpha(primary, 0.1)),
            border: `1px solid ${alpha(primary, 0.24)}`,
            'border-radius': tokens.radius.row,
            'overflow-wrap': 'anywhere',
        })}>${microHeader('Dislikes', '🚫', tokens, 6)}<span${part('row-value')}>$15</span></div>`
        + '</div>';

    // 7. Tell quote bar ($16)
    const tellBar = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': `3px solid ${primary}`,
        'border-radius': `4px ${tokens.radius.row} ${tokens.radius.row} 4px`,
        'margin-bottom': tokens.space.rowGap,
        'font-style': 'italic',
        color: tokens.on.body,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<span${part('row-label')}${decl({
            color: tokens.on.accents[6],
            'font-style': 'normal',
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
        })}>${decorative('👁', tokens)}${tokens.glyphMode === 'none' ? '' : ' '}Tell:</span> `
        + `<span${part('row-value')}>$16</span>`
        + '</div>';

    // 8. Unsaid concealed spoiler drawer ($17) - preserves exact `<details data-rat-part="row"><summary>...Unsaid:...</summary><span data-rat-part="row-value">$17</span></details>` contract
    const unsaidStyle = withExtra(decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, alpha(secondary, 0.1)),
        border: `1px dashed ${alpha(secondary, 0.35)}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.gap,
        'overflow-wrap': 'anywhere',
    }), tokens, 'rowAlt');

    const unsaidLabel = `<span${part('row-label')}${decl({
        color: tokens.on.accents[5],
        'font-size': tokens.type.labelSize,
        'font-weight': tokens.type.labelWeight,
        'text-transform': tokens.type.labelCase === 'none' ? '' : tokens.type.labelCase,
    })}>${decorative('💭', tokens)}${tokens.glyphMode === 'none' ? '' : ' '}Unsaid:</span>`
        + `<span${decl({
            'margin-left': '6px',
            color: tokens.on.muted,
            'font-size': tokens.type.labelSize,
            'font-style': 'italic',
        })}>(tap to read)</span>`;

    const unsaidDrawer = `<details${part('row')}${unsaidStyle}><summary>${unsaidLabel}</summary>`
        + `<span${part('row-value')}>$17</span></details>`;

    // 9. Keepsake Memory polaroid/note card ($18)
    const keepsakeCard = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, alpha(goldAccent, 0.12)),
        border: `1px solid ${alpha(goldAccent, 0.28)}`,
        'border-radius': tokens.radius.row,
        'box-shadow': tokens.shadow.body === 'none' ? '' : `0 4px 12px ${alpha('#000000', 0.16)}`,
        transform: 'rotate(-0.45deg)',
        'margin-bottom': tokens.space.gap,
        'overflow-wrap': 'anywhere',
    })}>`
        + microHeader('Keepsake Memory', '📸', tokens, 3)
        + `<span${part('row-value')}${decl({
            display: 'block',
            'font-style': 'italic',
            color: tokens.on.strong,
        })}>$18</span>`
        + '</div>';

    // 10. Would Say Yes To date invitation card ($19)
    const dateCard = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: layeredBackground(tokens, [
            `linear-gradient(135deg,${alpha(primary, 0.14)},${alpha(secondary, 0.12)})`,
        ]),
        border: `1px solid ${alpha(primary, 0.28)}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.gap,
        'overflow-wrap': 'anywhere',
    })}>`
        + microHeader('Would Say Yes To', '💌', tokens, 6)
        + `<span${part('row-value')}${decl({ color: tokens.on.strong })}>$19</span>`
        + '</div>';

    // 11. Bottom 2-column grid: Turning Point ($20) and Next Threshold ($21)
    const footerGrid = `<div${part('grid')}${decl({
        display: 'grid',
        'grid-template-columns': 'repeat(auto-fit,minmax(140px,1fr))',
        gap: tokens.space.gap,
    })}>`
        + `<div${part('row')}${decl({
            padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            background: surfaceFill(tokens, alpha(warmAccent, 0.11)),
            border: `1px solid ${alpha(warmAccent, 0.26)}`,
            'border-radius': tokens.radius.row,
            'overflow-wrap': 'anywhere',
        })}>${microHeader('Turning Point', '⟲', tokens, 2)}<span${part('row-value')}>$20</span></div>`
        + `<div${part('row')}${decl({
            padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            background: surfaceFill(tokens, tokens.surface.rowAlt),
            border: `1px dashed ${alpha(primary, 0.36)}`,
            'border-radius': tokens.radius.row,
            'overflow-wrap': 'anywhere',
        })}>${microHeader('Next Threshold', '🚪', tokens, 6)}<span${part('row-value')}>$21</span></div>`
        + '</div>';

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        'border-radius': weldedRadius(tokens.radius.body, 'bottom'),
        border: borderValue(tokens, tokens.line.body),
        'border-top': 'none',
        'box-shadow': tokens.shadow.body === 'none' ? '' : tokens.shadow.body,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: needsPositioning(tokens) ? 'relative' : '',
        overflow: 'hidden',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + ornament(tokens, 'bodyBefore')
        + routeBanner
        + heroIdentity
        + routeStepper
        + statGrid
        + affinityGrid
        + tellBar
        + unsaidDrawer
        + keepsakeCard
        + dateCard
        + footerGrid
        + ornament(tokens, 'bodyAfter')
        + '</div>';

    return collapsible(spec, tokens, header + body, { open });
}

/**
 * Classic 6-group Relationship Tracker card (`2ed3a072-ebe8-48aa-a36b-62b7c284ae8a`).
 */
export function renderRelationshipTracker(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const accent = accentAt(tokens, spec.accent);

    const summaryStyle = withExtra(decl({
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        gap: '8px',
        padding: `${tokens.space.headPadY} ${tokens.space.headPadX}`,
        background: surfaceBackground(tokens, tokens.surface.headFrom, tokens.surface.headTo, '135deg'),
        'border-radius': weldedRadius(tokens.radius.head, 'top'),
        border: borderValue(tokens, tokens.line.head),
        'box-shadow': tokens.shadow.head,
        color: tokens.on.head,
        'font-family': tokens.type.family,
        'font-size': tokens.type.headSize,
        'font-weight': tokens.type.headWeight,
        cursor: 'pointer',
        'list-style': 'none',
    }), tokens, 'header');

    const icon = decorative(spec.icon || '💞', tokens);
    const chevronGlyph = tokens.glyph.chevron
        ? `<span aria-hidden="true"${part('chevron')}${decl({ opacity: '0.65', 'margin-left': '6px' })}>${tokens.glyph.chevron}</span>`
        : '';

    const header = `<summary${part('header')}${summaryStyle}>`
        + ornament(tokens, 'headerBefore')
        + `<span>${icon ? `${icon} ` : ''}$1 · <span${decl({ color: tokens.on.accents[spec.accent] })}>$4</span></span>`
        + chevronGlyph
        + ornament(tokens, 'headerAfter')
        + '</summary>';

    const grid = `<dl${part('grid')}${decl({
        display: 'grid',
        'grid-template-columns': 'repeat(auto-fit,minmax(120px,1fr))',
        gap: tokens.space.gap,
        margin: `0 0 ${tokens.space.gap}`,
    })}>${spec.stats.map(statSpec => statTile(statSpec, tokens, options)).join('')}</dl>`;

    const conditionGlyph = decorative(tokens.glyph.section, tokens);
    const conditionRow = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': tokens.line.edgeSide === 'none' ? '' : `${tokens.line.edge} ${tokens.line.style} ${accent}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.rowGap,
    })}>`
        + `<span${part('row-label')}${decl({ color: tokens.on.label, 'font-size': tokens.type.labelSize })}>`
        + `${conditionGlyph}${conditionGlyph ? ' ' : ''}Condition:</span> `
        + `<span${part('row-value')}>${pill('$5', tokens, accent)}</span>`
        + '</div>';

    const changeRow = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.rowAlt),
        'border-left': `3px solid ${accent}`,
        'border-radius': tokens.radius.row,
        'white-space': 'pre-line',
        'overflow-wrap': 'anywhere',
    })}>`
        + `<span${part('row-label')}${decl({ color: tokens.on.label, 'font-size': tokens.type.labelSize })}>`
        + `${conditionGlyph}${conditionGlyph ? ' ' : ''}Change:</span> `
        + `<span${part('row-value')}>$6</span>`
        + '</div>';

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        'border-radius': weldedRadius(tokens.radius.body, 'bottom'),
        border: borderValue(tokens, tokens.line.body),
        'border-top': 'none',
        'box-shadow': tokens.shadow.body === 'none' ? '' : tokens.shadow.body,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + ornament(tokens, 'bodyBefore')
        + grid + conditionRow + changeRow
        + ornament(tokens, 'bodyAfter')
        + '</div>';

    return collapsible(spec, tokens, header + body, { open });
}

/**
 * Faithful, theme-aware renderers for the Ethereality ("Liminal") suite of 21
 * trackers and cards:
 *   - Aurora / Metallic sheen banners (`drift`, `clock-is-lying`)
 *   - Collapsible Liminal Lore cards (`motif`, `omen`, `thin-places`, `entanglement`,
 *     `improbable-effects`, `afflictions`, `the-ledger`, `rumor`)
 *   - Ledger baseline report cards (`thought-cabinet`, `the-becoming`)
 *   - Certificate of Miracle (`small-miracles`)
 *   - Parliament / Committee floor card (`the-committee`)
 *   - Meanwhile Impossibly bulleted vignette (`meanwhile`)
 *   - The Four Winds directional weather choices (`four-winds`)
 *   - Pre-wrap literary / corridor / seasonal cards (`doors`, `doors-fate`, `almanac`, `the-turning`)
 *   - Bureaucratic Census records (`census-resident`, `census-lodger`, `census-passerby`, `census-promotion`)
 *   - Census inline pill banners (`census-sighting`, `census-amendment`)
 *
 * Every surface, border, ornament and text colour flows through `tokens` so all
 * 118 Regex Agent Themes and contrast guarantees apply while preserving each
 * tracker's signature layout, botanical corners, watermarks and stamps.
 */

import { accentAt, alpha } from '../tokens.js';
import {
    borderValue, decl, decorative, frameDecoration,
    layeredBackground, ornament, part, pill, rootAttrs,
    surfaceBackground, surfaceFill, withExtra,
} from './parts.js';
import { resolveOpen } from './trackers.js';

function renderCornerGlyphs(corners, tokens) {
    if (!Array.isArray(corners) || corners.length === 0 || tokens.glyphMode === 'none') return '';
    const positions = [
        { top: '6px', left: '9px' },
        { top: '6px', right: '9px' },
        { bottom: '5px', left: '9px' },
        { bottom: '5px', right: '9px' },
    ];
    return corners.slice(0, 4).map((glyph, idx) => {
        if (!glyph) return '';
        const pos = positions[idx] || positions[0];
        return `<span aria-hidden="true"${part('corner')}${decl({
            position: 'absolute',
            ...pos,
            'font-size': '11px',
            opacity: '0.42',
            'pointer-events': 'none',
            'line-height': '1',
            'user-select': 'none',
        })}>${glyph}</span>`;
    }).join('');
}

function renderWatermark(glyph, tokens) {
    if (!glyph || tokens.glyphMode === 'none') return '';
    return `<span aria-hidden="true"${part('watermark')}${decl({
        position: 'absolute',
        right: '10px',
        bottom: '-8px',
        'font-size': '54px',
        opacity: '0.07',
        'pointer-events': 'none',
        'line-height': '1',
        'user-select': 'none',
    })}>${glyph}</span>`;
}

function renderFlourishDivider(text, tokens, accent) {
    if (!text) return '';
    const content = tokens.glyphMode === 'none' ? '─── · ───' : text;
    return `<div aria-hidden="true"${part('divider')}${decl({
        'text-align': 'center',
        color: tokens.on.muted,
        'font-size': '10px',
        'letter-spacing': '0.24em',
        margin: `2px 0 ${tokens.space.gap}`,
        'border-bottom': `1px dashed ${alpha(accent, 0.22)}`,
        'padding-bottom': '4px',
    })}>${content}</div>`;
}

function renderThematicFooter(text, tokens, accent, { align = 'center', dashedTop = false } = {}) {
    if (!text) return '';
    return `<div${part('footer')}${decl({
        'margin-top': tokens.space.gap,
        'padding-top': dashedTop ? '6px' : '2px',
        'border-top': dashedTop ? `1px dashed ${alpha(accent, 0.24)}` : '',
        'text-align': align,
        'font-size': '9.5px',
        'letter-spacing': '0.16em',
        color: tokens.on.muted,
        opacity: '0.82',
    })}>${text}</div>`;
}

function liminalCollapsible(spec, tokens, innerHtml, { open = false, radius = '', doubleBorder = false } = {}) {
    const openAttr = open ? ' open' : '';
    const accent = accentAt(tokens, spec.accent ?? 0);
    const cardRadius = radius || tokens.radius.card;
    const outerBorder = doubleBorder
        ? `3px double ${alpha(accent, 0.42)}`
        : borderValue(tokens, tokens.line.body);
    const style = withExtra(decl({
        margin: `${tokens.space.outer} 0`,
        'border-radius': cardRadius,
        overflow: 'hidden',
        position: 'relative',
        border: outerBorder,
        'box-shadow': tokens.shadow.body === 'none' ? '' : tokens.shadow.body,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
    }), tokens, 'root');
    return `<details ${rootAttrs(spec, tokens)}${part('root')}${openAttr}${style}>`
        + frameDecoration(tokens, accent)
        + renderCornerGlyphs(spec.corners, tokens)
        + ornament(tokens, 'rootBefore')
        + innerHtml
        + ornament(tokens, 'rootAfter')
        + '</details>';
}

function liminalSummary(spec, tokens, leftHtml, rightHint = '') {
    const accent = accentAt(tokens, spec.accent ?? 0);
    const summaryStyle = withExtra(decl({
        display: 'flex',
        'align-items': 'center',
        'flex-wrap': 'wrap',
        gap: '8px',
        padding: `${tokens.space.headPadY} ${tokens.space.headPadX}`,
        background: surfaceBackground(tokens, tokens.surface.headFrom, tokens.surface.headTo, '135deg'),
        'border-bottom': `1px solid ${alpha(accent, 0.24)}`,
        color: tokens.on.head,
        'font-family': tokens.type.family,
        'font-size': tokens.type.headSize,
        cursor: 'pointer',
        'list-style': 'none',
        position: 'relative',
    }), tokens, 'header');

    const hintHtml = rightHint
        ? `<span${part('hint')}${decl({
            'margin-left': 'auto',
            'font-size': tokens.type.labelSize,
            'font-style': 'italic',
            color: tokens.on.muted,
            'letter-spacing': '0.06em',
        })}>${tokens.glyphMode === 'none' ? rightHint.replace(/[^\w\s[\]·,-]/g, '').trim() : rightHint}</span>`
        : '';

    return `<summary${part('header')}${summaryStyle}>`
        + ornament(tokens, 'headerBefore')
        + leftHtml
        + hintHtml
        + ornament(tokens, 'headerAfter')
        + '</summary>';
}

/**
 * 1. Aurora / Metallic sheen banners (`drift-tracker` & `clock-is-lying`).
 */
export function renderLiminalBanner(spec, tokens) {
    const primary = accentAt(tokens, spec.accent ?? 1);
    const secondary = accentAt(tokens, (spec.accent ?? 1) + 1);
    const tertiary = accentAt(tokens, (spec.accent ?? 1) + 3);
    const isClock = spec.key === 'clock-is-lying';

    const outerRadius = isClock ? '16px' : '18px';
    const innerRadius = isClock ? '14px' : '16px';
    const outerGradient = isClock
        ? `linear-gradient(125deg,${alpha(primary, 0.7)},${alpha(secondary, 0.45)},${alpha(tertiary, 0.65)},${alpha(primary, 0.7)})`
        : `linear-gradient(130deg,${alpha(primary, 0.72)},${alpha(secondary, 0.65)},${alpha(tertiary, 0.65)},${alpha(primary, 0.72)})`;

    const outerStyle = withExtra(decl({
        margin: `${tokens.space.outer} 0`,
        padding: '2px',
        'border-radius': outerRadius,
        background: outerGradient,
        'box-shadow': tokens.shadow.body === 'none' ? '' : `0 6px 22px ${alpha('#000000', 0.28)}`,
        position: 'relative',
        overflow: 'hidden',
    }), tokens, 'root');

    const innerStyle = decl({
        'border-radius': innerRadius,
        background: layeredBackground(tokens, [
            `radial-gradient(ellipse at 20% 0%,${alpha(primary, 0.16)},transparent 65%)`,
            `radial-gradient(ellipse at 85% 100%,${alpha(secondary, 0.14)},transparent 65%)`,
            `linear-gradient(180deg,${tokens.surface.bodyFrom},${tokens.surface.bodyTo})`,
        ]),
        padding: `${tokens.space.headPadY} ${tokens.space.bodyPad}`,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    });

    let headerRow = '';
    let quoteGroup = 3;

    if (isClock) {
        quoteGroup = 4;
        const icon = decorative(spec.icon || '⏳', tokens);
        headerRow = `<div${part('header')}${decl({
            display: 'flex',
            'align-items': 'center',
            'flex-wrap': 'wrap',
            gap: '8px',
        })}>`
            + (icon ? `<span${decl({ 'font-size': '14px' })}>${icon}</span>` : '')
            + `<b${decl({
                'font-family': tokens.type.family,
                'font-size': tokens.type.labelSize,
                'letter-spacing': '0.18em',
                'text-transform': 'uppercase',
                color: tokens.on.head,
            })}>The Clock Is Lying</b>`
            + `<span${part('pill')} title="what clocks claim"${decl({
                padding: '2px 9px',
                'border-radius': tokens.radius.pill,
                background: surfaceFill(tokens, alpha(accentAt(tokens, 2), 0.12)),
                border: `1px dashed ${alpha(accentAt(tokens, 2), 0.38)}`,
                color: tokens.on.muted,
                'font-family': tokens.type.monoFamily,
                'font-size': tokens.type.labelSize,
                'text-decoration': 'line-through',
            })}>$1</span>`
            + `<span aria-hidden="true"${decl({ color: tokens.on.accents[spec.accent ?? 2], 'font-weight': '700' })}>⇢</span>`
            + `<span${part('pill')} title="what is true"${decl({
                padding: '2px 10px',
                'border-radius': tokens.radius.pill,
                background: surfaceFill(tokens, alpha(primary, 0.18)),
                border: `1px solid ${alpha(primary, 0.45)}`,
                color: tokens.on.strong,
                'font-weight': '700',
                'font-size': tokens.type.labelSize,
            })}>$2</span>`
            + `<span${decl({
                'font-style': 'italic',
                color: tokens.on.body,
                'font-size': tokens.type.labelSize,
            })}>$3</span>`
            + '</div>';
    } else {
        const star = decorative('⋆', tokens);
        headerRow = `<div${part('header')}${decl({
            display: 'flex',
            'align-items': 'center',
            'flex-wrap': 'wrap',
            gap: '8px',
        })}>`
            + `<b${decl({
                'font-family': tokens.type.family,
                'font-size': tokens.type.labelSize,
                'letter-spacing': '0.24em',
                'text-transform': 'uppercase',
                color: tokens.on.head,
            })}>${star ? `${star} ` : ''}D R I F T${star ? ` ${star}` : ''}</b>`
            + pill('$1', tokens, primary)
            + `<span${decl({
                'font-style': 'italic',
                color: tokens.on.body,
                'font-size': tokens.type.labelSize,
            })}>$2</span>`
            + '</div>';
    }

    const quoteOpen = tokens.glyphMode === 'none' ? '&ldquo;' : '❝ ';
    const quoteClose = tokens.glyphMode === 'none' ? '&rdquo;' : ' ❞';
    const quoteRow = `<div${part('row')}${decl({
        'margin-top': '8px',
        'padding-top': '7px',
        'border-top': `1px dashed ${alpha(primary, 0.28)}`,
        'font-style': 'italic',
        color: tokens.on.strong,
        'overflow-wrap': 'anywhere',
    })}>${quoteOpen}<span${part('row-value')}>$${quoteGroup}</span>${quoteClose}</div>`;

    return `<div ${rootAttrs(spec, tokens)}${part('root')}${outerStyle}>`
        + frameDecoration(tokens, primary)
        + renderCornerGlyphs(spec.corners, tokens)
        + `<div${part('body')}${innerStyle}>`
        + headerRow
        + quoteRow
        + '</div></div>';
}

/**
 * 2. Collapsible Liminal Lore trackers (`motif-tracker`, `omen-tracker`,
 *    `thin-places-tracker`, `entanglement-tracker`, `improbable-effects`,
 *    `afflictions-blessings`, `the-ledger`, `what-the-town-knows`).
 */
export function renderLiminalLore(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const accent = accentAt(tokens, spec.accent ?? 0);
    const secondaryAccent = accentAt(tokens, spec.secondaryAccent ?? (((spec.accent ?? 0) + 1) % 7));

    const icon = decorative(spec.icon, tokens);
    const prefixSym = spec.prefixSymbol
        ? `<span${decl({ color: tokens.on.accents[spec.accent ?? 0], opacity: '0.85' })}>${spec.prefixSymbol}</span> `
        : '';
    const titleGroup = spec.titleGroup ?? 1;
    const badgeGroup = spec.badgeGroup ?? 3;
    const badgeText = `$${badgeGroup}${spec.badgeSuffix || ''}`;

    const summaryLeft = (icon ? `<span>${icon}</span>` : '')
        + `<b${decl({
            'letter-spacing': '0.14em',
            'text-transform': 'uppercase',
            'font-size': tokens.type.labelSize,
            color: tokens.on.accents[spec.accent ?? 0],
        })}>${spec.headerTitle || spec.title}</b>`
        + `<span${decl({ color: tokens.on.strong, 'font-weight': '600' })}>${prefixSym}$${titleGroup}</span>`
        + pill(badgeText, tokens, accent);

    const header = liminalSummary(spec, tokens, summaryLeft, spec.actionHint);

    const primaryRowSpec = spec.rows?.[0] || { label: 'Reading', g: 2, accent: spec.accent ?? 0 };
    const secondaryRowSpec = spec.rows?.[1] || { label: 'Note', g: 4, accent: ((spec.accent ?? 0) + 1) % 7 };
    const primaryIcon = decorative(spec.primaryIcon || '⟡', tokens);
    const secondaryIcon = decorative(spec.secondaryIcon || '✧', tokens);

    const primaryBox = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': `3px solid ${accent}`,
        'border-radius': `3px ${tokens.radius.row} ${tokens.radius.row} 3px`,
        'margin-bottom': tokens.space.rowGap,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<div${part('row-label')}${decl({
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
            'letter-spacing': '0.12em',
            'text-transform': 'uppercase',
            color: tokens.on.accents[(primaryRowSpec.accent ?? spec.accent ?? 0) % 7],
            'margin-bottom': '3px',
        })}>${primaryIcon ? `${primaryIcon} ` : ''}${primaryRowSpec.label}</div>`
        + `<span${part('row-value')}${decl({ color: tokens.on.body })}>$${primaryRowSpec.g}</span>`
        + '</div>';

    const secondaryBox = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, alpha(secondaryAccent, 0.08)),
        border: `1px dashed ${alpha(secondaryAccent, 0.32)}`,
        'border-radius': tokens.radius.row,
        'font-style': 'italic',
        color: tokens.on.body,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<span${part('row-label')}${decl({
            'font-style': 'normal',
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
            color: tokens.on.accents[(secondaryRowSpec.accent ?? ((spec.accent ?? 0) + 1)) % 7],
        })}>${secondaryIcon ? `${secondaryIcon} ` : ''}${secondaryRowSpec.label}:</span> `
        + `<span${part('row-value')}>$${secondaryRowSpec.g}</span>`
        + '</div>';

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + renderWatermark(spec.watermark, tokens)
        + ornament(tokens, 'bodyBefore')
        + primaryBox
        + secondaryBox
        + renderThematicFooter(spec.footerText, tokens, accent)
        + ornament(tokens, 'bodyAfter')
        + '</div>';

    return liminalCollapsible(spec, tokens, header + body, {
        open,
        radius: spec.asymmetricRadius || '',
        doubleBorder: Boolean(spec.doubleBorder),
    });
}

/**
 * 3. Collapsible Ledger-row trackers (`thought-cabinet` & `the-becoming`).
 */
export function renderLiminalLedgerRow(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const accent = accentAt(tokens, spec.accent ?? 1);
    const secondary = accentAt(tokens, ((spec.accent ?? 1) + 1) % 7);
    const icon = decorative(spec.icon, tokens);
    const isBecoming = spec.key === 'the-becoming';

    let summaryLeft = (icon ? `<span>${icon}</span>` : '')
        + `<b${decl({
            'letter-spacing': '0.14em',
            'text-transform': 'uppercase',
            'font-size': tokens.type.labelSize,
            color: tokens.on.accents[spec.accent ?? 1],
        })}>${spec.headerTitle || spec.title}</b>`;

    if (isBecoming) {
        summaryLeft += `<span${decl({ color: tokens.on.muted })}>$1</span>`
            + `<span aria-hidden="true"${decl({ color: tokens.on.accents[spec.accent ?? 1] })}>→</span>`
            + `<b${decl({ color: tokens.on.strong, 'font-style': 'italic' })}>&ldquo;$2&rdquo;</b>`
            + pill('$3', tokens, accent);
    } else {
        summaryLeft += `<b${decl({ color: tokens.on.strong, 'font-style': 'italic' })}>$1</b>`
            + pill('$2', tokens, secondary)
            + pill('$3', tokens, accent);
    }

    const header = liminalSummary(spec, tokens, summaryLeft, spec.actionHint);
    const rowSpec = spec.rows?.[0] || { label: 'Report', g: 4, accent: spec.accent ?? 1 };
    const rowIcon = decorative(spec.primaryIcon || '🧠', tokens);

    const reportRow = `<div${part('row')}${decl({
        display: 'flex',
        'align-items': 'baseline',
        'flex-wrap': 'wrap',
        gap: '10px',
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-bottom': `1px dotted ${alpha(accent, 0.32)}`,
        'border-radius': tokens.radius.row,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<span${part('row-label')}${decl({
            'min-width': '120px',
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
            'letter-spacing': '0.12em',
            'text-transform': 'uppercase',
            color: tokens.on.accents[(rowSpec.accent ?? spec.accent ?? 1) % 7],
        })}>${rowIcon ? `${rowIcon} ` : ''}${rowSpec.label}</span>`
        + `<span${part('row-value')}${decl({ flex: '1', 'min-width': '160px', color: tokens.on.body })}>$${rowSpec.g}</span>`
        + '</div>';

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + renderWatermark(spec.watermark, tokens)
        + ornament(tokens, 'bodyBefore')
        + reportRow
        + renderThematicFooter(spec.footerText, tokens, accent, { align: 'right', dashedTop: true })
        + ornament(tokens, 'bodyAfter')
        + '</div>';

    return liminalCollapsible(spec, tokens, header + body, { open });
}

/**
 * 4. Certificate of Miracle (`small-miracles`, 4 groups).
 */
export function renderLiminalCertificate(spec, tokens) {
    const gold = accentAt(tokens, 3);
    const rose = accentAt(tokens, 6);
    const sage = accentAt(tokens, 4);
    const blossom = decorative('✿', tokens);

    const rootStyle = withExtra(decl({
        margin: `${tokens.space.outer} 0`,
        padding: tokens.space.bodyPad,
        'border-radius': tokens.radius.card,
        background: layeredBackground(tokens, [
            `radial-gradient(ellipse at 50% 0%,${alpha(gold, 0.14)},transparent 70%)`,
            `linear-gradient(180deg,${tokens.surface.bodyFrom},${tokens.surface.bodyTo})`,
        ]),
        border: `3px double ${alpha(gold, 0.48)}`,
        'box-shadow': tokens.shadow.body === 'none' ? '' : tokens.shadow.body,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        transform: 'rotate(-0.35deg)',
        position: 'relative',
        overflow: 'hidden',
    }), tokens, 'root');

    const bureauHeader = `<div${part('header')}${decl({ 'text-align': 'center', 'margin-bottom': '6px' })}>`
        + `<div${decl({
            'font-size': '10px',
            'letter-spacing': '0.22em',
            'text-transform': 'uppercase',
            color: tokens.on.accents[3],
            'font-weight': '700',
        })}>${blossom ? `${blossom} ` : ''}The Department of Small Miracles${blossom ? ` ${blossom}` : ''}</div>`
        + `<div${decl({
            'font-size': '9.5px',
            'font-style': 'italic',
            color: tokens.on.muted,
        })}>Bureau of Notable Impossibilities · Form 88-B · filed in triplicate</div>`
        + '</div>';

    const certTitle = `<div${decl({ 'text-align': 'center', 'margin-bottom': tokens.space.gap })}>`
        + `<div${decl({
            'font-family': tokens.type.family,
            'font-size': tokens.type.valueSize,
            'font-style': 'italic',
            'font-weight': '700',
            color: tokens.on.strong,
            'margin-bottom': '4px',
        })}>Certificate of Miracle</div>`
        + `<div${decl({
            display: 'inline-block',
            'font-weight': '700',
            'font-variant': 'small-caps',
            'letter-spacing': '0.06em',
            color: tokens.on.strong,
            'border-bottom': `1px solid ${alpha(gold, 0.45)}`,
            padding: '0 10px 2px',
            'margin-bottom': '6px',
        })}>$1</div>`
        + `<div${decl({ 'margin-top': '4px' })}>${pill('$2', tokens, rose)}</div>`
        + '</div>';

    const recognitionRow = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': `3px solid ${gold}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.rowGap,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<div${part('row-label')}${decl({
            'font-size': tokens.type.labelSize,
            'font-style': 'italic',
            color: tokens.on.accents[3],
            'margin-bottom': '2px',
        })}>in recognition of</div>`
        + `<span${part('row-value')}${decl({ color: tokens.on.strong })}>$3</span>`
        + '</div>';

    const remarksRow = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.rowAlt),
        border: `1px dashed ${alpha(sage, 0.35)}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.gap,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<span${part('row-label')}${decl({
            'font-size': tokens.type.labelSize,
            'font-weight': tokens.type.labelWeight,
            'letter-spacing': '0.1em',
            'text-transform': 'uppercase',
            color: tokens.on.accents[4],
        })}>Clerk&apos;s remarks:</span> `
        + `<span${part('row-value')}${decl({ 'font-style': 'italic', color: tokens.on.body })}>$4</span>`
        + '</div>';

    const sealRow = `<div${part('seal-row')}${decl({
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        'flex-wrap': 'wrap',
        gap: '10px',
        'margin-top': '6px',
    })}>`
        + `<div${decl({ 'line-height': '1.2' })}>`
        + `<div${decl({ 'font-style': 'italic', 'font-weight': '600', color: tokens.on.strong })}>E. Thistlewood</div>`
        + `<div${decl({
            'font-size': '9px',
            'letter-spacing': '0.12em',
            'text-transform': 'uppercase',
            color: tokens.on.muted,
            'border-top': `1px solid ${alpha(gold, 0.35)}`,
            'padding-top': '2px',
        })}>Clerk of Small Miracles</div>`
        + '</div>'
        + `<div aria-hidden="true"${decl({
            width: '36px',
            height: '36px',
            'border-radius': '50%',
            background: surfaceFill(tokens, alpha(rose, 0.22)),
            border: `2px double ${alpha(gold, 0.6)}`,
            display: 'inline-flex',
            'align-items': 'center',
            'justify-content': 'center',
            color: tokens.on.accents[6],
            'font-size': '15px',
        })}>${blossom || '✓'}</div>`
        + `<div${decl({
            padding: '2px 8px',
            border: `1.5px solid ${alpha(sage, 0.48)}`,
            'border-radius': '4px',
            transform: 'rotate(-3deg)',
            'text-align': 'center',
            'line-height': '1.15',
        })}>`
        + `<div${decl({
            'font-size': '9.5px',
            'font-weight': '700',
            'letter-spacing': '0.14em',
            color: tokens.on.accents[4],
        })}>CERTIFIED ✓</div>`
        + `<div${decl({ 'font-size': '8.5px', 'font-style': 'italic', color: tokens.on.muted })}>no appeals on Wednesdays</div>`
        + '</div></div>';

    const counterfoil = renderThematicFooter(
        '✂ RETAIN COUNTERFOIL · OFFICE HOURS UNKNOWABLE · Nº 88-B / ∞',
        tokens,
        gold,
        { dashedTop: true },
    );

    return `<div ${rootAttrs(spec, tokens)}${part('root')}${rootStyle}>`
        + frameDecoration(tokens, gold)
        + renderCornerGlyphs(spec.corners, tokens)
        + renderWatermark(spec.watermark, tokens)
        + `<div${part('body')}${decl({ position: 'relative' })}>`
        + bureauHeader
        + renderFlourishDivider('─── ❧ ───', tokens, gold)
        + certTitle
        + recognitionRow
        + remarksRow
        + sealRow
        + counterfoil
        + '</div></div>';
}

/**
 * 5. The Committee parliament voice card (`the-committee`, 4 groups).
 */
export function renderLiminalCommittee(spec, tokens) {
    const primary = accentAt(tokens, spec.accent ?? 5);
    const secondary = accentAt(tokens, 3);

    const rootStyle = withExtra(decl({
        margin: `${tokens.space.outer} 0`,
        padding: tokens.space.bodyPad,
        'border-radius': tokens.radius.card,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        border: `3px double ${alpha(primary, 0.42)}`,
        'box-shadow': tokens.shadow.body === 'none' ? '' : tokens.shadow.body,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
        overflow: 'hidden',
    }), tokens, 'root');

    const headerRow = `<div${part('header')}${decl({
        display: 'flex',
        'align-items': 'center',
        'flex-wrap': 'wrap',
        gap: '8px',
        'padding-bottom': '8px',
        'margin-bottom': tokens.space.gap,
        'border-bottom': `1px dashed ${alpha(primary, 0.28)}`,
    })}>`
        + `<b${decl({
            'font-family': tokens.type.family,
            'font-size': tokens.type.headSize,
            'letter-spacing': '0.08em',
            'text-transform': 'uppercase',
            color: tokens.on.head,
        })}>$1</b>`
        + pill('$2', tokens, secondary)
        + pill('$3', tokens, primary)
        + `<span${decl({
            'margin-left': 'auto',
            'font-size': tokens.type.labelSize,
            'font-style': 'italic',
            color: tokens.on.muted,
        })}>the committee has the floor</span>`
        + '</div>';

    const quoteMark = tokens.glyphMode === 'none' ? '&ldquo;' : '❝';
    const speechRow = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': `3px solid ${primary}`,
        'border-radius': `3px ${tokens.radius.row} ${tokens.radius.row} 3px`,
        'font-style': 'italic',
        color: tokens.on.strong,
        'overflow-wrap': 'anywhere',
    })}>`
        + `<span aria-hidden="true"${decl({
            color: tokens.on.accents[spec.accent ?? 5],
            'font-weight': '700',
            'margin-right': '6px',
        })}>${quoteMark}</span>`
        + `<span${part('row-value')}>$4</span>`
        + '</div>';

    return `<div ${rootAttrs(spec, tokens)}${part('root')}${rootStyle}>`
        + frameDecoration(tokens, primary)
        + renderCornerGlyphs(spec.corners, tokens)
        + renderWatermark(spec.watermark, tokens)
        + `<div${part('body')}${decl({ position: 'relative' })}>`
        + headerRow
        + speechRow
        + renderThematicFooter(spec.footerText, tokens, primary, { align: 'right', dashedTop: true })
        + '</div></div>';
}

/**
 * 6. Meanwhile, Impossibly vignette card (`elsewhere`, 5 groups).
 */
export function renderLiminalMeanwhile(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const accent = accentAt(tokens, spec.accent ?? 1);
    const icon = decorative(spec.icon || '🌫', tokens);

    const summaryLeft = (icon ? `<span>${icon}</span>` : '')
        + `<b${decl({
            'letter-spacing': '0.16em',
            'text-transform': 'uppercase',
            'font-size': tokens.type.labelSize,
            color: tokens.on.accents[spec.accent ?? 1],
        })}>Meanwhile</b>`
        + `<span${decl({ color: tokens.on.strong, 'font-style': 'italic' })}>⌖ $1</span>`
        + pill('$2', tokens, accent);

    const header = liminalSummary(spec, tokens, summaryLeft, spec.actionHint || '👁 peer');

    const bulletRows = [3, 4, 5].map((g, idx) => {
        const accentIdx = ((spec.accent ?? 1) + idx) % 7;
        const rowAccent = accentAt(tokens, accentIdx);
        return `<div${part('row')}${decl({
            padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
            background: surfaceFill(tokens, idx % 2 === 1 ? tokens.surface.rowAlt : tokens.surface.row),
            'border-left': `2px solid ${rowAccent}`,
            'border-radius': tokens.radius.row,
            'margin-bottom': idx < 2 ? tokens.space.rowGap : '',
            'overflow-wrap': 'anywhere',
        })}>`
            + `<span aria-hidden="true"${decl({ color: tokens.on.accents[accentIdx], 'margin-right': '6px' })}>•</span>`
            + `<span${part('row-value')}>$${g}</span>`
            + '</div>';
    }).join('');

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + renderWatermark(spec.watermark, tokens)
        + renderFlourishDivider('· IMPOSSIBLY ·', tokens, accent)
        + bulletRows
        + '</div>';

    return liminalCollapsible(spec, tokens, header + body, { open });
}

/**
 * Directional wind slot for `tpl-four-winds`.
 * Exported so `buildCleanupFindRegex` in `src/render/index.js` can derive the
 * exact empty-slot cleanup pattern from the rendered markup.
 */
export function windSlot(slotSpec, tokens, { choice = false } = {}) {
    const accentIdx = (slotSpec.accent ?? 0) % 7;
    const accent = accentAt(tokens, accentIdx);
    const dirArrow = slotSpec.dir || tokens.glyph.bullet || '→';
    const prefix = `<span aria-hidden="true"${decl({
        color: tokens.on.accents[accentIdx],
        'font-weight': '700',
        'margin-right': '8px',
        'user-select': 'none',
    })}>${dirArrow}</span>`;
    const style = withExtra(decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        margin: `${tokens.space.rowGap} 0`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': tokens.line.edgeSide === 'none' ? '' : `${tokens.line.edge} ${tokens.line.style} ${accent}`,
        'border-radius': tokens.radius.row,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        cursor: choice ? 'pointer' : '',
        'overflow-wrap': 'anywhere',
    }), tokens, 'slot');
    const cls = choice ? ' class="pura-choice"' : '';
    return `<div${part('slot')}${cls}${style}>${prefix}$${slotSpec.g}</div>`;
}

/**
 * 7. The Four Winds directional weather card (`winds`, 4 groups).
 */
export function renderLiminalWinds(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const icon = decorative(spec.icon || '🧭', tokens);
    const choice = Boolean(spec.choice);

    const summaryLeft = (icon ? `<span>${icon}</span>` : '')
        + `<b${decl({
            'letter-spacing': '0.16em',
            'text-transform': 'uppercase',
            'font-size': tokens.type.labelSize,
            color: tokens.on.accents[spec.accent ?? 4],
        })}>The Four Winds</b>`;

    const header = liminalSummary(spec, tokens, summaryLeft, spec.actionHint || 'choose a weather');
    const items = spec.slots.map(s => windSlot(s, tokens, { choice })).join('');

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + renderWatermark(spec.watermark, tokens)
        + items
        + '</div>';

    return liminalCollapsible(spec, tokens, header + body, { open });
}

/**
 * 8. Pre-wrap literary / corridor / seasonal cards (`doors`, `doors-fate-checks`,
 *    `almanac-generator`, `the-turning`, 1 group each).
 */
export function renderLiminalPrewrap(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const accent = accentAt(tokens, spec.accent ?? 3);
    const icon = decorative(spec.icon, tokens);

    const subtitleHtml = spec.subHeader
        ? `<span${decl({
            'font-style': 'italic',
            'font-size': tokens.type.labelSize,
            color: tokens.on.muted,
        })}>${spec.subHeader}</span>`
        : '';

    const summaryLeft = (icon ? `<span>${icon}</span>` : '')
        + `<b${decl({
            'letter-spacing': '0.16em',
            'text-transform': 'uppercase',
            'font-size': tokens.type.labelSize,
            color: tokens.on.accents[spec.accent ?? 3],
        })}>${spec.headerTitle || spec.title}</b>`
        + subtitleHtml;

    const header = liminalSummary(spec, tokens, summaryLeft, spec.actionHint);

    const contentRow = `<div${part('row')}${decl({
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, tokens.surface.row),
        'border-left': `3px solid ${accent}`,
        'border-radius': tokens.radius.row,
        'white-space': 'pre-wrap',
        'overflow-wrap': 'anywhere',
    })}><span${part('row-value')}>$1</span></div>`;

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + renderWatermark(spec.watermark, tokens)
        + renderFlourishDivider('─── ❦ ✿ ❦ ───', tokens, accent)
        + contentRow
        + renderThematicFooter(spec.footerText, tokens, accent, { dashedTop: Boolean(spec.footerText) })
        + '</div>';

    return liminalCollapsible(spec, tokens, header + body, {
        open,
        doubleBorder: Boolean(spec.doubleBorder),
    });
}

/**
 * Census baseline section row. Exported so `buildCleanupFindRegex` in
 * `src/render/index.js` can derive the exact empty-section cleanup pattern
 * for optional sections (`census-lodger` groups 3..6).
 */
export function censusSection(sectionSpec, tokens, accent) {
    const glyph = decorative(tokens.glyph.section, tokens);
    const prefix = glyph ? `${glyph} ` : '';
    const isHighlight = Boolean(sectionSpec.highlight);
    const style = withExtra(decl({
        display: 'flex',
        'align-items': 'baseline',
        'flex-wrap': 'wrap',
        gap: '10px',
        padding: `${tokens.space.rowPadY} ${tokens.space.rowPadX}`,
        background: surfaceFill(tokens, isHighlight ? alpha(accent, 0.1) : tokens.surface.row),
        'border-bottom': `1px dotted ${alpha(accent, 0.3)}`,
        'border-radius': tokens.radius.row,
        'margin-bottom': tokens.space.rowGap,
    }), tokens, 'row');
    const labelStyle = decl({
        'min-width': '115px',
        color: isHighlight ? tokens.on.accents[1] : tokens.on.label,
        'font-family': tokens.type.family,
        'font-size': tokens.type.labelSize,
        'font-weight': tokens.type.labelWeight,
        'letter-spacing': '0.1em',
        'text-transform': 'uppercase',
    });
    const valueStyle = decl({
        flex: '1',
        'min-width': '160px',
        color: isHighlight ? tokens.on.strong : tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        'overflow-wrap': 'anywhere',
    });
    return `<div${part('section')}${style}>`
        + `<div${part('section-label')}${labelStyle}>${prefix}${sectionSpec.label}</div>`
        + `<div${part('section-value')}${valueStyle}>$${sectionSpec.g}</div>`
        + '</div>';
}

/**
 * 9. Bureaucratic Census records (`census-resident`, `census-lodger`,
 *    `census-passerby`, `census-promotion`).
 */
export function renderLiminalCensus(spec, tokens, options = {}) {
    const open = resolveOpen(spec, options);
    const accent = accentAt(tokens, spec.accent ?? 3);
    const icon = decorative(spec.icon || '🪶', tokens);
    const isPromotion = spec.key === 'census-promotion';

    let summaryLeft = (icon ? `<span>${icon}</span>` : '')
        + `<b${decl({
            'letter-spacing': '0.14em',
            'text-transform': 'uppercase',
            'font-size': tokens.type.labelSize,
            color: tokens.on.accents[spec.accent ?? 3],
        })}>${spec.headerTitle || 'Census Record'}</b>`
        + `<b${decl({ color: tokens.on.strong })}>❈ $${spec.title?.g ?? 1}</b>`;

    if (isPromotion && spec.subtitle) {
        summaryLeft += `<span aria-hidden="true"${decl({ color: tokens.on.accents[spec.accent ?? 3] })}>→</span>`
            + pill(`$${spec.subtitle.g}`, tokens, accent);
    } else if (spec.statusPill) {
        summaryLeft += pill(spec.statusPill, tokens, accent);
    }

    const sections = spec.sections.map(s => censusSection(s, tokens, accent)).join('');

    const bodyStyle = withExtra(decl({
        padding: tokens.space.bodyPad,
        background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': tokens.type.lineHeight,
        position: 'relative',
    }), tokens, 'body');

    const body = `<div${part('body')}${bodyStyle}>`
        + renderWatermark(spec.watermark, tokens)
        + renderFlourishDivider('─── ❦ ✿ ❦ ───', tokens, accent)
        + sections
        + renderThematicFooter(spec.footerText, tokens, accent, { dashedTop: Boolean(spec.footerText) })
        + '</div>';

    if (spec.collapsible === false) {
        const headerStyle = withExtra(decl({
            display: 'flex',
            'align-items': 'center',
            'flex-wrap': 'wrap',
            gap: '8px',
            padding: `${tokens.space.headPadY} ${tokens.space.headPadX}`,
            background: surfaceBackground(tokens, tokens.surface.headFrom, tokens.surface.headTo, '135deg'),
            'border-bottom': `1px solid ${alpha(accent, 0.24)}`,
            color: tokens.on.head,
            'font-family': tokens.type.family,
            'font-size': tokens.type.headSize,
            position: 'relative',
        }), tokens, 'header');

        const rightBadge = isPromotion
            ? `<span${decl({
                'margin-left': 'auto',
                padding: '1px 7px',
                border: `1.5px solid ${alpha(accentAt(tokens, 4), 0.5)}`,
                'border-radius': '4px',
                color: tokens.on.accents[4],
                'font-size': '9.5px',
                'font-weight': '700',
                'letter-spacing': '0.12em',
                transform: 'rotate(-2deg)',
            })}>APPROVED ✓</span>`
            : `<span${decl({
                'margin-left': 'auto',
                'font-size': tokens.type.labelSize,
                'font-style': 'italic',
                color: tokens.on.muted,
            })}>${spec.actionHint || ''}</span>`;

        const staticHeader = `<div${part('header')}${headerStyle}>`
            + ornament(tokens, 'headerBefore')
            + summaryLeft
            + rightBadge
            + ornament(tokens, 'headerAfter')
            + '</div>';

        const rootStyle = withExtra(decl({
            margin: `${tokens.space.outer} 0`,
            'border-radius': tokens.radius.card,
            overflow: 'hidden',
            position: 'relative',
            border: spec.doubleBorder ? `3px double ${alpha(accent, 0.42)}` : borderValue(tokens, tokens.line.body),
            'box-shadow': tokens.shadow.body === 'none' ? '' : tokens.shadow.body,
            background: surfaceBackground(tokens, tokens.surface.bodyFrom, tokens.surface.bodyTo),
        }), tokens, 'root');

        return `<div ${rootAttrs(spec, tokens)}${part('root')}${rootStyle}>`
            + frameDecoration(tokens, accent)
            + renderCornerGlyphs(spec.corners, tokens)
            + staticHeader
            + body
            + '</div>';
    }

    const header = liminalSummary(spec, tokens, summaryLeft, spec.actionHint);
    return liminalCollapsible(spec, tokens, header + body, {
        open,
        doubleBorder: Boolean(spec.doubleBorder),
    });
}

/**
 * 10. Census inline pill banners (`census-sighting`, `census-amendment`).
 */
export function renderLiminalChip(spec, tokens) {
    const accent = accentAt(tokens, spec.accent ?? 4);
    const icon = decorative(spec.icon, tokens);
    const isAmendment = spec.key === 'census-amendment';

    const style = withExtra(decl({
        display: 'flex',
        'align-items': 'center',
        'flex-wrap': 'wrap',
        gap: '8px',
        padding: '6px 14px',
        margin: '4px 0',
        'border-radius': tokens.radius.pill,
        background: surfaceFill(tokens, alpha(accent, 0.12)),
        border: isAmendment
            ? `1px dashed ${alpha(accent, 0.42)}`
            : `1px solid ${alpha(accent, 0.32)}`,
        color: tokens.on.body,
        'font-family': tokens.type.bodyFamily,
        'font-size': tokens.type.bodySize,
        'line-height': '1.35',
    }), tokens, 'chip');

    const badgeLabel = isAmendment ? 'Record Amended' : 'Sighting';
    const rightPart = isAmendment
        ? `<span${decl({
            'margin-left': 'auto',
            'font-size': tokens.type.labelSize,
            'font-style': 'italic',
            color: tokens.on.muted,
        })}>initialed, illegibly</span>`
        : `<span${decl({ 'margin-left': 'auto' })}>${pill('$3', tokens, accent)}</span>`;

    return `<div ${rootAttrs(spec, tokens)}${part('root')}${style}>`
        + (icon ? `<span aria-hidden="true">${icon}</span>` : '')
        + `<b${decl({
            'font-family': tokens.type.family,
            'font-size': tokens.type.labelSize,
            'letter-spacing': '0.12em',
            'text-transform': 'uppercase',
            color: tokens.on.accents[spec.accent ?? 4],
        })}>${badgeLabel}</b>`
        + `<span aria-hidden="true"${decl({ color: tokens.on.muted })}>·</span>`
        + `<b${decl({ color: tokens.on.strong })}>$1</b>`
        + `<span aria-hidden="true"${decl({ color: tokens.on.muted })}>—</span>`
        + `<span${decl({ 'font-style': 'italic', color: tokens.on.body })}>$2</span>`
        + rightPart
        + '</div>';
}

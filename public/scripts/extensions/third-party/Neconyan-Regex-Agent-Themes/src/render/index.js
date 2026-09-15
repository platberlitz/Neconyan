/**
 * Dispatch layer: spec + theme -> replaceString, plus the two derived scripts (empty-slot
 * cleanup and optional meter bars) that must stay in lockstep with the markup.
 */

import { ARCHETYPES } from '../specs.js';
import { OWNED_SCRIPT_PREFIX } from '../constants.js';
import { accentAt, alpha, resolveTheme } from '../tokens.js';
import { pairSlot, section, slot } from './parts.js';
import { renderChip, renderPanel, renderProfile, renderSlots, renderStatcard } from './trackers.js';
import { renderBold, renderStream, renderTerminal, renderTranscript } from './companions.js';

const RENDERERS = Object.freeze({
    [ARCHETYPES.PANEL]: renderPanel,
    [ARCHETYPES.PROFILE]: renderProfile,
    [ARCHETYPES.SLOTS]: renderSlots,
    [ARCHETYPES.STATCARD]: renderStatcard,
    [ARCHETYPES.CHIP]: renderChip,
    [ARCHETYPES.TERMINAL]: renderTerminal,
    [ARCHETYPES.STREAM]: renderStream,
    [ARCHETYPES.TRANSCRIPT]: renderTranscript,
    [ARCHETYPES.BOLD]: renderBold,
});

export const DEFAULT_OPTIONS = Object.freeze({
    density: 'normal',
    adaptiveNeutrals: false,
    meters: false,
    restyleBold: false,
    openDefaults: 'theme',
    glyphs: 'theme',
});

/** Archetypes whose output legitimately spans multiple lines. */
export const MULTILINE_ARCHETYPES = Object.freeze([ARCHETYPES.TERMINAL]);

/**
 * Builds the `replaceString` for one script.
 * @param {object} spec An entry from SPECS.
 * @param {object} theme A theme token object.
 * @param {object} [options] Global render options.
 * @returns {string|null} null for pass-through and cleanup scripts, which carry no markup.
 */
export function buildReplaceString(spec, theme, options = {}) {
    if (spec.archetype === ARCHETYPES.PASSTHROUGH || spec.archetype === ARCHETYPES.CLEANUP) {
        return null;
    }
    const renderer = RENDERERS[spec.archetype];
    if (!renderer) {
        throw new Error(`No renderer for archetype "${spec.archetype}" (${spec.scriptName})`);
    }
    const merged = { ...DEFAULT_OPTIONS, ...options };
    return renderer(spec, resolveTheme(theme, merged), merged);
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\/]/g;

function escapeRegex(value) {
    return value.replace(REGEX_SPECIALS, '\\$&');
}

/**
 * Derives the cleanup pattern from the markup itself, so the regex can never drift away
 * from what the renderer emits. Style attribute values are relaxed to `[^"]*` because the
 * rainbow accent ramp gives each slot a different colour.
 */
function emptyMarkupPattern(markup) {
    const withoutGroups = markup.replace(/\$\d+/g, '');
    return escapeRegex(withoutGroups).replace(/style="[^"]*"/g, 'style="[^"]*"');
}

/**
 * The `findRegex` for a cleanup script: matches a rendered slot whose captures were all
 * empty. Returns null when the target spec has no collapsible slots.
 */
export function buildCleanupFindRegex(targetSpec, theme, options = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const tokens = resolveTheme(theme, merged);
    const patterns = [];

    if (targetSpec.archetype === ARCHETYPES.SLOTS && targetSpec.slots.length) {
        const first = targetSpec.slots[0];
        const markup = targetSpec.kv
            ? pairSlot(first, tokens, targetSpec.accent, 0)
            : slot(first, tokens, targetSpec.accent, 0);
        patterns.push(emptyMarkupPattern(markup));
    }

    if (targetSpec.archetype === ARCHETYPES.PROFILE) {
        for (const index of targetSpec.optionalSections ?? []) {
            const sectionSpec = targetSpec.sections[index];
            if (sectionSpec) {
                patterns.push(emptyMarkupPattern(section(sectionSpec, tokens, {
                    tier: targetSpec.tier,
                    index,
                })));
            }
        }
    }

    if (!patterns.length) return null;
    return patterns.length === 1 ? `/${patterns[0]}/g` : `/(?:${patterns.join('|')})/g`;
}

/** Stable id for a script this extension owns on a given agent. */
export function ownedScriptId(kind, agentId) {
    return `${OWNED_SCRIPT_PREFIX}${kind}:${agentId}`;
}

/**
 * The chained script that turns a `n/m` meter marker into a real bar. It runs after the
 * markup script over the already-rendered HTML, so `calc(100% * n / m)` receives literal
 * numbers. A non-numeric value simply fails to match and stays as plain text.
 */
export function buildMeterScript(agentId, theme, options = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const tokens = resolveTheme(theme, merged);
    const fill = tokens.on.meterFill;
    const track = alpha(accentAt(tokens, 6), 0.18);

    const bar = `<span role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuenow="$1" aria-valuemax="$2" aria-valuetext="$1/$2" data-rat-part="meterbar" style="display:block;height:6px;margin:4px 0 3px;`
        + `border-radius:${tokens.radius.pill};background:${track};overflow:hidden">`
        + `<span style="display:block;height:100%;width:min(100%,calc(100% * $1 / $2));`
        + `background:${fill}"></span></span>`
        + `<span data-rat-part="metertext" style="color:${tokens.on.strong};font-weight:${tokens.type.valueWeight}">$1/$2</span>`;

    return {
        id: ownedScriptId('meter', agentId),
        scriptName: 'Regex Agent Themes: meter bars',
        findRegex: '/<span data-rat-part="meter" data-v="(\\d+)\\s*\\/\\s*(\\d+)"[^>]*>[^<]*<\\/span>/g',
        replaceString: bar,
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

/**
 * The chained script that removes rendered slots whose captures were all empty. Used for
 * the direction menu and parallel tracker, which have no such script in stock. The CYOA
 * agent instead has one shipped with a fixed id, handled by the CLEANUP spec.
 */
export function buildExtraCleanupScript(agentId, targetSpec, theme, options = {}) {
    const findRegex = buildCleanupFindRegex(targetSpec, theme, options);
    if (!findRegex) {
        return null;
    }
    return {
        id: ownedScriptId(`cleanup-${targetSpec.key}`, agentId),
        scriptName: `Regex Agent Themes: remove empty ${targetSpec.key} content`,
        findRegex,
        replaceString: '',
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

export { RENDERERS, escapeRegex };

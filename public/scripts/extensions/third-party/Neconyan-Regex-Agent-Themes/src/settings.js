/**
 * Settings live in `extension_settings[MODULE_NAME]`, which is hand-editable JSON on disk,
 * so every field is validated and clamped on read rather than merged once at install.
 */

import { SETTINGS_KEY, STOCK_THEME } from './constants.js';
import { THEME_BY_SLUG } from './themes/index.js';
import { THEMABLE_TEMPLATE_IDS } from './specs.js';
import { getContext } from './host.js';
import { validateCustomThemeMap } from './custom-themes.js';

const SCHEMA_VERSION = 2;

const DENSITIES = ['compact', 'normal', 'roomy'];
const OPEN_DEFAULTS = ['theme', 'all-open', 'all-closed'];
const GLYPH_MODES = ['theme', 'none'];

export const DEFAULTS = Object.freeze({
    _v: SCHEMA_VERSION,
    theme: STOCK_THEME,
    overrides: {},
    options: Object.freeze({
        density: 'normal',
        adaptiveNeutrals: false,
        meters: false,
        restyleBold: false,
        cleanupScripts: true,
        openDefaults: 'theme',
        glyphs: 'theme',
    }),
    autoReapply: true,
    ledger: {},
    customThemes: {},
});

function clampEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function isKnownTheme(slug, customThemes) {
    return slug === STOCK_THEME || THEME_BY_SLUG.has(slug) || Object.hasOwn(customThemes, slug);
}

function validOverrides(raw, customThemes) {
    const out = {};
    if (!raw || typeof raw !== 'object') {
        return out;
    }
    for (const [templateId, slug] of Object.entries(raw)) {
        if (!THEMABLE_TEMPLATE_IDS.includes(templateId)) {
            continue;
        }
        if (typeof slug === 'string' && slug !== '' && isKnownTheme(slug, customThemes)) {
            out[templateId] = slug;
        }
    }
    return out;
}

function validScriptStates(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return out;
    }
    for (const [scriptId, state] of Object.entries(raw)) {
        if (!scriptId || !state || typeof state !== 'object' || Array.isArray(state)) {
            continue;
        }
        const clean = {};
        if (typeof state.applied === 'string') {
            clean.applied = state.applied;
        }
        if (typeof state.findRegex === 'string') {
            clean.findRegex = state.findRegex;
        }
        if (Array.isArray(state.generated)) {
            clean.generated = state.generated.filter(value => typeof value === 'string');
        }
        if (Object.keys(clean).length > 0) {
            out[scriptId] = clean;
        }
    }
    return out;
}

function validOriginals(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return out;
    }
    for (const [scriptId, state] of Object.entries(raw)) {
        if (!scriptId || !state || typeof state !== 'object' || Array.isArray(state)) {
            continue;
        }
        if (typeof state.replaceString !== 'string' || typeof state.findRegex !== 'string') {
            continue;
        }
        out[scriptId] = {
            replaceString: state.replaceString,
            findRegex: state.findRegex,
        };
    }
    return out;
}

function validLedger(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') {
        return out;
    }
    for (const [agentId, entry] of Object.entries(raw)) {
        if (!agentId || !entry || typeof entry !== 'object') {
            continue;
        }
        out[agentId] = {
            agentId,
            templateId: String(entry.templateId ?? ''),
            theme: String(entry.theme ?? ''),
            engine: Number(entry.engine) || 0,
            appliedAt: Number(entry.appliedAt) || 0,
            versionBefore: Number(entry.versionBefore) || 0,
            phaseLockedBefore: Boolean(entry.phaseLockedBefore),
            scripts: validScriptStates(entry.scripts),
            originals: validOriginals(entry.originals),
            added: Array.isArray(entry.added)
                ? [...new Set(entry.added.filter(value => typeof value === 'string' && value))]
                : [],
        };
    }
    return out;
}

function migrate(raw) {
    // Only one schema version so far; the chain exists so a future bump has a home.
    return raw;
}

/** Reads, validates and clamps the stored settings, creating them on first use. */
export function getSettings() {
    const context = getContext();
    const bag = context?.extensionSettings;
    if (!bag) {
        return structuredClone(DEFAULTS);
    }

    if (!bag[SETTINGS_KEY] || typeof bag[SETTINGS_KEY] !== 'object') {
        bag[SETTINGS_KEY] = structuredClone(DEFAULTS);
        context.saveSettingsDebounced();
    }

    const raw = migrate(bag[SETTINGS_KEY]);
    const customThemes = validateCustomThemeMap(raw.customThemes).themes;
    const options = raw.options && typeof raw.options === 'object' ? raw.options : {};

    const clean = {
        _v: SCHEMA_VERSION,
        theme: isKnownTheme(raw.theme, customThemes) ? raw.theme : STOCK_THEME,
        overrides: validOverrides(raw.overrides, customThemes),
        options: {
            density: clampEnum(options.density, DENSITIES, DEFAULTS.options.density),
            adaptiveNeutrals: Boolean(options.adaptiveNeutrals),
            meters: Boolean(options.meters),
            restyleBold: Boolean(options.restyleBold),
            cleanupScripts: options.cleanupScripts !== false,
            openDefaults: clampEnum(options.openDefaults, OPEN_DEFAULTS, DEFAULTS.options.openDefaults),
            glyphs: clampEnum(options.glyphs, GLYPH_MODES, DEFAULTS.options.glyphs),
        },
        autoReapply: raw.autoReapply !== false,
        ledger: validLedger(raw.ledger),
        customThemes,
    };

    bag[SETTINGS_KEY] = clean;
    return clean;
}

/** Merges a patch into the stored settings and schedules a save. */
export function updateSettings(patch) {
    const context = getContext();
    if (!context?.extensionSettings) {
        return getSettings();
    }
    const current = getSettings();
    context.extensionSettings[SETTINGS_KEY] = {
        ...current,
        ...patch,
        options: { ...current.options, ...(patch.options ?? {}) },
    };
    context.saveSettingsDebounced();
    return getSettings();
}

/** The theme slug in force for a template: its override, else the global choice. */
export function resolveThemeSlug(templateId, settings = getSettings()) {
    return settings.overrides[templateId] ?? settings.theme;
}

/** Drops ledger entries whose agent no longer exists. */
export function pruneLedger(existingAgentIds) {
    const settings = getSettings();
    const keep = {};
    let removed = 0;
    for (const [agentId, entry] of Object.entries(settings.ledger)) {
        if (existingAgentIds.includes(agentId)) {
            keep[agentId] = entry;
        } else {
            removed++;
        }
    }
    if (removed > 0) {
        updateSettings({ ledger: keep });
    }
    return removed;
}

export { SCHEMA_VERSION, DENSITIES, OPEN_DEFAULTS, GLYPH_MODES };

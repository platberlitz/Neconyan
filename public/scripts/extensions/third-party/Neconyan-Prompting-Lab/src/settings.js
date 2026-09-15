import { DEFAULT_SETTINGS, SETTINGS_KEY, SETTINGS_VERSION, TAB } from './constants.js';
import { getContext } from './host.js';

const TAB_VALUES = new Set(Object.values(TAB));

function integer(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/**
 * Repairs a stored settings object in place-safe fashion. Every field is
 * rebuilt from defaults, so a partially written or hand-edited blob cannot
 * leave the extension in a broken state.
 */
export function normalizeSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const dismissed = source.dismissedWarnings && typeof source.dismissedWarnings === 'object' && !Array.isArray(source.dismissedWarnings)
        ? source.dismissedWarnings
        : {};
    const dismissedWarnings = {};
    for (const [key, flag] of Object.entries(dismissed)) {
        if (flag === true) {
            dismissedWarnings[key] = true;
        }
    }
    const depth = source.manualCachingAtDepth;
    return {
        schemaVersion: SETTINGS_VERSION,
        lastTab: TAB_VALUES.has(source.lastTab) ? source.lastTab : DEFAULT_SETTINGS.lastTab,
        manualCachingAtDepth: Number.isInteger(depth) && depth >= 0
            ? depth
            : null,
        runRetention: integer(source.runRetention, DEFAULT_SETTINGS.runRetention, 1, 200),
        // A reasoning model spends its thinking out of the same allowance as
        // its reply, and can think for ten thousand tokens before writing a
        // word, so the ceiling has to leave room for both.
        abMaxTokens: integer(source.abMaxTokens, DEFAULT_SETTINGS.abMaxTokens, 16, 32000),
        normalizeVolatile: typeof source.normalizeVolatile === 'boolean'
            ? source.normalizeVolatile
            : DEFAULT_SETTINGS.normalizeVolatile,
        dismissedWarnings,
        // The recording switch itself lives in accountStorage, per device:
        // extensionSettings syncs, and opting in on one device must not
        // silently start recording on every other one.
        ledgerRetention: integer(source.ledgerRetention, DEFAULT_SETTINGS.ledgerRetention, 10, 2000),
    };
}

/** A newer settings document must remain untouched until this code understands it. */
export function isSettingsReadOnly(value = getContext()?.extensionSettings?.[SETTINGS_KEY]) {
    return Boolean(value && typeof value === 'object' && Number(value.schemaVersion) > SETTINGS_VERSION);
}

/**
 * Forward-only migration hook. Kept separate from normalizeSettings so future
 * versions can move fields before the generic repair pass runs.
 */
export function migrateSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (isSettingsReadOnly(source)) {
        return source;
    }
    // v0 -> v1: first released schema; nothing to move yet.
    return normalizeSettings(source);
}

export function getSettings() {
    const context = getContext();
    const stored = context?.extensionSettings?.[SETTINGS_KEY];
    if (isSettingsReadOnly(stored)) {
        return normalizeSettings(stored);
    }
    const settings = migrateSettings(stored);
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = settings;
    }
    return settings;
}

let lastOwnWriteAt = 0;

/**
 * True shortly after this extension saved its own settings. The debounced
 * save makes the host emit SETTINGS_UPDATED back at us; refreshing on our own
 * echo would rebuild the interface for no reason, about a second after every
 * tab switch or preference change.
 */
export function isOwnSettingsEcho(withinMs = 2500) {
    return Date.now() - lastOwnWriteAt < withinMs;
}

export function updateSettings(patch) {
    const context = getContext();
    const stored = context?.extensionSettings?.[SETTINGS_KEY];
    if (isSettingsReadOnly(stored)) {
        return normalizeSettings(stored);
    }
    const next = normalizeSettings({ ...getSettings(), ...patch });
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = next;
        lastOwnWriteAt = Date.now();
        context.saveSettingsDebounced?.();
    }
    return next;
}

export function dismissWarning(key) {
    const settings = getSettings();
    return updateSettings({
        dismissedWarnings: { ...settings.dismissedWarnings, [key]: true },
    });
}

export function isWarningDismissed(key) {
    return getSettings().dismissedWarnings[key] === true;
}

export function clearSettings() {
    const context = getContext();
    if (context?.extensionSettings) {
        delete context.extensionSettings[SETTINGS_KEY];
        lastOwnWriteAt = Date.now();
        context.saveSettingsDebounced?.();
    }
}

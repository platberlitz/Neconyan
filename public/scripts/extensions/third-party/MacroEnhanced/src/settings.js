export const MODULE_NAME = 'MacroEnhanced';

const SETTINGS_VERSION = 5;

function defaultSettings() {
    return {
        settingsVersion: SETTINGS_VERSION,
        customMacros: [],
        auditor: { manualCachingAtDepth: null },
        compatExpressions: false,
        fixImportedSyntax: false,
        pronouns: { personas: {} },
    };
}

/** Pronoun specs keyed by persona avatar id, repaired in place. */
function repairPronouns(settings) {
    if (!settings.pronouns || typeof settings.pronouns !== 'object') {
        settings.pronouns = { personas: {} };
    }
    if (!settings.pronouns.personas || typeof settings.pronouns.personas !== 'object' || Array.isArray(settings.pronouns.personas)) {
        settings.pronouns.personas = {};
    }
}

function migrate(settings) {
    // v1 -> v2: added the Cache Auditor preferences.
    if (!settings.auditor || typeof settings.auditor !== 'object') {
        settings.auditor = { manualCachingAtDepth: null };
    }
    // v2 -> v3: added compat mode. Off for existing installs -- it changes what
    // {{if}} means, so it is never turned on behind someone's back.
    if (typeof settings.compatExpressions !== 'boolean') {
        settings.compatExpressions = false;
    }
    // v3 -> v4: added persona pronouns. Nothing to convert; an install with no
    // pronouns set behaves exactly as it did, since unset means they/them.
    repairPronouns(settings);
    // v4 -> v5: added imported-syntax fixes. Off for existing installs -- it
    // rewrites text on its way into the engine, app-wide.
    if (typeof settings.fixImportedSyntax !== 'boolean') {
        settings.fixImportedSyntax = false;
    }
    settings.settingsVersion = SETTINGS_VERSION;
    return settings;
}

export function getSettings() {
    const ctx = SillyTavern.getContext();
    const container = ctx.extensionSettings;

    if (!container[MODULE_NAME] || typeof container[MODULE_NAME] !== 'object') {
        container[MODULE_NAME] = defaultSettings();
    }

    const settings = container[MODULE_NAME];

    if (settings.settingsVersion !== SETTINGS_VERSION) {
        migrate(settings);
    }
    if (!Array.isArray(settings.customMacros)) {
        settings.customMacros = [];
    }
    if (!settings.auditor || typeof settings.auditor !== 'object') {
        settings.auditor = { manualCachingAtDepth: null };
    }
    if (typeof settings.compatExpressions !== 'boolean') {
        settings.compatExpressions = false;
    }
    if (typeof settings.fixImportedSyntax !== 'boolean') {
        settings.fixImportedSyntax = false;
    }
    repairPronouns(settings);

    return settings;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

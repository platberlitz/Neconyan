import { DEFAULT_SETTINGS, GENERATION_TRIGGERS, SETTINGS_KEY } from './constants.js';
import { getContext } from './host.js';

function integer(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        schemaVersion: DEFAULT_SETTINGS.schemaVersion,
        lastTab: ['scan', 'trace', 'tests', 'batch', 'health'].includes(source.lastTab)
            ? source.lastTab
            : DEFAULT_SETTINGS.lastTab,
        inputMode: source.inputMode === 'text' ? 'text' : DEFAULT_SETTINGS.inputMode,
        trigger: GENERATION_TRIGGERS.includes(source.trigger) ? source.trigger : DEFAULT_SETTINGS.trigger,
        seed: integer(source.seed, DEFAULT_SETTINGS.seed, 0, 0xffffffff),
        selectedBook: typeof source.selectedBook === 'string' ? source.selectedBook : '',
        historyLimit: integer(source.historyLimit, DEFAULT_SETTINGS.historyLimit, 10, 500),
    };
}

export function getSettings() {
    const context = getContext();
    const settings = normalizeSettings(context?.extensionSettings?.[SETTINGS_KEY]);
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = settings;
    }
    return settings;
}

export function updateSettings(patch) {
    const context = getContext();
    const next = normalizeSettings({ ...getSettings(), ...patch });
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = next;
        context.saveSettingsDebounced?.();
    }
    return next;
}

export function clearSettings() {
    const context = getContext();
    if (context?.extensionSettings) {
        delete context.extensionSettings[SETTINGS_KEY];
        context.saveSettingsDebounced?.();
    }
}

import { applyTagsToStoryString, stripTagsFromStoryString } from './story-string.js';
import { getPresetKey, getSettings, save } from './settings.js';

const STORY_STRING_INPUT = '#context_story_string';

function context() {
    return SillyTavern.getContext();
}

export function getStoryString() {
    return String(context().powerUserSettings?.context?.story_string ?? '');
}

/**
 * Writes the story string back. The visible textarea is updated and an input event dispatched
 * so the app's own handler persists it exactly as if the user had typed it.
 */
function setStoryString(value) {
    const ctx = context();
    if (!ctx.powerUserSettings?.context) {
        return false;
    }

    ctx.powerUserSettings.context.story_string = value;

    if (typeof document !== 'undefined') {
        const input = document.querySelector(STORY_STRING_INPUT);
        if (input) {
            input.value = value;
            if (typeof Event === 'function') {
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }

    ctx.saveSettingsDebounced();
    return true;
}

function activePresetName() {
    try {
        return String(context().getPresetManager('context')?.getSelectedPresetName() ?? '');
    } catch {
        return '';
    }
}

function activePreset() {
    const name = activePresetName();
    return { name, key: getPresetKey(name) };
}

function recoveryRecords(settings) {
    if (!settings.storyStringBackups || typeof settings.storyStringBackups !== 'object') {
        settings.storyStringBackups = Object.create(null);
    }
    return settings.storyStringBackups;
}

function clearRecovery(settings, key) {
    const records = recoveryRecords(settings);
    if (Object.hasOwn(records, key)) {
        delete records[key];
        return true;
    }
    return false;
}

/** Returns the recovery record for the currently selected preset, never another preset. */
export function getBackup() {
    const settings = getSettings();
    const { key } = activePreset();
    const backup = recoveryRecords(settings)[key];
    if (!backup || typeof backup.baselineStoryString !== 'string' || !backup.baselineStoryString) {
        return null;
    }
    return backup;
}

export function hasBackup() {
    return !!getBackup();
}

/**
 * Describes the safe actions available for the active preset. A backup is only usable when its
 * preset key matches the active preset, and a changed current value is reported as divergent.
 */
export function getRecoveryState(rules) {
    const { name, key } = activePreset();
    const currentStoryString = getStoryString();
    const backup = getBackup();
    const stripped = stripTagsFromStoryString(currentStoryString, rules);
    const diverged = !!backup
        && typeof backup.appliedStoryString === 'string'
        && currentStoryString !== backup.appliedStoryString;

    return {
        presetName: name,
        presetKey: key,
        currentStoryString,
        backup,
        hasBackup: !!backup,
        diverged,
        canRestore: !!backup,
        canRemove: stripped.changed,
    };
}

/**
 * Rewrites the active context template so each enabled section is tagged.
 * @param {Record<string, object>} rules
 * @param {{force?: boolean}} options
 * @returns {{ok: boolean, applied: Array, skipped: Array, changed: boolean, diverged?: boolean, error?: string}}
 */
export function applyTags(rules, { force = false } = {}) {
    const before = getStoryString();
    if (!before) {
        return { ok: false, applied: [], skipped: [], changed: false, error: 'No context template is loaded.' };
    }

    const settings = getSettings();
    const { name: presetName, key: presetKey } = activePreset();
    const records = recoveryRecords(settings);
    const existing = records[presetKey];
    const diverged = !!existing
        && typeof existing.appliedStoryString === 'string'
        && existing.appliedStoryString !== before;

    const result = applyTagsToStoryString(before, rules);
    if (diverged && !force) {
        return {
            ok: false,
            ...result,
            diverged: true,
            error: 'The active context template changed after the saved version. Review it before updating.',
            preset: presetName,
        };
    }

    if (!result.changed) {
        return { ok: true, ...result };
    }

    if (!setStoryString(result.storyString)) {
        return { ok: false, applied: [], skipped: [], changed: false, error: 'Could not write to the context template.' };
    }

    records[presetKey] = {
        version: 1,
        presetKey,
        presetName,
        // Preserve the first baseline through repeated updates. Only an explicit restore or
        // tag removal discards it.
        baselineStoryString: existing?.baselineStoryString || before,
        appliedStoryString: result.storyString,
    };
    save();

    return { ok: true, ...result, diverged };
}

/**
 * Restores the saved baseline for the active preset. It deliberately does not fall back to
 * stripping wrappers: that operation is exposed separately so a preset mismatch or divergence
 * cannot silently mutate the user's current template.
 */
export function restore(rules, { force = false } = {}) {
    const settings = getSettings();
    const { key, name: presetName } = activePreset();
    const backup = recoveryRecords(settings)[key];
    if (!backup?.baselineStoryString) {
        return { ok: false, error: 'No saved context template is available for the active preset.' };
    }

    const current = getStoryString();
    const diverged = typeof backup.appliedStoryString === 'string'
        && current !== backup.appliedStoryString;
    if (diverged && !force) {
        return {
            ok: false,
            diverged: true,
            error: 'The active context template changed after tagging. Review it before restoring.',
            preset: presetName,
        };
    }

    if (!setStoryString(backup.baselineStoryString)) {
        return { ok: false, error: 'Could not write to the context template.' };
    }

    clearRecovery(settings, key);
    save();
    return { ok: true, exact: true, preset: presetName, diverged };
}

/** Removes only wrappers produced by the supplied rules from the active template. */
export function removeTags(rules) {
    const settings = getSettings();
    const { key, name: presetName } = activePreset();
    const stripped = stripTagsFromStoryString(getStoryString(), rules);
    if (!stripped.changed) {
        return { ok: false, error: 'No matching Prompt Tags wrappers were found.' };
    }
    if (!setStoryString(stripped.storyString)) {
        return { ok: false, error: 'Could not write to the context template.' };
    }

    clearRecovery(settings, key);
    save();
    return { ok: true, exact: false, preset: presetName, changed: true };
}

export function discardRecovery() {
    const settings = getSettings();
    const changed = clearRecovery(settings, activePreset().key);
    if (changed) {
        save();
    }
    return changed;
}

function normalizePresetName(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function collidesWithPreset(names, requested) {
    const normalized = normalizePresetName(requested);
    return names.some(name => normalizePresetName(name) === normalized);
}

function suggestedPresetName(names, requested) {
    let suffix = 2;
    let candidate = `${requested} (${suffix})`;
    while (collidesWithPreset(names, candidate)) {
        candidate = `${requested} (${++suffix})`;
    }
    return candidate;
}

/**
 * Saves a tagged copy as a brand new context preset, leaving the current one untouched.
 * Existing names are refused before the host save API is called.
 */
export async function saveAsPreset(name, rules) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
        return { ok: false, error: 'Give the preset a name.' };
    }

    const ctx = context();
    let manager;
    try {
        manager = ctx.getPresetManager('context');
    } catch {
        manager = null;
    }
    if (!manager) {
        return { ok: false, error: 'The context preset manager is unavailable.' };
    }

    let names = [];
    try {
        names = typeof manager.getAllPresets === 'function' ? manager.getAllPresets() : [];
        names = Array.isArray(names) ? names.map(value => String(value)) : [];
    } catch {
        return { ok: false, error: 'Could not check existing context preset names.' };
    }

    if (collidesWithPreset(names, trimmed)) {
        const suggestedName = suggestedPresetName(names, trimmed);
        return {
            ok: false,
            code: 'preset-collision',
            suggestedName,
            error: `A context preset named “${trimmed}” already exists. Try “${suggestedName}”.`,
        };
    }

    let current;
    try {
        current = manager.getPresetSettings(manager.getSelectedPresetName());
    } catch {
        current = null;
    }
    if (!current) {
        return { ok: false, error: 'Could not read the current context template.' };
    }

    let data;
    try {
        data = structuredClone(current);
    } catch {
        return { ok: false, error: 'Could not copy the current context template.' };
    }

    const result = applyTagsToStoryString(String(data.story_string ?? ''), rules);
    data.story_string = result.storyString;
    data.name = trimmed;

    try {
        const response = await manager.savePreset(trimmed, data);
        const serverName = typeof response === 'string'
            ? response
            : response?.name ?? trimmed;
        return {
            ok: true,
            applied: result.applied,
            skipped: result.skipped,
            changed: result.changed,
            name: String(serverName || trimmed),
        };
    } catch (error) {
        const detail = error?.message ? ` ${error.message}` : '';
        return { ok: false, error: `Could not save the context preset.${detail}` };
    }
}

import {
    createBlankRule,
    isTaggablePromptIdentifier,
    MAX_IDENTIFIER_LENGTH,
    normalizeRuleFields,
    suggestTagName,
} from './sections.js';

/**
 * Per-preset storage.
 *
 * Rules live inside the Chat Completion preset itself, under the preset's `extensions` field,
 * rather than in a preset-name-keyed map in extension settings. The host has no stable preset
 * ID — `getSelectedPresetName()` reads the selected option's text — so a local side table keyed
 * by name would break on rename. Storing in the preset instead means the host copies our data
 * during a rename, drops it when the preset is deleted, and carries it through preset
 * export/import for free.
 *
 * This module must not import settings.js: settings.js imports this one.
 */

/** Lodash path handed to the host's preset extension field API. */
export const PRESET_FIELD_PATH = 'promptTags';

/** Only Chat Completion presets own a prompt list, so that is the only API we support. */
const PRESET_API_ID = 'openai';

export const PRESET_DATA_VERSION = 1;

/** Upper bound on stored rules, so a preset file cannot grow without limit. */
export const MAX_PRESET_RULES = 200;

/** Delay before a burst of edits is written back to the preset. */
const WRITE_DELAY_MS = 400;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let cache = null;
const pendingWrites = new Map();
const writeStates = new Map();
const writeStateListeners = new Set();
let writeTimer = null;
let writeRevision = 0;
let writeChain = Promise.resolve();

function context() {
    return SillyTavern.getContext();
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function manager() {
    const ctx = context();
    return ctx?.getPresetManager?.(PRESET_API_ID) ?? null;
}

/** True when a Chat Completion preset is equipped and can be read from. */
export function isPresetScopeAvailable() {
    const ctx = context();
    if (ctx?.mainApi !== PRESET_API_ID) {
        return false;
    }
    return !!manager();
}

export function getCurrentPresetName() {
    const name = manager()?.getSelectedPresetName?.();
    return typeof name === 'string' ? name : '';
}

export function createDefaultPresetData() {
    return { version: PRESET_DATA_VERSION, profileId: '', rules: {} };
}

/**
 * Coerces a stored preset blob into the shape the rest of the extension expects.
 *
 * Unlike normalizeRules in settings.js, this accepts any identifier, because a preset's prompt
 * list is user-defined. It is pure so it can be tested without a host.
 */
export function normalizePresetData(raw) {
    const data = createDefaultPresetData();
    if (!isPlainObject(raw)) {
        return data;
    }

    if (typeof raw.profileId === 'string') {
        data.profileId = raw.profileId.trim();
    }

    if (!isPlainObject(raw.rules)) {
        return data;
    }

    let count = 0;
    for (const identifier of Object.keys(raw.rules)) {
        if (count >= MAX_PRESET_RULES) {
            break;
        }
        if (RESERVED_KEYS.has(identifier)) {
            continue;
        }
        if (!identifier.trim() || identifier.length > MAX_IDENTIFIER_LENGTH) {
            continue;
        }

        const value = raw.rules[identifier];
        if (!isPlainObject(value)) {
            continue;
        }

        data.rules[identifier] = normalizeRuleFields(value, createBlankRule());
        count++;
    }

    return data;
}

/** Reads the current preset's blob, using a cache keyed by preset name. */
export function readPresetData() {
    if (!isPresetScopeAvailable()) {
        return createDefaultPresetData();
    }

    const presetName = getCurrentPresetName();
    const pending = pendingWrites.get(presetName);
    if (pending) {
        return pending.value;
    }
    if (cache && cache.presetName === presetName) {
        return cache.data;
    }

    let raw = null;
    try {
        raw = manager()?.readPresetExtensionField?.({ path: PRESET_FIELD_PATH }) ?? null;
    } catch (error) {
        console.error('[Prompt Tags] Failed to read preset data:', error);
    }

    const data = normalizePresetData(raw);
    cache = { presetName, data };
    return data;
}

export function invalidatePresetCache() {
    cache = null;
}

function setWriteState(presetName, status, error = '') {
    const next = { presetName, status, error: String(error || '') };
    const previous = writeStates.get(presetName);
    if (previous?.status === next.status && previous?.error === next.error) {
        return;
    }

    writeStates.set(presetName, next);
    for (const listener of writeStateListeners) {
        try {
            listener({ ...next });
        } catch (listenerError) {
            console.error('[Prompt Tags] Preset write-state listener failed:', listenerError);
        }
    }
}

function reportWriteFailure(job, error) {
    const message = error?.message || 'The preset manager is unavailable.';
    if (job.reportedError === message) {
        return;
    }
    job.reportedError = message;
    console.error('[Prompt Tags] Failed to save preset data:', error);
    globalThis.toastr?.error?.(
        `Could not save prompt tags to “${job.presetName}”. ${message}`,
        'Prompt Tags',
    );
}

async function drainWrites() {
    writeTimer = null;
    const attempted = new Set();
    let firstError = null;

    while (true) {
        const entry = [...pendingWrites.entries()].find(([, job]) => !attempted.has(job));
        if (!entry) {
            break;
        }

        const [presetName, job] = entry;
        attempted.add(job);
        const target = manager();
        if (!target?.writePresetExtensionField) {
            const error = new Error('The Chat Completion preset manager is unavailable.');
            setWriteState(presetName, 'error', error.message);
            reportWriteFailure(job, error);
            firstError ??= error;
            continue;
        }

        setWriteState(presetName, 'saving');
        try {
            await target.writePresetExtensionField({
                name: presetName,
                path: PRESET_FIELD_PATH,
                value: job.value,
            });
        } catch (error) {
            setWriteState(presetName, 'error', error?.message);
            reportWriteFailure(job, error);
            firstError ??= error;
            continue;
        }

        // A newer edit may have replaced this revision while the host write was in flight.
        // Remove only the exact revision that reached the server, then loop to save the newer one.
        if (pendingWrites.get(presetName)?.revision === job.revision) {
            pendingWrites.delete(presetName);
            setWriteState(presetName, 'saved');
        } else {
            setWriteState(presetName, 'pending');
        }
    }

    if (firstError) {
        throw firstError;
    }
}

function queueFlush() {
    const run = writeChain.catch(() => {}).then(() => drainWrites());
    writeChain = run;
    return run;
}

/**
 * Applies a change to the current preset's blob and schedules one write.
 *
 * The cache is updated immediately so the UI reflects the edit without waiting for the round
 * trip; writes are batched because writePresetExtensionField posts the preset to the server.
 */
function mutate(change) {
    if (!isPresetScopeAvailable()) {
        return false;
    }

    const presetName = getCurrentPresetName();
    const data = structuredClone(readPresetData());
    if (change(data) === false) {
        return false;
    }

    cache = { presetName, data };
    pendingWrites.set(presetName, {
        presetName,
        value: data,
        revision: ++writeRevision,
        reportedError: '',
    });
    setWriteState(presetName, 'pending');

    if (writeTimer !== null) {
        clearTimeout(writeTimer);
    }
    // flushWrite reports its own failures. Nothing awaits the timer, so the rejection is
    // swallowed here rather than surfacing as an unhandled promise rejection.
    writeTimer = setTimeout(() => { queueFlush().catch(() => {}); }, WRITE_DELAY_MS);
    return true;
}

/** Writes any buffered change immediately. Returns a promise for the save. */
export function flushPresetWrites() {
    if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    return queueFlush();
}

/** Current persistence state for one preset, used by the settings drawer's autosave status. */
export function getPresetWriteState(presetName = getCurrentPresetName()) {
    return { ...(writeStates.get(presetName) ?? { presetName, status: 'saved', error: '' }) };
}

/** Subscribes to preset persistence changes. Returns a cleanup function. */
export function subscribePresetWriteState(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    writeStateListeners.add(listener);
    return () => writeStateListeners.delete(listener);
}

/** The explicit rule overrides stored on the equipped preset. */
export function getPresetRuleOverrides() {
    if (!isPresetScopeAvailable()) {
        return {};
    }
    return readPresetData().rules;
}

export function getPresetRule(identifier) {
    return getPresetRuleOverrides()[identifier] ?? null;
}

export function hasPresetRule(identifier) {
    return Object.hasOwn(getPresetRuleOverrides(), identifier);
}

export function setPresetRule(identifier, rule) {
    if (!isTaggablePromptIdentifier(identifier)) {
        return false;
    }

    return mutate(data => {
        const existing = data.rules[identifier];
        if (!existing && Object.keys(data.rules).length >= MAX_PRESET_RULES) {
            return false;
        }
        data.rules[identifier] = normalizeRuleFields(rule, existing ?? createBlankRule());
        return true;
    });
}

/** Applies several complete rule overrides in one all-or-nothing preset mutation. */
export function setPresetRules(updates) {
    if (!isPlainObject(updates)) {
        return false;
    }

    const entries = Object.entries(updates);
    if (!entries.length || entries.some(([identifier]) => !isTaggablePromptIdentifier(identifier))) {
        return false;
    }

    return mutate(data => {
        const next = { ...data.rules };
        let changed = false;
        for (const [identifier, rule] of entries) {
            const normalized = normalizeRuleFields(rule, next[identifier] ?? createBlankRule());
            if (JSON.stringify(next[identifier]) !== JSON.stringify(normalized)) {
                next[identifier] = normalized;
                changed = true;
            }
        }
        if (!changed || Object.keys(next).length > MAX_PRESET_RULES) {
            return false;
        }
        data.rules = next;
        return true;
    });
}

export function clearPresetRule(identifier) {
    return mutate(data => {
        if (!Object.hasOwn(data.rules, identifier)) {
            return false;
        }
        delete data.rules[identifier];
        return true;
    });
}

export function clearAllPresetRules() {
    return mutate(data => {
        if (!Object.keys(data.rules).length) {
            return false;
        }
        data.rules = {};
        return true;
    });
}

/** The profile this preset is bound to, or '' when it should inherit. */
export function getPresetProfileId() {
    if (!isPresetScopeAvailable()) {
        return '';
    }
    return readPresetData().profileId;
}

export function setPresetProfileId(profileId) {
    const value = String(profileId ?? '').trim();
    return mutate(data => {
        if (data.profileId === value) {
            return false;
        }
        data.profileId = value;
        return true;
    });
}

/**
 * Lists the prompts belonging to the equipped preset.
 *
 * `promptManager.serviceSettings` is the live Chat Completion settings object, and `prompts` is
 * a preset field, so this list already changes with the equipped preset.
 */
export function listPresetPrompts(knownSectionIds = []) {
    if (!isPresetScopeAvailable()) {
        return [];
    }

    const prompts = context()?.promptManager?.serviceSettings?.prompts;
    if (!Array.isArray(prompts)) {
        return [];
    }

    const known = new Set(knownSectionIds);
    const seen = new Set();
    const result = [];

    for (const prompt of prompts) {
        const identifier = prompt?.identifier;
        if (typeof identifier !== 'string' || seen.has(identifier)) {
            continue;
        }
        if (!isTaggablePromptIdentifier(identifier)) {
            continue;
        }

        seen.add(identifier);
        const label = typeof prompt.name === 'string' && prompt.name.trim()
            ? prompt.name.trim()
            : identifier;

        result.push({
            identifier,
            label,
            marker: !!prompt.marker,
            isKnownSection: known.has(identifier),
            suggestedTag: suggestTagName(label),
        });
    }

    return result;
}

import { createDefaultRules, MODULE_NAME, normalizeRuleFields, SECTION_IDS } from './sections.js';
import { isValidTagName } from './wrap.js';
import {
    getPresetProfileId,
    getPresetRuleOverrides,
    isPresetScopeAvailable,
    setPresetProfileId,
} from './preset-store.js';

export const DEFAULT_PROFILE = 'Default';
export const SETTINGS_VERSION = 2;
export const EXPORT_VERSION = 2;
export const MAX_IMPORT_BYTES = 1024 * 1024;

/** Sentinel meaning "fall through to the next scope". */
export const INHERIT = '';

const RESERVED_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype', '__prompttags_invalid_assignment__']);

function context() {
    return SillyTavern.getContext();
}

function hasOwn(value, key) {
    return value !== null && value !== undefined && Object.hasOwn(value, key);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function createMap() {
    return Object.create(null);
}

function isSafeProfileName(value) {
    const name = String(value ?? '').trim();
    return !!name && name.length <= 200 && !RESERVED_PROFILE_NAMES.has(name.toLowerCase());
}

function profileName(value) {
    return String(value ?? '').trim();
}

function createProfileId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createDefaultSettings() {
    const defaultId = createProfileId();
    const profiles = createMap();
    profiles[DEFAULT_PROFILE] = {
        id: defaultId,
        rules: createDefaultRules(),
    };

    return {
        schemaVersion: SETTINGS_VERSION,
        enabled: true,
        activeProfile: DEFAULT_PROFILE,
        activeProfileId: defaultId,
        profiles,
        storyStringBackups: createMap(),
        // Kept as a null compatibility field so older settings readers do not mistake a
        // migrated settings object for an unrelated schema.
        storyStringBackup: null,
        deletedProfileIds: [],
        deletedProfileNames: [],
    };
}

function normalizeRuleValue(rule, fallback) {
    if (!isPlainObject(rule)) {
        return { ...fallback };
    }

    return normalizeRuleFields(rule, fallback);
}

/**
 * Fills in any rule the stored profile is missing, so a profile saved by an older version
 * still works after new sections are added. Unknown section IDs are intentionally ignored.
 */
export function normalizeRules(rules) {
    const complete = createDefaultRules();
    if (!isPlainObject(rules)) {
        return complete;
    }

    for (const id of SECTION_IDS) {
        if (hasOwn(rules, id)) {
            complete[id] = normalizeRuleValue(rules[id], complete[id]);
        }
    }
    return complete;
}

function normalizeRulesInPlace(rules) {
    if (!isPlainObject(rules)) {
        return { rules: createDefaultRules(), changed: true };
    }

    let changed = false;
    const defaults = createDefaultRules();

    for (const id of Object.keys(rules)) {
        if (!SECTION_IDS.includes(id)) {
            delete rules[id];
            changed = true;
        }
    }

    for (const id of SECTION_IDS) {
        const fallback = defaults[id];
        const existing = hasOwn(rules, id) ? rules[id] : undefined;
        const normalized = normalizeRuleValue(existing, fallback);

        if (!hasOwn(rules, id) || !isPlainObject(existing)
            || existing.enabled !== normalized.enabled
            || existing.tag !== normalized.tag
            || existing.template !== normalized.template
            || existing.advanced !== normalized.advanced) {
            rules[id] = normalized;
            changed = true;
        }
    }

    return { rules, changed };
}

function normalizeAliases(profile) {
    if (!hasOwn(profile, 'aliases')) {
        return false;
    }

    if (!Array.isArray(profile.aliases)) {
        profile.aliases = [];
        return true;
    }

    const aliases = [];
    for (const value of profile.aliases) {
        const alias = profileName(value);
        if (!isSafeProfileName(alias) || aliases.includes(alias)) {
            continue;
        }
        aliases.push(alias);
    }

    if (JSON.stringify(profile.aliases) !== JSON.stringify(aliases)) {
        profile.aliases = aliases;
        return true;
    }
    return false;
}

function normalizeStoredProfiles(rawProfiles) {
    if (!isPlainObject(rawProfiles)) {
        const defaults = createDefaultSettings();
        return { profiles: defaults.profiles, changed: true };
    }

    // Null-prototype maps make every subsequent map lookup safe, including legacy keys such
    // as "constructor". The conversion happens once and is retained on later reads.
    const requiresNewMap = Object.getPrototypeOf(rawProfiles) !== null;
    const profiles = requiresNewMap ? createMap() : rawProfiles;
    let changed = requiresNewMap;
    const usedIds = new Set();

    for (const rawName of Object.keys(rawProfiles)) {
        if (!hasOwn(rawProfiles, rawName)) {
            continue;
        }

        const name = profileName(rawName);
        const rawProfile = rawProfiles[rawName];
        if (!isSafeProfileName(name) || !isPlainObject(rawProfile)) {
            changed = true;
            if (!requiresNewMap) {
                delete rawProfiles[rawName];
            }
            continue;
        }

        if (name !== rawName) {
            changed = true;
        }

        const profile = rawProfile;
        let id = typeof profile.id === 'string' && profile.id.trim() ? profile.id.trim() : '';
        if (!id || usedIds.has(id)) {
            id = createProfileId();
            changed = true;
        }
        usedIds.add(id);
        if (profile.id !== id) {
            profile.id = id;
            changed = true;
        }

        if (normalizeAliases(profile)) {
            changed = true;
        }

        const normalizedRules = normalizeRulesInPlace(profile.rules);
        if (profile.rules !== normalizedRules.rules) {
            profile.rules = normalizedRules.rules;
            changed = true;
        }
        if (normalizedRules.changed) {
            changed = true;
        }

        profiles[name] = profile;
        if (!requiresNewMap && name !== rawName) {
            delete rawProfiles[rawName];
        }
    }

    if (!Object.keys(profiles).length) {
        const defaults = createDefaultSettings();
        return { profiles: defaults.profiles, changed: true };
    }

    return { profiles, changed };
}

function getProfileEntries(settings) {
    return Object.entries(settings.profiles);
}

function findProfileById(settings, id) {
    if (typeof id !== 'string' || !id) {
        return null;
    }
    return getProfileEntries(settings).find(([, profile]) => profile?.id === id) ?? null;
}

function findProfileByName(settings, name, includeAliases = true) {
    const target = profileName(name);
    if (!target) {
        return null;
    }

    if (hasOwn(settings.profiles, target)) {
        return [target, settings.profiles[target]];
    }

    if (!includeAliases) {
        return null;
    }

    return getProfileEntries(settings).find(([, profile]) => profile?.aliases?.includes(target)) ?? null;
}

function findProfile(settings, reference) {
    const value = String(reference ?? '').trim();
    if (!value) {
        return null;
    }
    return findProfileByName(settings, value) ?? findProfileById(settings, value);
}

function isDeletedProfileId(settings, id) {
    return typeof id === 'string' && settings.deletedProfileIds.includes(id);
}

function isDeletedProfileName(settings, name) {
    return typeof name === 'string' && settings.deletedProfileNames.includes(name);
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function normalizeRecoveryRecords(settings) {
    let changed = false;
    const rawRecords = settings.storyStringBackups;
    const records = isPlainObject(rawRecords) && Object.getPrototypeOf(rawRecords) === null
        ? rawRecords
        : createMap();

    if (records !== rawRecords) {
        changed = true;
    }

    for (const key of Object.keys(rawRecords ?? {})) {
        if (!hasOwn(rawRecords, key)) {
            continue;
        }

        const raw = rawRecords[key];
        if (!isPlainObject(raw)) {
            delete records[key];
            changed = true;
            continue;
        }

        const presetName = profileName(raw.presetName ?? raw.preset);
        const baseline = typeof raw.baselineStoryString === 'string'
            ? raw.baselineStoryString
            : typeof raw.storyString === 'string' ? raw.storyString : '';
        const applied = raw.appliedStoryString === null || raw.appliedStoryString === undefined
            ? null
            : typeof raw.appliedStoryString === 'string' ? raw.appliedStoryString : null;

        if (!presetName || !baseline) {
            delete records[key];
            changed = true;
            continue;
        }

        const presetKey = getPresetKey(presetName);
        const normalized = {
            version: 1,
            presetKey,
            presetName,
            baselineStoryString: baseline,
            appliedStoryString: applied,
        };
        if (JSON.stringify(raw) !== JSON.stringify(normalized) || key !== presetKey) {
            changed = true;
        }
        records[presetKey] = normalized;
        if (key !== presetKey) {
            delete records[key];
        }
    }

    settings.storyStringBackups = records;
    return changed;
}

/** Returns the recovery map key for a context preset name. */
export function getPresetKey(name) {
    return `preset:${String(name ?? '')}`;
}

function migrateLegacyBackup(settings) {
    const legacy = settings.storyStringBackup;
    if (!isPlainObject(legacy)) {
        if (legacy !== null && legacy !== undefined) {
            settings.storyStringBackup = null;
            return true;
        }
        return false;
    }

    const presetName = profileName(legacy.preset);
    const baseline = typeof legacy.storyString === 'string' ? legacy.storyString : '';
    if (!presetName || !baseline) {
        settings.storyStringBackup = null;
        return true;
    }

    if (!isPlainObject(settings.storyStringBackups)) {
        settings.storyStringBackups = createMap();
    }

    const key = getPresetKey(presetName);
    if (!hasOwn(settings.storyStringBackups, key)) {
        settings.storyStringBackups[key] = {
            version: 1,
            presetKey: key,
            presetName,
            baselineStoryString: baseline,
            // Version-one backups did not record the tagged result. They remain scoped to the
            // exact legacy preset, but cannot make a divergence claim until the next update.
            appliedStoryString: null,
        };
    }
    settings.storyStringBackup = null;
    return true;
}

function normalizeStoredSettings(settings) {
    let changed = false;

    if (settings.schemaVersion !== SETTINGS_VERSION) {
        settings.schemaVersion = SETTINGS_VERSION;
        changed = true;
    }

    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = true;
        changed = true;
    }

    const profilesResult = normalizeStoredProfiles(settings.profiles);
    if (settings.profiles !== profilesResult.profiles) {
        settings.profiles = profilesResult.profiles;
        changed = true;
    }
    if (profilesResult.changed) {
        changed = true;
    }

    if (!Array.isArray(settings.deletedProfileIds)) {
        settings.deletedProfileIds = normalizeStringList(settings.deletedProfileIds);
        changed = true;
    } else {
        const ids = normalizeStringList(settings.deletedProfileIds);
        if (JSON.stringify(ids) !== JSON.stringify(settings.deletedProfileIds)) {
            settings.deletedProfileIds = ids;
            changed = true;
        }
    }

    if (!Array.isArray(settings.deletedProfileNames)) {
        settings.deletedProfileNames = normalizeStringList(settings.deletedProfileNames);
        changed = true;
    } else {
        const names = normalizeStringList(settings.deletedProfileNames);
        if (JSON.stringify(names) !== JSON.stringify(settings.deletedProfileNames)) {
            settings.deletedProfileNames = names;
            changed = true;
        }
    }

    if (migrateLegacyBackup(settings)) {
        changed = true;
    }
    if (normalizeRecoveryRecords(settings)) {
        changed = true;
    }

    const activeById = findProfileById(settings, settings.activeProfileId);
    const activeByName = findProfileByName(settings, settings.activeProfile);
    const active = activeById ?? activeByName ?? getProfileEntries(settings)[0];
    if (active) {
        const [name, profile] = active;
        if (settings.activeProfileId !== profile.id) {
            settings.activeProfileId = profile.id;
            changed = true;
        }
        if (settings.activeProfile !== name) {
            settings.activeProfile = name;
            changed = true;
        }
    }

    if (settings.storyStringBackup !== null) {
        settings.storyStringBackup = null;
        changed = true;
    }

    return changed;
}

/** Reads the settings blob, seeding defaults and healing anything missing. */
export function getSettings() {
    const ctx = context();
    const all = ctx.extensionSettings;

    if (!isPlainObject(all[MODULE_NAME])) {
        all[MODULE_NAME] = createDefaultSettings();
        ctx.saveSettingsDebounced();
        return all[MODULE_NAME];
    }

    const settings = all[MODULE_NAME];
    if (normalizeStoredSettings(settings)) {
        ctx.saveSettingsDebounced();
    }
    return settings;
}

export function save() {
    context().saveSettingsDebounced();
}

export function listProfiles() {
    return Object.keys(getSettings().profiles);
}

export function getProfileId(name) {
    const found = findProfile(getSettings(), name);
    return found?.[1]?.id ?? null;
}

export function getProfileName(id) {
    return findProfileById(getSettings(), id)?.[0] ?? null;
}

/**
 * The rule set that should be applied right now.
 *
 * Preset rules are layered over the profile: an entry for a section the profile already covers
 * overrides it, and an entry for a prompt that only exists in this preset is added.
 */
export function getActiveRules() {
    const profileRules = getResolvedProfileRules();

    if (!isPresetScopeAvailable()) {
        return profileRules;
    }

    return { ...profileRules, ...getPresetRuleOverrides() };
}

/** The active profile rules before any explicit preset prompt overrides are layered on top. */
export function getResolvedProfileRules() {
    const settings = getSettings();
    const { name } = resolveProfile();
    return normalizeRules(settings.profiles[name]?.rules);
}

/**
 * Returns the live rules object for a profile, healing anything missing in place.
 * Object identity matters because the settings UI edits this object directly.
 */
export function getEditableRules(profileReference) {
    const settings = getSettings();
    const found = findProfile(settings, profileReference);
    if (!found) {
        return null;
    }

    const profile = found[1];
    const normalized = normalizeRulesInPlace(profile.rules);
    if (profile.rules !== normalized.rules) {
        profile.rules = normalized.rules;
        save();
    } else if (normalized.changed) {
        save();
    }
    return profile.rules;
}

function assignmentRecord(scope) {
    const ctx = context();
    if (scope === 'chat') {
        return {
            record: ctx.chatMetadata?.[MODULE_NAME],
            set(value) {
                if (!ctx.chatMetadata) {
                    return false;
                }
                ctx.chatMetadata[MODULE_NAME] = value;
                return true;
            },
            persist() {
                ctx.saveMetadataDebounced?.();
            },
        };
    }

    const character = ctx.characters?.[ctx.characterId];
    return {
        record: character?.data?.extensions?.[MODULE_NAME],
        set(value) {
            if (!character) {
                return false;
            }
            character.data ??= {};
            character.data.extensions ??= {};
            character.data.extensions[MODULE_NAME] = value;
            return true;
        },
        persist() {
            if (character && typeof ctx.writeExtensionField === 'function') {
                const result = ctx.writeExtensionField(Number(ctx.characterId), MODULE_NAME, character.data.extensions[MODULE_NAME]);
                result?.catch?.(error => console.warn('[Prompt Tags] Could not migrate character profile assignment:', error));
            }
        },
    };
}

function migrateAssignment(scope, record, profile) {
    const holder = assignmentRecord(scope);
    if (!holder.set) {
        return;
    }

    const migrated = isPlainObject(record) ? { ...record, profileId: profile.id } : { profileId: profile.id };
    delete migrated.profile;
    if (holder.set(migrated)) {
        holder.persist();
    }
}

function readAssignment(scope, settings) {
    const holder = assignmentRecord(scope);
    const record = holder.record;
    if (record === undefined || record === null || record === '') {
        return { assigned: false, valid: true, profile: null, reference: '' };
    }

    if (!isPlainObject(record)) {
        return { assigned: true, valid: false, profile: null, reference: String(record) };
    }

    const storedId = hasOwn(record, 'profileId') ? record.profileId : '';
    if (storedId) {
        const found = findProfileById(settings, storedId);
        if (found && !isDeletedProfileId(settings, storedId)) {
            return { assigned: true, valid: true, profile: { name: found[0], ...found[1] }, reference: storedId };
        }
        return { assigned: true, valid: false, profile: null, reference: String(storedId), profileId: String(storedId) };
    }

    const storedName = hasOwn(record, 'profile') ? profileName(record.profile) : '';
    if (!storedName) {
        return { assigned: false, valid: true, profile: null, reference: '' };
    }

    // A deleted legacy name is a tombstone. Do not let a newly created profile with the same
    // display name silently reactivate an old chat or character assignment.
    if (isDeletedProfileName(settings, storedName)) {
        return { assigned: true, valid: false, profile: null, reference: storedName };
    }

    const found = findProfileByName(settings, storedName);
    if (!found || isDeletedProfileId(settings, found[1]?.id)) {
        return { assigned: true, valid: false, profile: null, reference: storedName };
    }

    migrateAssignment(scope, record, { name: found[0], ...found[1] });
    return { assigned: true, valid: true, legacy: true, profile: { name: found[0], ...found[1] }, reference: storedName };
}

/**
 * Reads the profile bound to the equipped preset.
 *
 * The stored value is a profile ID. A preset shared by someone else carries an ID that does not
 * exist here, so an unresolvable binding is reported as assigned-but-invalid and falls through
 * rather than silently doing nothing.
 */
function readPresetAssignment(settings) {
    if (!isPresetScopeAvailable()) {
        return { assigned: false, valid: true, profile: null, reference: '' };
    }

    const profileId = getPresetProfileId();
    if (!profileId) {
        return { assigned: false, valid: true, profile: null, reference: '' };
    }

    if (isDeletedProfileId(settings, profileId)) {
        return { assigned: true, valid: false, profile: null, reference: profileId };
    }

    const found = findProfileById(settings, profileId);
    if (!found) {
        return { assigned: true, valid: false, profile: null, reference: profileId };
    }

    return { assigned: true, valid: true, profile: { name: found[0], ...found[1] }, reference: profileId };
}

/**
 * Resolves which profile is in force. Chat scope beats character scope, which beats the preset
 * binding, which beats the globally selected profile.
 * @returns {{name: string, scope: 'chat'|'character'|'preset'|'global'}}
 */
export function resolveProfile() {
    const settings = getSettings();

    const fromChat = readAssignment('chat', settings);
    if (fromChat.valid && fromChat.profile) {
        return { name: fromChat.profile.name, scope: 'chat' };
    }

    const fromCharacter = readAssignment('character', settings);
    if (fromCharacter.valid && fromCharacter.profile) {
        return { name: fromCharacter.profile.name, scope: 'character' };
    }

    const fromPreset = readPresetAssignment(settings);
    if (fromPreset.valid && fromPreset.profile) {
        return { name: fromPreset.profile.name, scope: 'preset' };
    }

    return { name: settings.activeProfile, scope: 'global' };
}

/** Returns the raw assignment state so the UI can show invalid legacy overrides explicitly. */
export function getAssignmentState(scope) {
    if (scope === 'preset') {
        const result = readPresetAssignment(getSettings());
        return {
            scope,
            assigned: result.assigned,
            valid: result.valid,
            profileId: result.profile?.id ?? result.reference ?? '',
            profileName: result.profile?.name ?? '',
            reference: result.reference ?? '',
            legacy: false,
        };
    }

    if (scope !== 'chat' && scope !== 'character') {
        return { scope, assigned: false, valid: true, profileId: '', profileName: '', reference: '' };
    }

    const result = readAssignment(scope, getSettings());
    return {
        scope,
        assigned: result.assigned,
        valid: result.valid,
        profileId: result.profile?.id ?? result.profileId ?? '',
        profileName: result.profile?.name ?? '',
        reference: result.reference ?? '',
        legacy: !!result.legacy,
    };
}

export function getInvalidAssignments() {
    return ['character', 'chat', 'preset']
        .map(scope => getAssignmentState(scope))
        .filter(state => state.assigned && !state.valid);
}

export function isEnabled() {
    return !!getSettings().enabled;
}

export function setEnabled(value) {
    getSettings().enabled = !!value;
    save();
}

export function setActiveProfile(reference) {
    const settings = getSettings();
    const found = findProfile(settings, reference);
    if (!found) {
        return false;
    }

    settings.activeProfile = found[0];
    settings.activeProfileId = found[1].id;
    save();
    return true;
}

export function createProfile(name, sourceReference = null) {
    const settings = getSettings();
    const trimmed = profileName(name);
    if (!isSafeProfileName(trimmed) || hasOwn(settings.profiles, trimmed) || findProfileByName(settings, trimmed)) {
        return false;
    }

    const source = sourceReference ? findProfile(settings, sourceReference) : null;
    const rules = source ? normalizeRules(source[1].rules) : createDefaultRules();
    settings.profiles[trimmed] = { id: createProfileId(), rules: structuredClone(rules) };
    save();
    return true;
}

export function renameProfile(from, to) {
    const settings = getSettings();
    const source = findProfile(settings, from);
    const trimmed = profileName(to);
    if (!source || !isSafeProfileName(trimmed) || hasOwn(settings.profiles, trimmed) || findProfileByName(settings, trimmed)) {
        return false;
    }

    const [oldName, profile] = source;
    profile.aliases = [...new Set([...(profile.aliases ?? []), oldName])];
    settings.profiles[trimmed] = profile;
    delete settings.profiles[oldName];

    if (settings.activeProfileId === profile.id || settings.activeProfile === oldName) {
        settings.activeProfileId = profile.id;
        settings.activeProfile = trimmed;
    }
    save();
    return true;
}

export function deleteProfile(reference) {
    const settings = getSettings();
    const found = findProfile(settings, reference);
    if (!found || Object.keys(settings.profiles).length <= 1) {
        return false;
    }

    const [name, profile] = found;
    delete settings.profiles[name];
    settings.deletedProfileIds = [...new Set([...settings.deletedProfileIds, profile.id])];
    settings.deletedProfileNames = [...new Set([
        ...settings.deletedProfileNames,
        name,
        ...(profile.aliases ?? []),
    ])];

    if (settings.activeProfileId === profile.id || settings.activeProfile === name) {
        const [nextName, nextProfile] = Object.entries(settings.profiles)[0];
        settings.activeProfile = nextName;
        settings.activeProfileId = nextProfile.id;
    }
    save();
    return true;
}

/**
 * Binds the equipped preset to a profile, or clears the binding when given a blank reference.
 *
 * The ID is stored rather than the name so the binding survives a profile rename.
 */
export function setPresetProfile(reference) {
    if (!isPresetScopeAvailable()) {
        return false;
    }

    const found = profileName(reference) ? findProfile(getSettings(), reference) : null;
    if (reference && !found) {
        return false;
    }

    setPresetProfileId(found ? found[1].id : '');
    return true;
}

export async function setCharacterProfile(reference) {
    const ctx = context();
    if (ctx.characterId === undefined || ctx.characterId === null) {
        return false;
    }

    const found = profileName(reference) ? findProfile(getSettings(), reference) : null;
    if (reference && !found) {
        return false;
    }

    await ctx.writeExtensionField(Number(ctx.characterId), MODULE_NAME, found ? { profileId: found[1].id } : {});
    return true;
}

export function setChatProfile(reference) {
    const ctx = context();
    if (!ctx.chatMetadata) {
        return false;
    }

    const found = profileName(reference) ? findProfile(getSettings(), reference) : null;
    if (reference && !found) {
        return false;
    }

    ctx.chatMetadata[MODULE_NAME] = found ? { profileId: found[1].id } : {};
    ctx.saveMetadataDebounced();
    return true;
}

export function exportProfiles() {
    const settings = getSettings();
    return JSON.stringify({
        format: 'neconyan-prompt-tags',
        version: EXPORT_VERSION,
        activeProfile: settings.activeProfile,
        activeProfileId: settings.activeProfileId,
        profiles: settings.profiles,
    }, null, 4);
}

function importSize(value) {
    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(value).byteLength;
    }
    return value.length * 2;
}

function decodeImportedRules(rawRules) {
    if (!isPlainObject(rawRules)) {
        return { rules: null, error: 'rules must be an object.' };
    }

    const rules = createDefaultRules();
    for (const id of Object.keys(rawRules)) {
        if (!SECTION_IDS.includes(id)) {
            continue;
        }

        const rawRule = rawRules[id];
        if (!isPlainObject(rawRule)) {
            return { rules: null, error: `rules.${id} must be an object.` };
        }

        for (const field of ['enabled', 'tag', 'template', 'advanced']) {
            if (!hasOwn(rawRule, field)) {
                continue;
            }
            const expected = field === 'enabled' || field === 'advanced' ? 'boolean' : 'string';
            if (typeof rawRule[field] !== expected) {
                return { rules: null, error: `rules.${id}.${field} must be a ${expected}.` };
            }
        }

        const normalized = { ...rules[id], ...rawRule };
        if (normalized.enabled && normalized.advanced && !normalized.template.includes('{{content}}')) {
            return { rules: null, error: `rules.${id}.template must contain {{content}}.` };
        }
        if (normalized.enabled && !normalized.advanced && !isValidTagName(normalized.tag)) {
            return { rules: null, error: `rules.${id}.tag is not a valid tag name.` };
        }
        rules[id] = {
            enabled: normalized.enabled,
            tag: normalized.tag,
            template: normalized.template,
            advanced: normalized.advanced,
        };
    }

    return { rules, error: null };
}

function nextProfileName(settings, requested) {
    let target = requested;
    let suffix = 2;
    while (hasOwn(settings.profiles, target)) {
        target = `${requested} (${suffix++})`;
    }
    return target;
}

/**
 * Merges profiles from an exported blob. Colliding names get a numeric suffix rather than
 * overwriting what the user already has.
 * @returns {{imported: string[], rejected: Array<{name: string, reason: string}>, error: string|null}}
 */
export function importProfiles(json) {
    if (typeof json !== 'string') {
        return { imported: [], rejected: [], error: 'Choose a JSON file to import.' };
    }
    if (importSize(json) > MAX_IMPORT_BYTES) {
        return { imported: [], rejected: [], error: 'That import is too large. Choose a file smaller than 1 MB.' };
    }

    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { imported: [], rejected: [], error: 'That is not valid JSON.' };
    }

    if (!isPlainObject(parsed)
        // Files exported before the rename used the old format name.
        || !['neconyan-prompt-tags', 'sillybunny-prompt-tags'].includes(parsed.format)
        || ![1, EXPORT_VERSION].includes(parsed.version)
        || !hasOwn(parsed, 'profiles')
        || !isPlainObject(parsed.profiles)) {
        return { imported: [], rejected: [], error: 'That file is not a Prompt Tags export with a supported version (v1 or v2).' };
    }

    const settings = getSettings();
    const imported = [];
    const rejected = [];

    for (const nameKey of Object.keys(parsed.profiles)) {
        if (!hasOwn(parsed.profiles, nameKey)) {
            continue;
        }

        const name = profileName(nameKey);
        const profile = parsed.profiles[nameKey];
        const reject = reason => rejected.push({ name: nameKey, reason });

        if (!isSafeProfileName(name)) {
            reject('Profile names must be non-empty and cannot use reserved map keys.');
            continue;
        }
        if (!isPlainObject(profile)) {
            reject('The profile must be an object.');
            continue;
        }
        if (hasOwn(profile, 'id') && (typeof profile.id !== 'string' || !profile.id.trim())) {
            reject('The profile ID must be a non-empty string.');
            continue;
        }
        if (hasOwn(profile, 'aliases') && (!Array.isArray(profile.aliases) || profile.aliases.some(alias => typeof alias !== 'string'))) {
            reject('Profile aliases must be an array of strings.');
            continue;
        }

        const decoded = decodeImportedRules(profile.rules);
        if (decoded.error) {
            reject(decoded.error);
            continue;
        }

        const target = nextProfileName(settings, name);
        settings.profiles[target] = { id: createProfileId(), rules: decoded.rules };
        imported.push(target);
    }

    if (imported.length) {
        save();
    }

    if (!imported.length) {
        const detail = rejected.length ? ` ${rejected.length} profile(s) were rejected.` : '';
        return { imported, rejected, error: `No valid profiles found in that file.${detail}` };
    }

    return { imported, rejected, error: null };
}

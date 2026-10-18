/**
 * Conversation Mode REST API - Store Management
 *
 * Functions for reading, writing, and normalizing the Conversation Mode store.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_FILE } from '../constants.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import {
    getSettingsFileIdentity,
    invalidateParsedSettingsFile,
    sameSettingsFileIdentity,
} from '../settings-file-cache.js';
import { tryWriteFileSync } from '../util.js';
import { CONVERSATION_STORE_KEY } from '../../public/scripts/neconyan-conversation/constants.js';
import {
    getObject,
    getOwnRecord,
    getSafeRecord,
    hasOwn,
    isObject,
    parsePositiveInt,
    scopeConversationStorageKey,
    validateConversationStoragePart,
    validateStoreStructure,
} from './conversation-utils.js';

/**
 * Stat-validated cache of file text. Conversation workers read the same JSON
 * files many times inside one scan, and an 8 MB settings file costs tens of
 * milliseconds to pull from disk each time even when it has not changed. Only
 * the text is shared, never the parsed object, because callers mutate their
 * parsed copy before saving it back. A cached copy is reused only while the
 * file identity is unchanged; the identity includes ctime, so a same-size
 * rewrite is still a miss.
 */
const jsonTextCache = new Map();
const JSON_TEXT_CACHE_MAX_ENTRIES = 16;
// Only snapshots created by readConversationStoreForWrite may stand in for a
// save-time read, never a caller-built object that merely resembles one.
const preflightSnapshots = new WeakSet();

/**
 * @returns {{text: string, identity: ReturnType<typeof getSettingsFileIdentity>}|null}
 */
function readJsonTextSnapshot(filePath) {
    const key = path.resolve(filePath);
    let identity;
    try {
        identity = getSettingsFileIdentity(key);
    } catch (error) {
        if (error.code === 'ENOENT') {
            jsonTextCache.delete(key);
            return null;
        }
        throw error;
    }
    const cached = jsonTextCache.get(key);
    if (cached && sameSettingsFileIdentity(cached.identity, identity)) {
        // Refresh recency so a hot settings file is not evicted before its next scan.
        jsonTextCache.delete(key);
        jsonTextCache.set(key, cached);
        return { text: cached.text, identity: cached.identity };
    }
    let text;
    try {
        text = fs.readFileSync(key, 'utf8');
    } catch (error) {
        jsonTextCache.delete(key);
        throw error;
    }
    let stableIdentity = null;
    try {
        const currentIdentity = getSettingsFileIdentity(key);
        if (sameSettingsFileIdentity(identity, currentIdentity)) stableIdentity = identity;
    } catch {
        // A file removed or replaced during the read is returned once but not cached.
    }
    if (stableIdentity) {
        jsonTextCache.set(key, { identity: stableIdentity, text });
        while (jsonTextCache.size > JSON_TEXT_CACHE_MAX_ENTRIES) {
            jsonTextCache.delete(jsonTextCache.keys().next().value);
        }
    } else {
        jsonTextCache.delete(key);
    }
    return { text, identity: stableIdentity };
}

function invalidateJsonTextCache(filePath) {
    const key = path.resolve(filePath);
    jsonTextCache.delete(key);
    storeValidationByPath.delete(key);
}

/**
 * Read JSON file with error handling
 * Returns { ok, data, missing?, error? }
 */
function readJsonFileSnapshot(filePath, fallback = {}) {
    try {
        const snapshot = readJsonTextSnapshot(filePath);
        if (snapshot === null) {
            return { ok: true, data: fallback, missing: true, identity: null, text: null };
        }

        const data = JSON.parse(snapshot.text);
        return { ok: true, data, missing: false, identity: snapshot.identity, text: snapshot.text };
    } catch (error) {
        console.error(`Failed to read or parse JSON file ${filePath}:`, error.message);
        return { ok: false, error: error.message, missing: false };
    }
}

export function readJsonFile(filePath, fallback = {}) {
    const result = readJsonFileSnapshot(filePath, fallback);
    return result.ok
        ? { ok: true, data: result.data, missing: result.missing }
        : { ok: false, error: result.error, missing: result.missing };
}

/**
 * Store validation walks every thread and message, which costs tens of
 * milliseconds on a large settings file. The verdict only depends on the file
 * text, so remember the last verdict for as long as that exact text is still
 * the current content. One entry per settings path keeps this bounded, and the
 * key is a path string, so a plain Map is required: a WeakMap rejects it.
 */
const storeValidationByPath = new Map();
const STORE_VALIDATION_CACHE_MAX_ENTRIES = 16;

/**
 * Get the path to the user's settings.json file
 */
export function getSettingsPath(request) {
    return path.join(request.user.directories.root, SETTINGS_FILE);
}

/**
 * Read user settings (returns data only, no error handling)
 */
export function readUserSettings(request) {
    const result = readUserSettingsWithStatus(request);
    if (!result.ok) {
        throw new Error(result.error || 'Failed to read settings');
    }
    return result.data;
}

/**
 * Read user settings with status (returns { ok, data, error? })
 */
export function readUserSettingsWithStatus(request) {
    const settingsPath = getSettingsPath(request);
    const result = readJsonFileSnapshot(settingsPath, {});
    if (!result.ok) {
        return { ok: false, error: result.error, missing: false };
    }
    if (!isObject(result.data)) {
        return { ok: false, error: 'Settings must contain a JSON object', missing: false };
    }
    if (hasOwn(result.data, 'extension_settings') && !isObject(result.data.extension_settings)) {
        return { ok: false, error: 'Settings extension_settings must contain a JSON object', missing: false };
    }
    if (isObject(result.data.extension_settings)
        && hasOwn(result.data.extension_settings, CONVERSATION_STORE_KEY)
        && !isObject(result.data.extension_settings[CONVERSATION_STORE_KEY])) {
        return { ok: false, error: 'Conversation settings must contain a JSON object', missing: false };
    }
    if (isObject(result.data.extension_settings) && hasOwn(result.data.extension_settings, CONVERSATION_STORE_KEY)) {
        const content = result.text;
        const cacheKey = path.resolve(settingsPath);
        const cached = content === null ? undefined : storeValidationByPath.get(cacheKey);
        let storeValidation = cached && cached.text === content ? cached.validation : null;
        if (!storeValidation) {
            storeValidation = validateStoreStructure(result.data.extension_settings[CONVERSATION_STORE_KEY], { strictMessages: false });
            if (content !== null) {
                storeValidationByPath.set(cacheKey, { text: content, validation: storeValidation });
                while (storeValidationByPath.size > STORE_VALIDATION_CACHE_MAX_ENTRIES) {
                    storeValidationByPath.delete(storeValidationByPath.keys().next().value);
                }
            }
        }
        if (!storeValidation.valid) {
            return { ok: false, error: storeValidation.error, missing: false };
        }
    }
    return { ok: true, data: result.data, missing: result.missing, identity: result.identity };
}

/**
 * Ensure Conversation Mode store exists and is normalized
 * Mutates settings.extension_settings in place
 */
export function ensureConversationStore(settings, normalizeConversationGroupRecord) {
    settings.extension_settings = { ...getObject(settings.extension_settings) };

    const current = hasOwn(settings.extension_settings, CONVERSATION_STORE_KEY)
        ? getObject(settings.extension_settings[CONVERSATION_STORE_KEY])
        : {};
    const store = getOwnRecord(current);
    store.version = parsePositiveInt(current.version, 1, 1);
    store.localStorageMigrated = Boolean(current.localStorageMigrated);
    store.settings = getObject(current.settings);
    store.characters = getSafeRecord(current.characters);
    store.groups = Array.isArray(current.groups) ? current.groups.map(normalizeConversationGroupRecord).filter(Boolean) : [];
    store.legacyThreadPersonaAssignments = getSafeRecord(current.legacyThreadPersonaAssignments);
    store.reminders = Array.isArray(current.reminders) ? current.reminders : [];
    // Server-owned automation configuration; left absent for browser-owned accounts.
    if (current.automation !== undefined) store.automation = getOwnRecord(current.automation);

    settings.extension_settings[CONVERSATION_STORE_KEY] = store;
    return store;
}

/**
 * Validate an expected settings version supplied by a mutation.
 */
export function validateExpectedSettingsVersion(version) {
    return Number.isSafeInteger(version) && version >= 0
        ? { valid: true, version }
        : { valid: false, error: version === undefined ? 'version_required' : 'invalid_version' };
}

function setOwnProperty(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/**
 * Deep-copy JSON-shaped Conversation data before a caller mutates its writable
 * store. Plain objects keep this module's prototypes, and `__proto__` is
 * written as data instead of a prototype.
 */
function cloneConversationValue(root) {
    if (!root || typeof root !== 'object') return root;
    const copyRoot = Array.isArray(root) ? [] : {};
    const stack = [[root, copyRoot]];
    while (stack.length) {
        const [source, target] = stack.pop();
        for (const key of Object.keys(source)) {
            const value = source[key];
            if (!value || typeof value !== 'object') {
                if (key === '__proto__') setOwnProperty(target, key, value);
                else target[key] = value;
                continue;
            }
            const copy = Array.isArray(value) ? [] : {};
            if (key === '__proto__') setOwnProperty(target, key, copy);
            else target[key] = copy;
            stack.push([value, copy]);
        }
    }
    return copyRoot;
}

/**
 * Read and preflight settings before an expensive mutation.
 */
export function readConversationStoreForWrite(request, expectedVersion, normalizeConversationGroupRecord) {
    const versionValidation = validateExpectedSettingsVersion(expectedVersion);
    if (!versionValidation.valid) {
        return { ok: false, status: 400, body: { error: versionValidation.error } };
    }

    const settingsResult = readUserSettingsWithStatus(request);
    if (!settingsResult.ok) {
        return { ok: false, status: 500, body: { error: 'settings_read_failed' } };
    }
    const currentVersion = getSettingsVersion(settingsResult.data);
    if (currentVersion !== versionValidation.version) {
        return {
            ok: false,
            status: 409,
            body: { error: 'settings_conflict', version: currentVersion },
        };
    }

    const settings = settingsResult.data;
    const settingsPath = getSettingsPath(request);
    const currentConversation = isObject(settings.extension_settings)
        ? settings.extension_settings[CONVERSATION_STORE_KEY]
        : undefined;
    let writeConversation = currentConversation;
    let snapshot = settingsResult.identity
        ? { path: settingsPath, identity: settingsResult.identity, settings }
        : null;
    if (snapshot) preflightSnapshots.add(snapshot);
    if (currentConversation !== undefined) {
        try {
            // The caller mutates the writable store, so the snapshot that save
            // compares against must not share branch or message objects with it.
            writeConversation = cloneConversationValue(currentConversation);
        } catch {
            // Without an isolated copy the snapshot is unsafe; leave save to
            // re-read the file instead.
            snapshot = null;
            writeConversation = currentConversation;
        }
    }
    const writeSettings = { ...settings, extension_settings: { ...getObject(settings.extension_settings) } };
    if (writeConversation !== undefined) {
        writeSettings.extension_settings[CONVERSATION_STORE_KEY] = writeConversation;
    }

    return {
        ok: true,
        settings: writeSettings,
        store: ensureConversationStore(writeSettings, normalizeConversationGroupRecord),
        version: currentVersion,
        missing: settingsResult.missing,
        snapshot,
    };
}

/**
 * A preflight parse may stand in for the save-time read only while it is the
 * same file, for the same user path, with the exact identity it was read from.
 * Any write since the preflight makes this false, so save reads fresh and the
 * existing version check decides the outcome.
 */
function isCurrentSettingsSnapshot(request, snapshot) {
    if (!preflightSnapshots.has(snapshot) || !isObject(snapshot.settings) || typeof snapshot.path !== 'string' || !snapshot.identity) {
        return false;
    }
    const settingsPath = getSettingsPath(request);
    if (path.resolve(settingsPath) !== path.resolve(snapshot.path)) {
        return false;
    }
    let identity;
    try {
        identity = getSettingsFileIdentity(settingsPath);
    } catch {
        return false;
    }
    return sameSettingsFileIdentity(snapshot.identity, identity);
}

/**
 * Save Conversation Mode store to disk with version conflict detection
 * Returns { ok, version?, settings?, store?, status?, body? }
 */
export async function saveConversationStore(request, store, version, { trustedConversationEffects = false, trustedConversationAppend = false, navigationEnrolment = null, settingsSnapshot = null } = {}) {
    const versionValidation = validateExpectedSettingsVersion(version);
    if (!versionValidation.valid) {
        return { ok: false, status: 400, body: { error: versionValidation.error } };
    }
    const storeValidation = validateStoreStructure(store, { strictMessages: false });
    if (!storeValidation.valid) {
        return { ok: false, status: 400, body: { error: storeValidation.error } };
    }

    let latestSettings;
    if (isCurrentSettingsSnapshot(request, settingsSnapshot)) {
        latestSettings = settingsSnapshot.settings;
    } else {
        const latestResult = readUserSettingsWithStatus(request);
        if (!latestResult.ok) {
            return { ok: false, status: 500, body: { error: 'settings_read_failed' } };
        }
        latestSettings = latestResult.data;
    }
    const latestVersion = getSettingsVersion(latestSettings);
    if (latestVersion !== versionValidation.version) {
        return {
            ok: false,
            status: 409,
            body: { error: 'settings_conflict', version: latestVersion },
        };
    }

    const incomingSettings = {
        ...latestSettings,
        extension_settings: {
            ...getObject(latestSettings.extension_settings),
            [CONVERSATION_STORE_KEY]: store,
        },
        _version: versionValidation.version,
    };
    const preparedSave = prepareSettingsSave(incomingSettings, latestSettings, { trustedConversationEffects, trustedConversationAppend, conversationOnly: true, navigationEnrolment });
    if (!preparedSave.ok) {
        return {
            ok: false,
            status: 409,
            body: {
                error: preparedSave.conversationConflict ? 'conversation_conflict' : 'settings_conflict',
                version: preparedSave.currentVersion,
            },
        };
    }

    const settingsPath = getSettingsPath(request);
    try {
        tryWriteFileSync(settingsPath, JSON.stringify(preparedSave.settings, null, 4));
    } catch (error) {
        console.error('Conversation REST API: failed to save settings', error);
        return { ok: false, status: 500, body: { error: 'settings_save_failed' } };
    }
    invalidateJsonTextCache(settingsPath);
    const handle = request.user?.profile?.handle;
    invalidateParsedSettingsFile(settingsPath, handle);
    if (handle) {
        try {
            const { triggerAutoSave } = await import('./settings.js');
            triggerAutoSave(handle);
        } catch (error) {
            console.error('Conversation REST API: failed to trigger settings backup', error);
        }
    }
    return {
        ok: true,
        version: preparedSave.version,
        settings: preparedSave.settings,
        store: preparedSave.settings.extension_settings[CONVERSATION_STORE_KEY],
    };
}

/**
 * Build a thread storage key from avatar, groupId, and personaId
 */
export function getConversationThreadKey(avatar, groupId = '', personaId = '') {
    const safeAvatar = String(avatar || '').trim();
    const safeGroupId = String(groupId || '').trim();
    const avatarValidation = validateConversationStoragePart(safeAvatar, { required: true, allowColon: false });
    const groupValidation = validateConversationStoragePart(safeGroupId, { allowColon: false });
    const personaValidation = validateConversationStoragePart(personaId);
    if (!avatarValidation.valid || !groupValidation.valid || !personaValidation.valid) {
        return '';
    }

    const GROUP_CONVERSATION_STORE_PREFIX = 'group:';
    const threadKey = groupValidation.value
        ? `${GROUP_CONVERSATION_STORE_PREFIX}${groupValidation.value}:${avatarValidation.value}`
        : avatarValidation.value;
    return scopeConversationStorageKey(threadKey, personaValidation.value);
}

/**
 * Send standard save result response
 */
export function respondSaveResult(response, saveResult, successBody) {
    if (saveResult.ok) {
        return response.send({
            ...successBody,
            version: saveResult.version,
        });
    }

    return response.status(saveResult.status || 500).send(saveResult.body || { error: 'save_failed' });
}

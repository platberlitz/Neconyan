export function getSettingsVersion(settings) {
    const version = Number(settings?._version);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

export function getSettingsRevision(settings) {
    const revision = Number(settings?._settingsRevision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function hasSettingsRevision(settings) {
    const revision = Number(settings?._settingsRevision);
    return Number.isSafeInteger(revision) && revision >= 0;
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value).sort()) {
            result[key] = canonicalize(value[key]);
        }
        return result;
    }
    return value;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasEntries(value) {
    return isPlainObject(value) && Object.keys(value).length > 0;
}

/**
 * Copy a conversation with every server-owned record removed. Used to compare
 * what the user actually changed: receipts, automation bookkeeping and runtime
 * overrides are written by the server and must not count as a browser edit.
 */
function stripProtectedConversationState(conversation) {
    if (!isPlainObject(conversation)) {
        return conversation;
    }
    const stripped = { ...conversation };
    delete stripped.serverOperations;
    delete stripped.groupAsideLastSent;
    delete stripped.runtimeStatusOverrides;

    const characters = stripped.characters;
    if (!isPlainObject(characters)) {
        return stripped;
    }
    const nextCharacters = {};
    for (const [key, thread] of Object.entries(characters)) {
        if (!isPlainObject(thread) || !isPlainObject(thread.branches)) {
            nextCharacters[key] = thread;
            continue;
        }
        const branches = {};
        for (const [id, branch] of Object.entries(thread.branches)) {
            if (!isPlainObject(branch)) {
                branches[id] = branch;
                continue;
            }
            const rest = { ...branch };
            delete rest.serverOperations;
            delete rest.automationClaims;
            branches[id] = rest;
        }
        nextCharacters[key] = { ...thread, branches };
    }
    return { ...stripped, characters: nextCharacters };
}

/**
 * True when the Conversation store currently holds state the server owns, so a
 * browser replacement of it must be treated as destructive. This must not depend
 * on a single property: a store whose last managed branch was deleted still has
 * records worth protecting.
 */
function isConversationManaged(conversation) {
    if (!isPlainObject(conversation)) {
        return false;
    }
    if (hasEntries(conversation.serverOperations) || hasEntries(conversation.groupAsideLastSent) || hasEntries(conversation.runtimeStatusOverrides)) {
        return true;
    }
    const characters = conversation.characters;
    if (!isPlainObject(characters)) {
        return false;
    }
    for (const thread of Object.values(characters)) {
        const branches = thread?.branches;
        if (!isPlainObject(branches)) {
            continue;
        }
        for (const branch of Object.values(branches)) {
            if (isPlainObject(branch) && (branch.serverOperations || hasEntries(branch.automationClaims))) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Server-owned records that a browser payload must not be allowed to drop. A
 * browser replacement that leaves the protected shape behind (even with an empty
 * branch list) is destructive and must not pass as "unchanged".
 */
function missingProtectedConversationState(incoming, current) {
    if (!isConversationManaged(current)) {
        return false;
    }
    return JSON.stringify(canonicalize(protectedConversationShape(incoming)))
        !== JSON.stringify(canonicalize(protectedConversationShape(current)));
}

function protectedConversationShape(conversation) {
    if (!isPlainObject(conversation)) {
        return null;
    }
    const shape = {};
    for (const key of ['serverOperations', 'groupAsideLastSent', 'runtimeStatusOverrides']) {
        shape[key] = conversation[key] ?? null;
    }
    const characters = conversation.characters;
    const receipts = {};
    if (isPlainObject(characters)) {
        for (const [key, thread] of Object.entries(characters)) {
            if (!isPlainObject(thread?.branches)) continue;
            for (const [id, branch] of Object.entries(thread.branches)) {
                if (!isPlainObject(branch)) continue;
                if (branch.serverOperations !== undefined || hasEntries(branch.automationClaims)) {
                    receipts[`${key}\u001f${id}`] = {
                        serverOperations: branch.serverOperations ?? null,
                        automationClaims: branch.automationClaims ?? null,
                    };
                }
            }
        }
    }
    shape.branches = receipts;
    return shape;
}

function conversationChanged(incoming, current) {
    return JSON.stringify(canonicalize(stripProtectedConversationState(incoming)))
        !== JSON.stringify(canonicalize(stripProtectedConversationState(current)));
}

/**
 * Restore server-owned records the browser must not overwrite.
 *
 * For a surviving branch (same key, id and createdAt) its records are copied
 * back even when the message list changed, so a legitimate edit does not lose
 * the receipts that make native delivery repeat-safe. A branch that was deleted
 * or genuinely reset is not resurrected, and receipts supplied for it are
 * stripped: copying a branch does not copy another branch's execution history.
 * Store-level bookkeeping always comes from the server.
 */
function restoreProtectedConversationState(conversation, currentConversation) {
    if (!isPlainObject(conversation)) {
        return conversation;
    }
    const currentCharacters = currentConversation?.characters;
    const restored = { ...conversation };
    for (const key of ['serverOperations', 'groupAsideLastSent', 'runtimeStatusOverrides']) {
        if (currentConversation?.[key] !== undefined) {
            restored[key] = currentConversation[key];
        } else {
            delete restored[key];
        }
    }
    if (!isPlainObject(conversation.characters)) {
        return restored;
    }
    const characters = Object.fromEntries(Object.entries(conversation.characters).map(([key, thread]) => {
        if (!isPlainObject(thread) || !isPlainObject(thread.branches)) return [key, thread];
        const branches = Object.fromEntries(Object.entries(thread.branches).map(([id, branch]) => {
            if (!isPlainObject(branch)) return [id, branch];
            const previous = currentCharacters?.[key]?.branches?.[id];
            const updated = { ...branch };
            delete updated.serverOperations;
            delete updated.automationClaims;
            if (isPlainObject(previous) && String(previous.createdAt || '') === String(branch.createdAt || '')) {
                if (previous.serverOperations) updated.serverOperations = previous.serverOperations;
                if (hasEntries(previous.automationClaims)) updated.automationClaims = previous.automationClaims;
            }
            return [id, updated];
        }));
        return [key, { ...thread, branches }];
    }));
    return { ...restored, characters };
}

/**
 * Guard a whole-settings write.
 *
 * `_version` is a global monotonic counter bumped by every settings write, Conversation included.
 * `_settingsRevision` only moves when non-Conversation settings change, so a native Conversation
 * write (which bumps `_version` alone) does not force other open tabs to reload.
 *
 * @param {object} incomingSettings Body sent by the client.
 * @param {object} currentSettings Settings currently on disk.
 * @param {{trustedConversationEffects?: boolean, conversationOnly?: boolean}} [options]
 *   `trustedConversationEffects` - server-owned Conversation effect write; Conversation may change freely.
 *   `conversationOnly` - explicit version-checked Conversation store save; message content may change but server records are restored.
 */
export function prepareSettingsSave(incomingSettings, currentSettings = {}, { trustedConversationEffects = false, conversationOnly = false } = {}) {
    const incomingVersion = getSettingsVersion(incomingSettings);
    const currentVersion = getSettingsVersion(currentSettings);
    const currentRevision = getSettingsRevision(currentSettings);

    const versionMatches = incomingVersion === currentVersion;
    // A client that loaded revision R and has not changed non-Conversation settings may still be
    // behind on `_version` when the only intervening writes were Conversation-only.
    const revisionMatches = hasSettingsRevision(incomingSettings)
        && getSettingsRevision(incomingSettings) === currentRevision
        && currentSettings._settingsRevision !== undefined;
    const conversationOnlyDrift = !versionMatches && incomingVersion < currentVersion && revisionMatches;

    if (!versionMatches && !conversationOnlyDrift) {
        return {
            ok: false,
            currentVersion,
        };
    }

    const version = currentVersion + 1;
    const currentConversation = currentSettings.extension_settings?.sillybunny_conversation;
    const incomingConversation = incomingSettings.extension_settings?.sillybunny_conversation;
    let settingsRevision = currentRevision;
    let settings;

    if (trustedConversationEffects) {
        settings = incomingSettings;
    } else if (conversationOnly) {
        // An explicit, version-checked Conversation store save may intentionally
        // edit or delete messages, but it may not forge the server's records or
        // drop its bookkeeping. A deleted or reset branch is left as supplied.
        settings = isPlainObject(incomingConversation)
            ? {
                ...incomingSettings,
                extension_settings: {
                    ...incomingSettings.extension_settings,
                    sillybunny_conversation: restoreProtectedConversationState(incomingConversation, currentConversation),
                },
            }
            : incomingSettings;
    } else if (incomingSettings._conversationOmitted === true || conversationOnlyDrift) {
        // The client intentionally left the authoritative Conversation block out (or is only behind
        // on Conversation). Keep the server copy and apply the client's non-Conversation settings.
        settingsRevision += 1;
        settings = {
            ...incomingSettings,
            extension_settings: {
                ...(incomingSettings.extension_settings || {}),
                sillybunny_conversation: currentConversation,
            },
        };
    } else if ((isConversationManaged(currentConversation) && conversationChanged(incomingConversation, currentConversation))
        || missingProtectedConversationState(incomingConversation, currentConversation)) {
        // A legacy whole-settings write may not replace server-managed Conversation content.
        return {
            ok: false,
            currentVersion,
            conversationConflict: true,
        };
    } else {
        settingsRevision += 1;
        settings = incomingSettings;
        if (isPlainObject(incomingConversation)) {
            settings = {
                ...incomingSettings,
                extension_settings: {
                    ...incomingSettings.extension_settings,
                    sillybunny_conversation: restoreProtectedConversationState(incomingConversation, currentConversation),
                },
            };
        }
    }

    if (settings._conversationOmitted !== undefined) {
        settings = { ...settings };
        delete settings._conversationOmitted;
    }

    return {
        ok: true,
        version,
        settingsRevision,
        settings: {
            ...settings,
            _version: version,
            _settingsRevision: settingsRevision,
        },
    };
}

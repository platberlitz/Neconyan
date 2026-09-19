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

function stripServerOperations(conversation) {
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
        return conversation;
    }
    const characters = conversation.characters;
    if (!characters || typeof characters !== 'object' || Array.isArray(characters)) {
        return conversation;
    }
    const nextCharacters = {};
    for (const [key, thread] of Object.entries(characters)) {
        if (!thread || typeof thread !== 'object' || !thread.branches || typeof thread.branches !== 'object') {
            nextCharacters[key] = thread;
            continue;
        }
        const branches = {};
        for (const [id, branch] of Object.entries(thread.branches)) {
            if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
                branches[id] = branch;
                continue;
            }
            const rest = { ...branch };
            delete rest.serverOperations;
            branches[id] = rest;
        }
        nextCharacters[key] = { ...thread, branches };
    }
    return { ...conversation, characters: nextCharacters };
}

function isConversationManaged(conversation) {
    const characters = conversation?.characters;
    if (!characters || typeof characters !== 'object' || Array.isArray(characters)) {
        return false;
    }
    for (const thread of Object.values(characters)) {
        const branches = thread?.branches;
        if (!branches || typeof branches !== 'object' || Array.isArray(branches)) {
            continue;
        }
        for (const branch of Object.values(branches)) {
            if (branch && typeof branch === 'object' && !Array.isArray(branch) && branch.serverOperations) {
                return true;
            }
        }
    }
    return false;
}

function conversationChanged(incoming, current) {
    return JSON.stringify(canonicalize(stripServerOperations(incoming)))
        !== JSON.stringify(canonicalize(stripServerOperations(current)));
}

function restoreServerOperations(conversation, currentConversation) {
    const currentCharacters = currentConversation?.characters;
    const characters = Object.fromEntries(Object.entries(conversation.characters).map(([key, thread]) => {
        if (!thread?.branches) return [key, thread];
        const branches = Object.fromEntries(Object.entries(thread.branches).map(([id, branch]) => {
            if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return [id, branch];
            const previous = currentCharacters?.[key]?.branches?.[id];
            const updated = { ...branch };
            delete updated.serverOperations;
            if (previous?.serverOperations && previous.createdAt === branch?.createdAt) updated.serverOperations = previous.serverOperations;
            return [id, updated];
        }));
        return [key, { ...thread, branches }];
    }));
    return { ...conversation, characters };
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
 *   `conversationOnly` - native Conversation store replacement; Conversation may change, revision holds.
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

    if (trustedConversationEffects || conversationOnly) {
        settings = incomingSettings;
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
    } else if (isConversationManaged(currentConversation) && conversationChanged(incomingConversation, currentConversation)) {
        // A legacy whole-settings write may not replace server-managed Conversation content.
        return {
            ok: false,
            currentVersion,
            conversationConflict: true,
        };
    } else {
        settingsRevision += 1;
        settings = incomingSettings;
        if (incomingConversation?.characters) {
            settings = {
                ...incomingSettings,
                extension_settings: {
                    ...incomingSettings.extension_settings,
                    sillybunny_conversation: restoreServerOperations(incomingConversation, currentConversation),
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

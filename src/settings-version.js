export function getSettingsVersion(settings) {
    const version = Number(settings?._version);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

export function prepareSettingsSave(incomingSettings, currentSettings = {}, { trustedConversationEffects = false } = {}) {
    const incomingVersion = getSettingsVersion(incomingSettings);
    const currentVersion = getSettingsVersion(currentSettings);

    if (incomingVersion !== currentVersion) {
        return {
            ok: false,
            currentVersion,
        };
    }

    const version = currentVersion + 1;
    let settings = incomingSettings;
    const conversation = incomingSettings.extension_settings?.sillybunny_conversation;
    if (!trustedConversationEffects && conversation?.characters) {
        const currentCharacters = currentSettings.extension_settings?.sillybunny_conversation?.characters;
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
        settings = { ...incomingSettings, extension_settings: { ...incomingSettings.extension_settings, sillybunny_conversation: { ...conversation, characters } } };
    }
    return {
        ok: true,
        version,
        settings: {
            ...settings,
            _version: version,
        },
    };
}

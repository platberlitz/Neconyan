import { ctxOf } from '../host.js';

/**
 * Reads the Prompt Tags extension's configuration.
 *
 * Prompt Tags publishes no API and raises no events, so its settings blob is
 * read directly and its slash command is used to switch profiles. Everything
 * here degrades quietly when the extension is not installed.
 */

const SETTINGS_KEY = 'promptTags';

function settingsOf(hostRef) {
    const settings = ctxOf(hostRef)?.extensionSettings?.[SETTINGS_KEY];
    return settings && typeof settings === 'object' ? settings : null;
}

function extensionDisabled(hostRef) {
    const disabled = ctxOf(hostRef)?.extensionSettings?.disabledExtensions;
    return Array.isArray(disabled) && disabled.some((name) => {
        const normalized = String(name ?? '').trim().replace(/^third-party[\\/]/i, '').toLowerCase();
        return ['sillybunny-prompttags', 'neconyan-prompttags', 'prompttags'].includes(normalized);
    });
}

function profileEntry(settings, reference) {
    const profiles = settings?.profiles;
    if (!profiles || typeof profiles !== 'object') {
        return null;
    }
    const profileId = typeof reference?.profileId === 'string' ? reference.profileId : '';
    const profileName = typeof reference?.profile === 'string'
        ? reference.profile
        : (typeof reference?.profileName === 'string' ? reference.profileName : '');
    if (profileId) {
        const found = Object.entries(profiles).find(([, profile]) => profile?.id === profileId);
        if (found) {
            return found;
        }
    }
    return profileName && profiles[profileName] ? [profileName, profiles[profileName]] : null;
}

function presetPromptTags(context) {
    if (context?.mainApi !== 'openai') {
        return null;
    }
    try {
        return context?.getPresetManager?.('openai')?.readPresetExtensionField?.({ path: SETTINGS_KEY }) ?? null;
    } catch {
        return null;
    }
}

function effectiveProfile(context, settings) {
    const records = [
        ['chat', context?.chatMetadata?.[SETTINGS_KEY]],
        ['character', context?.characters?.[context?.characterId]?.data?.extensions?.[SETTINGS_KEY]],
        ['preset', presetPromptTags(context)],
    ];
    for (const [scope, record] of records) {
        const found = profileEntry(settings, record);
        if (found) {
            return { scope, name: found[0], profile: found[1] };
        }
    }
    const found = profileEntry(settings, {
        profileId: settings.activeProfileId,
        profileName: settings.activeProfile,
    }) ?? Object.entries(settings.profiles ?? {})[0];
    return found ? { scope: 'global', name: found[0], profile: found[1] } : null;
}

export function isPromptTagsAvailable(hostRef) {
    return Boolean(settingsOf(hostRef)) && !extensionDisabled(hostRef);
}

export function listPromptTagsProfiles(hostRef) {
    const profiles = settingsOf(hostRef)?.profiles;
    if (!profiles || typeof profiles !== 'object') {
        return [];
    }
    return Object.entries(profiles).map(([name, profile]) => ({
        name,
        id: typeof profile?.id === 'string' ? profile.id : '',
    }));
}

/** Global values that the supported Prompt Tags slash commands can restore. */
export function readPromptTagsGlobalState(hostRef) {
    const settings = settingsOf(hostRef);
    if (!settings) {
        return null;
    }
    const active = profileEntry(settings, {
        profileId: settings.activeProfileId,
        profileName: settings.activeProfile,
    });
    return {
        enabled: settings.enabled !== false && !extensionDisabled(hostRef),
        profileName: active?.[0] ?? String(settings.activeProfile ?? ''),
        profileId: String(active?.[1]?.id ?? settings.activeProfileId ?? ''),
        valid: Boolean(active),
    };
}

/**
 * Records which Prompt Tags profile was in force, and which sections it wraps.
 * The wrapping itself is already visible in the captured prompt, because Prompt
 * Tags rewrites the prompt while it is being built.
 */
export function readPromptTags(hostRef) {
    const context = ctxOf(hostRef);
    const settings = settingsOf(hostRef);
    if (!settings) {
        return null;
    }
    const active = effectiveProfile(context, settings);
    const presetRules = presetPromptTags(context)?.rules;
    const rules = presetRules && typeof presetRules === 'object'
        ? { ...(active?.profile?.rules ?? {}), ...presetRules }
        : (active?.profile?.rules ?? {});
    const enabledSections = Object.entries(rules)
        .filter(([, rule]) => rule?.enabled)
        .map(([section]) => section)
        .sort();
    return {
        enabled: settings.enabled !== false && !extensionDisabled(hostRef),
        profileName: active?.name ?? '',
        profileId: String(active?.profile?.id ?? ''),
        scope: active?.scope ?? 'global',
        enabledSections,
    };
}

const PORTABLE_SETTINGS = ['participants', 'roundTable', 'randomReply', 'feedbackTone', 'assistantTones', 'maxTokens', 'stream', 'assistants'];

/** A session file or copy never carries permissions, connections or private context settings. */
export function portableSettings(settings) {
    return Object.fromEntries(PORTABLE_SETTINGS.filter(key => Object.hasOwn(settings ?? {}, key)).map(key => [key, settings[key]]));
}

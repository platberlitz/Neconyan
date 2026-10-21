/** Scene state is chat-scoped. Each message records its audience at creation time. */
export function readGroupScene(metadata, members) {
    const scene = metadata?.group_scene || {};
    const valid = values => Array.isArray(values) ? [...new Set(values)].filter(avatar => members.includes(avatar)) : [];
    return { away: valid(scene.away), location: String(scene.location || '').slice(0, 300), whisper_to: valid(scene.whisper_to) };
}

export function groupMessageAudience(scene, members, whisperTargets = []) {
    const present = members.filter(avatar => !scene.away.includes(avatar));
    return { present, whisper_to: [...whisperTargets] };
}

/** Missing audience means an older public message, before scene tracking was enabled. */
export function canGroupMemberSee(message, avatar) {
    const audience = message?.extra?.group_scene;
    if (!audience) return true;
    if (Array.isArray(audience.present) && !audience.present.includes(avatar)) return false;
    return !audience.whisper_to?.length || audience.whisper_to.includes(avatar);
}

export function groupScenePrompt(scene, members) {
    const present = members.filter(member => !scene.away.includes(member.avatar)).map(member => member.name);
    const away = members.filter(member => scene.away.includes(member.avatar)).map(member => member.name);
    return `[Scene: ${scene.location ? `Location: ${scene.location}. ` : ''}Present: ${present.join(', ') || 'nobody'}.${away.length ? ` Away: ${away.join(', ')}. They cannot hear or react to this exchange.` : ''}]`;
}

let promptScope = null;

/** Scope every prompt reader to the same audience, without changing the saved chat. */
export function beginGroupPromptScope(avatars, messages) {
    const previous = promptScope;
    const scope = { avatars: [...avatars], messages };
    promptScope = scope;
    return () => { if (promptScope === scope) promptScope = previous; };
}

export function isGroupPromptMessageVisible(message) {
    return !promptScope || promptScope.avatars.every(avatar => canGroupMemberSee(message, avatar));
}

export function filterGroupPromptMessages(messages) {
    return promptScope ? messages.filter(isGroupPromptMessageVisible) : messages;
}

/** Shared summaries have no audience provenance, so cannot be used on a restricted turn. */
export function hasRestrictedGroupHistory() {
    return Boolean(promptScope?.messages.some(message => !isGroupPromptMessageVisible(message)));
}

/** Background Agent work follows its source message even after the active speaker changes. */
export function canGroupTargetSee(message, target) {
    const audience = target?.extra?.group_scene;
    const avatars = target?.original_avatar ? [target.original_avatar]
        : audience?.whisper_to?.length ? audience.whisper_to : audience?.present;
    return avatars ? avatars.every(avatar => canGroupMemberSee(message, avatar)) : isGroupPromptMessageVisible(message);
}

export function filterGroupTargetMessages(messages, target) {
    return messages.filter(message => canGroupTargetSee(message, target));
}

/** Synchronous macro expansion for background work must use its own target's audience. */
export function withGroupTargetPrompt(target, messages, callback) {
    const audience = target?.extra?.group_scene;
    const avatars = target?.original_avatar ? [target.original_avatar]
        : audience?.whisper_to?.length ? audience.whisper_to : audience?.present;
    if (!avatars) return callback();
    const restore = beginGroupPromptScope(avatars, messages);
    try { return callback(); } finally { restore(); }
}

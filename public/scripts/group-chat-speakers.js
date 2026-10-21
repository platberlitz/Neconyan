/** Store the speaker with each reply variant, including older variants before a speaker change. */
export function rememberGroupSpeaker(message) {
    const speaker = { name: message.name, original_avatar: message.original_avatar ?? null, force_avatar: message.force_avatar ?? null };
    message.extra ??= {};
    message.extra.group_speaker = speaker;
    for (const info of message.swipe_info ?? []) {
        if (!info) continue;
        info.extra ??= {};
        info.extra.group_speaker ??= { ...speaker };
    }
    return speaker;
}

export function restoreGroupSpeaker(message) {
    const speaker = message.extra?.group_speaker;
    if (!speaker) return;
    message.name = speaker.name;
    if (speaker.original_avatar) message.original_avatar = speaker.original_avatar;
    else delete message.original_avatar;
    if (speaker.force_avatar) message.force_avatar = speaker.force_avatar;
    else delete message.force_avatar;
}

/** The pooled strategy chooses randomly from these candidates; its preview shows the whole pool. */
export function getGroupSpeakerPool(members, messages, isUserInput = false) {
    if (isUserInput) return members;
    const spoken = new Set();
    for (const message of [...messages].reverse()) {
        if (message.is_user) break;
        if (!message.is_system && message.original_avatar) spoken.add(message.original_avatar);
    }
    const remaining = members.filter(avatar => !spoken.has(avatar));
    if (remaining.length) return remaining;
    const last = messages.at(-1);
    return members.length > 1 && !last?.is_user ? members.filter(avatar => avatar !== last?.original_avatar) : members;
}

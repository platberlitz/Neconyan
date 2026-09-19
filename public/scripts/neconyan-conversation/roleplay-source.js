export function getRoleplaySourceMessageRevision(message) {
    return JSON.stringify({
        id: message?.id ?? '',
        is_user: Boolean(message?.is_user),
        mes: message?.mes || '',
        name: message?.name || '',
        original_avatar: message?.original_avatar || message?.extra?.original_avatar || message?.extra?.avatar || '',
        role: message?.role || '',
    });
}

export function getRoleplayGroupRevision(group) {
    return JSON.stringify({
        disabled_members: Array.isArray(group?.disabled_members) ? group.disabled_members : [],
        id: group?.id || '',
        members: Array.isArray(group?.members) ? group.members : [],
    });
}

export function buildGroupAsideDirective({ characterName = 'Character', userName = 'User', reason = 'random', groupContext = '' } = {}) {
    const reasonLine = reason === 'mention'
        ? `${userName} just mentioned or addressed you in the group chat. Send them a private aside DM about it.`
        : 'Send a private aside DM while the group chat is ongoing. React to the group if there is something worth reacting to; otherwise start a natural casual DM topic.';
    return `[System directive: You are ${characterName}, currently present in the active group chat. ${reasonLine} This message goes only to ${userName} in Conversation Mode, not into the group chat. Keep it short, casual, in-character, and suitable as one or two chat bubbles. Output only your DM body, without a name prefix.\n\nRecent group chat context:\n${groupContext}]`;
}

export function buildRoleplayDMDirective({ roleplayContext = '' } = {}) {
    return `[System directive: You are sending a private direct message (DM) to {{user}} to comment on the ongoing roleplay/story scene. Step out of the main scene and send a short, private, personal DM sharing your inner thoughts, a side-comment, or a private reaction to what just happened. Keep it short, casual, and completely in-character. Do not continue the roleplay scene; write a private side-message.\n\nRoleplay context:\n${roleplayContext}]`;
}

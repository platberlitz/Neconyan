/**
 * Editing who is in a Conversation group DM: the pure rules the member editor, the follow-up after an edit and the error texts share.
 * No imports, so a suite or a page module can load it without the rest of Conversation Mode.
 */

/** Whether `avatar` is a current, unmuted member of `group` (the test `partners-utils.js` uses for a speaker). */
export function isConversationGroupMemberActive(group, avatar) {
    return Boolean(group?.members?.includes(avatar) && !group.disabled_members?.includes(avatar));
}

/**
 * What saving the editor changes. `members`, `disabled` and `name` are what the editor was drawn with; `selected` is what is ticked now
 * and `visible` is every pal the editor listed. Only a pal that was listed can be removed, so a member added elsewhere meanwhile is kept,
 * and a muted member who is left unticked is not removed. Ticking a muted member adds them (the server un-mutes them).
 * `rename` is `{ from, to }` only when the drawn name is the automatic name of the drawn members and the members' automatic name changes.
 */
export function computeConversationGroupMemberEdit({ members = [], disabled = [], selected = [], visible = [], name = '', autoName = null } = {}) {
    const ticked = [...new Set(selected)];
    const listed = new Set(visible);
    const muted = new Set(disabled);
    const active = members.filter(member => !muted.has(member));
    const activeSet = new Set(active);
    const remove = active.filter(member => listed.has(member) && !ticked.includes(member));
    const add = ticked.filter(avatar => !activeSet.has(avatar));
    const next = members.filter(member => !remove.includes(member));
    for (const avatar of add) {
        if (!next.includes(avatar)) next.push(avatar);
    }
    let rename = null;
    if (typeof autoName === 'function' && name) {
        const from = autoName(members);
        const to = autoName(next);
        if (name === from && to !== from) rename = { from, to };
    }
    return { add, remove, next, count: ticked.length, tooFew: ticked.length < 2, unchanged: !add.length && !remove.length, rename };
}

/**
 * Whether an open view of `avatar` in a group must move after the store changed under it, and to whom.
 * `removedTargets` are the parsed keys the refresh dropped (`{ avatar, groupId, personaId }`). Only Conversation-owned groups move.
 * `{ follow: true, avatar: '' }` means it must move and the group has nobody left to hold it.
 */
export function pickConversationGroupFollowTarget({ avatar = '', groupId = '', personaId = '', group = null, anchorAvatar = '', removedTargets = [] } = {}) {
    if (!groupId || group?.is_conversation_group !== true) return { follow: false };
    const wasRemoved = removedTargets.some(target => target?.avatar === avatar && target?.groupId === groupId
        && (target.personaId === personaId || !target.personaId));
    if (isConversationGroupMemberActive(group, avatar) && !wasRemoved) return { follow: false };
    if (anchorAvatar && anchorAvatar === avatar) return { follow: false };
    return { follow: true, avatar: anchorAvatar || '' };
}

/** The editor's rows: the group's members first, in their order, then every other pal as listed. */
export function orderConversationGroupPickerAvatars(avatars = [], members = []) {
    const listed = new Set(avatars);
    const first = members.filter(member => listed.has(member));
    const firstSet = new Set(first);
    return [...first, ...avatars.filter(avatar => !firstSet.has(avatar))];
}

/** Which toast a failed member edit gets: 'too_few', 'missing_card', 'gone' or 'connection'. */
export function describeConversationGroupMemberError(error) {
    const code = typeof error === 'string' ? error : String(error?.message || '');
    if (code === 'members_required' || code === 'no_available_members') return 'too_few';
    if (code === 'member_not_found') return 'missing_card';
    if (code === 'group_not_found') return 'gone';
    return 'connection';
}

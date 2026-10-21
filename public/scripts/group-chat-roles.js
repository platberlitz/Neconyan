/** A group override wins over the role bundled with a character card. */
export function getGroupMemberRole(group, character) {
    const override = group?.member_roles?.[character?.avatar];
    if (override === 'narrator' || override === 'character') return override;
    return character?.data?.extensions?.neconyan_group_role === 'narrator' ? 'narrator' : 'character';
}

export function buildNarratorReminder(userName) {
    return `[Narrator / GM: describe the setting, consequences and supporting characters. Advance the scene when it needs an event. Leave the group members' choices to their own replies. Never decide ${userName || 'the user'}'s words, thoughts or actions. Respect the scene's presence and whisper boundaries.]`;
}

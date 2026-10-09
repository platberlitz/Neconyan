export const EXPRESSION_SETS_KEY = 'expression_sets';

/** Card-owned, portable set definitions. Folders stay stable when a member is renamed. */
export function readExpressionSets(character) {
    const saved = character?.data?.extensions?.[EXPRESSION_SETS_KEY] ?? character?.extensions?.[EXPRESSION_SETS_KEY];
    const members = [];
    for (const member of Array.isArray(saved?.members) ? saved.members : []) {
        if (!member || typeof member.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(member.id)
            || typeof member.name !== 'string' || !member.name.trim() || member.name.length > 80
            || typeof member.folder !== 'string' || !/^[^./\\<>:"|?*\u0000-\u001f]+\/[^./\\<>:"|?*\u0000-\u001f]+$/.test(member.folder)
            || members.some(item => item.id === member.id || item.folder === member.folder || item.name.toLowerCase() === member.name.trim().toLowerCase())) continue;
        members.push({ id: member.id, name: member.name.trim(), folder: member.folder,
            description: String(member.description || '').slice(0, 2400) });
    }
    return { version: 1, members, active: members.some(member => member.id === saved?.active) ? saved.active : '', auto: saved?.auto === true };
}

/** Only explicit speaker labels count, never an ordinary mention of another character. */
export function resolveExpressionMember(character, message = null) {
    const sets = readExpressionSets(character);
    if (sets.auto && message) {
        const byName = sets.members.find(member => member.name.toLowerCase() === String(message.name || '').trim().toLowerCase());
        if (byName) return byName;
        for (const line of String(message.mes || '').split('\n')) {
            const speaker = line.trim().replace(/^[*_]+/, '').match(/^([^:\n]{1,84}):/);
            if (!speaker) continue;
            const name = speaker[1].replace(/[*_]+$/, '').trim().toLowerCase();
            const match = sets.members.find(member => member.name.toLowerCase() === name);
            if (match) return match;
        }
    }
    return sets.members.find(member => member.id === sets.active) ?? null;
}

export function applyExpressionMemberPrompt(context, member) {
    if (!member) return { ...context };
    return { ...context, characterName: member.name, characterCard: [
        `Draw only ${member.name}, one character from this shared card. Do not draw any other cast member.`,
        member.description ? `Appearance of ${member.name}: ${member.description}` : '',
        context.characterCard ? `Shared card reference:\n${context.characterCard}` : '',
    ].filter(Boolean).join('\n') };
}

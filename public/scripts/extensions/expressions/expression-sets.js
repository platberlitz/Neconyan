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

function findMemberByName(members, name) {
    const wanted = String(name || '').trim().toLowerCase();
    return wanted ? members.find(member => member.name.toLowerCase() === wanted) : undefined;
}

/** A saved sprite path names the member's folder, so a chosen expression keeps its character. */
function findMemberBySprite(members, src) {
    let path = String(src || '').split(/[?#]/)[0];
    try { path = decodeURIComponent(path); } catch { return undefined; }
    return members.find(member => path.startsWith(`/characters/${member.folder}/`));
}

/**
 * Only explicit speaker labels count, never an ordinary mention of another character.
 * `speaker` is the Expressions Agent's named character; `savedSrc` is the message's saved sprite.
 */
export function resolveExpressionMember(character, message = null, { speaker = '', savedSrc = '' } = {}) {
    const sets = readExpressionSets(character);
    if (sets.auto && message) {
        const chosen = findMemberByName(sets.members, speaker) ?? findMemberBySprite(sets.members, savedSrc);
        if (chosen) return chosen;
        const byName = findMemberByName(sets.members, message.name);
        if (byName) return byName;
        for (const line of String(message.mes || '').split('\n')) {
            const label = line.trim().replace(/^[*_]+/, '').match(/^([^:\n]{1,84}):/);
            if (!label) continue;
            const name = label[1].replace(/[*_]+$/, '').trim().toLowerCase();
            const match = sets.members.find(member => member.name.toLowerCase() === name);
            if (match) return match;
        }
    }
    return sets.members.find(member => member.id === sets.active) ?? null;
}

/** Shared cards that follow the speaker ask the Expressions Agent to name the character first. */
export function getExpressionsAgentCastPrompt(character) {
    const sets = readExpressionSets(character);
    if (!sets.auto || sets.members.length < 2) return '';
    const names = sets.members.map(member => member.name);
    return [
        '[Characters on this card]',
        `This card holds several characters, and each has their own expression set: ${names.join(', ')}.`,
        'Decide which of these characters the target message mainly shows, then answer with that character\'s name, a colon and the label, for example:',
        `${names[0]}: <label>`,
        'This replaces the single-label answer format above. Use the name exactly as written in the list and nothing else.',
    ].join('\n');
}

export function applyExpressionMemberPrompt(context, member) {
    if (!member) return { ...context };
    return { ...context, characterName: member.name, characterCard: [
        `Draw only ${member.name}, one character from this shared card. Do not draw any other cast member.`,
        member.description ? `Appearance of ${member.name}: ${member.description}` : '',
        context.characterCard ? `Shared card reference:\n${context.characterCard}` : '',
    ].filter(Boolean).join('\n') };
}

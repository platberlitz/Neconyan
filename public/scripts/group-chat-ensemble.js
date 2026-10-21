/** Pure prompt and message splitting helpers for a single multi-character reply. */

export function buildEnsemblePrompt(names, userName) {
    return `[Group ensemble: write the next exchange for ${names.join(', ')}, in that order, in one response. Write one passage per character, beginning each passage on a new line with the character's exact name followed by a colon. Use every listed character once. Keep each character's dialogue, actions and thoughts in their own passage. Never write dialogue, decisions or thoughts for ${userName || 'the user'}. No introduction, closing summary or code fence.]`;
}

/**
 * Only split when all of the output can be assigned without guessing.
 * The caller keeps an ambiguous answer intact as a Narrator message.
 * @param {string} text Generated exchange
 * @param {{name: string, avatar: string}[]} members Expected speakers, in order
 * @returns {{name: string, avatar: string, text: string}[]|null}
 */
export function splitEnsembleReply(text, members) {
    const source = String(text || '').trim();
    const names = members.map(member => member.name);
    if (!source || new Set(names).size !== names.length) return null;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markers = new RegExp(`^[ \\t]*(?:#{1,3}[ \\t]+)?(?:\\*\\*|__)?(${names.map(escape).join('|')})(?:\\*\\*|__)?:(?:\\*\\*|__)?[ \\t]*`, 'gm');
    const matches = [...source.matchAll(markers)];
    if (matches.length !== members.length || matches[0]?.index !== 0) return null;
    const passages = matches.map((match, index) => ({
        ...members[index],
        name: match[1],
        text: source.slice(match.index + match[0].length, matches[index + 1]?.index ?? source.length).trim(),
    }));
    if (passages.some((passage, index) => passage.name !== names[index] || !passage.text)) return null;
    return passages;
}

/** Build separate messages while keeping request-wide metadata on the first one only. */
export function createEnsembleMessages(message, members, avatarUrl, narratorAvatar) {
    const passages = splitEnsembleReply(message.mes, members);
    if (!passages) {
        return [{ ...message, name: 'Narrator', force_avatar: narratorAvatar, original_avatar: undefined,
            extra: { ...message.extra, group_ensemble: true } }];
    }
    return passages.map((passage, index) => {
        const extra = index === 0 ? { ...message.extra } : { gen_id: message.extra?.gen_id };
        extra.group_ensemble = true;
        const result = { ...message, name: passage.name, mes: passage.text, original_avatar: passage.avatar,
            force_avatar: avatarUrl(passage.avatar), extra, swipe_id: 0, swipes: [passage.text],
            swipe_info: [{ send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished, extra: { ...extra } }] };
        if (index > 0) delete result.mewmory_id;
        return result;
    });
}

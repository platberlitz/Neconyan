/**
 * Pure helpers for group chat turns: keeping each character to its own lines.
 * Kept free of DOM and app state so the browser and tests share one copy.
 */

export const GROUP_SPEAKER_STOP_LIMIT_FALLBACK = 8;

/**
 * Whether a group keeps each character to their own lines. New and existing groups default to on.
 * @param {object} group Group record
 * @returns {boolean}
 */
export function isKeepOwnLinesEnabled(group) {
    return group?.keep_own_lines !== false;
}

/**
 * Names of the other group members, without the speaker, blanks or repeats.
 * @param {string[]} names Member names
 * @param {string} speakerName Current speaker
 * @returns {string[]}
 */
export function getOtherMemberNames(names, speakerName) {
    const speaker = String(speakerName || '').trim();
    const seen = new Set();
    const result = [];
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw || '').trim();
        if (!name || name === speaker || seen.has(name)) continue;
        seen.add(name);
        result.push(name);
    }
    return result;
}

/**
 * Append `\nName:` stop strings for other members after the user's own stops, within the provider limit.
 * @param {string[]} existing Stop strings already chosen
 * @param {string[]} otherNames Other member names
 * @param {number} [limit] Provider stop limit; 0 or undefined means no limit
 * @returns {string[]}
 */
export function appendGroupSpeakerStops(existing, otherNames, limit) {
    const stops = Array.isArray(existing) ? [...existing] : [];
    const max = Number(limit) > 0 ? Number(limit) : GROUP_SPEAKER_STOP_LIMIT_FALLBACK + stops.length;
    for (const name of otherNames || []) {
        if (stops.length >= max) break;
        const stop = `\n${name}:`;
        if (!stops.includes(stop)) stops.push(stop);
    }
    return stops;
}

/**
 * The extra instruction that keeps a speaker from writing for the others.
 * @param {string} speakerName Current speaker
 * @param {string[]} otherNames Other member names
 * @param {string} [userName] The user's persona name
 * @returns {string}
 */
export function buildOwnLinesReminder(speakerName, otherNames, userName = '') {
    const others = [...(otherNames || []), userName].filter(Boolean);
    if (!others.length) return '';
    return ` Never write dialogue, actions or thoughts for ${others.join(', ')}; end the reply when it is someone else's turn.`;
}

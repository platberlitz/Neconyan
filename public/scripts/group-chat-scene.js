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

export const GROUP_DIRECTOR_STRATEGY = 4;
export const GROUP_DIRECTOR_TIMEOUT_MS = 3000;
export const GROUP_DIRECTOR_MAX_SPEAKERS = 3;
export const GROUP_DIRECTOR_RESPONSE_TOKENS = 160;
const DIRECTOR_HISTORY_MESSAGES = 8;
const DIRECTOR_MESSAGE_CHARS = 360;
const DIRECTOR_SUMMARY_CHARS = 140;

function squash(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * A one-line summary of a character card for the director.
 * @param {string} text Description or personality text, macros already resolved
 * @returns {string}
 */
export function summariseMemberCard(text) {
    const flat = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] || flat;
    return squash(sentence, DIRECTOR_SUMMARY_CHARS);
}

/**
 * Build the small prompt that asks the director who speaks next.
 * @param {object} options
 * @param {{name: string, summary?: string, role?: string}[]} options.members Members who may speak
 * @param {{name: string, text: string, isUser?: boolean}[]} options.messages Recent visible messages, oldest first
 * @param {string} [options.userName] The user's persona name
 * @param {number} [options.maxSpeakers] Most speakers the director may pick
 * @returns {{role: string, content: string}[]}
 */
export function buildDirectorPrompt({ members, messages, userName = '', maxSpeakers = GROUP_DIRECTOR_MAX_SPEAKERS }) {
    const max = Math.max(1, Math.min(GROUP_DIRECTOR_MAX_SPEAKERS, Number(maxSpeakers) || 1));
    const memberLines = (members || []).map(member => {
        const role = member.role ? ` (${member.role})` : '';
        const summary = member.summary ? `: ${member.summary}` : '';
        return `- ${member.name}${role}${summary}`;
    });
    const history = (messages || []).slice(-DIRECTOR_HISTORY_MESSAGES)
        .map(message => `${message.name || (message.isUser ? userName : 'Someone')}: ${squash(message.text, DIRECTOR_MESSAGE_CHARS)}`);
    const user = userName ? ` ${userName} is the user; never choose them.` : '';
    return [
        {
            role: 'system',
            content: `You direct a group roleplay scene and decide who speaks next. Choose 1 to ${max} members from the list, in speaking order. Prefer whoever was addressed, asked something or has the strongest reason to react. Do not pick the same member twice in a row unless they were asked something directly.${user} Answer with JSON only, no other text: {"speakers": ["Name"], "reason": "under 12 words"}`,
        },
        {
            role: 'user',
            content: `Members:\n${memberLines.join('\n')}\n\nRecent messages:\n${history.join('\n') || '(none yet)'}\n\nWho speaks next?`,
        },
    ];
}

/**
 * Read the director's answer into known member names, tolerating code fences and loose text.
 * @param {string} text Model output
 * @param {string[]} memberNames Names the director may choose from
 * @param {number} [maxSpeakers] Most speakers to keep
 * @returns {{speakers: string[], reason: string}}
 */
export function parseDirectorResponse(text, memberNames, maxSpeakers = GROUP_DIRECTOR_MAX_SPEAKERS) {
    const raw = String(text || '');
    const names = (memberNames || []).map(name => String(name || '').trim()).filter(Boolean);
    const max = Math.max(1, Math.min(GROUP_DIRECTOR_MAX_SPEAKERS, Number(maxSpeakers) || 1));
    const byLower = new Map(names.map(name => [name.toLowerCase(), name]));
    let picked = [];
    let reason = '';
    let readJson = false;

    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
        try {
            const parsed = JSON.parse(json);
            const list = Array.isArray(parsed?.speakers) ? parsed.speakers : [parsed?.speakers ?? parsed?.speaker].filter(Boolean);
            picked = list.map(name => byLower.get(String(name || '').trim().toLowerCase())).filter(Boolean);
            reason = typeof parsed?.reason === 'string' ? parsed.reason : '';
            readJson = Array.isArray(parsed?.speakers);
        } catch {
            picked = [];
        }
    }

    if (!picked.length && !readJson) {
        const found = names
            .map(name => ({ name, index: raw.toLowerCase().indexOf(name.toLowerCase()) }))
            .filter(entry => entry.index !== -1)
            .sort((a, b) => a.index - b.index);
        picked = found.map(entry => entry.name);
    }

    return {
        speakers: [...new Set(picked)].slice(0, max),
        reason: squash(reason, 90),
    };
}

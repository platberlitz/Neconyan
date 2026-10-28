// Shared by the browser runner and the server Roleplay job, so both keep the
// original text, and skip after-reply Agents, for the same refusals.

const OPENING_LENGTH = 600;

const POLICY_PATTERNS = [
    /\bas an ai\b/,
    /\bi am (?:an ai|a language model|an assistant)\b/,
    /\b(?:content|usage|safety) (?:polic(?:y|ies)|guidelines)\b/,
    /\b(?:against|violates?|violating|outside|breach(?:es)?) (?:my|our) (?:\w+ )?(?:guidelines|policies|principles|values)\b/,
];

const REFUSAL_PATTERNS = [
    /\bi (?:really |simply |just )?(?:cannot|will not|cannot and will not|am unable to|am not able to|am not comfortable|do not feel comfortable|am not going to|do not|must decline to|have to decline to) (?:help|assist|continu|comply|creat|writ|produc|generat|provid|engag|fulfil|edit|revis|rewrit|enhanc|mak|expand|describ|depict|do (?:that|this))\w*(?!\w| but\b)/,
    /\bi (?:must|have to|need to) (?:respectfully |politely )?(?:decline|refuse)\b/,
];

// A main reply is only treated as a refusal when it opens with a refusal and
// also talks about the request itself, so a character turning someone down in
// unquoted dialogue still gets its Agents.
const MAIN_REPLY_REFUSAL_START = 160;
const MAIN_REPLY_LENGTH_LIMIT = 2000;
const MAIN_REPLY_IN_STORY_OPENING = /^["\u201c\u201e\u00ab*_~]/;
const MAIN_REPLY_OOC_PREFIX = /^\(?\s*ooc\s*:\s*/;

const MAIN_REPLY_CONTEXT_PATTERNS = [
    ...POLICY_PATTERNS,
    /\b(?:this|that|your|the) (?:request|prompt|role-?play|scenario|content|kind of content|type of content)\b/,
    /\bcontent (?:of|like) (?:that|this)\b/,
    /\b(?:sexually )?explicit\b/,
    /\bnsfw\b/,
    /\bguidelines\b/,
    /\bpolic(?:y|ies)\b/,
];

function normalizeRefusalText(text) {
    return String(text ?? '')
        .replace(/[\u2018\u2019\u02bc]/g, '\'')
        .toLowerCase()
        .replace(/\bi'm\b/g, 'i am')
        .replace(/\bcan'?t\b|\bcan not\b/g, 'cannot')
        .replace(/\bwon'?t\b/g, 'will not')
        .replace(/\bdon'?t\b/g, 'do not')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Report whether an Agent's output reads as a model refusal rather than the requested text.
 * A phrase that already appears in the original never counts, so characters may still refuse in the story.
 * @param {string} output Agent output.
 * @param {string} original Text the Agent was asked to transform.
 * @returns {boolean}
 */
export function isLikelyPromptTransformRefusal(output, original) {
    const normalizedOutput = normalizeRefusalText(output);
    if (!normalizedOutput) return false;
    const normalizedOriginal = normalizeRefusalText(original);
    const opening = normalizedOutput.slice(0, OPENING_LENGTH);
    const isNewPhrase = pattern => {
        const match = opening.match(pattern);
        return Boolean(match) && !normalizedOriginal.includes(match[0]);
    };
    if (POLICY_PATTERNS.some(isNewPhrase)) return true;
    if (!REFUSAL_PATTERNS.some(isNewPhrase)) return false;
    return normalizedOutput.length < Math.max(800, normalizedOriginal.length * 0.5);
}

/**
 * Report whether a main reply reads as a model refusal, so after-reply Agents should not run on it.
 * Stricter than the Agent check: the refusal must open the reply, outside quotes or actions,
 * and the reply must talk about the request or a policy.
 * @param {string} text Main reply text.
 * @returns {boolean}
 */
export function isLikelyMainReplyRefusal(text) {
    const raw = String(text ?? '').trim();
    if (!raw || MAIN_REPLY_IN_STORY_OPENING.test(raw)) return false;
    const normalized = normalizeRefusalText(raw).replace(MAIN_REPLY_OOC_PREFIX, '');
    if (!normalized || normalized.length > MAIN_REPLY_LENGTH_LIMIT) return false;
    const opening = normalized.slice(0, OPENING_LENGTH);
    const opensWithRefusal = REFUSAL_PATTERNS.some(pattern => {
        const match = opening.match(pattern);
        return Boolean(match) && match.index <= MAIN_REPLY_REFUSAL_START && !/["\u201c\u201d*]/.test(opening.slice(0, match.index));
    });
    if (!opensWithRefusal) return false;
    return MAIN_REPLY_CONTEXT_PATTERNS.some(pattern => pattern.test(opening));
}

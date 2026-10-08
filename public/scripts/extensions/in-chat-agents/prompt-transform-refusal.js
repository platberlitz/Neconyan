// Shared by the browser runner and the server Roleplay job, so both keep the
// original text for the same refusals.

const OPENING_LENGTH = 600;

const POLICY_PATTERNS = [
    /\bas an ai\b/,
    /\bi am (?:an ai|a language model|an assistant)\b/,
    /\b(?:content|usage|safety) polic(?:y|ies)\b/,
    /\b(?:against|violates?|violating|outside|breach(?:es)?) (?:my|our) (?:\w+ )?(?:guidelines|policies|principles|values)\b/,
];

const REFUSAL_PATTERNS = [
    /\bi (?:really |simply |just )?(?:cannot|will not|am unable to|am not able to|am not comfortable|am not going to|must decline to|have to decline to) (?:help|assist|continu|comply|creat|writ|produc|generat|provid|engag|fulfil|edit|revis|rewrit|enhanc|mak|expand|describ|depict|do (?:that|this))\w*/,
    /\bi (?:must|have to|need to) (?:respectfully |politely )?(?:decline|refuse)\b/,
];

function normalizeRefusalText(text) {
    return String(text ?? '')
        .replace(/[\u2018\u2019\u02bc]/g, '\'')
        .toLowerCase()
        .replace(/\bi'm\b/g, 'i am')
        .replace(/\bcan'?t\b|\bcan not\b/g, 'cannot')
        .replace(/\bwon'?t\b/g, 'will not')
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

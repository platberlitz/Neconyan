const MAX_DIAGNOSTIC_LENGTH = 500;
const MAX_CANDIDATE_LENGTH = 65536;
const NON_CONTENT_FIELDS = new Set(['model', 'role', 'type', 'reasoning_effort', 'effort', 'verbosity', 'service_tier', 'tool_choice']);
const normalise = value => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = value => value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];

/** Reject obvious request echoes rather than trying to remove arbitrary prompt text. */
function echoesRequest(candidate, requestBody) {
    if (/\b(?:prompt|request\s+body|messages)\s*[:=]|["'](?:messages|prompt|input|request)["']\s*:/i.test(candidate)) return true;
    if (!requestBody) return false;
    const lower = candidate.toLowerCase();
    const tokens = words(candidate);
    const phrases = new Set(tokens.slice(4).map((_, index) => tokens.slice(index, index + 5).join(' ')));
    const longTokens = tokens.filter(token => token.length >= 24);
    const pending = [requestBody], seen = new Set();
    let remaining = 10000;
    while (pending.length) {
        if (--remaining < 0) return true;
        const value = pending.pop();
        if (typeof value === 'string') {
            const content = normalise(value).toLowerCase();
            if (!content) continue;
            const contentWords = words(content);
            // Short complete values can be private too. Match whole words so a
            // common fragment such as 'is' or 'here' does not match inside prose.
            const fullContent = content.length >= 4 && lower.includes(content)
                && (contentWords.length > 1 || tokens.includes(contentWords[0]));
            if (lower === content || fullContent) return true;
            if (longTokens.some(token => content.includes(token))) return true;
            for (let index = 0; index + 5 <= contentWords.length; index++) {
                if (phrases.has(contentWords.slice(index, index + 5).join(' '))) return true;
            }
        } else if (value && typeof value === 'object' && !seen.has(value)) {
            seen.add(value);
            for (const [key, item] of Object.entries(value)) {
                if (!NON_CONTENT_FIELDS.has(key)) pending.push(item);
            }
        }
    }
    return false;
}

function privateValues(secrets, headers) {
    const values = [...secrets];
    for (const [key, value] of Object.entries(headers)) {
        // Unknown/custom headers may carry credentials under arbitrary names.
        if (!/^(?:content-type|accept)$/i.test(key) && typeof value === 'string') {
            values.push(value);
            if (/^(?:Bearer|Basic)\s+/i.test(value)) values.push(value.replace(/^(?:Bearer|Basic)\s+/i, ''));
        }
    }
    return [...new Set(values.filter(value => typeof value === 'string' && value.length))].sort((a, b) => b.length - a.length);
}

function redact(candidate, values) {
    let result = candidate;
    // Exact values and complete credentials are removed before the display bound.
    for (const value of values) result = result.split(value).join('[redacted]');
    return result
        .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|cookie)\s*["']?\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;}]+)/gi, '$1[redacted]')
        .replace(/\b(?:sk|sess)-[a-zA-Z0-9_-]{12,}/g, '[redacted]')
        .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/((?:https?|file):\/\/[^\s?#)]+)[?#][^\s)]*/gi, '$1?[redacted]')
        .replace(/(\/[\w/.-]+)\?[^\s)]*/g, '$1?[redacted]');
}

/**
 * A safe, recognised provider diagnostic for the shared non-streamed handler.
 * Request material and credentials are private inputs only, never output fields.
 */
export function safeProviderErrorMessage(errorData, { status, statusText = '', secrets = [], headers = {}, requestBody } = {}) {
    const values = privateValues(secrets, headers);
    const safe = candidate => {
        if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > MAX_CANDIDATE_LENGTH) return '';
        const text = normalise(candidate);
        // Ordinary validation prose often lists a few quoted scalar choices.
        // Exempt only these bounded lists from the embedded-structure check;
        // the original text still passes the credential and request-echo checks.
        const prose = text.replace(/\[\s*(?:"[a-z0-9_. -]{1,40}"|'[a-z0-9_. -]{1,40}')(?:\s*,\s*(?:"[a-z0-9_. -]{1,40}"|'[a-z0-9_. -]{1,40}')){0,15}\s*\]/gi, '');
        if (/^\s*[[{]/.test(text) || /[[{]\s*["'[{]|<\/?[a-z!][^>]*>/i.test(prose) || echoesRequest(text, requestBody)) return '';
        return normalise(redact(candidate, values)).slice(0, MAX_DIAGNOSTIC_LENGTH);
    };
    const candidate = [errorData?.error?.message, errorData?.error, errorData?.message, errorData?.detail]
        .find(value => typeof value === 'string' && value.trim());
    const numericStatus = Number(status);
    const fallback = Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus <= 599
        ? `The model provider could not complete the reply (HTTP ${numericStatus}).`
        : 'The model provider could not complete the reply.';
    return safe(candidate) || safe(statusText) || fallback;
}

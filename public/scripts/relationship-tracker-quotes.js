const BUNDLED_UNSAID = '<div style="padding:9px 12px;color:#ffe3f1;font-family:Georgia,serif;font-size:12px;font-style:italic">“$17”</div>';
const QUOTE_PAIRS = [['"', '"'], ['“', '”'], ['«', '»'], ['「', '」'], ['『', '』'], ['＂', '＂']];

/**
 * Keep the bundled Unsaid decoration only when its value is not already quoted.
 * Match the original fragment so saved copies work too, without changing custom
 * replacements or the captured text (including Dialogue Colors markup).
 * @param {string} replacement
 * @param {string} match
 * @param {string} unsaid
 * @returns {string}
 */
export function preserveRelationshipQuotePair(replacement, match, unsaid) {
    if (!/^\[METER\|/i.test(match) || typeof unsaid !== 'string' || !replacement.includes(BUNDLED_UNSAID)) {
        return replacement;
    }

    const visible = unsaid
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
        .replace(/&ldquo;|&#0*8220;|&#x0*201c;/gi, '“')
        .replace(/&rdquo;|&#0*8221;|&#x0*201d;/gi, '”')
        .trim();
    if (!QUOTE_PAIRS.some(([open, close]) => visible.length >= 2 && visible.startsWith(open) && visible.endsWith(close))) {
        return replacement;
    }

    return replacement.replace(BUNDLED_UNSAID, BUNDLED_UNSAID.replace('“$17”', '$17'));
}

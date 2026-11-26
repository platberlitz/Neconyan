/**
 * Removes one Markdown code fence wrapped around a whole reply, such as ```json ... ```.
 * Plain string checks keep this linear on any input; a fence regex with whitespace on
 * both sides of a lazy body backtracks badly on long replies.
 * @param {unknown} text Model reply.
 * @returns {string} The trimmed reply without its surrounding fence.
 */
export function stripCreatorCodeFence(text) {
    const source = String(text ?? '').trim();
    if (source.length < 6 || !source.startsWith('```') || !source.endsWith('```')) return source;
    let body = source.slice(3, -3);
    if (body.slice(0, 4).toLowerCase() === 'json') body = body.slice(4);
    return body.trim();
}

/**
 * Whether lore text is already wrapped as '[', newline, content, newline, ']'.
 * Matches /^\[\s*\n[\s\S]*\n\s*\]$/ without its backtracking on long whitespace.
 * @param {string} text Trimmed lore text.
 * @returns {boolean}
 */
export function hasCreatorLoreBrackets(text) {
    if (text.length < 4 || text[0] !== '[' || text[text.length - 1] !== ']') return false;
    const first = text.indexOf('\n', 1);
    const last = text.lastIndexOf('\n', text.length - 2);
    if (first < 0 || last <= first) return false;
    return !/\S/.test(text.slice(1, first)) && !/\S/.test(text.slice(last + 1, -1));
}

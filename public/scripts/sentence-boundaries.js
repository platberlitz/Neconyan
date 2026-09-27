/** Trim at the nearest completed sentence, preserving the existing prompt and file-chunk behaviour. */
export function trimToEndSentence(input) {
    if (!input) return '';
    const isEmoji = value => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu.test(value);
    const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '。', '！', '？', '”', '）', '】', '’', '」', '_']);
    let last = -1;
    const characters = Array.from(input);
    for (let i = characters.length - 1; i >= 0; i--) {
        const char = characters[i];
        const emoji = isEmoji(char);
        if (punctuation.has(char) || emoji) {
            last = !emoji && i > 0 && /[\s\n]/.test(characters[i - 1]) ? i - 1 : i;
            break;
        }
    }
    return last === -1 ? input.trimEnd() : characters.slice(0, last + 1).join('').trimEnd();
}

export function trimToStartSentence(input) {
    if (!input) return '';
    const p1 = input.indexOf('.');
    const p2 = input.indexOf('!');
    const p3 = input.indexOf('?');
    const p4 = input.indexOf('\n');
    let first = p1;
    let skip1 = false;
    if (p2 > 0 && p2 < first) first = p2;
    if (p3 > 0 && p3 < first) first = p3;
    if (p4 > 0 && p4 < first) { first = p4; skip1 = true; }
    return first > 0 ? input.substring(first + (skip1 ? 1 : 2)) : input;
}

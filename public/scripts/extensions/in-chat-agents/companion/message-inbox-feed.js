// Neconyan: Message Inbox lines. Kept free of imports so the line rules can be tested on their own.

const MESSAGE_INBOX_TEXT_ROW_RE = /^(?:PHONE_TEXT|phone-text|LETTER_TEXT|letter-text)\|[^|\n]+\|[^|\n]*\|/;
const MESSAGE_INBOX_ANY_LINE_RE = /^(?:phone|letter)(?:[-_][a-z]+)?(?:\||$)/i;

/**
 * Folds the lines a model wraps under a phone message or letter line into that message, so a
 * long letter shows inside its card instead of as loose text below it. Display only.
 * @param {string} content Message Inbox content
 * @returns {string}
 */
export function foldMessageInboxLines(content = '') {
    const out = [];
    let open = false;
    let blanks = [];

    for (const line of String(content ?? '').replaceAll(/\r\n?/g, '\n').split('\n')) {
        const trimmed = line.trim();
        if (open && !trimmed) {
            blanks.push(line);
            continue;
        }
        if (open && !MESSAGE_INBOX_ANY_LINE_RE.test(trimmed) && !trimmed.startsWith('```')) {
            out[out.length - 1] += `<br>${trimmed}`;
            blanks = [];
            continue;
        }

        out.push(...blanks);
        blanks = [];
        open = MESSAGE_INBOX_TEXT_ROW_RE.test(trimmed);
        out.push(line);
    }
    out.push(...blanks);

    return out.join('\n');
}

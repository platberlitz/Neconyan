export const PROMPT_PREVIEW_MAX_LENGTH = 140;

const COMMENT_MACRO_PATTERN = /\{\{\/\/([\s\S]*?)\}\}/;
const ALL_COMMENT_MACROS_PATTERN = /\{\{\/\/[\s\S]*?\}\}/g;
const TRIM_MACRO_PATTERN = /\{\{trim\}\}/gi;

function collapseWhitespace(text) {
    return String(text ?? '')
        .replace(/\*\*|__|^\s*#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncatePreview(text, maxLength) {
    if (text.length <= maxLength) {
        return text;
    }

    const cut = text.slice(0, maxLength - 1);
    const lastSpace = cut.lastIndexOf(' ');
    const trimmed = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
    return `${trimmed.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * Builds the short blurb shown under a prompt name in the prompt list.
 * A {{// comment}} in the prompt is used as the blurb; otherwise the start of the prompt text is shown.
 * @param {string} content Raw prompt content.
 * @param {number} [maxLength] Longest blurb before it is cut with an ellipsis.
 * @returns {{ text: string, isComment: boolean }}
 */
export function getPromptPreview(content, maxLength = PROMPT_PREVIEW_MAX_LENGTH) {
    const source = String(content ?? '');
    const comment = collapseWhitespace(source.match(COMMENT_MACRO_PATTERN)?.[1]);
    if (comment) {
        return { text: truncatePreview(comment, maxLength), isComment: true };
    }

    const body = collapseWhitespace(source.replace(ALL_COMMENT_MACROS_PATTERN, ' ').replace(TRIM_MACRO_PATTERN, ' '));
    return { text: body ? truncatePreview(body, maxLength) : '', isComment: false };
}

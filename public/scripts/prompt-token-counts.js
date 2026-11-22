'use strict';

function getTokenCount(item) {
    const tokenCount = Number(item?.getTokens?.() ?? 0);
    return Number.isFinite(tokenCount) ? tokenCount : 0;
}

function getCollection(item) {
    const collection = item?.getCollection?.();
    return Array.isArray(collection) ? collection : null;
}

function addCount(counts, identifier, tokens) {
    if (!identifier) {
        return;
    }

    const tokenCount = Number(tokens);
    if (!Number.isFinite(tokenCount)) {
        return;
    }

    counts[identifier] = (counts[identifier] ?? 0) + tokenCount;
}

function getPromptContent(prompt) {
    return typeof prompt?.content === 'string' ? prompt.content : '';
}

function collectDirectMessageCounts(item, counts) {
    const collection = getCollection(item);
    if (collection) {
        for (const child of collection) {
            collectDirectMessageCounts(child, counts);
        }
        return;
    }

    addCount(counts, item?.identifier, getTokenCount(item));
}

export function getPromptDisplayTokenCounts(messages) {
    const rootCollection = getCollection(messages) ?? [];
    const aggregateCounts = {};
    const directCounts = {};

    for (const item of rootCollection) {
        addCount(aggregateCounts, item?.identifier, getTokenCount(item));
        collectDirectMessageCounts(item, directCounts);
    }

    return { ...aggregateCounts, ...directCounts };
}

// Bare comment tags as the macro engine reads them: {{//}} / {{comment}} open a scope
// and {{///}} / {{/comment}} close it. Flags and spaces inside the braces are allowed,
// the name is case-insensitive, and an opener only pairs with a closer of its own name.
const COMMENT_SCOPE_TAG_PATTERN = /{{\s*[!?~#]*\s*(\/\s*)?(\/\/|comment)\s*}}/gi;
// Start of any comment macro, inline or a stray {{///}} closer, which hides itself.
const COMMENT_START_PATTERN = /{{\s*[!?~#]*\s*(?:(?:\/\s*)?\/\/|comment[\s:}])/iy;
// Zero-output utility macros commonly appended to comments, e.g. {{// ...}}{{trim}}.
const NO_OUTPUT_MACRO_PATTERN = /{{(?:trim|noop)}}/gi;

function hasUnclosedBraces(text) {
    let open = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.startsWith('{{', i)) {
            open++;
            i++;
        } else if (text.startsWith('}}', i) && open > 0) {
            open--;
            i++;
        }
    }
    return open > 0;
}

// Drops every {{//}}...{{///}} (or {{comment}}...{{/comment}}) block. Nested blocks of
// the same name count depth, like the engine does, so the outer closer ends the block.
// An opener without a closer is left for stripInlineComments, as the engine hides only
// the tag itself. A block whose text holds an unclosed '{{' is left alone too: the
// engine reads that '{{' as a macro that swallows the closer, so the block stays visible.
export function stripScopedComments(text) {
    const tags = Array.from(text.matchAll(COMMENT_SCOPE_TAG_PATTERN), match => ({
        start: match.index,
        end: match.index + match[0].length,
        closing: Boolean(match[1]),
        name: match[2].toLowerCase(),
    }));

    let result = '';
    let cursor = 0;
    for (let index = 0; index < tags.length; index++) {
        const opener = tags[index];
        if (opener.closing || opener.start < cursor) {
            continue;
        }

        let depth = 1;
        let closer = null;
        for (let next = index + 1; next < tags.length && !closer; next++) {
            if (tags[next].name !== opener.name) {
                continue;
            }
            depth += tags[next].closing ? -1 : 1;
            closer = depth === 0 ? tags[next] : null;
        }

        if (closer && !hasUnclosedBraces(text.slice(opener.end, closer.start))) {
            result += text.slice(cursor, opener.start);
            cursor = closer.end;
        }
    }

    return result + text.slice(cursor);
}

// The macro lexer allows nested macros inside args, so a comment body can contain
// balanced {{...}} pairs; a non-greedy regex would stop at the first '}}'. Walk the
// braces instead, dropping each comment up to its matching close.
function stripInlineComments(text) {
    let result = '';
    let i = 0;
    while (i < text.length) {
        COMMENT_START_PATTERN.lastIndex = i;
        const isComment = COMMENT_START_PATTERN.test(text);
        if (!isComment) {
            result += text[i];
            i++;
            continue;
        }

        let depth = 0;
        let j = i;
        while (j < text.length) {
            if (text.startsWith('{{', j)) {
                depth++;
                j += 2;
            } else if (text.startsWith('}}', j)) {
                depth--;
                j += 2;
                if (depth === 0) break;
            } else {
                j++;
            }
        }

        if (depth !== 0) {
            // Unterminated macro; keep the character and move on.
            result += text[i];
            i++;
            continue;
        }

        i = j;
    }

    return result;
}

export function isCommentOnlyPromptContent(content) {
    const withoutScoped = stripScopedComments(String(content ?? ''));
    return !stripInlineComments(withoutScoped).replace(NO_OUTPUT_MACRO_PATTERN, '').trim();
}

export function mergePromptTokenCounts(sourceCounts, runtimeCounts) {
    const counts = { ...(sourceCounts ?? {}) };

    for (const [identifier, tokens] of Object.entries(runtimeCounts ?? {})) {
        const tokenCount = Number(tokens);
        // A runtime zero means the prompt never made it into the message tree under
        // its own identifier; keep the source estimate instead of clobbering it.
        if (Number.isFinite(tokenCount) && tokenCount > 0) {
            counts[identifier] = tokenCount;
        }
    }

    return counts;
}

export async function getPromptSourceTokenCounts(prompts, countPromptTokens) {
    const counts = {};

    if (!Array.isArray(prompts) || typeof countPromptTokens !== 'function') {
        return counts;
    }

    for (const prompt of prompts) {
        const content = getPromptContent(prompt);
        if (!prompt?.identifier || prompt?.marker || !content) {
            continue;
        }

        const tokens = await countPromptTokens({ role: prompt.role || 'system', content });
        addCount(counts, prompt.identifier, tokens);
    }

    return counts;
}

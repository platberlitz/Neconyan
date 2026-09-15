import { classifySource, CLASS_STABLE, CLASS_WHY, SEVERITY } from './vendor/volatility.js';

/**
 * Works out which part of a prompt gets cached, and whether anything in that
 * part changes between runs.
 *
 * Prompt caching is applied by the server after the browser hands the prompt
 * over, so no event can report where the cache boundary landed. The walk below
 * mirrors Neconyan's own (src/prompt-converters.js, cachingAtDepthForClaude)
 * so the boundary can be predicted from the captured messages. The host
 * contract test hashes that function and fails if its rules change.
 *
 * Pure: no host imports, so every rule is testable.
 */

const CLAUDE_PROMPT_PLACEHOLDER = "Let's get started.";

function cloneValue(value) {
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }
}

function messageContentParts(message, { includeName = true } = {}) {
    const namePrefix = includeName && message?.name ? `${message.name}: ` : '';
    if (typeof message?.content === 'string') {
        return [{ type: 'text', text: `${namePrefix}${message.content}` }];
    }
    if (Array.isArray(message?.content)) {
        return message.content.map((part) => {
            const next = cloneValue(part);
            if (next?.type === 'image_url') {
                const imageData = next.image_url?.url ?? '';
                return {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: imageData.split(';')[0]?.split(':')[1],
                        data: imageData.split(',')[1],
                    },
                };
            }
            if (next?.type === 'text') {
                next.text = `${namePrefix}${next.text || '\u200b'}`;
            }
            return next;
        });
    }
    return [];
}

function parseJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function startsWithGroupName(text, names) {
    if (typeof names?.startsWithGroupName === 'function') {
        return names.startsWithGroupName(text);
    }
    return (Array.isArray(names?.groupNames) ? names.groupNames : [])
        .some(name => String(text).startsWith(`${name}: `));
}

function addExampleName(message, names) {
    if (message?.role !== 'system' || typeof message.content !== 'string') {
        return message;
    }
    const next = { ...message };
    if (next.name === 'example_user' && names?.userName
        && !next.content.startsWith(`${names.userName}: `)) {
        next.content = `${names.userName}: ${next.content}`;
    }
    if (next.name === 'example_assistant' && names?.charName
        && !next.content.startsWith(`${names.charName}: `)
        && !startsWithGroupName(next.content, names)) {
        next.content = `${names.charName}: ${next.content}`;
    }
    return next;
}

/**
 * Reproduces the message shape passed to Neconyan's Claude converter.
 * The cache walker runs after Claude has removed its leading system prompt,
 * rewritten later system/tool messages, and merged adjacent turns. Work on
 * clones so this analysis never changes a captured prompt.
 */
export function toClaudeShape(messages, options = {}) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const useSysPrompt = options.useSysPrompt
        ?? options.useSystemPrompt
        ?? options.use_sysprompt
        ?? true;
    const useTools = options.useTools ?? options.use_tools ?? true;
    const prefillString = options.prefillString ?? options.prefill ?? '';
    const names = options.names ?? {};
    const cloned = messages
        .filter(message => message && typeof message === 'object')
        .map(message => cloneValue(message));

    if (useSysPrompt) {
        let firstNonSystem = 0;
        while (firstNonSystem < cloned.length && cloned[firstNonSystem]?.role === 'system') {
            firstNonSystem += 1;
        }
        cloned.splice(0, firstNonSystem);
        if (!cloned.length) {
            cloned.push({
                role: 'user',
                content: options.placeholder ?? CLAUDE_PROMPT_PLACEHOLDER,
            });
        }
    }

    const converted = cloned.map((message) => {
        const next = addExampleName({ ...message }, names);
        const wasSystem = next.role === 'system';
        if (next.role === 'tool') {
            next.role = 'user';
            next.content = [{
                type: 'tool_result',
                tool_use_id: next.tool_call_id,
                content: cloneValue(next.content),
            }];
        } else if (next.role === 'assistant' && Array.isArray(next.tool_calls)) {
            next.content = next.tool_calls.map(call => ({
                type: 'tool_use',
                id: call?.id,
                name: call?.function?.name,
                input: typeof call?.function?.arguments === 'string'
                    ? parseJson(call.function.arguments)
                    : cloneValue(call?.function?.arguments),
            }));
        } else {
            if (wasSystem) {
                delete next.name;
            }
            next.content = messageContentParts(next, { includeName: !wasSystem });
        }
        if (wasSystem) {
            next.role = 'user';
        }
        delete next.name;
        delete next.tool_calls;
        delete next.tool_call_id;
        return next;
    });

    // Anthropic requires assistant images to be carried by the following user
    // turn. This happens before same-role messages are merged in the host.
    for (let index = 0; index < converted.length; index += 1) {
        const message = converted[index];
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
            continue;
        }
        const images = message.content.filter(part => part?.type === 'image');
        if (!images.length) {
            continue;
        }
        let userIndex = index + 1;
        while (userIndex < converted.length && converted[userIndex]?.role !== 'user') {
            userIndex += 1;
        }
        if (userIndex >= converted.length) {
            // No user turn follows, so the host appends one at the very end to
            // carry the images. Appending (not inserting mid-way) keeps the
            // role-switch count identical to a real send.
            converted.push({ role: 'user', content: [] });
            userIndex = converted.length - 1;
        }
        converted[userIndex].content.push(...images);
        message.content = message.content.filter(part => part?.type !== 'image');
    }

    if (prefillString) {
        converted.push({
            role: 'assistant',
            content: [{ type: 'text', text: String(prefillString).trimEnd() }],
        });
    }

    if (!useTools) {
        for (const message of converted) {
            for (const content of message.content ?? []) {
                if (content?.type === 'tool_use') {
                    content.type = 'text';
                    content.text = JSON.stringify(content.input);
                    delete content.id;
                    delete content.name;
                    delete content.input;
                }
                if (content?.type === 'tool_result') {
                    content.type = 'text';
                    content.text = content.content;
                    delete content.tool_use_id;
                    delete content.content;
                }
            }
        }
    }

    const merged = [];
    for (const message of converted) {
        const previous = merged.at(-1);
        if (previous?.role === message.role) {
            previous.content.push(...message.content);
        } else {
            merged.push(message);
        }
    }
    return merged;
}

/**
 * Finds the messages the server would mark as cache boundaries.
 *
 * Depth counts role *switches* from the end of the conversation, not messages,
 * and the assistant prefill at the very end is skipped. Boundaries are placed
 * at the requested depth and again two switches later.
 *
 * @param {object[]} messages the outgoing messages
 * @param {number} cachingAtDepth depth configured on the server
 * @returns {number[]} indices of the messages that carry a cache boundary
 */
export function predictCacheBreakpoints(messages, cachingAtDepth) {
    if (!Array.isArray(messages) || !Number.isInteger(cachingAtDepth) || cachingAtDepth < 0) {
        return [];
    }
    const breakpoints = [];
    let passedThePrefill = false;
    let depth = 0;
    let previousRoleName = '';

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!passedThePrefill && message?.role === 'assistant') {
            continue;
        }
        passedThePrefill = true;

        if (message?.role !== previousRoleName) {
            if (depth === cachingAtDepth || depth === cachingAtDepth + 2) {
                breakpoints.push(index);
            }
            if (depth === cachingAtDepth + 2) {
                break;
            }
            depth += 1;
            previousRoleName = message?.role;
        }
    }
    return breakpoints.sort((a, b) => a - b);
}

/**
 * The part of the prompt that caching is supposed to reuse: everything from the
 * start up to and including the last boundary.
 */
export function cachedPrefix(messages, breakpoints) {
    if (!Array.isArray(messages) || !breakpoints?.length) {
        return [];
    }
    const last = Math.max(...breakpoints);
    return messages.slice(0, last + 1);
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
    }
    return '';
}

export function prefixText(messages, breakpoints) {
    return cachedPrefix(messages, breakpoints).map(messageText).join('\n');
}

/**
 * Neconyan merges consecutive system messages before sending, but skips that
 * step during a dry run. Because depth counts role switches, leaving them
 * unmerged would put the predicted boundary in the wrong place, so the merge is
 * reproduced here on a copy.
 */
export function squashSystemMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const result = [];
    for (const message of messages) {
        const previous = result[result.length - 1];
        if (
            previous
            && previous.role === 'system'
            && message?.role === 'system'
            && typeof previous.content === 'string'
            && typeof message.content === 'string'
            && !previous.name
            && !message.name
        ) {
            previous.content = `${previous.content}\n${message.content}`;
            continue;
        }
        result.push({ ...message });
    }
    return result;
}

/**
 * Explains why a piece of text is not the same on every run, using the macro
 * names it contains.
 */
export function explainSpan(span, { deps = {}, sourceText = '' } = {}) {
    // The classifier reads macro syntax, but a captured prompt has already had
    // its macros resolved, so the span itself usually holds only the result.
    // Any source text the caller can supply (a preset's own prompt, a card
    // field) is where a macro name will actually still be found.
    const haystack = [sourceText, span?.text, span?.otherText]
        .filter(part => typeof part === 'string' && part)
        .join('\n');
    const findings = classifySource(haystack, deps);
    const worst = (Array.isArray(findings) ? findings : [])
        .filter(finding => finding?.cls && finding.cls !== CLASS_STABLE)
        .sort((a, b) => (SEVERITY[b.cls] ?? 0) - (SEVERITY[a.cls] ?? 0))[0] ?? null;
    return {
        macro: worst?.name ?? '',
        class: worst?.cls ?? '',
        why: worst
            ? `${worst.name}: ${CLASS_WHY[worst.cls] ?? 'changes between runs'}`
            : 'this text is different each time the prompt is built',
    };
}

/**
 * Full cache report for one run.
 *
 * @param {object} options
 * @param {object[]} options.messages captured outgoing messages
 * @param {object[]} options.volatileSpans pieces that differed between two builds
 * @param {number|null} options.cachingAtDepth configured depth, or null if unknown
 * @param {boolean} options.squashSystem whether Neconyan merges system messages
 * @param {boolean} options.useTools whether Claude tool content remains structured
 * @param {string} options.prefillString assistant prefill appended by the host
 * @param {object} options.names prompt names used for example messages
 * @param {function} options.hash stable hash for the cached prefix
 */
export function analyzeCache({
    messages = [],
    volatileSpans = [],
    cachingAtDepth = null,
    squashSystem = false,
    hash = null,
    sections = [],
    sourceTexts = {},
    deps = {},
    useSysPrompt = true,
    useTools = true,
    prefillString = '',
    names = {},
} = {}) {
    // The server walks the converted Claude messages, not the ChatML capture.
    // `squashSystem` remains accepted for callers from older records; role
    // merging is now part of the Claude conversion in either mode.
    const effective = toClaudeShape(messages, {
        useSysPrompt,
        useTools,
        prefillString,
        names,
    });
    const known = Number.isInteger(cachingAtDepth) && cachingAtDepth >= 0;
    const breakpoints = known ? predictCacheBreakpoints(effective, cachingAtDepth) : [];
    const prefix = prefixText(effective, breakpoints);

    const spans = volatileSpans.map((span) => {
        const explained = explainSpan(span, {
            deps,
            // The unresolved prompt text is where a macro name still exists.
            sourceText: sourceTexts?.[span?.section] ?? '',
        });
        return {
            ...span,
            ...explained,
            // Without a boundary there is no cached region, so nothing can sit
            // above one. Saying "above" here would invent a problem.
            aboveBreakpoint: breakpoints.length ? isSpanInPrefix(span, prefix) : false,
        };
    });

    return {
        predictedBreakpoints: breakpoints,
        prefixHash: prefix && typeof hash === 'function' ? String(hash(prefix)) : '',
        volatileSpans: spans,
        source: known ? 'manual' : 'unknown',
        squashApplied: Boolean(squashSystem),
    };
}

/**
 * The bare span text is a poor locator: a short volatile value such as a die
 * roll matches almost anywhere, and a pure insertion has no text at all. The
 * unchanged anchors recorded around the span are what actually place it, so
 * they are checked first. A span that cannot be located is treated as outside
 * the cached prefix: a missed warning reads better than an invented one.
 */
const BARE_TEXT_MATCH_MINIMUM = 16;

function isSpanInPrefix(span, prefix) {
    if (!prefix) {
        return false;
    }
    const text = String(span?.text ?? '');
    const before = String(span?.anchorBefore ?? '');
    const after = String(span?.anchorAfter ?? '');
    if (before || after) {
        return prefix.includes(`${before}${text}${after}`);
    }
    return text.length >= BARE_TEXT_MATCH_MINIMUM && prefix.includes(text);
}

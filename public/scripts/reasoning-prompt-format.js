/** Format prompt reasoning while retaining the exact continuation prefix state. */
export function formatPromptReasoning(content, reasoning, { settings, counter = 0, isPrefix = false, duration = null,
    substitute = value => value } = {}) {
    if (!isPrefix && (!settings.add_to_prompts || counter >= settings.max_additions) || !reasoning || reasoning === '\u200B') {
        return { content, counter };
    }
    const prefix = substitute(settings.prefix || '');
    const separator = substitute(settings.separator || '');
    const suffix = substitute(settings.suffix || '');
    const formatted = isPrefix && !content ? `${prefix}${reasoning}` : `${prefix}${reasoning}${suffix}${separator}`;
    return { content: formatted + content, counter: counter + 1,
        ...(isPrefix ? { prefixReasoning: reasoning, prefixReasoningFormatted: formatted,
            prefixLength: formatted.length, prefixDuration: duration, prefixIncomplete: !content } : {}) };
}

import { formatInstructModeChat, formatInstructModePrompt, formatInstructModeStoryString } from './instruct-format.js';

/** Extract plain text from supported structured provider content. */
export function normalizeContentText(value, { excludeReasoning = false } = {}) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(item => normalizeContentText(item, { excludeReasoning })).filter(Boolean).join('\n\n');
    if (typeof value !== 'object') return '';
    if (excludeReasoning && (value.thought === true || /reasoning|thinking|thought/i.test(String(value.type ?? '')))) return '';
    for (const key of ['text', 'content', ...(!excludeReasoning ? ['thinking'] : []), 'tool_plan', ...(!excludeReasoning ? ['reasoning'] : []), 'output', 'message']) {
        if (typeof value[key] === 'string') return value[key];
    }
    if (Array.isArray(value.parts)) return normalizeContentText(value.parts, { excludeReasoning });
    if (Array.isArray(value.content)) return normalizeContentText(value.content, { excludeReasoning });
    if (typeof value.content === 'object' && value.content !== null) {
        const content = normalizeContentText(value.content, { excludeReasoning });
        if (content) return content;
    }
    if (Array.isArray(value.tool_plan)) return normalizeContentText(value.tool_plan, { excludeReasoning });
    if (!excludeReasoning && Array.isArray(value.reasoning)) return normalizeContentText(value.reasoning);
    if (Array.isArray(value.output)) return normalizeContentText(value.output, { excludeReasoning });
    return '';
}

/** Scoped profile requests intentionally leave macros in message content untouched. */
export function constructScopedTextPrompt(prompt, instruct, { name1 = '', name2 = '', selectedGroup = false, substitute = value => value } = {}) {
    const formatting = { customInstruct: instruct, name1, name2, selectedGroup, substitute };
    const prefillActive = prompt.at(-1)?.role === 'assistant';
    return prompt.map((message, index) => {
        const raw = normalizeContentText(message.content);
        if (message.ignoreInstruct) return raw;
        const last = index === prompt.length - 1;
        let content = !last || !prefillActive ? formatInstructModeChat({
            ...formatting, name: message.name ?? message.role, mes: raw,
            isUser: message.role === 'user', isNarrator: message.role === 'system',
        }) : raw;
        if (last) {
            let ending = formatInstructModePrompt({ ...formatting, name: 'assistant', isImpersonate: false,
                promptBias: prefillActive ? raw : undefined, isQuiet: true, isQuietToLoud: false });
            if (prefillActive && ending.endsWith('\n') && !raw.endsWith('\n')) ending = ending.slice(0, -1);
            content = prefillActive ? ending : content + ending;
        }
        return content;
    }).join('');
}

/** Preserve raw generation's separate system prompt, macro and prefill semantics. */
export function createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill, {
    instruct = {}, context = {}, name1 = '', name2 = '', selectedGroup = false,
    substitute = value => value, adjustNovelPrompt = value => value,
} = {}) {
    const isInstruct = instruct.enabled && api !== 'openai' && api !== 'novel' && !instructOverride;
    const formatting = { customInstruct: instruct, name1, name2, selectedGroup, substitute };
    if (typeof prompt === 'string') prompt = [{ role: 'user', content: prompt.trim() }];
    else if (prompt.length === 0 && !systemPrompt) throw Error('No messages provided');
    prefill = substitute(prefill ?? '');
    for (const message of prompt) {
        let name = '';
        if (message.role === 'user') name = message.name ?? name1;
        if (message.role === 'assistant') name = message.name ?? name2;
        if (message.role === 'system') name = message.name ?? '';
        const prefix = isInstruct || api === 'openai' ? '' : (name ? `${name}: ` : '');
        if (api === 'openai' && Array.isArray(message.content)) {
            message.content = message.content.map(part => part?.type === 'text' && typeof part.text === 'string'
                ? { ...part, text: substitute(part.text) } : part);
        } else message.content = prefix + substitute(normalizeContentText(message.content));
        if (isInstruct) message.content = formatInstructModeChat({ ...formatting, name, mes: message.content,
            isUser: message.role === 'user', isNarrator: message.role === 'system', forceAvatar: '', forceOutputSequence: false });
    }
    if (systemPrompt) {
        systemPrompt = substitute(systemPrompt);
        systemPrompt = isInstruct ? formatInstructModeStoryString(systemPrompt, {
            customContext: context, customInstruct: instruct, substitute,
        }) : systemPrompt.trim();
        if (isInstruct && systemPrompt.length > 0 && !systemPrompt.endsWith('\n') && instruct.wrap && !instruct.story_string_suffix) systemPrompt += '\n';
        prompt.unshift({ role: 'system', content: systemPrompt });
    }
    if (api === 'openai' && prefill) prompt.push({ role: 'assistant', content: prefill });
    if (api !== 'openai') {
        prompt = prompt.map(message => message.content).join(isInstruct ? '' : '\n');
        if (api === 'novel') prompt = adjustNovelPrompt(prompt);
        prompt += isInstruct ? formatInstructModePrompt({ ...formatting, name: name2, isImpersonate: false,
            promptBias: prefill, isQuiet: true, isQuietToLoud: quietToLoud }) : `\n${prefill}`;
    }
    return prompt;
}

export function removePartialStops(message, stoppingStrings = []) {
    if (!stoppingStrings) return message;
    for (const stop of stoppingStrings) {
        for (let length = stop.length; length > 0; length--) {
            if (message.slice(-length) === stop.slice(0, length)) {
                message = message.slice(0, -length);
                break;
            }
        }
    }
    return message;
}

export function cleanScopedTextResponse(message, stoppingStrings = [], instruct) {
    message = removePartialStops(message.replace(/[^\S\r\n]+$/gm, ''), stoppingStrings);
    if (instruct) {
        for (const sequence of [instruct.stop_sequence, instruct.input_sequence]) {
            if (sequence?.trim() && message.includes(sequence)) message = message.slice(0, message.indexOf(sequence));
        }
        for (const sequence of [instruct.output_sequence, instruct.last_output_sequence]) {
            for (const line of sequence?.split('\n').filter(line => line.trim() !== '') ?? []) message = message.replaceAll(line, '');
        }
    }
    return message;
}

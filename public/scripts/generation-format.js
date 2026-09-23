import { formatInstructModeChat, formatInstructModePrompt, formatInstructModeStoryString } from './instruct-format.js';

export function stringifyUnknown(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try { return JSON.stringify(value); } catch { return String(value); }
}

/** Provider response extraction shared by browser raw requests and saved-active jobs. */
export function extractMessageFromData(data, activeApi, { excludeReasoning = false } = {}) {
    const normalize = value => normalizeContentText(value, { excludeReasoning });
    const stringify = stringifyUnknown;
    let result = '';
    if (typeof data === 'string') result = data;
    else switch (activeApi) {
        case 'kobold': result = data.results[0].text; break;
        case 'koboldhorde': result = data.text; break;
        case 'textgenerationwebui': result = data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? data.content ?? data.response ?? data[0]?.content ?? ''; break;
        case 'novel': result = data.output; break;
        case 'openai':
            result = normalize(data?.content?.filter?.(part => part?.type === 'text')?.map?.(part => part.text)?.join?.('\n\n'))
                || normalize(data?.choices?.[0]?.message?.content) || normalize(data?.choices?.[0]?.text)
                || normalize(data?.text) || normalize(data?.message?.content) || normalize(data?.message?.tool_plan)
                || normalize(Array.isArray(data?.responseContent?.parts) ? data.responseContent.parts.filter(part => !part?.thought) : data?.responseContent?.parts)
                || normalize(Array.isArray(data?.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts.filter(part => !part?.thought) : data?.candidates?.[0]?.content?.parts)
                || (excludeReasoning ? '' : stringify(data?.message?.content));
            break;
    }
    if (excludeReasoning) return normalize(result);
    if (Array.isArray(result)) return result.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('');
    return typeof result === 'string' ? result : stringify(result);
}

export function extractJsonFromData(data, { mainApi, chatCompletionSource, returnInvalidJson = false, removeReasoning = value => value } = {}) {
    if (mainApi !== 'openai') return '{}';
    const text = extractMessageFromData(data, mainApi);
    let result;
    if (chatCompletionSource === 'claude' || (chatCompletionSource === 'linkapi' && Array.isArray(data?.content))) {
        result = data?.content?.find(item => item.type === 'tool_use')?.input;
    } else {
        try { result = JSON.parse(chatCompletionSource === 'perplexity' ? removeReasoning(text) : text); } catch { /* Preserve raw invalid JSON only when requested. */ }
    }
    if (!result && returnInvalidJson && chatCompletionSource !== 'claude') return text;
    return JSON.stringify(result ?? {});
}

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

/** Provider reasoning and signatures shared by page replies and server jobs. */
export function extractProviderReasoning(data, { mainApi, textGenType, chatCompletionSource, showThoughts = true } = {}) {
    if (mainApi === 'textgenerationwebui') {
        if (textGenType === 'openrouter') return data?.choices?.[0]?.reasoning ?? '';
        if (textGenType === 'ollama') return data?.thinking ?? '';
        return '';
    }
    if (mainApi !== 'openai' || !showThoughts) return '';
    const message = data?.choices?.[0]?.message;
    switch (chatCompletionSource) {
        case 'deepseek':
        case 'xai': return message?.reasoning_content ?? '';
        case 'openrouter': return message?.reasoning ?? message?.reasoning_content ?? '';
        case 'makersuite':
        case 'vertexai': return data?.responseContent?.parts?.filter(part => part.thought)?.map(part => part.text)?.join('\n\n') ?? '';
        case 'claude': return data?.content?.filter(part => part.type === 'thinking')?.map(part => part.thinking)?.join('\n\n') ?? '';
        case 'mistralai': return message?.content?.[0]?.thinking?.map(part => part.text)?.filter(Boolean)?.join('\n\n') ?? '';
        case 'linkapi':
            if (Array.isArray(data?.content)) return data.content.filter(part => part.type === 'thinking').map(part => part.thinking).join('\n\n');
            if (Array.isArray(data?.responseContent?.parts)) return data.responseContent.parts.filter(part => part.thought).map(part => part.text).join('\n\n');
            return message?.reasoning_content ?? message?.reasoning ?? '';
        case 'aimlapi': case 'pollinations': case 'moonshot': case 'cometapi': case 'chutes':
        case 'electronhub': case 'nanogpt': case 'siliconflow': case 'zai': case 'workers_ai': case 'custom':
            return String(message?.reasoning_content ?? message?.reasoning ?? '').replaceAll('<|sep|>', '');
        default: return '';
    }
}

export function extractProviderReasoningSignature(data, { mainApi, chatCompletionSource } = {}) {
    if (mainApi !== 'openai') return null;
    const isGemini = chatCompletionSource === 'makersuite' || chatCompletionSource === 'vertexai'
        || (chatCompletionSource === 'linkapi' && Boolean(data?.responseContent || data?.candidates));
    const details = data?.choices?.[0]?.message?.reasoning_details;
    if (chatCompletionSource === 'openrouter' && Array.isArray(details)) {
        for (const detail of details) {
            if (!/^tool_/.test(detail.id) && detail.type === 'reasoning.encrypted' && detail.data) return detail.data;
        }
    }
    const parts = data?.responseContent?.parts ?? data?.candidates?.[0]?.content?.parts;
    if (isGemini && Array.isArray(parts)) {
        for (const part of parts) {
            if (part.thoughtSignature && typeof part.text === 'string') return part.thoughtSignature;
        }
    }
    return null;
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

/** Repair paired markdown spacing without changing continuation boundaries. */
export function fixGeneratedMarkdown(text) {
    const matches = [...text.matchAll(/([*_]{1,2})([\s\S]*?)\1/gm)];
    for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        const replacement = match[0].replace(/(\*|_)([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)|([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)(\*|_)/g, '$1$4');
        text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
    }
    return text;
}

/** Apply raw-generation cleanup after prompt bias, partial stops and regex processing. */
export function cleanGeneratedText(message, {
    power = {}, mainApi, name1 = '', name2 = '', groupNames = [], isImpersonate = false,
    trimNames = true, trimWrongNames = true, displayIncompleteSentences = false,
    reasoningPrefix = '', trimSentence,
} = {}) {
    if (power.collapse_newlines) message = message.replaceAll(/\n+/g, '\n');
    message = message.replace(/[^\S\r\n]+$/gm, '');
    if (trimWrongNames) {
        const wrong = isImpersonate ? (!power.allow_name2_display ? name2 : '') : (!power.allow_name1_display ? name1 : '');
        if (wrong) {
            if (message.startsWith(`${wrong}:`)) message = '';
            const index = message.indexOf(`\n${wrong}:`);
            if (index >= 0) message = message.slice(0, index);
        }
    }
    if (message.includes('<|endoftext|>')) message = message.slice(0, message.indexOf('<|endoftext|>'));
    const instruct = power.instruct || {};
    const notEmpty = value => value && value.trim() !== '';
    if (instruct.enabled && mainApi !== 'openai') {
        for (const sequence of [instruct.stop_sequence, notEmpty(instruct.input_sequence) ? instruct.input_sequence : '']) {
            if (sequence && message.includes(sequence)) message = message.slice(0, message.indexOf(sequence));
        }
        if (instruct.sequences_as_stop_strings) {
            for (const sequence of isImpersonate ? [instruct.input_sequence] : [instruct.output_sequence, instruct.last_output_sequence]) {
                if (notEmpty(sequence)) for (const line of sequence.split('\n').filter(line => line.trim() !== '')) message = message.replaceAll(line, '');
            }
        }
    }
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!power.disable_group_trimming) {
        for (const name of groupNames) {
            if (name === name2) continue;
            const match = message.match(new RegExp(`(^|\n)${escape(name)}:`));
            if (match) message = message.slice(0, match.index);
        }
    }
    if (!power.allow_name2_display) message = message.replace(new RegExp(`(^|\n)${escape(name2)}:\\s*`, 'g'), '$1');
    if (isImpersonate) message = message.trim();
    if (power.auto_fix_generated_markdown) message = fixGeneratedMarkdown(message);
    if (trimNames) {
        const name = isImpersonate ? (!power.allow_name1_display ? name1 : '') : (!power.allow_name2_display ? name2 : '');
        if (name && message.startsWith(`${name}:`)) message = message.replace(`${name}:`, '').trimStart();
    }
    if (isImpersonate) message = message.trim();
    if (!displayIncompleteSentences && power.trim_sentences) message = trimSentence(message);
    if (power.trim_spaces && !reasoningPrefix) message = message.trim();
    return message;
}

function getAutoAppendReasoningTagStyle(settings) {
    const style = String(settings.auto_append_reasoning_tag_style ?? '').trim().toLowerCase();
    if (['think', 'thinking', 'thought'].includes(style)) {
        return style;
    }

    return 'think';
}

function getAutoAppendReasoningTagPair(settings) {
    const tagName = getAutoAppendReasoningTagStyle(settings);
    return {
        openTag: `<${tagName}>`,
        closeTag: `</${tagName}>`,
    };
}

function shouldInjectAutoAppendReasoningInstruction(settings, model = null, type = 'normal') {
    if (!settings.auto_append_reasoning_tags || type === 'quiet') {
        return false;
    }

    const source = settings.chat_completion_source;
    if (source === 'custom') {
        return true;
    }

    const normalizedModel = String(model ?? '').trim().toLowerCase();
    if (!normalizedModel) {
        return false;
    }

    if (['openai', 'openai_responses', 'azure_openai'].includes(source)) {
        return ['gpt-4.5', 'o1', 'o3'].some(prefix => normalizedModel.startsWith(prefix));
    }

    if (['makersuite', 'vertexai'].includes(source)) {
        return ['gemini-2.0-flash-thinking-exp', 'gemini-2.0-pro-exp'].some(prefix => normalizedModel.startsWith(prefix));
    }

    return false;
}

export function appendAutoAppendReasoningInstruction(messages, settings, model = null, type = 'normal') {
    if (!shouldInjectAutoAppendReasoningInstruction(settings, model, type)) {
        return messages;
    }

    const { openTag, closeTag } = getAutoAppendReasoningTagPair(settings);
    const instruction = `Before your final answer, place any visible reasoning inside ${openTag}...${closeTag}. Put the user-facing reply after ${closeTag}, and always close the tag before the final reply.`;
    const nextMessages = structuredClone(messages);
    const systemMessage = nextMessages.find(message => message?.role === 'system' && typeof message?.content === 'string');

    if (systemMessage) {
        const existingContent = String(systemMessage.content ?? '').trim();
        systemMessage.content = existingContent ? `${existingContent}\n\n${instruction}` : instruction;
        return nextMessages;
    }

    nextMessages.unshift({
        role: 'system',
        content: instruction,
    });
    return nextMessages;
}

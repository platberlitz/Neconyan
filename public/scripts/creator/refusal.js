import { isLikelyPromptTransformRefusal } from '../extensions/in-chat-agents/prompt-transform-refusal.js';

function parseReply(text) {
    try { return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); } catch { return text; }
}

function strings(value) {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
}

/** Use the Agent guard on plain replies and individual JSON values, before accepting a proposal. */
export function assertCreatorReplyNotRefused(text, messages) {
    // Decode source JSON so quoted dialogue and line breaks compare as actual text.
    // System instructions are not source text and must not exempt a model refusal.
    const original = messages.filter(message => message.role === 'user')
        .flatMap(message => strings(parseReply(message.content))).join('\n');
    const outputs = strings(parseReply(text));
    if (outputs.some(output => isLikelyPromptTransformRefusal(output, original))) {
        throw Object.assign(new Error('The model refused the request. Nothing was applied; finished steps are saved. Try another connection or revise the request.'), { code: 'CREATOR_REFUSAL' });
    }
}
